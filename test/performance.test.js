'use strict';

// Resource profiles, the shared ffmpeg cap, the resource monitor's hysteresis, batched window messages, and the
// upload cache staying bounded. All local: nothing here talks to Telegram.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RESOURCE_PROFILES, resolveResourceProfile, Limiter, Batcher, Coalescer, ResourceMonitor, PerformanceManager } = require('../src/core/performance-manager');
const { HashPool } = require('../src/core/hashing');
const { scanFolder, buildPlan } = require('../src/core/scanner');
const { UploadJob, UploadHistory } = require('../src/core/uploader');
const { PROFILES: SAFETY_PROFILES } = require('../src/core/telegram-safety');

test('resource profiles resolve to bounded numbers, ordered low <= balanced <= high', () => {
  for (const n of [1, 2, 4, 8, 32]) {
    const [lo, mid, hi] = ['low', 'balanced', 'high'].map((k) => resolveResourceProfile(k, n));
    for (const k of ['ffmpeg', 'hashWorkers', 'analysis', 'videoInfo', 'uiHz']) {
      assert.ok(lo[k] >= 1, `${k} at least 1`);
      assert.ok(lo[k] <= mid[k] || n < 4, `low ${k} <= balanced on ${n} cores`);
      assert.ok(hi[k] >= 1);
    }
    assert.ok(hi.ffmpeg <= 4 && hi.hashWorkers <= 4 && hi.analysis <= 8 && hi.uiHz <= 10);
    assert.ok(lo.uiHz >= 4 && mid.uiHz <= 10); // the window gets 4 to 10 updates a second
  }
  assert.equal(resolveResourceProfile('nonsense').name, 'balanced');
});

test('resource profiles contain no Telegram pacing setting', () => {
  const telegramKeys = new Set(Object.values(SAFETY_PROFILES).flatMap((p) => Object.keys(p)));
  for (const p of Object.values(RESOURCE_PROFILES)) for (const k of Object.keys(p)) assert.ok(!telegramKeys.has(k) || k === 'label', `${k} must not overlap Telegram pacing`);
});

test('limiter never runs more than its limit, and a lowered limit applies to queued work', async () => {
  const l = new Limiter(3);
  let active = 0, peak = 0;
  const job = () => l.run(async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); active--; });
  const all = Array.from({ length: 12 }, job);
  l.setLimit(1);
  await Promise.all(all);
  assert.ok(peak <= 3);
  peak = 0;
  await Promise.all(Array.from({ length: 6 }, job));
  assert.equal(peak, 1);
  assert.equal(l.state().active, 0);
});

test('limiter releases its slot when the work throws', async () => {
  const l = new Limiter(1);
  await assert.rejects(l.run(async () => { throw new Error('ffmpeg failed'); }));
  assert.equal(await l.run(async () => 'next'), 'next');
});

test('batcher groups lines, flushes at max size, and loses nothing on close', () => {
  const out = [];
  const timers = [];
  const b = new Batcher((items) => out.push(items), { ms: 100, max: 4, setTimer: (f) => { timers.push(f); return timers.length; }, clearTimer: () => {} });
  for (let i = 0; i < 10; i++) b.push(i);
  assert.deepEqual(out, [[0, 1, 2, 3], [4, 5, 6, 7]]);
  b.close();
  assert.deepEqual(out.flat(), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  b.flush(); // nothing left: no empty batch
  assert.equal(out.length, 3);
});

test('coalescer limits updates per second but always delivers the last value', () => {
  let t = 0;
  const sent = [];
  let pending = null;
  const c = new Coalescer((v) => sent.push(v), { hz: 5, now: () => t, setTimer: (f) => { pending = f; return 1; }, clearTimer: () => { pending = null; } });
  for (let i = 1; i <= 50; i++) { t = i * 10; c.push(i); } // 50 ticks in 0.5 s
  assert.ok(sent.length <= 4, `sent ${sent.length}`);
  assert.notEqual(sent[sent.length - 1], 50);
  pending(); // the trailing timer fires
  assert.equal(sent[sent.length - 1], 50);
  c.push(51, { final: true });
  assert.equal(sent[sent.length - 1], 51); // the final tick is never held back
});

test('resource monitor needs a sustained busy period to throttle and a calm one to recover', () => {
  const changes = [];
  const m = new ResourceMonitor({ thresholds: { enterAfter: 3, leaveAfter: 5, loopDelayMs: 200 }, heap: () => ({ used: 1, limit: 100 }), freemem: () => 8e9, loopDelayMs: () => 0, onChange: (c) => changes.push(c.pressure) });
  const calm = { cpuPct: 5, freeMemMB: 8000, heapPct: 10, loopDelayMs: 5 };
  const busy = { ...calm, loopDelayMs: 900 };
  m.tick({ ...busy }); m.tick({ ...busy }); m.tick({ ...calm }); m.tick({ ...busy }); // spikes, not sustained
  assert.equal(m.pressure, false);
  m.tick({ ...busy }); m.tick({ ...busy });
  assert.equal(m.pressure, true);
  for (let i = 0; i < 4; i++) m.tick({ ...calm });
  assert.equal(m.pressure, true); // not yet: needs 5 calm samples
  m.tick({ ...calm });
  assert.equal(m.pressure, false);
  assert.deepEqual(changes, [true, false]);
  assert.deepEqual(m.reasons({ ...calm, freeMemMB: 100 }), ['memory']);
  m.stop();
});

test('under pressure the limits step down to Low and come back after', () => {
  const applied = [];
  const pm = new PerformanceManager({ profile: 'high', apply: (l) => applied.push(l) });
  const high = pm.current;
  pm.setPressure(true, ['cpu']);
  const low = resolveResourceProfile('low');
  assert.equal(pm.current.ffmpeg, Math.min(high.ffmpeg, low.ffmpeg));
  assert.equal(pm.current.uiHz, Math.min(high.uiHz, low.uiHz));
  assert.equal(pm.current.throttled, true);
  pm.setPressure(false);
  assert.equal(pm.current.ffmpeg, high.ffmpeg);
  assert.equal(applied.length, 3);
  pm.setProfile('low');
  assert.equal(pm.current.name, 'low');
});

test('hash pool can shrink and grow while idle and still hashes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fgp-'));
  const files = Array.from({ length: 6 }, (_, i) => { const f = path.join(dir, `${i}.bin`); fs.writeFileSync(f, Buffer.alloc(1000 + i, i)); return f; });
  const pool = new HashPool(4);
  const a = await Promise.all(files.map((f) => pool.hash(f)));
  pool.setSize(1);
  assert.ok(pool.workers.length <= 1);
  const b = await Promise.all(files.map((f) => pool.hash(f)));
  assert.deepEqual(a, b);
  await pool.close();
});

