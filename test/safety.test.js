'use strict';

// Telegram Safety Engine 4.0: rate limits, album budgeting, flood/spam handling, topic protection, destructive-call
// guards, the integrity ledger and read-only audits. Everything runs against mocks; nothing talks to Telegram.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Api } = require('telegram');
const { instantSafety: baseSafety } = require('./safety-helpers');
const instantSafety = (o) => { const e = baseSafety(o); e.reservationLog = recordReservations(e); return e; };
const { FakeTelegram, err } = require('./fake-telegram');
const { SafetyEngine, classifyTelegramError, resolveProfile, PROFILES, MINUTE } = require('../src/core/telegram-safety');
const { TopicRegistry, JsonTopicStore, DualTopicStore, validateTopic, incidentReport } = require('../src/core/topic-protection');
const guard = require('../src/core/destructive-guard');
const { Ledger, migrateFromJobs } = require('../src/core/ledger');
const { runAudit, inspectAdminLog, groupWarnings } = require('../src/core/integrity-audit');
const { Telegram } = require('../src/core/telegram');
const { UploadJob, MemoryState } = require('../src/core/uploader');
const { UploadHistory } = require('../src/core/history');
const { SyncState, SyncRunner } = require('../src/core/sync');
const { scanFolder } = require('../src/core/scanner');
const { buildPlan } = require('../src/core/planner');

const tmp = (p = 'fgs-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const chat = { id: '-100777', title: 'Archive', isForum: true };
const quick = { delayMs: 0, retryBaseMs: 1, offlineBaseMs: 1, concurrency: { adaptive: false } };
const history = () => new UploadHistory(path.join(tmp('fgh-'), 'uploaded.json'));

function tree(files) {
  const base = path.join(tmp(), 'Downloads', 'Cosplay');
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(base, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof content === 'number' ? Buffer.alloc(content, content % 251) : content);
  }
  return base;
}
const planFor = async (files) => buildPlan(await scanFolder(tree(files)), { captionWhere: 'every' });

/** FakeTelegram whose sends go through a safety engine, like telegram.js does. */
function safeFake(opts = {}, safety = instantSafety()) {
  const t = new FakeTelegram(opts);
  t.safety = safety;
  const send = t.sendAlbum.bind(t);
  t.sendAlbum = async (c, files, caption, topicId, o, onProgress, ctl) => {
    if (ctl.isDone(0)) return {};
    const r = await safety.acquire({ chatId: String(c.id), topicId, messages: files.length, ctx: { isCanceled: ctl.isCanceled } });
    try {
      const out = await send(c, files, caption, topicId, o, onProgress, ctl);
      r.confirm(files.length);
      return out;
    } catch (e) {
      if (e.errorMessage && !/Not connected|TIMEOUT/.test(e.errorMessage)) r.release(); else r.uncertain();
      if (!e.safetyDecision) e.safetyDecision = safety.reportError(e, { chatId: String(c.id), topicId, method: 'sendMultiMedia' });
      throw e;
    }
  };
  return t;
}

/** Every reservation an engine makes, as [{ t, n, chatId }] (its own window forgets entries after a minute). */
function recordReservations(e) {
  const log = [];
  const reserve = e.reserve.bind(e);
  e.reserve = (chatId, topicId, n, now) => { log.push({ t: now, n, chatId }); return reserve(chatId, topicId, n, now); };
  return log;
}
const groupLog = (e, chatId) => (e.reservationLog || []).filter((r) => r.chatId === String(chatId));
function maxInWindow(log, ms = MINUTE) {
  let max = 0;
  for (const a of log) max = Math.max(max, log.filter((b) => b.t >= a.t && b.t < a.t + ms).reduce((s, b) => s + b.n, 0));
  return max;
}

// ---------------------------------------------------------------- 1-3, 24: pacing and album budgeting

test('1. a 10-item album uses 10 messages of the budget, and the next album waits for it', async () => {
  const e = instantSafety(); // Balanced: 12/min, 5 s per message
  const log = [];
  for (let i = 0; i < 4; i++) {
    const r = await e.acquire({ chatId: chat.id, messages: 10 });
    log.push({ t: r.at, n: 10 });
    r.confirm();
  }
  for (let i = 1; i < log.length; i++) assert.ok(log[i].t - log[i - 1].t >= 50000, `album ${i} only ${log[i].t - log[i - 1].t} ms after the one before`);
  assert.ok(maxInWindow(log) <= 12, `at most 12 messages in any minute, saw ${maxInWindow(log)}`);
  assert.equal(e.stats.messagesReserved, 40);
});

