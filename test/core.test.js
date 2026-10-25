'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanFolder, buildPlan, fileStem, makeAlbums } = require('../src/core/scanner');
const { UploadJob, UploadHistory, floodSeconds } = require('../src/core/uploader');

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-'));
  const base = path.join(root, 'Cosplay');
  for (const [rel, size] of Object.entries(files)) {
    const p = path.join(base, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.alloc(size, size % 251)); // same size = same content
  }
  return base;
}

const sample = () => {
  const files = {
    'a1.jpg': 10, 'a10.jpg': 11, 'a2.jpg': 12, 'notes.txt': 5, 'clip.mp4': 30,
    'Rem/Set 1/Rem 01.jpg': 10, 'Rem/Set 1/Rem 02.jpg': 11, 'Rem/Set 1/anim.gif': 10,
    'Rem/Set 2/Emilia (1).jpg': 13, 'Rem/Set 2/Emilia (2).jpg': 14, 'Rem/Set 2/Rem_03.jpg': 15,
    'Rem/cover.png': 16, 'Ram/song.mp3': 17, '.hidden/x.jpg': 10, 'Ram/zero.jpg': 0,
  };
  for (let i = 0; i < 12; i++) files[`Big/img${i}.jpg`] = 20 + i;
  return tree(files);
};

test('fileStem drops numbering', () => {
  assert.equal(fileStem('Rem cosplay 01.jpg'), 'Rem cosplay');
  assert.equal(fileStem('Rem cosplay (2).jpg'), 'Rem cosplay');
  assert.equal(fileStem('Rem_cosplay_p03.mp4'), 'Rem_cosplay');
  assert.equal(fileStem('CatDemon cosplay Rem - ReZero - 12.jpg'), 'CatDemon cosplay Rem - ReZero');
  assert.equal(fileStem('0001.jpg'), '');
  assert.equal(fileStem('IMG_2034.JPG'), '');
});

test('scan groups by folder, natural order, skips hidden/empty', () => {
  const root = sample();
  const g = scanFolder(root);
  assert.deepEqual(g.map((x) => x.path), ['Cosplay', 'Big', 'Ram', 'Rem', 'Rem / Set 1', 'Rem / Set 2']);
  assert.deepEqual(g[0].files.map((f) => f.name), ['a1.jpg', 'a2.jpg', 'a10.jpg', 'clip.mp4']);
  assert.equal(g[4].top, 'Rem');
  assert.equal(g[4].leaf, 'Set 1');
  assert.deepEqual(scanFolder(root, { recursive: false }).map((x) => x.path), ['Cosplay']);
  const noVideo = scanFolder(root, { types: { photo: true, video: false, audio: true, other: true } });
  assert.ok(!noVideo[0].files.some((f) => f.ext === '.mp4'));
});

test('topics come from the top parent folder by default', () => {
  const plan = buildPlan(scanFolder(sample()));
  assert.deepEqual(plan.map((e) => e.topicName), ['Cosplay', 'Big', 'Ram', 'Rem', 'Rem', 'Rem']);
  // Folder-name caption under the last album of each folder, using the subfolder's own name.
  const set1 = plan[4];
  assert.deepEqual(set1.albums.map((a) => a.caption), ['', 'Set 1']); // photos album, then the gif
  const each = buildPlan(scanFolder(sample()), { topicBy: 'each' });
  assert.deepEqual(each.map((e) => e.topicName).slice(3), ['Rem', 'Rem / Set 1', 'Rem / Set 2']);
});

test('caption by file name groups files sharing a name', () => {
  const plan = buildPlan(scanFolder(sample()), { captionBy: 'filename', captionWhere: 'every' });
  const set2 = plan.find((e) => e.folder.path === 'Rem / Set 2');
  assert.deepEqual(set2.albums.map((a) => [a.files.map((f) => f.name), a.caption]), [
    [['Emilia (1).jpg', 'Emilia (2).jpg'], 'Emilia'],
    [['Rem_03.jpg'], 'Rem'],
  ]);
  const big = buildPlan(scanFolder(sample()), { captionBy: 'filename', captionWhere: 'last' }).find((e) => e.folder.path === 'Big');
  assert.deepEqual(big.albums.map((a) => [a.files.length, a.caption]), [[10, ''], [2, 'Big']]);
});

