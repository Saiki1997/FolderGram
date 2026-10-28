'use strict';

// FolderGram 4.0 Phase 3: organization rules, the naming dictionary and similar-title suggestions, similar-picture
// detection and cover suggestions. Pictures are made with the bundled ffmpeg, so the decoding is real.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const O = require('../src/core/organize');
const S = require('../src/core/naming-suggest');
const P = require('../src/core/perceptual');
const { suggestCovers, measure } = require('../src/core/cover');
const { makeDecoder, imageSize, parseSize } = require('../src/core/imaging');
const { scanFolder } = require('../src/core/scanner');
const { buildModel } = require('../src/core/planner');

const tmp = (p = 'fgo-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const ff = (...args) => {
  const r = spawnSync(ffmpeg, ['-v', 'error', '-y', ...args]);
  if (r.status !== 0) throw new Error(String(r.stderr));
};
const file = (p, ext = path.extname(p)) => ({ path: p, name: path.basename(p), ext, size: fs.statSync(p).size, mtimeMs: fs.statSync(p).mtimeMs, kind: 'photo' });

// ---------------------------------------------------------------- organization rules

function tree(spec) {
  const root = tmp();
  for (const [rel, names] of Object.entries(spec)) {
    fs.mkdirSync(path.join(root, rel), { recursive: true });
    for (const n of names) fs.writeFileSync(path.join(root, rel, n), Buffer.concat([Buffer.from('ffd8ffe0', 'hex'), Buffer.from(n)]));
  }
  return root;
}

test('rules: Anime/Marin/Set 01 → topic “Marin”, album “Set 01” (the brief’s example)', async () => {
  const root = tree({ 'Marin/Set 01': ['001.jpg', '002.jpg'], 'Marin/Set 02': ['001.jpg'], 'Rem/Set 01': ['a.jpg'] });
  const rules = [O.PRESETS.find((p) => p.id === 'character-set')];
  const m = buildModel(await scanFolder(root), { captionBy: 'smart', organizeRules: rules });
  const got = m.entries.map((e) => `${e.topicName} | ${e.sets.map((s) => s.name).join(', ')}`);
  assert.deepStrictEqual(got, ['Marin | Set 01', 'Marin | Set 02', 'Rem | Set 01']);
  assert.equal(m.entries[0].sets[0].auto.source, 'rule');
  assert.match(m.entries[0].sets[0].auto.reasons[0], /Topic per collection/);
});

test('rules: conditions on extensions, file names, folders and dates; first match wins; a skip rule leaves albums out', async () => {
  const root = tree({ 'Trip/clips': ['a.mp4', 'b.mov'], 'Trip/mixed': ['a.mp4', 'b.jpg'], 'Trip/raw': ['x.jpg'], 'Trip/best': ['best_1.jpg', 'best_2.jpg'] });
  const rules = O.sanitizeRules([
    { name: 'skip raw', when: { folder: '/^raw$/' }, then: { skip: true } },
    { name: 'videos', when: { ext: 'mp4, mov' }, then: { topic: 'Videos', album: '{parent} {folder}' } },
    { name: 'best', when: { file: 'best_*' }, then: { album: 'Best of {parent}' } },
    { name: 'never', when: { from: '2999-01-01' }, then: { album: 'future' } },
  ]);
  const m = buildModel(await scanFolder(root), { captionBy: 'folder', organizeRules: rules });
  const by = Object.fromEntries(m.entries.map((e) => [e.folder.leaf, e]));
  assert.equal(by.clips.topicName, 'Videos');
  assert.equal(by.clips.sets[0].name, 'Trip clips');
  assert.notEqual(by.mixed.topicName, 'Videos', 'a jpg in the album: the videos rule does not apply');
  assert.equal(by.best.sets[0].name, 'Best of Trip');
  assert.equal(by.raw.sets.length, 0);
  assert.equal(by.raw.skippedByRule[0].rule, 'skip raw');
  // The tester says why a rule did not apply.
  const set = { name: 'mixed', files: by.mixed.sets[0].files };
  const r = O.test(rules[1], by.mixed.folder, set);
  assert.equal(r.ok, false);
  assert.match(r.why[0], /1 of 2 files are not/);
});

