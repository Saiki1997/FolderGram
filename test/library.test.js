'use strict';

// FolderGram 4.0 Phase 4: the Telegram library (albums page by page, comparisons and checks), downloads with
// resume and overwrite policies, and folder sync (changes, renames, two-way lists, loop prevention).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('../src/core/library');
const { DownloadJob, DownloadManifest, safeName } = require('../src/core/downloader');
const S = require('../src/core/sync');
const { scanSources } = require('../src/core/scanner');
const { buildPlan } = require('../src/core/planner');

const tmp = (p = 'fgl-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const msg = (id, extra = {}) => ({ id, date: 1700000000 + id, groupedId: null, caption: '', kind: 'photo', size: 100, ...extra });

// ---------------------------------------------------------------- library

test('albums: messages group by album even when a page ends in the middle of one', () => {
  // Newest first, as Telegram sends them: album g2 (ids 9..7) is cut by the page end after id 8.
  const page1 = [msg(12), msg(11, { groupedId: 'g1', caption: 'B' }), msg(10, { groupedId: 'g1' }), msg(9, { groupedId: 'g2', caption: 'A' }), msg(8, { groupedId: 'g2' })];
  const page2 = [msg(7, { groupedId: 'g2' }), msg(6)];
  const p = new L.AlbumPager();
  const first = p.add(page1);
  assert.deepStrictEqual(first.map((a) => a.ids), [[12], [10, 11]]);
  const second = p.add(page2, true);
  assert.deepStrictEqual(second.map((a) => a.ids), [[7, 8, 9], [6]]);
  assert.equal(second[0].caption, 'A');
  assert.equal(second[0].count, 3);
});

test('compare: local albums against Telegram by title; sets split over several albums count together', () => {
  const tg = L.groupAlbums([
    // "Rem - Set 01" was sent as 10 + 2 with the caption on the last album (ids ascending = sent order).
    ...Array.from({ length: 10 }, (_, i) => msg(100 + i, { groupedId: 'a' })), msg(110, { groupedId: 'b', caption: 'Rem - Set 01' }), msg(111, { groupedId: 'b' }),
    msg(120, { groupedId: 'c', caption: 'Rem - Set 02 — Part 1 of 1' }), msg(121, { groupedId: 'c' }),
    msg(130, { caption: 'Only on Telegram' }),
  ]);
  const r = L.compareCollections([{ name: 'Rem - Set 01', count: 12 }, { name: 'rem - set 02', count: 3 }, { name: 'Only here', count: 4 }], tg);
  assert.deepStrictEqual(r.both, [{ title: 'Rem - Set 01', local: 12, telegram: 12, differs: false }, { title: 'rem - set 02', local: 3, telegram: 2, differs: true }]);
  assert.deepStrictEqual(r.onlyLocal, [{ title: 'Only here', local: 4 }]);
  assert.deepStrictEqual(r.onlyTelegram, [{ title: 'Only on Telegram', telegram: 1 }]);
});

test('checks: duplicate topics, albums in the wrong topic, albums that lost messages', () => {
  const topics = [{ id: 1, title: 'General' }, { id: 5, title: 'Marin Kitagawa' }, { id: 6, title: 'marin  kitagawa' }, { id: 7, title: 'Rem' }];
  assert.deepStrictEqual(L.duplicateTopics(topics).map((g) => g.map((t) => t.id)), [[5, 6]]);
  const albums = new Map([[5, L.groupAlbums([msg(1, { caption: 'Rem - Set 02' }), msg(2, { caption: 'Marin Kitagawa - Set 01' })])], [7, L.groupAlbums([msg(3, { caption: 'Rem - Set 01' })])]]);
  const mis = L.misplacedAlbums(topics, albums);
  assert.equal(mis.length, 1);
  assert.equal(mis[0].album.caption, 'Rem - Set 02');
  assert.deepStrictEqual(mis[0].suggested, { id: 7, title: 'Rem' });
  const inc = L.incompleteAlbums([{ topic: 'Rem', caption: 'x', files: ['a', 'b'], messageIds: [10, 11] }, { topic: 'Rem', caption: 'y', files: ['c'], messageIds: [12] }], new Set([10, 12]));
  assert.deepStrictEqual(inc.map((a) => a.missing), [[11]]);
});

// ---------------------------------------------------------------- downloads

/** A stand-in transport with files held in memory; can fail once after n chunks to test resuming. */
function fakeFiles(files, { failAfterChunks = null } = {}) {
  let chunks = 0;
  return {
    calls: [],
    async downloadMessageFile(chat, id, { offset = 0, onChunk, isCanceled }) {
      this.calls.push({ id, offset });
      const buf = files[id];
      for (let pos = offset; ; pos += 512 * 1024) {
        if (isCanceled()) throw Object.assign(new Error('USER_CANCELED'), { errorMessage: 'USER_CANCELED' });
        if (failAfterChunks != null && chunks++ === failAfterChunks) { failAfterChunks = null; throw Object.assign(new Error('Not connected'), { errorMessage: 'Not connected' }); }
        const part = buf.subarray(pos, pos + 512 * 1024);
        if (part.length) await onChunk(part);
        if (part.length < 512 * 1024) return;
      }
    },
  };
}
const bytes = (n, seed) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255));
const chat = { id: '-1001', title: 'My: Group?' };

