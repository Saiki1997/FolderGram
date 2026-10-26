'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanFolder, scanSources, buildPlan, fileStem, makeAlbums } = require('../src/core/scanner');
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

test('fileStem: what counts as the same name', async () => {
  // Default "series": only Windows-style (N) numbering is ignored.
  assert.equal(fileStem('Marin Kitagawa.mp4'), 'Marin Kitagawa');
  assert.equal(fileStem('Marin Kitagawa 2.mp4'), 'Marin Kitagawa 2');
  assert.equal(fileStem('Marin Kitagawa-copy.mp4'), 'Marin Kitagawa-copy');
  assert.equal(fileStem('AikoUwU cosplay Elaina - Majo No Tabitabi (11).jpg'), 'AikoUwU cosplay Elaina - Majo No Tabitabi');
  assert.equal(fileStem('Rem (2).jpg', 'exact'), 'Rem (2)');
  assert.equal(fileStem('Rem cosplay 01.jpg', 'loose'), 'Rem cosplay');
  assert.equal(fileStem('Rem_cosplay_p03.mp4', 'loose'), 'Rem_cosplay');
  assert.equal(fileStem('Marin Kitagawa-copy.mp4', 'loose'), 'Marin Kitagawa');
  assert.equal(fileStem('0001.jpg'), '');
  assert.equal(fileStem('IMG_2034.JPG'), '');
  assert.equal(fileStem('IMG_2034.JPG', 'exact'), '');
});

test('file name albums: the name setting applies to videos, photo sets always group', async () => {
  const root = tree({ 'Marin/Marin Kitagawa.mp4': 10, 'Marin/Marin Kitagawa 2.mp4': 11, 'Marin/Marin Kitagawa-copy.mp4': 12,
    'Marin/Marin (2).mp4': 15, 'Marin/Marin (3).mp4': 16,
    'Marin/Elaina 01.jpg': 13, 'Marin/Elaina 02.jpg': 14, 'Marin/Elaina (3).jpg': 17 });
  const groups = await scanFolder(root);
  const albums = (opts) => new Map(buildPlan(groups, { captionBy: 'filename', captionWhere: 'every', ...opts })[0].albums.map((a) => [a.caption, a.files.length]));
  assert.deepEqual(albums({}), new Map([['Elaina', 3], ['Marin', 2], ['Marin Kitagawa', 1], ['Marin Kitagawa 2', 1], ['Marin Kitagawa-copy', 1]]));
  assert.deepEqual(albums({ nameMatch: 'exact' }), new Map([['Elaina', 3], ['Marin (2)', 1], ['Marin (3)', 1], ['Marin Kitagawa', 1], ['Marin Kitagawa 2', 1], ['Marin Kitagawa-copy', 1]]));
  assert.deepEqual(albums({ nameMatch: 'loose' }), new Map([['Elaina', 3], ['Marin', 2], ['Marin Kitagawa', 3]]));
});

test('scan groups by folder, natural order, skips hidden/empty', async () => {
  const root = sample();
  const g = await scanFolder(root);
  assert.deepEqual(g.map((x) => x.path), ['Cosplay', 'Big', 'Ram', 'Rem', 'Rem / Set 1', 'Rem / Set 2']);
  assert.deepEqual(g[0].files.map((f) => f.name), ['a1.jpg', 'a2.jpg', 'a10.jpg', 'clip.mp4']);
  assert.equal(g[4].top, 'Rem');
  assert.equal(g[4].leaf, 'Set 1');
  assert.deepEqual((await scanFolder(root, { recursive: false })).map((x) => x.path), ['Cosplay']);
  const noVideo = await scanFolder(root, { types: { photo: true, video: false, audio: true, other: true } });
  assert.ok(!noVideo[0].files.some((f) => f.ext === '.mp4'));
});

test('topics come from the top parent folder by default', async () => {
  const plan = buildPlan(await scanFolder(sample()));
  assert.deepEqual(plan.map((e) => e.topicName), ['Cosplay', 'Big', 'Ram', 'Rem', 'Rem', 'Rem']);
  // Folder-name caption under the last album of each folder, using the subfolder's own name.
  const set1 = plan[4];
  assert.deepEqual(set1.albums.map((a) => a.caption), ['', 'Set 1']); // photos album, then the gif
  const each = buildPlan(await scanFolder(sample()), { topicBy: 'each' });
  assert.deepEqual(each.map((e) => e.topicName).slice(3), ['Rem', 'Rem / Set 1', 'Rem / Set 2']);
});

test('caption by file name groups files sharing a name', async () => {
  const plan = buildPlan(await scanFolder(sample()), { captionBy: 'filename', captionWhere: 'every', nameMatch: 'loose' });
  const set2 = plan.find((e) => e.folder.path === 'Rem / Set 2');
  assert.deepEqual(set2.albums.map((a) => [a.files.map((f) => f.name), a.caption]), [
    [['Emilia (1).jpg', 'Emilia (2).jpg'], 'Emilia'],
    [['Rem_03.jpg'], 'Rem'],
  ]);
  const big = buildPlan(await scanFolder(sample()), { captionBy: 'filename', captionWhere: 'last', nameMatch: 'loose' }).find((e) => e.folder.path === 'Big');
  assert.deepEqual(big.albums.map((a) => [a.files.length, a.caption]), [[10, ''], [2, 'Big']]);
});