test('rules: user corrections still win over rules, and bad patterns never throw', async () => {
  const root = tree({ 'Marin/Set 01': ['1.jpg'] });
  const folders = await scanFolder(root);
  const rules = O.sanitizeRules([{ name: 'bad', when: { folder: '/([/' }, then: { album: 'x' } }, { name: 'ok', when: {}, then: { album: 'From rule' } }]);
  const memory = { resolveTopic: () => null, resolveAlbum: () => 'My name' };
  const m = buildModel(folders, { captionBy: 'smart', organizeRules: rules, memory });
  assert.equal(m.entries[0].sets[0].name, 'My name');
  assert.equal(O.test(rules[0], folders[0], { name: 'a', files: folders[0].files }).why[0], 'folder: the pattern is not valid');
});

// ---------------------------------------------------------------- dictionary and similar titles

test('dictionary: whole words only, longest spelling first, no doubled words', () => {
  const d = S.compileDictionary([{ name: 'Marin Kitagawa', aliases: ['Marin', 'kitagawa marin'] }, { name: 'Re:Zero', aliases: 'rezero, re zero' }]);
  assert.equal(S.applyDictionary('Marin - Set 01', d).name, 'Marin Kitagawa - Set 01');
  assert.equal(S.applyDictionary('Kitagawa Marin cosplay', d).name, 'Marin Kitagawa cosplay');
  assert.equal(S.applyDictionary('Marina beach', d), null);
  assert.equal(S.applyDictionary('Marin Kitagawa - Set 01', d), null, 'already the preferred spelling');
  assert.equal(S.applyDictionary('marin kitagawa', d).name, 'Marin Kitagawa');
  assert.equal(S.applyDictionary('ReZero Rem', d).name, 'Re:Zero Rem');
});

test('similar titles: spelling, word order and typos are grouped; different numbers never are', () => {
  const g = S.similarTitles([
    { name: 'Marin Kitagawa', count: 30, ref: 'a' }, { name: 'marin_kitagawa', count: 5, ref: 'b' }, { name: 'Marin Kitagwa', count: 2, ref: 'c' },
    { name: 'Kitagawa Marin', count: 1, ref: 'd' }, { name: 'Set 01', count: 3 }, { name: 'Set 02', count: 3 }, { name: 'Rem', count: 1 }, { name: 'Ram', count: 1 },
    { name: 'Elaina Set 01', count: 2 }, { name: 'Elaina Set 02', count: 2 },
  ]);
  assert.equal(g.length, 1);
  assert.equal(g[0].to, 'Marin Kitagawa');
  assert.deepStrictEqual(g[0].from.map((x) => x.name).sort(), ['Kitagawa Marin', 'Marin Kitagwa', 'marin_kitagawa']);
  // The dictionary decides the spelling when it knows the title.
  const d = S.similarTitles([{ name: 'rezero', count: 9 }, { name: 'ReZero', count: 1 }], { dictionary: [{ name: 'Re:Zero', aliases: ['rezero'] }] });
  assert.equal(d[0].to, 'Re:Zero');
  assert.equal(d[0].reason, 'your dictionary');
});

test('dictionary in the plan: album and topic names use the preferred spelling, with the reason', async () => {
  const root = tree({ 'marin kitagawa': ['Marin_001.jpg', 'Marin_002.jpg'] });
  const m = buildModel(await scanFolder(root), { captionBy: 'smart', dictionary: [{ name: 'Marin Kitagawa', aliases: ['Marin'] }] });
  assert.equal(m.entries[0].topicName, 'Marin Kitagawa');
  assert.equal(m.entries[0].sets[0].name, 'Marin Kitagawa');
  assert.match(m.entries[0].sets[0].auto.reasons.join(' '), /dictionary/);
});

test('naming suggestions for a plan: folders spelled differently would make two topics', async () => {
  const root = tree({ 'Marin Kitagawa/a': ['1.jpg'], 'marin kitagawa/b': ['1.jpg'], 'Rem/a': ['1.jpg'] });
  const m = buildModel(await scanFolder(root), { captionBy: 'smart' });
  const s = S.suggestForModel(m.entries);
  const topic = s.find((x) => x.kind === 'topic');
  assert.ok(topic, JSON.stringify(s));
  assert.equal(topic.from.length, 1);
  assert.equal(topic.from[0].refs.length, 1);
});