test('downloads: topic/album/file layout, safe names, verified, and the manifest skips them next time', async () => {
  const dest = tmp();
  const files = { 1: bytes(1300 * 1024, 1), 2: bytes(1000, 2) };
  const items = [{ msgId: 1, fileName: 'clip.mp4', size: files[1].length, topic: 'Rem', album: 'Set 01' }, { msgId: 2, fileName: 'a/b:c.jpg', size: 1000, topic: 'Rem', album: 'Set 01' }];
  const t = fakeFiles(files);
  const r = await new DownloadJob(t, chat, items, { dest }).run();
  assert.equal(r.done, 2);
  const p1 = path.join(dest, 'My Group', 'Rem', 'Set 01', 'clip.mp4');
  assert.ok(fs.readFileSync(p1).equals(files[1]));
  assert.ok(fs.existsSync(path.join(dest, 'My Group', 'Rem', 'Set 01', 'a b c.jpg')));
  const m = new DownloadManifest(dest);
  assert.equal(m.get(chat.id, 1).size, files[1].length);
  assert.match(m.get(chat.id, 1).sha256, /^[0-9a-f]{64}$/);
  const again = await new DownloadJob(t, chat, items, { dest }).run();
  assert.equal(again.skipped, 2);
  assert.equal(t.calls.length, 2, 'nothing downloaded twice');
  assert.equal(safeName('CON'), '_CON');
  assert.equal(safeName('  ...  '), 'untitled');
});

test('downloads: an interrupted file continues from its last whole piece, not from the start', async () => {
  const dest = tmp();
  const files = { 7: bytes(1700 * 1024, 7) };
  const items = [{ msgId: 7, fileName: 'big.mp4', size: files[7].length, topic: 'T', album: 'A' }];
  const t = fakeFiles(files, { failAfterChunks: 2 }); // dies after 1 MB
  const first = await new DownloadJob(t, chat, items, { dest }).run();
  assert.equal(first.failed, 1);
  const part = path.join(dest, 'My Group', 'T', 'A', 'big.mp4.part');
  assert.equal(fs.statSync(part).size, 1024 * 1024);
  const second = await new DownloadJob(t, chat, items, { dest }).run();
  assert.equal(second.done, 1);
  assert.equal(t.calls[1].offset, 1024 * 1024, 'resumed at 1 MB');
  assert.ok(fs.readFileSync(path.join(dest, 'My Group', 'T', 'A', 'big.mp4')).equals(files[7]));
  assert.ok(!fs.existsSync(part));
});

test('downloads: existing files are skipped by default, renamed or overwritten only when chosen', async () => {
  const files = { 3: bytes(500, 3) };
  const items = [{ msgId: 3, fileName: 'x.jpg', size: 500, topic: 'T', album: 'A' }];
  const setup = () => {
    const dest = tmp();
    const p = path.join(dest, 'My Group', 'T', 'A', 'x.jpg');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'mine, different size');
    return { dest, p };
  };
  let s = setup();
  let r = await new DownloadJob(fakeFiles(files), chat, items, { dest: s.dest }).run();
  assert.equal(r.skipped, 1);
  assert.equal(fs.readFileSync(s.p, 'utf8'), 'mine, different size');
  s = setup();
  r = await new DownloadJob(fakeFiles(files), chat, items, { dest: s.dest, policy: 'rename' }).run();
  assert.equal(fs.readFileSync(s.p, 'utf8'), 'mine, different size');
  assert.ok(fs.readFileSync(path.join(path.dirname(s.p), 'x (2).jpg')).equals(files[3]));
  s = setup();
  r = await new DownloadJob(fakeFiles(files), chat, items, { dest: s.dest, policy: 'overwrite' }).run();
  assert.ok(fs.readFileSync(s.p).equals(files[3]));
});

// ---------------------------------------------------------------- folder sync