test('2. simultaneous workers cannot oversubscribe a group: every reservation respects the window and the spacing', async () => {
  const e = instantSafety();
  const sizes = [3, 10, 1, 7, 2, 10, 4, 1, 5, 6];
  await Promise.all(sizes.map(async (n, i) => {
    const r = await e.acquire({ chatId: chat.id, topicId: 10 + (i % 3), messages: n });
    await Promise.resolve();
    r.confirm();
  }));
  const log = groupLog(e, chat.id).sort((a, b) => a.t - b.t);
  assert.equal(log.reduce((s, r) => s + r.n, 0), sizes.reduce((a, b) => a + b, 0));
  assert.ok(maxInWindow(log) <= 12, `window max ${maxInWindow(log)}`);
  for (let i = 1; i < log.length; i++) assert.ok(log[i].t - log[i - 1].t >= log[i - 1].n * 5000, 'spacing after each album');
});

test('3. single messages are spread out: no bursts, at most the profile rate per minute', async () => {
  for (const name of ['safe_archive', 'balanced', 'fast_conservative']) {
    const e = instantSafety({ profile: name });
    const log = [];
    for (let i = 0; i < 40; i++) { const r = await e.acquire({ chatId: chat.id, messages: 1 }); log.push({ t: r.at, n: 1 }); r.confirm(); }
    const p = PROFILES[name];
    assert.ok(maxInWindow(log) <= p.perMinute, `${name}: ${maxInWindow(log)} > ${p.perMinute}`);
    for (let i = 1; i < log.length; i++) assert.ok(log[i].t - log[i - 1].t >= p.minIntervalMs, `${name}: gap ${log[i].t - log[i - 1].t}`);
  }
});

test('an album bigger than the per-minute budget is not split; it goes alone and the group rests longer after it', async () => {
  const e = instantSafety({ profile: 'safe_archive' }); // 8/min
  const a = await e.acquire({ chatId: chat.id, messages: 10 }); a.confirm();
  const b = await e.acquire({ chatId: chat.id, messages: 1 }); b.confirm();
  assert.ok(b.at - a.at >= 75000, 'rests 10 × 7.5 s');
});

test('24. a send cancelled while waiting for its slot frees the line for the next one', async () => {
  const e = instantSafety();
  const first = await e.acquire({ chatId: chat.id, messages: 1 });
  let cancelled = false;
  const waiting = e.acquire({ chatId: chat.id, messages: 1, ctx: { isCanceled: () => cancelled } });
  cancelled = true;
  first.uncertain(); // outcome unknown: the message stays counted
  await assert.rejects(waiting, /USER_CANCELED/);
  const next = await e.acquire({ chatId: chat.id, messages: 1 });
  assert.ok(next.at - first.at >= 5000, 'the uncertain send still counts');
  next.release(); // nothing was sent: the budget comes back
  assert.equal(e.windows.get(`group:${chat.id}`).length, 1);
});

test('custom settings are kept within the published guidance', () => {
  const r = resolveProfile('custom', { perMinute: 100, minIntervalMs: 100, burst: 50, maxWorkers: 99 }, { sessionType: 'bot' });
  assert.equal(r.settings.perMinute, 20);
  assert.ok(r.settings.minIntervalMs >= 3000);
  assert.equal(r.settings.burst, 3);
  assert.equal(r.settings.maxWorkers, 6);
  assert.ok(r.warnings.length >= 3);
});

// ---------------------------------------------------------------- 4-8: flood, slow mode, spam, 429, restart

test('4. FLOOD_WAIT: the exact wait plus a margin, a lower saved rate, and an event for the ledger', async () => {
  const events = [];
  const e = instantSafety({ onEvent: (ev) => events.push(ev) });
  const a = await e.acquire({ chatId: chat.id, messages: 1 });
  a.release();
  const d = e.reportError(err('FLOOD_WAIT_30', { code: 420, seconds: 30 }), { chatId: chat.id, method: 'sendMultiMedia' });
  assert.equal(d.action, 'wait');
  assert.ok(d.seconds >= 30 && d.seconds <= 33);
  const t0 = e.clock.t;
  const b = await e.acquire({ chatId: chat.id, messages: 1 });
  assert.ok(b.at - t0 >= 32000, 'waited the full flood time plus margin');
  assert.ok(e.effectiveRate(chat.id) < 12, 'rate lowered');
  assert.ok(events.some((x) => x.type === 'rate_limit' && x.seconds === 30 && x.effectiveRate < 12));
});

test('the rate only recovers slowly after a flood and never above the chosen profile', async () => {
  const e = instantSafety();
  e.reportError(err('FLOOD_WAIT_5'), { chatId: chat.id, method: 'sendMedia' });
  const low = e.effectiveRate(chat.id);
  for (let i = 0; i < 2000; i++) { const r = await e.acquire({ chatId: chat.id, messages: 1 }); r.confirm(); }
  assert.ok(e.effectiveRate(chat.id) > low, 'recovered somewhat');
  assert.ok(e.effectiveRate(chat.id) <= PROFILES.balanced.perMinute, 'never above Balanced');
});