// ---------------------------------------------------------------- folder metadata files

test('foldergram.txt names a folder’s album and topic, and is never uploaded', async () => {
  const root = tree({ kb03wM: ['a1.jpg', 'a2.jpg'] });
  fs.writeFileSync(path.join(root, 'kb03wM', 'foldergram.txt'), 'title: Marin Kitagawa - Beach\ntopic: Marin Kitagawa\n');
  const folders = await scanFolder(root, { includeAllFiles: true });
  assert.deepStrictEqual(folders[0].files.map((f) => f.name), ['a1.jpg', 'a2.jpg']);
  const m = buildModel(folders, { captionBy: 'smart' });
  assert.equal(m.entries[0].sets[0].name, 'Marin Kitagawa - Beach');
  assert.equal(m.entries[0].sets[0].auto.source, 'metadata');
  assert.equal(m.entries[0].topicName, 'Marin Kitagawa');
});

// ---------------------------------------------------------------- pictures

const pics = (() => {
  let dir = null;
  return () => {
    if (dir) return dir;
    dir = tmp('fgp-');
    const p = (n) => path.join(dir, n);
    ff('-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=1', '-frames:v', '1', p('orig.png'));
    ff('-i', p('orig.png'), '-q:v', '2', p('orig.jpg'));
    ff('-i', p('orig.png'), '-vf', 'scale=480:270', '-q:v', '28', p('small_bad.jpg')); // resized and badly recompressed
    ff('-i', p('orig.png'), '-vf', 'scale=640:360', p('half.webp'));
    ff('-f', 'lavfi', '-i', 'mandelbrot=size=1280x720', '-frames:v', '1', p('other.png'));
    ff('-f', 'lavfi', '-i', 'life=size=320x240:mold=10:ratio=0.5:seed=3', '-frames:v', '1', '-vf', 'scale=1280:720', p('third.png'));
    ff('-f', 'lavfi', '-i', 'color=c=gray:size=640x480', '-frames:v', '1', p('plain.png'));
    ff('-i', p('orig.png'), '-vf', 'boxblur=12:2', p('blurred.jpg'));
    ff('-i', p('orig.png'), '-vf', 'eq=brightness=-0.85', p('dark.jpg'));
    ff('-i', p('orig.png'), '-vf', 'scale=320:180', '-q:v', '2', p('tiny.jpg'));
    // Videos: a clip, the same clip smaller and recompressed, and a different clip of the same length.
    ff('-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=10', '-t', '6', '-pix_fmt', 'yuv420p', p('clip.mp4'));
    ff('-i', p('clip.mp4'), '-vf', 'scale=320:180', '-crf', '40', p('clip_small.mp4'));
    ff('-f', 'lavfi', '-i', 'mandelbrot=size=640x360:rate=10', '-t', '6', '-pix_fmt', 'yuv420p', p('other.mp4'));
    fs.writeFileSync(p('broken.jpg'), Buffer.from('ffd8ffe000104a464946', 'hex'));
    return dir;
  };
})();

test('image sizes come from the file header (JPEG, PNG, WebP), without decoding', async () => {
  const d = pics();
  assert.deepStrictEqual(await imageSize(path.join(d, 'orig.jpg')), { width: 1280, height: 720, format: 'jpeg' });
  assert.deepStrictEqual(await imageSize(path.join(d, 'orig.png')), { width: 1280, height: 720, format: 'png' });
  assert.deepStrictEqual(await imageSize(path.join(d, 'half.webp')), { width: 640, height: 360, format: 'webp' });
  assert.equal(parseSize(Buffer.from('hello world, not an image')), null);
});