test('albums: 10 per album, gif alone, documents when forced', () => {
  const big = scanFolder(sample()).find((g) => g.path === 'Big');
  assert.deepEqual(makeAlbums(big.files).map((a) => a.length), [10, 2]);
  assert.deepEqual(makeAlbums(big.files, { useAlbums: false }).map((a) => a.length), Array(12).fill(1));
});

class FakeTransport {
  constructor(topics = []) { this.topics = [...topics]; this.sent = []; this.next = 100; this.failOnce = false; }
  async listTopics() { return this.topics.map(([id, title]) => ({ id, title })); }
  async createTopic(_c, title) { this.topics.push([++this.next, title]); return this.next; }
  async sendText(_c, text, topicId) { this.sent.push({ text, topicId }); }
  async sendAlbum(_c, files, caption, topicId, _o, onProgress) {
    if (this.failOnce) { this.failOnce = false; const e = new Error('FLOOD_WAIT_0'); e.errorMessage = 'FLOOD_WAIT_0'; e.seconds = 0; throw e; }
    onProgress(1);
    this.sent.push({ files: files.map((f) => f.name), caption, topicId });
  }
}

const tmpHistory = () => new UploadHistory(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fgh-')), 'h.json'));
const chat = { id: '-100', title: 'G', isForum: true };
const run = async (t, plan, opts, history = tmpHistory()) => {
  const job = new UploadJob(t, chat, plan, { delayMs: 0, ...opts }, {}, history);
  await job.run();
  return job;
};

test('per-folder upload creates topics once and reuses existing ones', async () => {
  const plan = buildPlan(scanFolder(sample()));
  const t = new FakeTransport([[1, 'General'], [50, 'rem']]);
  t.failOnce = true; // flood wait is retried
  const history = tmpHistory();
  const job = await run(t, plan, {}, history);
  assert.equal(job.stats.failed, 0);
  assert.deepEqual(t.topics.map((x) => x[1]), ['General', 'rem', 'Cosplay', 'Big', 'Ram']);
  assert.ok(t.sent.filter((s) => s.topicId === 50).length >= 4); // all Rem subfolders in the existing topic
  assert.ok(!t.sent.some((s) => s.text)); // no header messages in topic mode

  const t2 = new FakeTransport(t.topics);
  const again = await run(t2, plan, {}, history);
  assert.equal(again.stats.sent, 0);
  assert.equal(t2.sent.length, 0);
});

test('single topic with headers; duplicates skipped by content', async () => {
  const root = tree({ 'A/x.jpg': 50, 'B/copy of x.jpg': 50, 'B/y.jpg': 60 });
  const plan = buildPlan(scanFolder(root));
  const t = new FakeTransport();
  const job = await run(t, plan, { mode: 'single', topicId: 7, headerMessage: true, skipDuplicates: true });
  assert.deepEqual(t.sent.filter((s) => s.text).map((s) => s.text), ['📁 A', '📁 B']);
  assert.ok(t.sent.every((s) => s.topicId === 7));
  assert.equal(job.stats.duplicates, 1);
  assert.deepEqual(t.sent.filter((s) => s.files).map((s) => [s.files, s.caption]), [[['x.jpg'], 'A'], [['y.jpg'], 'B']]);
});

test('pause waits, cancel stops', async () => {
  const plan = buildPlan(scanFolder(sample()));
  const t = new FakeTransport();
  const job = new UploadJob(t, chat, plan, { mode: 'none', delayMs: 0 }, {}, tmpHistory());
  job.pause();
  const p = job.run();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(t.sent.length, 0);
  job.cancel();
  await p;
  assert.equal(t.sent.length, 0);
});

test('too-big files are skipped and flood errors parsed', async () => {
  const root = tree({ 'big.mp4': 3 * 1024 * 1024, 'ok.jpg': 10 });
  const t = new FakeTransport();
  const job = await run(t, buildPlan(scanFolder(root)), { mode: 'none', maxFileMb: 2 });
  assert.equal(job.stats.skipped, 1);
  assert.deepEqual(t.sent.map((s) => s.files), [['ok.jpg']]);
  assert.equal(t.sent[0].caption, 'Cosplay'); // caption moves to the last album that is still sent
  assert.equal(floodSeconds({ errorMessage: 'FLOOD_WAIT_42' }), 42);
});
