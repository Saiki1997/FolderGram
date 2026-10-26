'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanFolder } = require('../src/core/scanner');
const { buildPlan } = require('../src/core/planner');
const { UploadJob, randomIds } = require('../src/core/uploader');
const { UploadHistory } = require('../src/core/history');
const { HashCache } = require('../src/core/hashing');
const { UploadQueue, JobState } = require('../src/core/queue');
const { classify, backoff, floodSeconds } = require('../src/core/retry');
const { AdaptiveConcurrency } = require('../src/core/concurrency');
const { sniff, checkFile } = require('../src/core/integrity');
const { writeJson, readJson, dailyBackup } = require('../src/core/store');
const { NamingMemory } = require('../src/core/naming-memory');

const tmp = (p = 'fgu-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
function tree(files) {
  const base = path.join(tmp(), 'Downloads', 'Cosplay');
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(base, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof content === 'number' ? Buffer.alloc(content, content % 251) : content);
  }
  return base;
}
const err = (m, extra = {}) => Object.assign(new Error(m), { errorMessage: m, ...extra });

/**
 * Fake Telegram that behaves like the real one where it matters: messages with a random id it already has are
 * refused with RANDOM_ID_DUPLICATE. `failures` is a script: { when: "before" | "after", error } per send, where
 * "after" means Telegram posted the album but the reply was lost.
 */
class FakeTelegram {
  constructor({ topics = [], failures = [] } = {}) {
    this.topics = topics.map(([id, title, closed]) => ({ id, title, closed: !!closed }));
    this.failures = failures;
    this.posts = [];
    this.ids = new Set();
    this.next = 100;
    this.topicFailures = [];
  }
  async listTopics() { return this.topics.map((t) => ({ ...t })); }
  async createTopic(_c, title) {
    const f = this.topicFailures.shift();
    if (f && f.when === 'before') throw err(f.error);
    this.topics.push({ id: ++this.next, title });
    if (f && f.when === 'after') throw err(f.error);
    return this.next;
  }
  async sendText(_c, text, topicId) { this.posts.push({ text, topicId }); }
  async sendAlbum(_c, files, caption, topicId, _o, onProgress, ctl) {
    if (ctl.isDone(0)) return {};
    onProgress(0.5);
    if (ctl.isCanceled()) throw err('USER_CANCELED');
    const ids = ctl.randomIds(0, files.length);
    const f = this.failures.shift();
    if (f && f.when === 'before') throw err(f.error, f.extra);
    if (ids.some((id) => this.ids.has(String(id)))) throw err('RANDOM_ID_DUPLICATE');
    ids.forEach((id) => this.ids.add(String(id)));
    this.posts.push({ files: files.map((x) => x.name), caption, topicId });
    if (f && f.when === 'after') throw err(f.error);
    ctl.stepDone(0, [this.posts.length]);
    onProgress(1);
    return { messageIds: [this.posts.length] };
  }
}

const chat = { id: '-100', title: 'G', isForum: true };
const history = () => new UploadHistory(path.join(tmp('fgh-'), 'uploaded.json'));
const fast = { delayMs: 0, retryBaseMs: 1, concurrency: { adaptive: false } };
const job = (t, plan, opts = {}, h = history(), extras = {}, events = {}) => new UploadJob(t, chat, plan, { mode: 'none', ...fast, ...opts }, events, h, extras);
const planOf = async (files, opts = {}) => buildPlan(await scanFolder(tree(files)), { captionWhere: 'every', ...opts });

// ---------------------------------------------------------------- retries and errors

test('errors are classified: delivered, flood, uncertain, temporary, permanent', () => {
  assert.equal(classify(err('RANDOM_ID_DUPLICATE')), 'delivered');
  assert.equal(classify(err('FLOOD_WAIT_30')), 'flood');
  assert.equal(classify(err('SLOWMODE_WAIT_10')), 'flood');
  assert.equal(classify(err('Request timed out')), 'uncertain');
  assert.equal(classify(err('Not connected')), 'uncertain');
  assert.equal(classify(err('INTERNAL_SERVER_ERROR')), 'temporary');
  assert.equal(classify(err('CHAT_WRITE_FORBIDDEN')), 'permanent');
  assert.equal(classify(err('TOPIC_CLOSED')), 'permanent');
  assert.equal(classify(err('USER_CANCELED')), 'cancelled');
  assert.equal(floodSeconds(err('FLOOD_PREMIUM_WAIT_7')), 7);
  const waits = [1, 2, 3, 4, 5, 6].map((a) => backoff(a, { baseMs: 1000, capMs: 8000, random: () => 1 }));
  assert.deepEqual(waits, [1000, 2000, 4000, 8000, 8000, 8000]);
  assert.ok(backoff(3, { baseMs: 1000, random: () => 0 }) === 1000); // jitter can go down to the base
});