test('repeated flood warnings fall back to Safe Archive and pause for the user', () => {
  const e = instantSafety();
  e.reportError(err('FLOOD_WAIT_10'), { chatId: chat.id, method: 'sendMedia' });
  e.reportError(err('FLOOD_WAIT_10'), { chatId: chat.id, method: 'sendMedia' });
  const d = e.reportError(err('FLOOD_WAIT_10'), { chatId: chat.id, method: 'sendMedia' });
  assert.equal(d.action, 'stop');
  assert.equal(e.profileName, 'safe_archive');
  assert.ok(e.suspension());
});

test('5. SLOWMODE_WAIT pauses that group only', async () => {
  const e = instantSafety();
  e.reportError(err('SLOWMODE_WAIT_40'), { chatId: chat.id, method: 'sendMedia' });
  const t0 = e.clock.t;
  const other = await e.acquire({ chatId: '-100999', messages: 1 });
  assert.ok(other.at - t0 < 1000, 'another group is not held');
  other.confirm();
  const same = await e.acquire({ chatId: chat.id, messages: 1 });
  assert.ok(same.at - t0 >= 42000);
  assert.equal(classifyTelegramError(err('SLOWMODE_WAIT_40')).category, 'slowmode');
});

test('6. PEER_FLOOD stops every send of the account until the user resumes; no retry loop', async () => {
  const e = instantSafety();
  const d = e.reportError(err('PEER_FLOOD'), { chatId: chat.id, method: 'sendMultiMedia' });
  assert.equal(d.action, 'stop');
  await assert.rejects(e.acquire({ chatId: '-100999', messages: 1 }), /SAFETY_SUSPENDED/);
  assert.equal(e.clearSuspension(), true);
  const r = await e.acquire({ chatId: chat.id, messages: 1 });
  r.confirm();
});

test('6b. an upload job hit by PEER_FLOOD pauses (held), keeps the album unsent and does not retry', async () => {
  const plan = await planFor({ 'A/a.jpg': 10, 'A/b.jpg': 11, 'B/c.jpg': 12 });
  const t = safeFake({ topics: [[50, 'A'], [51, 'B']], failures: [{ when: 'before', error: 'PEER_FLOOD' }] });
  const state = new MemoryState();
  const j = new UploadJob(t, chat, plan, { mode: 'per_folder', ...quick, maxRetries: 5 }, {}, history(), { state, safety: t.safety });
  await j.run();
  assert.equal(t.sendCalls, 1, 'one send, no retries');
  assert.equal(t.posts.length, 0);
  assert.ok(j.halted);
  assert.equal(j.stats.failed, 0);
  const statuses = [...state.albums.values()].map((a) => a.status);
  assert.ok(statuses.every((s) => s === 'pending'), statuses.join(','));
});

test('7. HTTP 429 (Bot API) honours retry_after', () => {
  const c = classifyTelegramError({ error_code: 429, description: 'Too Many Requests: retry after 17', parameters: { retry_after: 17 } });
  assert.equal(c.category, 'flood');
  assert.equal(c.seconds, 17);
});

test('8. a restart during a cooldown still waits it out (the cooldown is saved)', async () => {
  const file = path.join(tmp(), 'telegram-safety.json');
  const clock = { t: 1_700_000_000_000 };
  const mk = () => new SafetyEngine({ file, now: () => clock.t, sleep: async (ms) => { clock.t += ms; } });
  const a = mk();
  a.reportError(err('FLOOD_WAIT_300'), { chatId: chat.id, method: 'sendMedia' });
  clock.t += 10000; // FolderGram restarts 10 s later
  const b = mk();
  const t0 = clock.t;
  const r = await b.acquire({ chatId: chat.id, messages: 1 });
  assert.ok(r.at - t0 >= 290000, `waited ${r.at - t0} ms`);
  assert.ok(b.effectiveRate(chat.id) < 12, 'the lowered rate survived the restart too');
});

test('the flood wait reaches the job as a countdown and costs no attempt', async () => {
  const plan = await planFor({ 'A/a.jpg': 10 });
  const t = safeFake({ topics: [[50, 'A']], failures: [{ when: 'before', error: 'FLOOD_WAIT_1' }] });
  const waits = [];
  const j = new UploadJob(t, chat, plan, { mode: 'per_folder', ...quick, maxRetries: 1 }, { wait: (w) => waits.push(w) }, history(), { safety: t.safety });
  await j.run();
  assert.equal(j.stats.sent, 1);
  assert.ok(waits.some((w) => w.reason === 'flood' && w.seconds >= 3));
});

// ---------------------------------------------------------------- 11-17: topics

test('11. an existing topic is reused by its id after a check', async () => {
  const plan = await planFor({ 'A/a.jpg': 10 });
  const t = new FakeTelegram({ topics: [[50, 'A']] });
  const registry = new TopicRegistry();
  registry.record({ chatId: chat.id, topicId: 50, name: 'A', source: 'foldergram' });
  const j = new UploadJob(t, chat, plan, { mode: 'per_folder', ...quick }, {}, history(), { registry });
  await j.run();
  assert.equal(t.posts[0].topicId, 50);
  assert.equal(t.created || 0, 0);
});

