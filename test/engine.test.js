'use strict';

// FolderGram 4.0 upload engine: live progress numbers, uploading the next album while one is posted, the
// throughput explorer of the "Maximum" preset, and the upload speed limit.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Api } = require('telegram');
const { ProgressTracker, RollingRate } = require('../src/core/progress');
const { AdaptiveConcurrency } = require('../src/core/concurrency');
const { RateLimiter } = require('../src/core/fastupload');
const { Telegram } = require('../src/core/telegram');
const { UploadJob } = require('../src/core/uploader');
const { UploadHistory } = require('../src/core/history');
const { scanFolder } = require('../src/core/scanner');
const { buildPlan } = require('../src/core/planner');

const MB = 1024 * 1024;
const tmp = (p = 'fge-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const clock = (start = 1_000_000) => { let t = start; const now = () => t; now.add = (ms) => { t += ms; }; return now; };

// ---------------------------------------------------------------- rolling speed

test('rolling speed follows the last seconds and drops to 0 when transfers stop', () => {
  const now = clock();
  const r = new RollingRate(5000, now);
  let total = 0;
  for (let i = 0; i < 10; i++) { total += MB; now.add(1000); r.add(total); } // 1 MB/s for 10 s
  assert.ok(Math.abs(r.rate() - MB) < MB * 0.05, `${r.rate()}`);
  for (let i = 0; i < 5; i++) { total += 4 * MB; now.add(1000); r.add(total); } // then 4 MB/s
  assert.ok(Math.abs(r.rate() - 4 * MB) < MB * 0.3, `${r.rate()}`);
  now.add(6000);
  assert.equal(r.rate(), 0);
  assert.equal(r.idleMs(), 6000);
});

// ---------------------------------------------------------------- the progress tracker

function tracker() {
  const now = clock();
  const p = new ProgressTracker({ now, stallMs: 15000 });
  p.setAlbums([
    { key: 'A', title: 'Rem', topic: 'T', files: [{ path: '/a1', name: 'a1.jpg', size: 10 * MB }, { path: '/a2', name: 'a2.jpg', size: 10 * MB }] },
    { key: 'B', title: 'Ram', topic: 'T', files: [{ path: '/b1', name: 'b1.mp4', size: 80 * MB }] },
  ]);
  p.setStatus('uploading');
  return { p, now };
}

test('progress: confirmed bytes never go back or past 100%, retries count only as network bytes', () => {
  const { p, now } = tracker();
  now.add(1000); p.fileProgress('/a1', 0.5);
  now.add(1000); p.fileProgress('/a1', 1);
  now.add(1000); p.fileProgress('/a2', 0.6);
  now.add(1000); p.fileProgress('/a2', 0.2); // Telegram lost it: uploaded again from the start
  now.add(1000); p.fileProgress('/a2', 1.4); // bad input is clamped
  let s = p.snapshot();
  assert.equal(s.bytes.uploaded, 20 * MB);
  assert.equal(s.bytes.network, Math.round(10 * MB + 6 * MB + 2 * MB + 8 * MB));
  assert.ok(s.percent <= 100);
  assert.equal(s.files.done, 0, 'uploaded is not delivered');
  p.delivered('A');
  s = p.snapshot();
  assert.equal(s.files.done, 2);
  assert.equal(s.files.remaining, 1);
  assert.equal(s.albums.find((a) => a.key === 'A').status, 'done');
  assert.equal(s.albums.find((a) => a.key === 'A').delivered, 2);
  assert.ok(Math.abs(s.percent - 20) < 0.01);
});

test('progress: per-file speed, time left, active files and albums', () => {
  const { p, now } = tracker();
  p.albumStatus('B', 'uploading');
  for (let i = 1; i <= 8; i++) { now.add(1000); p.fileProgress('/b1', i / 10); } // 8 MB/s
  const s = p.snapshot();
  const f = s.activeFiles.find((x) => x.path === '/b1');
  assert.equal(f.status, 'uploading');
  assert.equal(f.album, 'Ram');
  assert.ok(Math.abs(f.percent - 80) < 0.01);
  assert.ok(Math.abs(f.speed - 8 * MB) < MB, `${f.speed}`);
  assert.ok(f.eta > 1.5 && f.eta < 3.5, `file eta ${f.eta}`);
  assert.ok(Math.abs(s.speed - 8 * MB) < MB);
  // 100 MB in all, 64 done at 8 MB/s: about 4.5 s left.
  assert.ok(s.eta > 3 && s.eta < 7, `eta ${s.eta}`);
  const b = s.albums.find((a) => a.key === 'B');
  assert.equal(b.current, 'b1.mp4');
});

test('progress: a stall shows no time left instead of a stale one; waits and pauses do not count as upload time', () => {
  const { p, now } = tracker();
  for (let i = 1; i <= 5; i++) { now.add(1000); p.fileProgress('/b1', i / 20); }
  assert.ok(p.snapshot().eta > 0);
  now.add(20000);
  const s = p.snapshot();
  assert.equal(s.eta, null);
  assert.equal(s.stalled, true);
  assert.equal(s.speed, 0);
  const active = p.activeTime();
  p.setStatus('waiting', 'flood', 30);
  now.add(30000);
  assert.equal(p.activeTime(), active);
  assert.equal(p.snapshot().waitSeconds, 0);
  p.setStatus('waiting', 'flood', 10);
  assert.equal(p.snapshot().waitSeconds, 10);
  // Right after a loss of connection the last seconds were fast, but nothing is moving: no speed, no promise.
  p.setStatus('uploading');
  for (let i = 6; i <= 8; i++) { now.add(1000); p.fileProgress('/b1', i / 20); }
  assert.ok(p.snapshot().speed > 0 && p.snapshot().eta > 0);
  p.setStatus('offline', 'offline', 4);
  assert.equal(p.snapshot().speed, 0);
  assert.equal(p.snapshot().eta, null);
});

test('progress: failed and reviewed files leave the total; album progress spreads over files', () => {
  const { p } = tracker();
  p.albumProgress('A', 0.75); // a1 full, a2 half
  assert.equal(p.files.get('/a1').logical, 10 * MB);
  assert.equal(p.files.get('/a2').logical, 5 * MB);
  p.failed(['/b1'], { key: 'B', error: 'boom' });
  const s = p.snapshot();
  assert.equal(s.bytes.total, 20 * MB);
  assert.equal(s.files.failed, 1);
  assert.equal(s.albums.find((a) => a.key === 'B').status, 'failed');
});

// ---------------------------------------------------------------- pipelining with the real Telegram code

function jpgTree(folders) {
  const root = path.join(tmp(), 'Pics');
  for (const [name, n] of Object.entries(folders)) {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    for (let i = 0; i < n; i++) fs.writeFileSync(path.join(root, name, `${name}_${String(i).padStart(3, '0')}.jpg`), Buffer.concat([Buffer.from('ffd8ffe0', 'hex'), Buffer.alloc(2000, i)]));
  }
  return root;
}

/** The real Telegram class over a stand-in connection: uploads take `uploadMs`, sends take `sendMs`; all logged. */
function timedTelegram({ uploadMs = 30, sendMs = 80 } = {}) {
  const t = new Telegram({ store: { load: () => null, save() {}, remove() {} }, shrinkPhoto: async () => null });
  t.storePauseMs = 1;
  const events = [];
  let id = 1n;
  const t0 = Date.now();
  const at = () => Date.now() - t0;
  t.uploadFast = async (file, size, onFrac) => {
    events.push({ type: 'up', name: file.name, start: at() });
    await new Promise((r) => setTimeout(r, uploadMs / 2));
    onFrac(0.5);
    await new Promise((r) => setTimeout(r, uploadMs / 2));
    onFrac(1);
    events.push({ type: 'upDone', name: file.name, at: at() });
    return new Api.InputFile({ id: id++, parts: 1, name: file.name, md5Checksum: '' });
  };
  let msg = 100;
  t.client = {
    invoke: async (req) => {
      if (req instanceof Api.messages.UploadMedia) {
        return new Api.MessageMediaPhoto({ photo: new Api.Photo({ id: id++, accessHash: 1n, fileReference: Buffer.alloc(0), date: 0, sizes: [], dcId: 1 }) });
      }
      if (req instanceof Api.messages.SendMultiMedia || req instanceof Api.messages.SendMedia) {
        const n = req.multiMedia ? req.multiMedia.length : 1;
        const start = at();
        await new Promise((r) => setTimeout(r, sendMs));
        events.push({ type: 'send', n, start, end: at() });
        return new Api.Updates({ updates: Array.from({ length: n }, () => new Api.UpdateMessageID({ id: ++msg, randomId: 1n })), users: [], chats: [], date: 0, seq: 0 });
      }
      return true; // connection checks and the like
    },
  };
  t.entities.set('-100', new Api.InputPeerChannel({ channelId: 1n, accessHash: 1n }));
  return { t, events };
}

async function runPipeline(pipeline) {
  const root = jpgTree({ Rem: 10, Ram: 10, Emilia: 10 });
  const plan = buildPlan(await scanFolder(root), { captionWhere: 'last' });
  const { t, events } = timedTelegram();
  const h = new UploadHistory(path.join(tmp(), 'uploaded.json'));
  const snaps = [];
  const j = new UploadJob(t, { id: '-100', title: 'G', isForum: false }, plan, { mode: 'none', delayMs: 50, retryBaseMs: 1, pipeline, concurrency: { adaptive: false } },
    { progress: (p) => { if (p.snapshot) snaps.push(p.snapshot()); } }, h);
  const started = Date.now();
  await j.run();
  return { j, events, ms: Date.now() - started, snaps };
}

test('pipelining: the next album uploads while the current one is posted; every file is uploaded once', async () => {
  const { j, events, snaps } = await runPipeline(true);
  assert.equal(j.stats.sent, 30);
  assert.equal(j.stats.failed, 0);
  const ups = events.filter((e) => e.type === 'up');
  assert.equal(ups.length, 30, 'no file uploaded twice');
  assert.equal(new Set(ups.map((e) => e.name)).size, 30);
  const sends = events.filter((e) => e.type === 'send');
  assert.equal(sends.length, 3);
  // Album 2's first upload started before album 1's send finished.
  const firstOf2 = ups.find((e) => e.name.startsWith('Ram_'));
  assert.ok(firstOf2.start < sends[0].end, `album 2 started at ${firstOf2.start}, album 1 posted at ${sends[0].end}`);
  // Posts are still in order: album 2's send starts after album 1's ended.
  assert.ok(sends[1].start >= sends[0].end);
  // The final snapshot: everything delivered, 100%.
  const last = snaps[snaps.length - 1];
  assert.equal(last.files.done, 30);
  assert.equal(Math.round(last.percent), 100);
  assert.ok(snaps.some((s) => s.activeFiles.length > 0));
  // Nothing was retried, so the bytes sent over the network are the files' bytes, not more: a preloaded album's
  // files must not be counted again when the album itself picks them up.
  assert.ok(Math.abs(last.bytes.network - last.bytes.uploaded) <= last.bytes.total * 0.01, `network ${last.bytes.network} vs uploaded ${last.bytes.uploaded}`);
});

test('pipelining can be turned off, and then albums upload strictly one after another', async () => {
  const { events } = await runPipeline(false);
  const ups = events.filter((e) => e.type === 'up');
  const sends = events.filter((e) => e.type === 'send');
  const firstOf2 = ups.find((e) => e.name.startsWith('Ram_'));
  assert.ok(firstOf2.start >= sends[0].end);
});

test('pipelining makes a run of small albums faster (stand-in network, not live Telegram)', async () => {
  const off = await runPipeline(false);
  const on = await runPipeline(true);
  assert.ok(on.ms < off.ms, `pipelined ${on.ms} ms vs ${off.ms} ms`);
});

// ---------------------------------------------------------------- the throughput explorer

test('Maximum preset climbs while more connections help and settles where they stop helping', () => {
  // A line of 12 MB/s where each connection carries at most 2.5 MB/s.
  const speed = (c) => Math.min(12 * MB, 2.5 * MB * c);
  const c = new AdaptiveConcurrency({ preset: 'max' });
  for (let i = 0; i < 30; i++) {
    const n = c.connections;
    c.observe({ bytes: 100 * MB, ms: (100 * MB / speed(n)) * 1000, connections: n });
  }
  assert.equal(c.phase, 'settled');
  // 4 connections give 10 MB/s, 6 give 12 (20% more), 8 give 12 (no gain): settle on 6.
  assert.equal(c.connections, 6);
  assert.ok(c.decisions.some((d) => /not faster/.test(d.why)));
});

test('Maximum preset: a flood wait caps the number of connections; other presets never explore', () => {
  const c = new AdaptiveConcurrency({ preset: 'max' });
  c.connections = 8;
  c.flood(20);
  assert.equal(c.connections, 4);
  assert.ok(c.ceiling < 8);
  for (let i = 0; i < 60; i++) c.observe({ bytes: 100 * MB, ms: 1000, connections: c.connections });
  assert.ok(c.connections < 8);
  const b = new AdaptiveConcurrency({ preset: 'balanced' });
  b.observe({ bytes: 100 * MB, ms: 1000, connections: 4 });
  b.observe({ bytes: 100 * MB, ms: 1000, connections: 4 });
  assert.equal(b.connections, 4);
});

// ---------------------------------------------------------------- speed limit

test('the upload speed limit holds the average rate', async () => {
  const lim = new RateLimiter(2 * MB);
  const started = Date.now();
  for (let i = 0; i < 12; i++) await lim.take(512 * 1024); // 6 MB: 2 MB at once from the full bucket, then 2 s
  const s = (Date.now() - started) / 1000;
  assert.ok(s >= 1.8 && s < 3.5, `${s}s`);
  const off = new RateLimiter(0);
  const t0 = Date.now();
  for (let i = 0; i < 100; i++) await off.take(MB);
  assert.ok(Date.now() - t0 < 50);
});