test('a lost reply after Telegram posted the album does not post it twice', async () => {
  const plan = await planOf({ 'a.jpg': 10, 'b.jpg': 11 });
  const t = new FakeTelegram({ failures: [{ when: 'after', error: 'Request timed out' }] });
  const j = job(t, plan);
  await j.run();
  assert.equal(t.posts.length, 1); // the retry was refused as RANDOM_ID_DUPLICATE and counted as delivered
  assert.equal(j.stats.sent, 2);
  assert.equal(j.stats.failed, 0);
});

test('an uncertain send is checked against the chat before retrying', async () => {
  const plan = await planOf({ 'a.jpg': 10 });
  const t = new FakeTelegram({ failures: [{ when: 'after', error: 'Connection closed' }] });
  let checked = 0;
  t.findRecentAlbum = async () => { checked++; return [77]; };
  const sendSpy = t.sendAlbum.bind(t);
  let sends = 0;
  t.sendAlbum = (...a) => { sends++; return sendSpy(...a); };
  const j = job(t, plan);
  await j.run();
  assert.equal(checked, 1);
  assert.equal(sends, 1); // found it, so no second send at all
  assert.equal(j.stats.sent, 1);
});

test('flood waits are honoured, not counted as attempts, and reported', async () => {
  const plan = await planOf({ 'a.jpg': 10 });
  const t = new FakeTelegram({ failures: [{ when: 'before', error: 'FLOOD_WAIT_0', extra: { seconds: 0 } }, { when: 'before', error: 'FLOOD_WAIT_0', extra: { seconds: 0 } }] });
  const waits = [];
  const j = job(t, plan, { maxRetries: 1 }, history(), {}, { wait: (w) => waits.push(w) });
  await j.run();
  assert.equal(j.stats.sent, 1);
  assert.ok(waits.some((w) => w.reason === 'flood' && w.seconds === 1));
});

test('retries give up after the limit, permanent errors are not retried', async () => {
  const plan = await planOf({ 'a.jpg': 10, 'Sub/b.jpg': 11 });
  const t = new FakeTelegram({ failures: Array(3).fill({ when: 'before', error: 'INTERNAL' }) });
  const j = job(t, plan, { maxRetries: 3 });
  await j.run();
  assert.equal(j.stats.failed, 1);
  assert.equal(j.stats.sent, 1); // the next album still goes
  assert.equal(j.report.failed[0].error, 'INTERNAL');

  const t2 = new FakeTelegram({ failures: [{ when: 'before', error: 'CHAT_WRITE_FORBIDDEN' }] });
  const j2 = job(t2, await planOf({ 'a.jpg': 10 }), { maxRetries: 5 });
  await j2.run();
  assert.equal(t2.failures.length, 0);
  assert.equal(j2.stats.failed, 1);
});

test('cancel interrupts a long flood wait at once', async () => {
  const plan = await planOf({ 'a.jpg': 10 });
  const t = new FakeTelegram({ failures: [{ when: 'before', error: 'FLOOD_WAIT_600', extra: { seconds: 600 } }] });
  const j = job(t, plan);
  const p = j.run();
  await new Promise((r) => setTimeout(r, 50));
  const t0 = Date.now();
  j.cancel();
  await p;
  assert.ok(Date.now() - t0 < 500);
  assert.equal(t.posts.length, 0);
});

test('pause stops between albums and resume continues', async () => {
  const plan = await planOf(Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`p${i}.jpg`, 10 + i])));
  const t = new FakeTelegram();
  const j = job(t, plan);
  const p = j.run();
  j.pause();
  await new Promise((r) => setTimeout(r, 80));
  const during = t.posts.length;
  assert.ok(during < 3);
  j.resume();
  await p;
  assert.equal(t.posts.length, 3);
});

// ---------------------------------------------------------------- recovery