test('a renamed topic keeps receiving its folder (identity is the id, not the name)', async () => {
  const plan = await planFor({ 'A/a.jpg': 10 });
  const t = new FakeTelegram({ topics: [[50, 'A (2019)']] });
  const registry = new TopicRegistry();
  registry.record({ chatId: chat.id, topicId: 50, name: 'A', source: 'foldergram' });
  const j = new UploadJob(t, chat, plan, { mode: 'per_folder', ...quick }, {}, history(), { registry });
  await j.run();
  assert.equal(t.posts.length, 1);
  assert.equal(t.posts[0].topicId, 50);
  assert.equal(t.created || 0, 0, 'no new "A" topic');
  assert.deepEqual(registry.get(chat.id, 50).aliases, ['A']);
});

test('12/14. a known topic deleted in Telegram is not replaced by a new one with the same name', async () => {
  const plan = await planFor({ 'A/a.jpg': 10 });
  const t = new FakeTelegram({ topics: [[50, 'A']] });
  t.deletedTopics.add(50); // gone from the list, getTopicsById says deleted
  const registry = new TopicRegistry();
  registry.record({ chatId: chat.id, topicId: 50, name: 'A', source: 'foldergram' });
  const j = new UploadJob(t, chat, plan, { mode: 'per_folder', ...quick }, {}, history(), { registry });
  await j.run();
  assert.equal(t.created || 0, 0);
  assert.equal(t.posts.length, 0);
  assert.equal(j.halted.kind, 'missing');
  assert.equal(registry.get(chat.id, 50).status, 'deleted');
  assert.equal(registry.incidents().length, 1);
  // Even the next job (fresh state) won't create it…
  const j2 = new UploadJob(t, chat, plan, { mode: 'per_folder', ...quick }, {}, history(), { registry });
  await j2.run();
  assert.equal(t.created || 0, 0);
  // …until the user approves a new topic; then the old record stays, linked to the new one.
  registry.setStatus(chat.id, 50, 'deleted', { recreateApproved: true });
  const j3 = new UploadJob(t, chat, plan, { mode: 'per_folder', ...quick }, {}, history(), { registry });
  await j3.run();
  assert.equal(t.created, 1);
  const nu = t.posts[0].topicId;
  assert.notEqual(nu, 50);
  assert.equal(registry.get(chat.id, 50).replacedBy, nu);
  assert.equal(registry.get(chat.id, nu).replaces, 50);
});

test('13. two topics with the same name: FolderGram asks instead of guessing; a known one is used', async () => {
  const plan = await planFor({ 'A/a.jpg': 10 });
  const t = new FakeTelegram({ topics: [[50, 'A'], [60, 'A']] });
  const j = new UploadJob(t, chat, plan, { mode: 'per_folder', ...quick }, {}, history());
  await j.run();
  assert.equal(t.posts.length, 0);
  assert.equal(j.halted.kind, 'ambiguous');
  const registry = new TopicRegistry();
  registry.record({ chatId: chat.id, topicId: 60, name: 'A', source: 'foldergram' });
  const j2 = new UploadJob(t, chat, plan, { mode: 'per_folder', ...quick }, {}, history(), { registry });
  await j2.run();
  assert.equal(t.posts[0].topicId, 60);
});

test('15. a closed topic is reported, not replaced', async () => {
  const plan = await planFor({ 'A/a.jpg': 10 });
  const t = new FakeTelegram({ topics: [[50, 'A', true]] });
  const logs = [];
  const state = new MemoryState();
  state.setTopic('A', 50);
  const j = new UploadJob(t, chat, plan, { mode: 'per_folder', ...quick }, { log: (x, k) => logs.push([k, x]) }, history(), { state });
  await j.run();
  assert.ok(logs.some(([k, x]) => k === 'warn' && /closed/.test(x)));
  assert.equal(t.created || 0, 0);
});

test('16. a topic that can\'t be checked right now (network) is never treated as missing', async () => {
  const plan = await planFor({ 'A/a.jpg': 10 });
  const t = new FakeTelegram({ topics: [[50, 'A']] });
  t.topicCheckError = err('RPC_CALL_FAIL');
  const state = new MemoryState();
  state.setTopic('A', 50);
  const registry = new TopicRegistry();
  registry.record({ chatId: chat.id, topicId: 50, name: 'A' });
  const j = new UploadJob(t, chat, plan, { mode: 'per_folder', ...quick }, {}, history(), { state, registry });
  await j.run();
  assert.equal(t.posts.length, 0, 'not posted while unchecked');
  assert.equal(t.created || 0, 0);
  assert.equal(registry.get(chat.id, 50).status, 'ok', 'status unchanged');
  assert.equal(registry.incidents().length, 0);
  assert.ok(!j.halted, 'the folder fails for now; nothing is decided');
  assert.equal(validateTopic.length, 3);
  assert.equal((await validateTopic(t, chat, 50)).status, 'uncertain');
});

