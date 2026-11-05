'use strict';

// FolderGram 4.0 reliability: connection outages, stalled calls, delivery checks, resuming half-sent albums,
// progress that never goes back, deleted topics, and the details a resumed job needs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Api } = require('telegram');
const { scanFolder } = require('../src/core/scanner');
const { buildPlan } = require('../src/core/planner');
const { UploadJob, MemoryState, albumKeyOf } = require('../src/core/uploader');
const { UploadHistory } = require('../src/core/history');
const { UploadQueue, JobState } = require('../src/core/queue');
const { isNetworkError, classify } = require('../src/core/retry');
const { matchAlbum, normalizeCheck } = require('../src/core/reconcile');
const { Telegram } = require('../src/core/telegram');
const { uploadParallel, SenderPool } = require('../src/core/fastupload');
const { FakeTelegram, err } = require('./fake-telegram');

const tmp = (p = 'fgr-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
function tree(files) {
  const base = path.join(tmp(), 'Downloads', 'Cosplay');
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(base, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof content === 'number' ? Buffer.alloc(content, content % 251) : content);
  }
  return base;
}
const chat = { id: '-100', title: 'G', isForum: true };
const history = () => new UploadHistory(path.join(tmp('fgh-'), 'uploaded.json'));
const quick = { delayMs: 0, retryBaseMs: 1, offlineBaseMs: 5, concurrency: { adaptive: false } };
const job = (t, plan, opts = {}, h = history(), extras = {}, events = {}) => new UploadJob(t, chat, plan, { mode: 'none', ...quick, ...opts }, events, h, extras);
const planOf = async (files, opts = {}) => buildPlan(await scanFolder(tree(files)), { captionWhere: 'every', ...opts });
const jpgs = (n, prefix = 'p') => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}${String(i).padStart(3, '0')}.jpg`, 50 + i]));

// ---------------------------------------------------------------- connection outages

test('a connection outage is waited out: no album fails and no attempt is used up', async () => {
  const plan = await planOf(jpgs(30), { captionWhere: 'last' });
  const t = new FakeTelegram();
  t.offline = true;
  setTimeout(() => { t.offline = false; }, 150);
  const logs = [];
  const j = job(t, plan, { maxRetries: 2 }, history(), {}, { log: (x) => logs.push(x) });
  await j.run();
  assert.equal(j.stats.failed, 0);
  assert.equal(j.stats.sent, 30);
  assert.equal(t.posts.length, 3);
  assert.ok(j.stats.offlineMs >= 100, `waited ${j.stats.offlineMs} ms`);
  assert.ok(logs.some((l) => /Connection to Telegram lost/.test(l)) && logs.some((l) => /Reconnected after/.test(l)));
});

test('cancel ends an outage wait at once', async () => {
  const plan = await planOf(jpgs(3));
  const t = new FakeTelegram();
  t.offline = true;
  const j = job(t, plan, { offlineBaseMs: 60000 });
  const started = Date.now();
  setTimeout(() => j.cancel(), 80);
  await j.run();
  assert.ok(Date.now() - started < 2000);
  assert.equal(t.posts.length, 0);
});

test('errors that mean "no connection" are told apart from Telegram errors', () => {
  for (const m of ['Not connected', 'getaddrinfo ENOTFOUND venus.web.telegram.org', 'connect ENETUNREACH', 'STALLED: no progress', 'Request timed out', 'socket hang up'])
    assert.equal(isNetworkError(err(m)), true, m);
  for (const m of ['FLOOD_WAIT_10', 'CHAT_WRITE_FORBIDDEN', 'INTERNAL_SERVER_ERROR', 'USER_CANCELED', 'RANDOM_ID_DUPLICATE'])
    assert.equal(isNetworkError(err(m)), false, m);
  assert.equal(classify(err('STALLED: no progress for 150 s')), 'uncertain');
});

// ---------------------------------------------------------------- watchdog

test('a send Telegram never answers is given up and retried, and posts once', async () => {
  const plan = await planOf(jpgs(2));
  const t = new FakeTelegram({ failures: [{ hang: true }] });
  const j = job(t, plan, { stallMs: 60 });
  await j.run();
  assert.equal(t.posts.length, 1);
  assert.equal(t.sendCalls, 2);
  assert.equal(j.stats.failed, 0);
  assert.equal(j.stats.stalls, 1);
});

test('a send that arrived but never answered is not posted twice after the watchdog retries', async () => {
  const plan = await planOf(jpgs(2), { captionWhere: 'last' });
  const t = new FakeTelegram({ failures: [{ hangAfter: true }] });
  const j = job(t, plan, { stallMs: 60 });
  await j.run();
  assert.equal(t.posts.length, 1); // found by the delivery check (or refused as a repeat), not sent again
  assert.equal(j.stats.sent, 2);
});

test('cancel ends a send Telegram never answers', async () => {
  const plan = await planOf(jpgs(1));
  const t = new FakeTelegram({ failures: [{ hang: true }] });
  const j = job(t, plan, { stallMs: 0 }); // watchdog off: only cancel can end it
  setTimeout(() => j.cancel(), 60);
  const started = Date.now();
  await j.run();
  assert.ok(Date.now() - started < 2000);
});

// ---------------------------------------------------------------- delivery checks

test('delivery check: an earlier album without caption is not mistaken for this one', async () => {
  // 30 photos -> 3 albums, only the last captioned. The 2nd send fails before posting with an uncertain error.
  const plan = await planOf(jpgs(30), { captionWhere: 'last' });
  const t = new FakeTelegram({ failures: [null, { when: 'before', error: 'Request timed out' }] });
  const j = job(t, plan);
  await j.run();
  assert.equal(t.posts.length, 3, 'all three albums are in the chat');
  assert.equal(j.stats.sent, 30);
  assert.ok(t.checks >= 1);
});

test('matchAlbum needs the same count, caption, file names, date and an unknown message', () => {
  const msgs = [
    { id: 10, date: 100, out: true, groupedId: 'a', media: true, text: '' }, { id: 11, date: 100, out: true, groupedId: 'a', media: true, text: '' },
    { id: 20, date: 200, out: true, groupedId: 'b', media: true, text: '' }, { id: 21, date: 200, out: true, groupedId: 'b', media: true, text: 'Rem' },
    { id: 30, date: 300, out: false, groupedId: 'c', media: true, text: '' }, { id: 31, date: 300, out: false, groupedId: 'c', media: true, text: '' },
    { id: 40, date: 300, out: true, media: true, text: '', names: ['clip.mp4'] },
  ];
  assert.deepEqual(matchAlbum(msgs, { since: 90, count: 2, caption: '' }).ids, [10, 11]);
  assert.equal(matchAlbum(msgs, { since: 90, count: 2, caption: '', exclude: new Set([10, 11]) }), null); // known album; c is not ours
  assert.equal(matchAlbum(msgs, { since: 150, count: 2, caption: '' }), null); // a is too old
  assert.deepEqual(matchAlbum(msgs, { since: 150, count: 2, caption: 'Rem' }).ids, [20, 21]);
  assert.deepEqual(matchAlbum(msgs, { since: 250, count: 1, caption: '', names: ['clip.mkv'] }).ids, [40]); // remuxed to .mp4
  assert.equal(matchAlbum(msgs, { since: 250, count: 1, caption: '', names: ['other.mp4'] }), null);
  assert.deepEqual(normalizeCheck([5]), { ids: [5], complete: true });
  assert.deepEqual(normalizeCheck(null), { ids: null, complete: true });
  assert.equal(normalizeCheck({ ids: null, complete: false }).complete, false);
});

test('Telegram.findRecentAlbum pages back until it has seen every message since the send', async () => {
  const t = new Telegram({ store: { load: () => null, save() {}, remove() {} } });
  const peer = new Api.InputPeerChannel({ channelId: 1n, accessHash: 2n });
  t.entities.set('-100', peer);
  // 250 messages, newest first, one per second; ours: an album of 2 at the 220th newest (old enough to need paging).
  const all = [];
  for (let i = 0; i < 250; i++) {
    const id = 1000 - i;
    const mine = i === 220 || i === 221;
    all.push(new Api.Message({ id, date: 5000 - i, out: mine, message: '', groupedId: mine ? 7n : undefined, peerId: new Api.PeerChannel({ channelId: 1n }),
      media: new Api.MessageMediaPhoto({ photo: new Api.PhotoEmpty({ id: BigInt(id) }) }) }));
  }
  const calls = [];
  t.client = {
    invoke: async (req) => {
      calls.push(req.offsetId);
      const start = req.offsetId ? all.findIndex((m) => m.id < req.offsetId) : 0;
      return new Api.messages.Messages({ messages: all.slice(start, start + req.limit), chats: [], users: [] });
    },
  };
  const r = await t.findRecentAlbum({ id: '-100' }, 55, { since: 4770, count: 2, caption: '' });
  assert.deepEqual(r.ids, [779, 780]);
  assert.equal(r.complete, true);
  assert.equal(calls.length, 3);
  const none = await t.findRecentAlbum({ id: '-100' }, 55, { since: 4770, count: 2, caption: '', exclude: new Set([779, 780]) });
  assert.deepEqual(none, { ids: null, ambiguous: false, complete: true });
});

test('Telegram.findRecentAlbum does not take the album sent just before (no caption) for the lost one', async () => {
  const t = new Telegram({ store: { load: () => null, save() {}, remove() {} } });
  t.entities.set('-100', new Api.InputPeerChannel({ channelId: 1n, accessHash: 2n }));
  // Album 1: ten photos, no caption, posted 1 s before album 2 started; album 2 never arrived.
  const msgs = Array.from({ length: 10 }, (_, i) => new Api.Message({ id: 510 - i, date: 4999, out: true, message: '', groupedId: 9n,
    peerId: new Api.PeerChannel({ channelId: 1n }), media: new Api.MessageMediaPhoto({ photo: new Api.PhotoEmpty({ id: BigInt(i) }) }) }));
  t.client = { invoke: async () => new Api.messages.Messages({ messages: msgs, chats: [], users: [] }) };
  const r = await t.findRecentAlbum({ id: '-100' }, 55, { since: 5000, count: 10, caption: '', exclude: new Set(msgs.map((m) => m.id)) });
  assert.strictEqual(normalizeCheck(r).ids, null);
});

// ---------------------------------------------------------------- resuming half-sent albums

/** A job whose first album was being sent when FolderGram stopped `agoMs` ago. */
async function halfSent({ agoMs, phase = 'send', posted }) {
  const plan = await planOf(jpgs(2), { captionWhere: 'last' });
  const state = new MemoryState();
  const key = albumKeyOf('none:null', plan[0].albums[0]);
  const t = new FakeTelegram();
  const startedAt = Date.now() - agoMs;
  state.setAlbum(key, { status: 'sending', phase, startedAt, sendAt: startedAt });
  if (posted) t.posts.push({ files: ['p000.jpg', 'p001.jpg'], caption: plan[0].albums[0].caption, topicId: null, ids: [5, 6], groupedId: 'g5', date: t.serverNow() - Math.round(agoMs / 1000) });
  return { plan, state, key, t };
}

test('resume: an album that reached Telegram before the stop is found and not sent again', async () => {
  const { plan, state, key, t } = await halfSent({ agoMs: 3 * 3600e3, posted: true });
  const j = job(t, plan, {}, history(), { state });
  await j.run();
  assert.equal(t.posts.length, 1);
  assert.equal(t.sendCalls, 0);
  assert.equal(state.album(key).status, 'done');
  assert.equal(j.stats.sent, 2);
});

test('resume: an album confirmed missing is sent; one stopped while uploading is sent without a check', async () => {
  const a = await halfSent({ agoMs: 3 * 3600e3, posted: false });
  const j = job(a.t, a.plan, {}, history(), { state: a.state });
  await j.run();
  assert.equal(a.t.posts.length, 1);
  assert.equal(a.t.checks, 1);
  const b = await halfSent({ agoMs: 3 * 3600e3, phase: 'upload', posted: false });
  await job(b.t, b.plan, {}, history(), { state: b.state }).run();
  assert.equal(b.t.posts.length, 1);
  assert.equal(b.t.checks, 0);
});

test('resume: when Telegram cannot confirm an old half-sent album it is held for review, then resolved by the user', async () => {
  const dir = tmp('fgq-');
  const plan = await planOf(jpgs(12), { captionWhere: 'last' }); // two albums
  const t = new FakeTelegram();
  const h = history();
  const q = new UploadQueue({ dir, transport: t, history: h });
  const spec = { chat, mode: 'none', options: quick, plan, hold: true };
  const jb = q.add(spec);
  // Pretend an earlier run stopped while sending the first album, two hours ago.
  const key = albumKeyOf('none:null', plan[0].albums[0]);
  const st = new JobState(q.stateFile(jb.id));
  st.setAlbum(key, { status: 'sending', phase: 'send', startedAt: Date.now() - 7200e3, sendAt: Date.now() - 7200e3 });
  st.close();
  t.checkResult = { ids: null, complete: false };
  const finished = () => new Promise((r) => q.once('finished', ({ job: x }) => r(x)));
  let wait = finished();
  q.resume(jb.id);
  let done = await wait;
  assert.equal(done.status, 'review');
  assert.equal(t.posts.length, 1, 'the second album went, the uncertain one waits');
  assert.match(done.error, /may already be in Telegram/);
  assert.equal(q.report(jb.id).review.length, 1);
  // "Mark as sent": recorded as sent and in the history, nothing posted.
  wait = finished();
  q.resolveReview(jb.id, 'mark');
  done = await wait;
  assert.equal(done.status, 'done');
  assert.equal(t.posts.length, 1);
  for (const f of plan[0].albums[0].files) assert.ok(h.has(UploadHistory.key(chat.id, 'none:null', f)));
});

test('resume: "Send again" sends a held album with its own message ids', async () => {
  const dir = tmp('fgq-');
  const plan = await planOf(jpgs(2));
  const t = new FakeTelegram();
  const q = new UploadQueue({ dir, transport: t, history: history() });
  const jb = q.add({ chat, mode: 'none', options: quick, plan, hold: true });
  const st = new JobState(q.stateFile(jb.id));
  for (const al of plan[0].albums) st.setAlbum(albumKeyOf('none:null', al), { status: 'review', startedAt: Date.now() - 7200e3 });
  st.close();
  q.update(jb.id, { status: 'review' });
  t.checkResult = { ids: null, complete: false };
  const wait = new Promise((r) => q.once('finished', ({ job: x }) => r(x)));
  q.resolveReview(jb.id, 'resend');
  const done = await wait;
  assert.equal(done.status, 'done');
  assert.equal(t.posts.length, plan[0].albums.length);
  assert.equal(q.get(jb.id).options.reviewAction, undefined, 'the choice is used once');
});

test('a recent half-sent album is sent again with the same ids when it cannot be checked', async () => {
  const { plan, state, t } = await halfSent({ agoMs: 60e3, posted: false });
  t.checkResult = { ids: null, complete: false };
  const j = job(t, plan, {}, history(), { state });
  await j.run();
  assert.equal(t.posts.length, 1);
  assert.equal(j.stats.review, 0);
});

// ---------------------------------------------------------------- counts and progress

test('a file missing at send time counts as failed only, not also as sent', async () => {
  const base = tree({ 'Set/a.jpg': 10, 'Set/b.jpg': 11, 'Set/c.jpg': 12 });
  const plan = buildPlan(await scanFolder(base), { captionWhere: 'every' });
  fs.unlinkSync(path.join(base, 'Set', 'b.jpg'));
  const t = new FakeTelegram();
  const j = job(t, plan);
  await j.run();
  assert.equal(j.stats.sent, 2);
  assert.equal(j.stats.failed, 1);
});

test('progress never goes back when a file is uploaded again, and checking is reported separately', async () => {
  const plan = await planOf(jpgs(400));
  const t = new FakeTelegram();
  t.progressScript = [0.8, 0.2, 0.6];
  const seen = [];
  const phases = [];
  const j = job(t, plan, {}, history(), {}, { progress: (p) => { if (p.phase) phases.push(p); else seen.push(p.done); } });
  await j.run();
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1], `progress went back at ${i}: ${seen[i - 1]} -> ${seen[i]}`);
  assert.ok(phases.length >= 1 && phases.every((p) => p.phase === 'checking' && p.total === 0 && p.totalFiles === 400));
  assert.equal(seen[seen.length - 1], j.stats.bytesTotal);
});

// ---------------------------------------------------------------- topics and groups

test('a topic deleted in Telegram during the job is created again and the album goes there', async () => {
  const base = tree({ 'Rem/a.jpg': 10, 'Rem/b.jpg': 11 });
  const plan = buildPlan(await scanFolder(path.dirname(base)), { captionWhere: 'every' });
  const t = new FakeTelegram({ topics: [[50, 'Cosplay']] });
  t.deletedTopics.add(50);
  t.topics = t.topics.map((x) => ({ ...x })); // listTopics hides deleted ones
  const state = new MemoryState();
  state.setTopic('Cosplay', 50); // looked up earlier in the job
  const j = new UploadJob(t, chat, plan, { mode: 'per_folder', ...quick }, {}, history(), { state });
  await j.run();
  assert.equal(j.stats.failed, 0);
  assert.equal(t.posts.length, 1);
  assert.notEqual(t.posts[0].topicId, 50);
  assert.equal(state.topic('Cosplay'), t.posts[0].topicId);
});

test('a saved job reaches its group after a restart without listing chats (bots cannot)', () => {
  const t = new Telegram({ store: { load: () => null, save() {}, remove() {} } });
  const ch = new Api.Channel({ id: 1234n, accessHash: -987n, title: 'G', forum: true, photo: new Api.ChatPhotoEmpty(), date: 0 });
  const info = t.info(ch);
  assert.deepEqual(info.peer, { type: 'channel', id: '1234', accessHash: '-987' });
  const fresh = new Telegram({ store: { load: () => null, save() {}, remove() {} } });
  const e = fresh.entity({ id: info.id, peer: info.peer });
  assert.ok(e instanceof Api.InputPeerChannel);
  assert.equal(e.channelId.toString(), '1234');
  assert.equal(e.accessHash.toString(), '-987');
  assert.throws(() => fresh.entity({ id: '-1005' }), /Pick the group again/);
});

// ---------------------------------------------------------------- fast upload waits

test('a flood wait on file parts is reported and Cancel ends it at once', async () => {
  const f = path.join(tmp(), 'v.mp4');
  fs.writeFileSync(f, Buffer.alloc(3 * 512 * 1024, 1));
  let cancelled = false;
  const pool = new SenderPool(async () => ({
    isConnected: () => true, disconnect: async () => {},
    send: async () => { throw Object.assign(new Error('FLOOD_WAIT_30'), { errorMessage: 'FLOOD_WAIT_30', seconds: 30 }); },
  }));
  const waits = [];
  const started = Date.now();
  setTimeout(() => { cancelled = true; }, 100);
  await assert.rejects(uploadParallel(pool, { savePart: (a) => a, saveBigPart: (a) => a }, { path: f, name: 'v.mp4', size: 3 * 512 * 1024 }, {
    connections: 1, perConnection: 1, isCanceled: () => cancelled, onWait: (s) => waits.push(s),
    floodSeconds: (e) => e.seconds ?? null,
  }), /USER_CANCELED/);
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(waits, [30]);
  await pool.close();
});