test('crash recovery: a resumed job sends only what is left, with no duplicates', async () => {
  const files = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`img${String(i).padStart(2, '0')}.jpg`, 100 + i]));
  const plan = await planOf(files, { captionWhere: 'last' });
  const dir = tmp('fgq-');
  const h = history();
  const t = new FakeTelegram();
  // Simulate a crash: the transport dies while the second album is being sent.
  const real = t.sendAlbum.bind(t);
  let n = 0;
  t.sendAlbum = async (...a) => { if (++n === 2) { q1.stop(); q1.running.upload.cancel(); throw err('USER_CANCELED'); } return real(...a); };
  const q1 = new UploadQueue({ dir, transport: t, history: h });
  const first = q1.add({ name: 'Cosplay', chat, mode: 'none', options: fast, plan });
  await new Promise((r) => q1.once('finished', r));
  assert.equal(t.posts.length, 1);
  // Pretend the app died while running: mark it running again on disk.
  const saved = readJson(path.join(dir, 'queue.json'), []);
  saved[0].status = 'running';
  writeJson(path.join(dir, 'queue.json'), saved);

  t.sendAlbum = real;
  const q2 = new UploadQueue({ dir, transport: t, history: new UploadHistory(h.file) });
  assert.equal(q2.get(first.id).status, 'interrupted');
  q2.resume(first.id);
  const { job: done } = await new Promise((r) => q2.once('finished', r));
  assert.equal(done.status, 'done');
  assert.equal(t.posts.length, 3);
  assert.deepEqual(t.posts.map((p) => p.files.length), [10, 10, 10]);
  assert.deepEqual(t.posts.map((p) => p.caption), ['', '', 'Cosplay']);
});

test('partly sent albums continue with the next message', async () => {
  const st = new JobState(path.join(tmp(), 's.jsonl'));
  const plan = await planOf({ 'a.jpg': 10 });
  const t = new FakeTelegram();
  t.sendAlbum = async (_c, files, caption, topicId, _o, onProgress, ctl) => {
    // Two messages: photos, then files. The first went through before the interruption.
    for (const step of [0, 1]) {
      if (ctl.isDone(step)) continue;
      t.posts.push({ step });
      ctl.stepDone(step, [step + 1]);
    }
  };
  const key = require('../src/core/uploader').albumKeyOf('none:null', plan[0].albums[0]);
  st.setAlbum(key, { status: 'sending', steps: ['0.0'], messageIds: [1] });
  const j = job(t, plan, {}, history(), { state: st });
  await j.run();
  assert.deepEqual(t.posts, [{ step: 1 }]);
  assert.deepEqual(st.album(key).messageIds, [1, 2]);
  assert.equal(new JobState(st.file).album(key).status, 'done'); // persisted
});

test('random ids are stable per album and step, different per job', () => {
  assert.deepEqual(randomIds('j1', 'a', '0.0', 3), randomIds('j1', 'a', '0.0', 3));
  assert.notDeepEqual(randomIds('j1', 'a', '0.0', 1), randomIds('j2', 'a', '0.0', 1));
  assert.notDeepEqual(randomIds('j1', 'a', '0.0', 1), randomIds('j1', 'a', '0.1', 1));
});

test('upload history survives a crash between saves and a damaged file', async () => {
  const dir = tmp();
  const file = path.join(dir, 'uploaded.json');
  const h = new UploadHistory(file);
  h.add('k1');
  h.addMany([['k2', 5], ['k3', { s: 'abc' }]]);
  // No save(): the journal alone must bring them back.
  const again = new UploadHistory(file);
  assert.ok(again.has('k1') && again.has('k2') && again.get('k3').s === 'abc');
  again.save();
  assert.equal(fs.readFileSync(`${file}.journal`, 'utf8'), '');
  again.add('k4');
  again.save();
  fs.writeFileSync(file, '{"k1": 1, "k2'); // torn write
  const notes = [];
  const recovered = new UploadHistory(file, { onRecover: (m) => notes.push(m) });
  assert.ok(recovered.has('k1') && recovered.has('k3')); // from the .bak copy
  assert.ok(notes[0].includes('restored'));
  assert.ok(fs.readdirSync(dir).some((n) => n.includes('.corrupt-')));
});