test('the upload cache does not keep files of albums that were posted', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fgc-'));
  for (let i = 0; i < 25; i++) { const p = path.join(root, 'Set', `${String(i).padStart(2, '0')}.jpg`); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.alloc(100 + i, i)); }
  const plan = buildPlan(await scanFolder(root));
  const peaks = [];
  const t = {
    topics: [[1, 'General']],
    async listTopics() { return this.topics.map(([id, title]) => ({ id, title })); },
    async createTopic(_c, title) { this.topics.push([100 + this.topics.length, title]); return 100 + this.topics.length - 1; },
    async sendText() {},
    async sendAlbum(_c, files, _cap, _topic, _o, onProgress, ctl) {
      for (const f of files) ctl.mediaCache.set(`${f.path}|${f.size}|${f.mtime}|photo|orig`, Promise.resolve({}));
      peaks.push(ctl.mediaCache.size);
      onProgress(1);
      return { ok: true, messageIds: files.map((_, i) => i + 1) };
    },
  };
  const history = new UploadHistory(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fgh-')), 'h.json'));
  const job = new UploadJob(t, { id: '-100', title: 'G', isForum: true }, plan, { delayMs: 0, concurrency: { adaptive: false } }, {}, history);
  await job.run();
  assert.equal(job.stats.failed, 0);
  assert.ok(peaks.length >= 3);
  assert.ok(Math.max(...peaks) <= 10, `cache peaked at ${Math.max(...peaks)} entries`); // one album's worth, not the whole job
  assert.equal(job.uploadedMedia.size, 0);
});

test('ledger full check and backup run on a worker thread and produce a usable copy', async () => {
  const { Ledger } = require('../src/core/ledger');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fgl-'));
  const l = Ledger.open(dir);
  if (!l.available) return; // SQLite missing in this runtime: covered by the NullLedger tests
  l.addFilesBatch(Array.from({ length: 2000 }, (_, i) => ({ path: `/d/${i}.jpg`, name: `${i}.jpg`, size: i, mtime: 1, uploadedAt: 1, chatId: '-1', topicId: 5, messageId: i + 1, albumKey: 'a', jobId: 'j', state: 'VERIFIED_SENT' })));
  const bdir = path.join(dir, 'backups', 'integrity');
  for (let k = 0; k < 9; k++) await l.maintain({ backupDir: bdir, keep: 7, now: new Date(Date.UTC(2026, 0, 1 + k)) });
  const r = await l.maintain({ backupDir: bdir, keep: 7, now: new Date(Date.UTC(2026, 0, 20)) });
  assert.equal(r.check, 'ok');
  assert.equal(r.thread, 'worker');
  assert.equal(fs.readdirSync(bdir).length, 7);
  l.close();
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(r.backup, { readOnly: true });
  assert.equal(Object.values(db.prepare('SELECT COUNT(*) FROM uploaded_files').get())[0], 2000);
  db.close();
});

test('ledger keyset pages over a whole chat use the chat index (no full sort per page)', () => {
  const { Ledger } = require('../src/core/ledger');
  const l = Ledger.open(fs.mkdtempSync(path.join(os.tmpdir(), 'fgl-')));
  if (!l.available) return;
  const plan = (q) => l.db.prepare(`EXPLAIN QUERY PLAN ${q}`).all('-1', 0, 10).map((r) => r.detail).join(' | ');
  assert.match(plan('SELECT id, message_id, topic_id FROM uploaded_files WHERE chat_id = ? AND message_id IS NOT NULL AND id > ? ORDER BY id LIMIT ?'), /USING INDEX uploaded_files_chat/);
  assert.doesNotMatch(plan('SELECT * FROM uploaded_files WHERE chat_id = ? AND id > ? ORDER BY id LIMIT ?'), /TEMP B-TREE/);
  l.close();
});