function syncWorld() {
  const root = tmp('fgs-');
  const dir = path.join(root, 'Pics');
  fs.mkdirSync(path.join(dir, 'Rem'), { recursive: true });
  const write = (rel, content) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.concat([Buffer.from('ffd8ffe0', 'hex'), Buffer.from(content)])); return p; };
  const jobs = [];
  const runner = new S.SyncRunner({
    scan: (folders) => scanSources(folders, {}),
    plan: (groups) => buildPlan(groups, { captionBy: 'smart' }),
    enqueue: async ({ plan }) => { const job = { id: `j${jobs.length + 1}`, plan }; jobs.push(job); return job; },
    stateFile: (id) => path.join(root, `${id}.json`),
    downloadedPaths: () => new Set([path.join(dir, 'Rem', 'from-telegram.jpg')]),
    telegramAlbums: async () => [{ ids: [500] }, { ids: [900, 901] }],
  });
  const profile = S.sanitizeProfile({ name: 'Pics', folders: [dir], direction: 'two-way' });
  // Pretend each job delivered everything it was given.
  const deliver = (job) => runner.jobFinished(profile.id, job.id, { albums: job.plan.flatMap((e) => e.albums.map((a, i) => ({ status: 'sent', paths: a.files.map((f) => f.path),
    messageIds: a.files.map((_, k) => 900 + jobs.length * 10 + i * 3 + k) }))) });
  return { dir, write, jobs, runner, profile, deliver };
}
const sent = (job) => job.plan.flatMap((e) => e.albums.flatMap((a) => a.files.map((f) => path.basename(f.path)))).sort();

test('sync: first run sends everything, then only new and changed files; renames are not sent again', async () => {
  const w = syncWorld();
  w.write('Rem/1.jpg', 'one');
  w.write('Rem/2.jpg', 'two');
  w.write('Rem/from-telegram.jpg', 'downloaded earlier');
  let r = await w.runner.run(w.profile);
  assert.deepStrictEqual(r.changes, { added: 2, changed: 0, removed: 0, renamed: 0 });
  assert.deepStrictEqual(sent(w.jobs[0]), ['1.jpg', '2.jpg'], 'a downloaded file is never uploaded back');
  w.deliver(w.jobs[0]);
  r = await w.runner.run(w.profile);
  assert.equal(r.jobId, null, 'nothing changed, nothing queued');
  // A rename, a new file and an edit.
  fs.renameSync(path.join(w.dir, 'Rem/1.jpg'), path.join(w.dir, 'Rem/one-renamed.jpg'));
  w.write('Rem/3.jpg', 'three');
  const p2 = path.join(w.dir, 'Rem/2.jpg');
  fs.writeFileSync(p2, Buffer.concat([Buffer.from('ffd8ffe0', 'hex'), Buffer.from('two, edited and longer')]));
  r = await w.runner.run(w.profile);
  assert.deepStrictEqual(r.changes, { added: 1, changed: 1, removed: 0, renamed: 1 });
  assert.deepStrictEqual(sent(w.jobs[1]), ['2.jpg', '3.jpg']);
  assert.equal(path.basename(r.renamed[0].to), 'one-renamed.jpg');
});

test('sync two-way: removed files list their messages, Telegram albums the sync posted are never offered back', async () => {
  const w = syncWorld();
  w.write('Rem/1.jpg', 'one');
  await w.runner.run(w.profile);
  w.deliver(w.jobs[0]);
  const st = w.runner.state(w.profile.id);
  const own = [...st.own];
  fs.rmSync(path.join(w.dir, 'Rem/1.jpg'));
  const r = await w.runner.run(w.profile);
  assert.equal(r.changes.removed, 1);
  assert.equal(r.removedOnTelegram.length, 1);
  assert.deepStrictEqual(r.removedOnTelegram[0].messageIds, own);
  // Albums on Telegram: [500] is new; [900, 901] would be ours only if those ids were posted by this sync.
  assert.ok(r.newOnTelegram.some((a) => a.ids[0] === 500));
  assert.ok(!r.newOnTelegram.some((a) => a.ids.some((id) => own.includes(id))));
  w.runner.markDownloaded(w.profile.id, [500]);
  const again = await w.runner.run(w.profile);
  assert.ok(!again.newOnTelegram.some((a) => a.ids[0] === 500), 'downloaded albums are not offered again');
});

test('sync: a run while the last sync upload is still going queues nothing', async () => {
  const w = syncWorld();
  w.runner.deps.jobActive = () => true;
  w.write('Rem/1.jpg', 'one');
  await w.runner.run(w.profile);
  w.write('Rem/2.jpg', 'two');
  const r = await w.runner.run(w.profile);
  assert.match(r.note, /still running/);
  assert.equal(w.jobs.length, 1);
});

test('sync profiles are cleaned: unknown modes fall back, intervals stay within 5 minutes and a week', () => {
  const p = S.sanitizeProfile({ folders: ['C:/x'], schedule: { type: 'hourly?', minutes: 1 }, direction: 'mirror' });
  assert.equal(p.schedule.type, 'manual');
  assert.equal(p.schedule.minutes, 5);
  assert.equal(p.direction, 'upload');
  const due = S.nextRunAt({ ...p, schedule: { type: 'interval', minutes: 60 }, lastRun: new Date(1000).toISOString() }, 2000);
  assert.equal(due, 1000 + 3600000);
});