test('17. permission changes: no rights to read the topic pauses the job; no rights to write fails without retry loops', async () => {
  const plan = await planFor({ 'A/a.jpg': 10 });
  const t = new FakeTelegram({ topics: [[50, 'A']] });
  t.topicCheckError = err('CHANNEL_PRIVATE');
  const state = new MemoryState();
  state.setTopic('A', 50);
  const j = new UploadJob(t, chat, plan, { mode: 'per_folder', ...quick }, {}, history(), { state });
  await j.run();
  assert.equal(j.halted.kind, 'inaccessible');
  const t2 = new FakeTelegram({ topics: [[50, 'A']], failures: [{ when: 'before', error: 'CHAT_WRITE_FORBIDDEN' }] });
  const j2 = new UploadJob(t2, chat, plan, { mode: 'per_folder', ...quick, maxRetries: 5 }, {}, history());
  await j2.run();
  assert.equal(t2.sendCalls, 1);
  assert.equal(j2.stats.failed, 1);
  assert.equal(classifyTelegramError(err('CHAT_WRITE_FORBIDDEN')).category, 'write_forbidden');
});

test('a topic name missing from an incomplete topic list is not created', async () => {
  const plan = await planFor({ 'New/a.jpg': 10 });
  const t = new FakeTelegram({ topics: [[50, 'A']] });
  const list = t.listTopics.bind(t);
  t.listTopics = async () => { const l = await list(); Object.defineProperty(l, 'complete', { value: false }); return l; };
  const j = new UploadJob(t, chat, plan, { mode: 'per_folder', ...quick }, {}, history());
  await j.run();
  assert.equal(t.created || 0, 0);
  assert.equal(j.stats.failed, 1);
});

// ---------------------------------------------------------------- 25: no destructive calls

test('25. the guard refuses delete methods outside a user-confirmed action', async () => {
  const calls = [];
  const client = guard.guardClient({ invoke: async (r) => { calls.push(r.className); return true; } });
  await assert.rejects(client.invoke(new Api.channels.DeleteMessages({ channel: new Api.InputChannel({ channelId: 1n, accessHash: 1n }), id: [5] })), /DESTRUCTIVE_BLOCKED/);
  await assert.rejects(client.invoke(new Api.channels.DeleteTopicHistory({ channel: new Api.InputChannel({ channelId: 1n, accessHash: 1n }), topMsgId: 5 })), /DESTRUCTIVE_BLOCKED/);
  await assert.rejects(client.invoke(new Api.messages.DeleteHistory({ peer: new Api.InputPeerSelf(), maxId: 0 })), /DESTRUCTIVE_BLOCKED/);
  assert.equal(calls.length, 0);
  await guard.authorize('test: user confirmed', () => client.invoke(new Api.channels.DeleteMessages({ channel: new Api.InputChannel({ channelId: 1n, accessHash: 1n }), id: [5] })));
  assert.deepEqual(calls, ['channels.DeleteMessages']);
  assert.ok(guard.isDestructive('deleteForumTopic'), 'Bot API names are covered too');
});

test('25b. a real album send (telegram.js) goes through the safety gate, counts 10 messages and calls nothing destructive', async () => {
  const t = new Telegram({ store: { load: () => null, save() {}, remove() {} }, shrinkPhoto: async () => null });
  const safety = instantSafety();
  t.setSafety(safety);
  t.dlog = { write() {} };
  const seen = [];
  let nextId = 1n;
  t.uploadFast = async (file) => new Api.InputFile({ id: nextId++, parts: 1, name: file.name, md5Checksum: '' });
  t.client = guard.guardClient({
    uploadFile: async ({ file }) => new Api.InputFile({ id: nextId++, parts: 1, name: file.name, md5Checksum: '' }),
    invoke: async (req) => {
      seen.push(req.className);
      if (req instanceof Api.messages.UploadMedia) return new Api.MessageMediaPhoto({ photo: new Api.Photo({ id: nextId++, accessHash: 1n, fileReference: Buffer.alloc(0), date: 0, sizes: [], dcId: 1 }) });
      const n = req.multiMedia ? req.multiMedia.length : 1;
      return new Api.Updates({ updates: Array.from({ length: n }, (_, i) => new Api.UpdateMessageID({ id: 200 + i, randomId: 1n })), users: [], chats: [], date: 0, seq: 0 });
    },
  });
  t.entities.set(chat.id, new Api.InputPeerChannel({ channelId: 1n, accessHash: 1n }));
  const dir = tmp();
  const files = Array.from({ length: 10 }, (_, i) => { const p = path.join(dir, `p${i}.jpg`); fs.writeFileSync(p, Buffer.alloc(100, i)); return { path: p, name: `p${i}.jpg`, ext: '.jpg', size: 100, mtime: 1 }; });
  for (let k = 0; k < 2; k++) await t.sendAlbum(chat, files, 'cap', 50, {}, () => {}, {});
  assert.equal(safety.stats.messagesReserved, 20);
  assert.equal(safety.stats.messagesConfirmed, 20);
  const log = groupLog(safety, chat.id);
  assert.ok(log[1].t - log[0].t >= 50000, 'second album of 10 waited for the first one\'s budget');
  assert.ok(seen.every((c) => !guard.isDestructive(c)), seen.join(','));
});