test('settings-style JSON recovers from the backup; daily backups rotate', () => {
  const dir = tmp();
  const f = path.join(dir, 'settings.json');
  writeJson(f, { a: 1 });
  writeJson(f, { a: 2 });
  fs.writeFileSync(f, '');
  assert.deepEqual(readJson(f, {}), { a: 1 });
  for (let d = 1; d <= 9; d++) dailyBackup(dir, ['settings.json'], 7, new Date(`2026-01-0${d}T10:00:00Z`));
  assert.equal(fs.readdirSync(path.join(dir, 'backups')).length, 7);
});

// ---------------------------------------------------------------- duplicates

test('duplicates: same content under another name is skipped, confirmed by SHA-256', async () => {
  const big = Buffer.alloc(300000, 7);
  const plan = await planOf({ 'A/x.jpg': big, 'B/copy of x.jpg': big, 'B/y.jpg': 60 });
  const t = new FakeTelegram();
  const j = job(t, plan, { skipDuplicates: true });
  await j.run();
  assert.equal(j.stats.duplicates, 1);
  assert.deepEqual(j.report.duplicates.map((d) => [d.name, d.of, d.certain]), [['copy of x.jpg', 'x.jpg', true]]);
});

test('duplicates: files that differ only in the middle are not duplicates', async () => {
  const a = Buffer.alloc(400000, 1);
  const b = Buffer.from(a);
  b[200000] = 9; // same size, same first and last 64 KB
  const plan = await planOf({ 'a.wav': a, 'b.wav': b }, { captionBy: 'folder' });
  const t = new FakeTelegram();
  const j = job(t, plan, { skipDuplicates: true });
  await j.run();
  assert.equal(j.stats.duplicates, 0);
  assert.equal(j.stats.sent, 2);
});

test('duplicates: a later job recognises files sent before, and can be overridden', async () => {
  const content = Buffer.alloc(5000, 3);
  const root = tree({ 'old.jpg': content });
  const h = history();
  const hashes = new HashCache(null);
  await job(new FakeTelegram(), buildPlan(await scanFolder(root)), { skipDuplicates: true }, h, { hashCache: hashes }).run();
  fs.writeFileSync(path.join(root, 'renamed.jpg'), content);
  fs.unlinkSync(path.join(root, 'old.jpg'));
  const plan2 = buildPlan(await scanFolder(root));
  const j2 = job(new FakeTelegram(), plan2, { skipDuplicates: true }, h, { hashCache: hashes });
  await j2.run();
  assert.equal(j2.stats.duplicates, 1);
  assert.equal(j2.report.duplicates[0].certain, true); // SHA-256 was kept from the first upload
  const t3 = new FakeTelegram();
  const j3 = job(t3, plan2, { skipDuplicates: true, forceUpload: [path.join(root, 'renamed.jpg')] }, h, { hashCache: hashes });
  await j3.run();
  assert.equal(t3.posts.length, 1);
});

test('duplicates: FolderGram 2.x fingerprints in old history still count (as probable)', async () => {
  const root = tree({ 'x.jpg': 5000 });
  const h = history();
  const f = (await scanFolder(root))[0].files[0];
  h.add(`dup:${chat.id}:${UploadHistory.fingerprint(f)}`); // what 2.3.0 wrote
  const j = job(new FakeTelegram(), buildPlan(await scanFolder(root)), { skipDuplicates: true, skipUploaded: true }, h);
  await j.run();
  assert.deepEqual(j.report.duplicates.map((d) => d.certain), [false]);
  const j2 = job(new FakeTelegram(), buildPlan(await scanFolder(root)), { skipDuplicates: true, dupProbable: 'upload' }, h);
  await j2.run();
  assert.equal(j2.stats.sent, 1);
});

test('overlapping jobs in the queue never send the same file twice', async () => {
  const plan = await planOf({ 'a.jpg': 10, 'b.jpg': 11 });
  const dir = tmp('fgq-');
  const t = new FakeTelegram();
  const q = new UploadQueue({ dir, transport: t, history: history() });
  q.add({ name: 'one', chat, mode: 'none', options: fast, plan, hold: true });
  assert.equal(q.overlap(chat.id, plan), 2);
  const two = q.add({ name: 'two', chat, mode: 'none', options: fast, plan });
  await new Promise((r) => q.once('finished', r));
  q.resume(q.jobs[0].id);
  await new Promise((r) => q.once('finished', r));
  assert.equal(t.posts.length, 1);
  assert.equal(q.get(two.id).status, 'done');
  assert.equal(q.jobs[0].stats.skipped, 2);
});