test('similar pictures: resized, recompressed and converted copies are found; different pictures are not', async () => {
  const d = pics();
  const dec = makeDecoder({ ffmpeg });
  const names = ['orig.jpg', 'small_bad.jpg', 'half.webp', 'orig.png', 'other.png', 'third.png', 'plain.png', 'broken.jpg'];
  const items = [];
  for (const n of names) {
    const fp = await P.fingerprint(file(path.join(d, n)), dec);
    if (fp && !fp.error) items.push({ id: n, ...fp });
    else assert.equal(n, 'broken.jpg', `${n} should be readable`);
  }
  const groups = P.groupSimilar(items);
  assert.equal(groups.length, 1, JSON.stringify(groups));
  assert.deepStrictEqual(groups[0].members.map((m) => m.id).sort(), ['half.webp', 'orig.jpg', 'orig.png', 'small_bad.jpg']);
  // Highest quality first: full size, then the bigger file (the PNG).
  assert.equal(groups[0].best, 'orig.png');
  for (const m of groups[0].members) assert.ok(m.distance <= P.SIMILAR, `${m.id}: ${m.distance}`);
  assert.ok(items.find((x) => x.id === 'plain.png').plain, 'a plain gray picture is flagged, not matched');
});

test('similar videos: a smaller recompressed copy matches; another clip of the same length does not', async () => {
  const d = pics();
  const dec = makeDecoder({ ffmpeg });
  const items = [];
  for (const n of ['clip.mp4', 'clip_small.mp4', 'other.mp4']) items.push({ id: n, ...(await P.fingerprint({ ...file(path.join(d, n), '.mp4'), kind: 'video' }, dec)) });
  const groups = P.groupSimilar(items);
  assert.equal(groups.length, 1);
  assert.deepStrictEqual(groups[0].members.map((m) => m.id).sort(), ['clip.mp4', 'clip_small.mp4']);
  assert.equal(groups[0].best, 'clip.mp4');
});

test('similar pictures scale: 20,000 random hashes group in well under a few seconds', () => {
  const items = [];
  const crypto = require('crypto');
  for (let i = 0; i < 20000; i++) items.push({ id: i, kind: 'photo', hash: crypto.randomBytes(16).toString('hex'), quality: {} });
  // Plant 50 near copies (3 bits changed).
  for (let i = 0; i < 50; i++) {
    const h = items[i].hash.split('');
    for (const j of [3, 14, 27]) h[j] = (parseInt(h[j], 16) ^ 1).toString(16); // 3 bits changed
    items.push({ id: `copy${i}`, kind: 'photo', hash: h.join(''), quality: {} });
  }
  const t0 = Date.now();
  const groups = P.groupSimilar(items);
  const ms = Date.now() - t0;
  assert.equal(groups.length, 50);
  assert.ok(ms < 5000, `${ms} ms`);
});

test('covers: a sharp, well-exposed, full-size photo is suggested over blurred, dark, tiny or broken ones', async () => {
  const d = pics();
  const dec = makeDecoder({ ffmpeg });
  const files = ['blurred.jpg', 'dark.jpg', 'tiny.jpg', 'broken.jpg', 'orig.jpg'].map((n, i) => ({ ...file(path.join(d, n)), id: i }));
  const [r] = await suggestCovers([{ id: 'A', files }], dec);
  assert.equal(r.fileId, 4, JSON.stringify(r));
  assert.equal(r.better, true);
  assert.equal(r.currentId, 0);
  assert.deepStrictEqual(r.unreadable, [3]);
  assert.ok(r.reasons.includes('sharp'), r.reasons.join());
  // Already first: nothing to change.
  const [same] = await suggestCovers([{ id: 'B', files: [files[4], files[0], files[1]] }], dec);
  assert.equal(same.better, false);
  assert.equal(same.fileId, 4);
  // Two albums with copies of the same best photo: both still get it rather than a much worse one.
  const two = await suggestCovers([{ id: 'C', files: [files[0], files[4]] }, { id: 'D', files: [files[1], { ...files[4], id: 9 }] }], dec);
  assert.deepStrictEqual(two.map((c) => c.fileId), [4, 9]);
  const gray = await dec.gray(path.join(d, 'blurred.jpg'), 64, 64, { ext: '.jpg' });
  const sharp = await dec.gray(path.join(d, 'orig.jpg'), 64, 64, { ext: '.jpg' });
  assert.ok(measure(sharp).sharpness > measure(gray).sharpness * 2);
});