test('albums: 10 per album, gif alone, documents when forced', async () => {
  const big = (await scanFolder(sample())).find((g) => g.path === 'Big');
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
  const job = new UploadJob(t, chat, plan, { delayMs: 0, concurrency: { adaptive: false }, ...opts }, {}, history);
  await job.run();
  return job;
};

test('per-folder upload creates topics once and reuses existing ones', async () => {
  const plan = buildPlan(await scanFolder(sample()));
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
  const plan = buildPlan(await scanFolder(root));
  const t = new FakeTransport();
  const job = await run(t, plan, { mode: 'single', topicId: 7, headerMessage: true, skipDuplicates: true });
  assert.deepEqual(t.sent.filter((s) => s.text).map((s) => s.text), ['📁 A', '📁 B']);
  assert.ok(t.sent.every((s) => s.topicId === 7));
  assert.equal(job.stats.duplicates, 1);
  assert.deepEqual(t.sent.filter((s) => s.files).map((s) => [s.files, s.caption]), [[['x.jpg'], 'A'], [['y.jpg'], 'B']]);
});

test('pause waits, cancel stops', async () => {
  const plan = buildPlan(await scanFolder(sample()));
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
  const job = await run(t, buildPlan(await scanFolder(root)), { mode: 'none', maxFileMb: 2 });
  assert.equal(job.stats.skipped, 1);
  assert.deepEqual(t.sent.map((s) => s.files), [['ok.jpg']]);
  assert.equal(t.sent[0].caption, 'Cosplay'); // caption moves to the last album that is still sent
  assert.equal(floodSeconds({ errorMessage: 'FLOOD_WAIT_42' }), 42);
});

test('loose files are grouped by their folder; folders and files mix', async () => {
  const root = sample();
  const groups = await scanSources([
    path.join(root, 'Rem', 'Set 1', 'Rem 01.jpg'),
    path.join(root, 'Rem', 'Set 1', 'Rem 02.jpg'),
    path.join(root, 'notes.txt'), // not media: ignored
    path.join(root, 'Ram'),
  ]);
  assert.deepEqual(groups.map((g) => [g.top, g.files.map((f) => f.name)]), [
    ['Ram', ['song.mp3']],
    ['Set 1', ['Rem 01.jpg', 'Rem 02.jpg']],
  ]);
});

test('big photos stay photos so they can be resized into the album', async () => {
  const { fileKind } = require('../src/core/scanner');
  assert.equal(fileKind({ ext: '.jpg', size: 13 * 1024 * 1024 }), 'photo');
  assert.equal(fileKind({ ext: '.jpg', size: 13 * 1024 * 1024 }, true), 'document');
});

test('photos over 10 MB are resized and stay in the album; failed resize sends a file', async () => {
  const { Telegram } = require('../src/core/telegram');
  const { Api } = require('telegram');
  const root = tree({ 'big.jpg': 11 * 1024 * 1024, 'small.jpg': 100, 'huge.png': 12 * 1024 * 1024 });
  const files = (await scanFolder(root))[0].files;
  const uploaded = [];
  const sends = [];
  const client = {
    uploadFile: async ({ file }) => { uploaded.push([file.name, file.size, !!file.buffer]); return new Api.InputFile({ id: 1n, parts: 1, name: file.name, md5Checksum: '' }); },
    invoke: async (req) => {
      if (req instanceof Api.messages.UploadMedia) {
        return req.media instanceof Api.InputMediaUploadedPhoto
          ? new Api.MessageMediaPhoto({ photo: new Api.Photo({ id: 1n, accessHash: 1n, fileReference: Buffer.alloc(0), date: 0, sizes: [], dcId: 1 }) })
          : new Api.MessageMediaDocument({ document: new Api.Document({ id: 2n, accessHash: 1n, fileReference: Buffer.alloc(0), date: 0, mimeType: 'x', size: 1n, dcId: 1, attributes: [] }) });
      }
      sends.push(req);
      return {};
    },
  };
  const tg = new Telegram({
    store: { load: () => null, save() {}, remove() {} },
    shrinkPhoto: async (p) => (p.endsWith('png') ? null : { buffer: Buffer.alloc(2 * 1024 * 1024), width: 2560, height: 1440 }),
  });
  tg.client = client;
  tg.entities.set('-100', new Api.InputPeerChannel({ channelId: 1n, accessHash: 1n }));
  await tg.sendAlbum({ id: '-100' }, files, 'Cap', 5, {}, () => {});
  assert.deepEqual(uploaded.sort(), [['big.jpg', 2 * 1024 * 1024, true], ['huge.png', 12 * 1024 * 1024, false], ['small.jpg', 100, false]]);
  // Photos go together; the png that couldn't be resized goes after them as a file, with the caption.
  const [photos, file] = sends;
  assert.ok(photos instanceof Api.messages.SendMultiMedia);
  assert.deepEqual(photos.multiMedia.map((m) => [m.media.className, m.message]), [['InputMediaPhoto', ''], ['InputMediaPhoto', '']]);
  assert.ok(file instanceof Api.messages.SendMedia);
  assert.equal(file.message, 'Cap');
  const sent = file;
  assert.equal(sent.replyTo.replyToMsgId, 5);
});

test('videos over the limit are split into parts and sent in order, caption on the last album', async () => {
  const root = tree({ 'Movie/long.mp4': 3000, 'Movie/short.mp4': 100, 'Movie/pic.jpg': 50 });
  const plan = buildPlan(await scanFolder(root), { captionWhere: 'every' });
  const t = new FakeTransport();
  let cleaned = 0;
  const splitVideo = async (f, limit) => {
    assert.ok(f.size > limit);
    const parts = Array.from({ length: 11 }, (_, i) => ({ ...f, name: `long (part ${i + 1} of 11).mp4`, size: 300 }));
    return { parts, cleanup: async () => { cleaned++; } };
  };
  const job = new UploadJob(t, chat, plan, { mode: 'none', delayMs: 0, maxFileMb: 1000 / (1024 * 1024), splitVideos: true, splitVideo }, {}, tmpHistory());
  await job.run();
  assert.equal(job.stats.failed, 0);
  assert.equal(job.stats.sent, 3);
  assert.equal(cleaned, 1);
  // 13 items (11 parts, pic, short) in folder order → albums of 10 and 3; caption only on the last.
  assert.deepEqual(t.sent.map((s) => [s.files.length, s.caption]), [[10, ''], [3, 'Movie']]);
  assert.equal(t.sent[0].files[0], 'long (part 1 of 11).mp4');

  const t2 = new FakeTransport();
  const job2 = new UploadJob(t2, chat, plan, { mode: 'none', delayMs: 0, maxFileMb: 1000 / (1024 * 1024), splitVideos: false, splitVideo }, {}, tmpHistory());
  await job2.run();
  assert.equal(job2.stats.skipped, 1);
});

test('splitter cuts a real video into playable parts under the limit', async (t) => {
  const { splitVideo, ffmpegPath } = require('../src/core/splitter');
  const ff = ffmpegPath();
  if (!ff || !fs.existsSync(ff)) return t.skip('ffmpeg not installed');
  const { spawnSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fgv-'));
  const src = path.join(dir, 'clip.mp4');
  spawnSync(ff, ['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine', '-t', '30', '-c:v', 'libx264',
    '-g', '25', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', src]);
  const st = fs.statSync(src);
  const limit = Math.ceil(st.size / 3);
  const { parts, cleanup } = await splitVideo({ path: src, name: 'clip.mp4', ext: '.mp4', size: st.size, mtime: 1 }, limit, { tmpRoot: dir });
  assert.ok(parts.length >= 3);
  assert.ok(parts.every((p) => p.size <= limit && fs.existsSync(p.path)));
  assert.equal(parts[0].name, `clip (part 1 of ${parts.length}).mp4`);
  await cleanup();
  assert.ok(!fs.existsSync(parts[0].path));
});

test('random folder names can become Album 1, Album 2…', async () => {
  const { isGibberish } = require('../src/core/scanner');
  for (const n of ['2Zy6lA (GoFile)', '8V9q2D (GoFile)', 'bti08i (GoFile)', 'cfLHwd (GoFile)', 'F3hKsb (GoFile)', 'fEQHwf (GoFile)',
    'kb03wM (GoFile)', 'kVNZAi (GoFile)', 'wXKrJ9 (GoFile)', 'Wy4dQa (GoFile)', 'xkqztr']) assert.ok(isGibberish(n), n);
  for (const n of ['Loose Files (GoFile)', 'Loose Files (GoonBox)', 'Rem', 'ReZero', 'Emilia', 'Set 1', 'Vol2', 'NASA', '2024',
    'CatDemon Rem - ReZero', 'Cosplay', 'Marin']) assert.ok(!isGibberish(n), n);

  const root = tree({ 'kb03wM (GoFile)/a.jpg': 10, 'kb03wM (GoFile)/Sub/b.jpg': 11, 'Wy4dQa (GoFile)/c.jpg': 12, 'Loose Files (GoFile)/d.jpg': 13 });
  const groups = await scanFolder(root);
  const plan = buildPlan(groups, { renameGibberish: true });
  assert.deepEqual(plan.map((e) => [e.topicName, e.albums[0].caption]),
    [['Album 1', 'Album 1'], ['Album 1', 'Sub'], ['Loose Files (GoFile)', 'Loose Files (GoFile)'], ['Album 2', 'Album 2']]);
  const each = buildPlan(groups, { renameGibberish: true, topicBy: 'each', albumPrefix: 'Set' });
  assert.deepEqual(each.map((e) => e.topicName), ['Set 1', 'Set 1 / Sub', 'Loose Files (GoFile)', 'Set 2']);
  assert.equal(buildPlan(groups)[0].topicName, 'kb03wM (GoFile)'); // off by default
});