// ---------------------------------------------------------------- queue

test('queue: order, hold, schedule, retry failed, remove finished', async () => {
  const plan = await planOf({ 'a.jpg': 10 });
  let now = 1_000_000;
  const t = new FakeTelegram({ failures: [{ when: 'before', error: 'CHAT_WRITE_FORBIDDEN' }] });
  const q = new UploadQueue({ dir: tmp('fgq-'), transport: t, history: history(), now: () => now });
  const a = q.add({ name: 'a', chat, mode: 'none', options: fast, plan });
  const { job: ja } = await new Promise((r) => q.once('finished', r));
  assert.equal(ja.status, 'failed');
  const later = q.add({ name: 'later', chat, mode: 'none', options: fast, plan: await planOf({ 'b.jpg': 12 }), scheduledAt: now + 60_000 });
  assert.equal(q.get(later.id).status, 'queued');
  assert.equal(t.posts.length, 0);
  q.retry(a.id); // the error is gone now
  await new Promise((r) => q.once('finished', r));
  assert.equal(q.get(a.id).status, 'done');
  assert.equal(t.posts.length, 1); // "later" still waits for its time
  now += 61_000;
  q.kick();
  await new Promise((r) => q.once('finished', r));
  assert.equal(q.get(later.id).status, 'done');
  q.move(later.id, 0);
  assert.equal(q.jobs[0].id, later.id);
  q.clearFinished();
  assert.equal(q.jobs.length, 0);
});

// ---------------------------------------------------------------- topics

test('topic creation: a lost reply does not create the topic twice; a refused topic fails only its folder', async () => {
  const plan = buildPlan(await scanFolder(tree({ 'Rem/a.jpg': 10, 'Ram/b.jpg': 11 })));
  const t = new FakeTelegram({ topics: [[1, 'General']] });
  t.topicFailures = [{ when: 'after', error: 'Request timed out' }];
  const j = job(t, plan, { mode: 'per_folder' });
  await j.run();
  assert.deepEqual(t.topics.map((x) => x.title), ['General', 'Ram', 'Rem']);
  assert.equal(j.stats.sent, 2);

  const t2 = new FakeTelegram();
  t2.topicFailures = [{ when: 'before', error: 'CHAT_ADMIN_REQUIRED' }];
  const j2 = job(t2, plan, { mode: 'per_folder' });
  await j2.run();
  assert.equal(j2.stats.failed, 1);
  assert.equal(j2.stats.sent, 1);
});

test('topics match ignoring case and punctuation; closed topics are reported', async () => {
  const plan = buildPlan(await scanFolder(tree({ 'Rem Collection/a.jpg': 10 })));
  const logs = [];
  const t = new FakeTelegram({ topics: [[5, 'rem collection!', true], [6, 'Rem  Collection']] });
  await job(t, plan, { mode: 'per_folder' }, history(), {}, { log: (m) => logs.push(m) }).run();
  assert.equal(t.posts[0].topicId, 6); // the open one wins over the closed one
  const t2 = new FakeTelegram({ topics: [[5, 'Rem Collection', true]] });
  await job(t2, plan, { mode: 'per_folder' }, history(), {}, { log: (m) => logs.push(m) }).run();
  assert.ok(logs.some((m) => m.includes('is closed')));
});

// ---------------------------------------------------------------- integrity, concurrency, reports

test('integrity: missing, changed, empty and mislabelled files', async () => {
  assert.equal(sniff(Buffer.from('ffd8ffe000104a46', 'hex')), 'image');
  assert.equal(sniff(Buffer.from('000000206674797069736f6d', 'hex')), 'video');
  assert.equal(sniff(Buffer.from('1a45dfa3', 'hex')), 'video');
  assert.equal(sniff(Buffer.from('ID3\u0004')), 'audio');
  assert.equal(sniff(Buffer.alloc(16)), 'empty');
  const root = tree({ 'photo.jpg': Buffer.from('000000206674797069736f6d00000000', 'hex'), 'ok.jpg': Buffer.from('ffd8ffe000104a4600', 'hex') });
  const [g] = await scanFolder(root);
  const bad = await checkFile(g.files.find((f) => f.name === 'photo.jpg'));
  assert.ok(bad.ok && bad.asDocument && /looks like a video/.test(bad.warning));
  const good = g.files.find((f) => f.name === 'ok.jpg');
  assert.deepEqual((await checkFile(good)).warning, '');
  fs.appendFileSync(good.path, 'more');
  assert.ok((await checkFile(good)).changed);
  fs.unlinkSync(good.path);
  assert.ok((await checkFile(good)).missing);
});