test('25c. only telegram.js deleteMessages references a delete method, and only the sync dialog calls it, inside authorize()', () => {
  const src = path.join(__dirname, '..', 'src');
  const hits = [];
  const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (p.endsWith('.js')) { const s = fs.readFileSync(p, 'utf8'); if (/Api\.\w+\.Delete\w*|DeleteTopicHistory|deleteForumTopic\(/.test(s)) hits.push(path.relative(src, p).split(path.sep).join('/')); } } }; // '/' on Windows too
  walk(src);
  assert.deepEqual(hits.filter((f) => f !== 'core/destructive-guard.js').sort(), ['core/telegram.js']); // the guard only lists the names
  const lib = fs.readFileSync(path.join(src, 'ipc-library.js'), 'utf8');
  const callers = lib.split('\n').filter((l) => /deleteMessages\(/.test(l));
  assert.equal(callers.length, 1);
  assert.ok(/guard\.authorize\(/.test(callers[0]));
  for (const f of ['core/uploader.js', 'core/queue.js', 'core/sync.js', 'core/integrity-audit.js', 'core/library.js', 'core/downloader.js']) {
    assert.ok(!/deleteMessages|Delete\w*\(/.test(fs.readFileSync(path.join(src, f), 'utf8')), f);
  }
});

// ---------------------------------------------------------------- sync deletion safety

test('sync: when message ids don\'t line up with files, no file is credited with the whole album', () => {
  const st = new SyncState(path.join(tmp(), 's.json'));
  st.recordJob({ albums: [{ status: 'sent', paths: ['/a', '/b', '/c'], messageIds: [10, 11] }] }, { '/a': {}, '/b': {}, '/c': {} });
  assert.deepEqual(st.posted['/a'], []);
  st.recordJob({ albums: [{ status: 'sent', paths: ['/d', '/e'], messageIds: [20, 21] }] }, { '/d': {}, '/e': {} });
  assert.deepEqual(st.posted['/e'], [21]);
});

test('sync: a missing folder (unplugged drive) never turns into "delete everything from Telegram"', async () => {
  const dir = tmp();
  const stateFile = path.join(dir, 'state.json');
  const st = new SyncState(stateFile);
  for (let i = 0; i < 30; i++) { st.files[`/x/${i}.jpg`] = { size: 1, mtimeMs: 1 }; st.posted[`/x/${i}.jpg`] = [100 + i]; }
  st.save();
  const runner = new SyncRunner({ stateFile: () => stateFile, scan: async () => [], plan: () => [], enqueue: async () => ({ id: 'j' }), folderExists: () => false });
  const r = await runner.run({ id: 'p', name: 'p', folders: ['/x'], direction: 'two-way', options: {} });
  assert.deepEqual(r.removedOnTelegram, []);
  assert.match(r.note, /not found/);
  const runner2 = new SyncRunner({ stateFile: () => stateFile, scan: async () => [], plan: () => [], enqueue: async () => ({ id: 'j' }), folderExists: () => true });
  const r2 = await runner2.run({ id: 'p', name: 'p', folders: ['/x'], direction: 'two-way', options: {} });
  assert.deepEqual(r2.removedOnTelegram, [], 'a mass disappearance is held too');
  assert.match(r2.note, /disappeared at once/);
});

// ---------------------------------------------------------------- ledger, migration, corruption

test('ledger: albums are recorded with message ids, never overwritten, and paged by key', () => {
  const dir = tmp();
  const l = Ledger.open(dir);
  assert.ok(l.available, 'node:sqlite available');
  l.recordAlbum({ chatId: chat.id, topicId: 50, jobId: 'j', albumKey: 'k', files: [{ path: '/a', size: 1 }, { path: '/b', size: 2 }], messageIds: [7, 8] });
  l.recordAlbum({ chatId: chat.id, topicId: 50, jobId: 'j', albumKey: 'k', files: [{ path: '/a', size: 1 }, { path: '/b', size: 2 }], messageIds: [7, 8] }); // resumed
  assert.equal(l.counts().files, 2);
  assert.equal(l.counts().confirmed, 2);
  const page = l.pageFiles({ chatId: chat.id, afterId: 0, limit: 1 });
  assert.equal(page.length, 1);
  assert.equal(l.pageFiles({ chatId: chat.id, afterId: page[0].id, limit: 10 }).length, 1);
  // A new topic with the same name is a separate record.
  const reg = new TopicRegistry(l.topicStore());
  reg.record({ chatId: chat.id, topicId: 50, name: 'A' });
  reg.record({ chatId: chat.id, topicId: 99, name: 'A' });
  assert.equal(reg.byName(chat.id, 'A').length, 2);
  assert.equal(l.integrityCheck(), 'ok');
  l.close();
});

test('22. a damaged integrity database is kept aside and restored from its newest backup', () => {
  const dir = tmp();
  let l = Ledger.open(dir);
  l.recordAlbum({ chatId: chat.id, topicId: 50, files: [{ path: '/a', size: 1 }], messageIds: [7] });
  l.backup(path.join(dir, 'backups', 'integrity'));
  l.close();
  const file = path.join(dir, 'foldergram-integrity.sqlite');
  for (const s of ['-wal', '-shm']) fs.rmSync(file + s, { force: true });
  fs.writeFileSync(file, crypto.randomBytes(8192));
  const notes = [];
  l = Ledger.open(dir, { onRecover: (m) => notes.push(m) });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /restored/);
  assert.equal(l.counts().files, 1);
  assert.ok(fs.readdirSync(dir).some((f) => /\.corrupt-/.test(f)), 'the damaged file is kept');
  l.close();
});

test('23. migration from existing job files fills the registry and ledger and changes nothing in the old files', () => {
  const dir = tmp();
  const jobs = path.join(dir, 'jobs');
  fs.mkdirSync(jobs);
  fs.writeFileSync(path.join(jobs, 'queue.json'), JSON.stringify([{ id: 'j1', chat: { id: chat.id } }]));
  fs.writeFileSync(path.join(jobs, 'j1.state.jsonl'), `${JSON.stringify({ t: 'Cosplay', id: 50 })}\n${JSON.stringify({ a: 'k', p: { status: 'done' } })}\n{"torn`);
  fs.writeFileSync(path.join(jobs, 'j1.report.json'), JSON.stringify({ jobId: 'j1', chat: { id: chat.id }, albums: [{ topic: 'Cosplay', topicId: 50, status: 'sent', paths: ['/a', '/b'], files: ['a', 'b'], messageIds: [7, 8] }] }));
  const before = fs.readdirSync(jobs).map((f) => [f, crypto.createHash('sha1').update(fs.readFileSync(path.join(jobs, f))).digest('hex')]);
  const l = Ledger.open(dir);
  const reg = new TopicRegistry(new DualTopicStore(l.topicStore(), new JsonTopicStore(path.join(dir, 'topic-registry.json'))));
  const m = migrateFromJobs(l, reg, jobs);
  assert.equal(m.topics, 1);
  assert.equal(m.files, 2);
  assert.equal(reg.get(chat.id, 50).originalName, 'Cosplay');
  assert.equal(migrateFromJobs(l, reg, jobs).files, 0, 'runs once');
  const after = fs.readdirSync(jobs).map((f) => [f, crypto.createHash('sha1').update(fs.readFileSync(path.join(jobs, f))).digest('hex')]);
  assert.deepEqual(after, before);
  l.close();
});

test('20. 100,000 ledger rows: batch insert and keyset pages stay fast (1,000,000 in bench/integrity-bench.js)', () => {
  const l = Ledger.open(tmp());
  const N = 100000;
  const rows = Array.from({ length: N }, (_, i) => ({ path: `/d/${i}.jpg`, name: `${i}.jpg`, size: i, mtime: 1, uploadedAt: 1, chatId: chat.id, topicId: 50 + (i % 20), messageId: 1000 + i, albumKey: `a${i >> 3}`, jobId: 'j', state: 'VERIFIED_SENT', verification: 'confirmed' }));
  let t0 = Date.now();
  l.addFilesBatch(rows);
  const insertMs = Date.now() - t0;
  t0 = Date.now();
  let after = 0;
  let pages = 0;
  for (;;) { const p = l.pageFiles({ chatId: chat.id, topicId: 55, afterId: after, limit: 500 }); if (!p.length) break; after = p[p.length - 1].id; pages++; }
  const pageMs = Date.now() - t0;
  assert.equal(pages, 10);
  assert.ok(l.findFile('/d/99999.jpg', 99999, 1));
  assert.ok(insertMs < 30000 && pageMs < 5000, `insert ${insertMs} ms, paging ${pageMs} ms`);
  l.close();
});

// ---------------------------------------------------------------- 18-19: audits and anti-spam awareness

test('18. a read-only audit finds messages Telegram no longer returns, without claiming why', async () => {
  const l = Ledger.open(tmp());
  l.recordAlbum({ chatId: chat.id, topicId: 50, files: [1, 2, 3, 4].map((i) => ({ path: `/f${i}` })), messageIds: [11, 12, 13, 14] });
  const reg = new TopicRegistry();
  reg.record({ chatId: chat.id, topicId: 50, name: 'A' });
  const calls = [];
  const transport = {
    getTopicsById: async (_c, ids) => { calls.push('topics'); return ids.map((id) => ({ id, title: 'A' })); },
    existingMessageIds: async (_c, ids) => { calls.push('messages'); return new Set(ids.filter((x) => x !== 13)); },
  };
  const r = await runAudit('standard', { transport, registry: reg, ledger: l, chat, sleep: async () => {} });
  assert.equal(r.topics.ok, 1);
  assert.equal(r.messages.missing, 1);
  const inc = reg.incidents().find((i) => i.category === 'missing_messages');
  assert.deepEqual(inc.evidence.messageIds, [13]);
  assert.match(inc.evidence.note, /not known/);
  assert.equal(l.counts().missing, 1);
  // A failing check marks nothing.
  const r2 = await runAudit('deep', { transport: { ...transport, existingMessageIds: async () => { throw err('TIMEOUT'); } }, registry: reg, ledger: l, chat, sleep: async () => {} });
  assert.equal(r2.messages.checked, 0);
  l.close();
});

test('a topic lookup that comes back without a topic list is "not checkable", never "missing" (no incident, no pause)', async () => {
  const t = new Telegram({ store: { load: () => null, save() {}, remove() {} }, shrinkPhoto: async () => null });
  t.client = { invoke: async () => true }; // an answer of the wrong shape
  t.invokeBusy = (req) => t.client.invoke(req);
  t.entity = () => ({});
  await assert.rejects(t.getTopicsById(chat, [50]), /no topic list/);
  const reg = new TopicRegistry();
  reg.record({ chatId: chat.id, topicId: 50, name: 'A', source: 'created' });
  const r = await runAudit('quick', { transport: t, registry: reg, chat, sleep: async () => {} });
  assert.equal(r.topics.missing, 0);
  assert.equal(r.topics.uncertain, 1);
  assert.equal(reg.incidents().length, 0);
  assert.equal(reg.get(chat.id, 50).status, 'ok');
});

test('19. native anti-spam and moderator deletions (mocked admin log) become incidents with the actor as evidence', async () => {
  const reg = new TopicRegistry();
  reg.record({ chatId: chat.id, topicId: 50, name: 'A' });
  const transport = { adminLogDeletions: async () => [
    { at: 1, actorId: '5434988373', kind: 'message', messageId: 11, topicId: 50 },
    { at: 2, actorId: '5434988373', kind: 'message', messageId: 12, topicId: 50 },
    { at: 3, actorId: '42', kind: 'topic', topicId: 50, title: 'A' },
  ] };
  const r = await inspectAdminLog({ transport, registry: reg, ledger: null, chat });
  assert.equal(r.available, true);
  const cats = reg.incidents().map((i) => i.category).sort();
  assert.deepEqual(cats, ['messages_deleted_admin_log', 'topic_deleted_admin_log']);
  assert.deepEqual(reg.incidents().find((i) => i.category === 'messages_deleted_admin_log').evidence.byActor, { 5434988373: 2 });
  const w = groupWarnings({ ttlPeriod: 86400, antispam: true, slowmodeSeconds: 0, canDeleteMessages: true, isBot: true, canManageTopics: true });
  assert.ok(w.some((x) => x.level === 'critical' && /auto-delete/.test(x.text)));
  assert.ok(w.some((x) => /Anti-Spam/.test(x.text) && /never changes/.test(x.text)));
  const noLog = await inspectAdminLog({ transport: { adminLogDeletions: async () => { throw err('CHAT_ADMIN_REQUIRED'); } }, registry: reg, chat });
  assert.equal(noLog.available, false);
});

test('the incident report holds topics and incidents and no secrets', () => {
  const reg = new TopicRegistry();
  reg.record({ chatId: chat.id, topicId: 50, name: 'A' });
  reg.incident({ chatId: chat.id, topicId: 50, category: 'missing_topic', evidence: { x: 1 } });
  const txt = incidentReport(reg, chat.id, { title: 'Archive' });
  assert.match(txt, /missing_topic/);
  assert.match(txt, /not a backup of the media/);
  assert.ok(!/botToken|apiHash|session/i.test(txt));
});

// ---------------------------------------------------------------- 9-10, 21: restart and lost answers with the gate on

test('10/21. an album posted but whose answer was lost is found, not posted again, also after a restart', async () => {
  const plan = await planFor({ 'A/a.jpg': 10, 'A/b.jpg': 11 });
  const t = safeFake({ topics: [[50, 'A']], failures: [{ when: 'after', error: 'TIMEOUT' }] });
  const h = history();
  const j = new UploadJob(t, chat, plan, { mode: 'per_folder', ...quick }, {}, h, { safety: t.safety });
  await j.run();
  assert.equal(t.posts.length, 1, 'posted once');
  assert.equal(j.stats.sent, 2);
  // Restart: a new job over the same plan with the same history sends nothing.
  const j2 = new UploadJob(t, chat, plan, { mode: 'per_folder', ...quick }, {}, h, { safety: t.safety });
  await j2.run();
  assert.equal(t.posts.length, 1);
  assert.equal(j2.stats.skipped, 2);
});