test('a file deleted after the scan fails alone; the rest of its album is sent', async () => {
  const root = tree({ 'a.jpg': 10, 'b.jpg': 11, 'c.jpg': 12 });
  const plan = buildPlan(await scanFolder(root));
  fs.unlinkSync(path.join(root, 'b.jpg'));
  const t = new FakeTelegram();
  const j = job(t, plan);
  await j.run();
  assert.deepEqual(t.posts[0].files, ['a.jpg', 'c.jpg']);
  assert.equal(j.stats.failed, 1);
  assert.deepEqual(j.report.failed.map((f) => [f.name, f.error]), [['b.jpg', 'file no longer exists']]);
});

test('adaptive concurrency backs off on floods and failures, recovers slowly', () => {
  const c = new AdaptiveConcurrency({ preset: 'fast', freemem: () => 8e9 });
  assert.equal(c.filesFor([1e6]), 4);
  c.flood(30);
  assert.equal(c.files, 2);
  assert.ok(c.delayMs >= 1500);
  for (let i = 0; i < 8; i++) c.success();
  assert.equal(c.files, 4);
  assert.equal(c.filesFor([900 * 1024 * 1024]), 2); // big files: fewer at once
  assert.equal(new AdaptiveConcurrency({ preset: 'balanced', freemem: () => 1e8 }).filesFor([1]), 1); // low memory
  assert.equal(new AdaptiveConcurrency({ preset: 'conservative' }).workersFor(50 * 1024 * 1024), 4);
  const fixed = new AdaptiveConcurrency({ preset: 'custom', custom: { files: 5 }, adaptive: false });
  fixed.flood(10);
  assert.equal(fixed.files, 5);
});

test('report lists topics, albums, uploads, failures and skips', async () => {
  const plan = buildPlan(await scanFolder(tree({ 'Rem/a.jpg': 10, 'Rem/b.jpg': 11 })), { captionBy: 'smart' });
  const t = new FakeTelegram();
  const j = job(t, plan, { mode: 'per_folder' });
  await j.run();
  const r = j.report;
  assert.deepEqual(r.topics, ['Rem']);
  assert.equal(r.albums.length, 1);
  assert.equal(r.albums[0].status, 'sent');
  assert.equal(r.uploaded.length, 2);
  assert.ok(r.startedAt && r.finishedAt);
});

test('naming memory keeps aliases, corrections and rules on disk', () => {
  const f = path.join(tmp(), 'naming.json');
  const m = new NamingMemory(f);
  assert.equal(m.alias('kb03wM'), 'Album 1');
  assert.equal(m.alias('Wy4dQa'), 'Album 2');
  m.correctAlbum({ dir: 'D:/x', key: 's1', from: 'kb03wM', to: 'Marin' });
  m.correctTopic('kb03wM', 'Marin topic');
  m.setRules([{ find: ' (GoFile)', replace: '' }, { find: '^Cosplay - ', replace: '', regex: true }]);
  m.save();
  const again = new NamingMemory(f);
  assert.equal(again.alias('Wy4dQa'), 'Album 2');
  assert.equal(again.alias('2Zy6lA'), 'Album 3');
  assert.equal(again.resolveAlbum({ dir: 'D:/x', key: 's1', name: 'whatever' }), 'Marin');
  assert.equal(again.resolveAlbum({ dir: 'E:/y', key: 's9', name: 'KB03WM' }), 'Marin'); // learned
  assert.equal(again.resolveAlbum({ dir: 'E:/y', key: 's9', name: 'Loose Files (GoFile)' }), 'Loose Files');
  assert.equal(again.resolveAlbum({ dir: 'E:/y', key: 's9', name: 'Cosplay - Rem' }), 'Rem');
  assert.equal(again.resolveTopic('kb03wm'), 'Marin topic');
});
