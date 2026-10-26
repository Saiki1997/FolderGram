'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const N = require('../src/core/naming');
const C = require('../src/core/captions');
const { scanFolder, scanSources } = require('../src/core/scanner');
const { buildModel, buildPlan, materialize } = require('../src/core/planner');

/** Creates files under a temp folder; keys are relative paths. Returns the temp folder. */
function tree(files, base = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fgn-')), 'Downloads')) {
  for (const rel of files) {
    const p = path.join(base, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, rel);
  }
  return base;
}

const smart = async (root, opts = {}) => buildModel(await scanFolder(root), { captionBy: 'smart', ...opts });
const names = (model) => model.entries.flatMap((e) => e.sets.map((s) => s.name));

// ---------------------------------------------------------------- random names

test('random names: download ids, hashes and UUIDs are recognised', () => {
  for (const n of ['a8D3fG92', 'XK29Msa2', '2Zy6lA', '8d1e4fa3b9c2', '550e8400-e29b-41d4-a716-446655440000', 'd41d8cd98f00b204e9800998ecf8427e',
    'X8dk92ks', 'kb03wM (GoFile)', 'cfLHwd', 'kVNZAi', 'xkqztr', 'wXKrJ9', 'Wy4dQa', 'bti08i', '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08']) {
    assert.ok(N.isGibberish(n), `${n} should look random`);
  }
});

test('random names: real names with numbers, acronyms, casing and other scripts are kept', () => {
  for (const n of ['Final Fantasy 7', 'Resident Evil 4', 'Set 01', '2026 Collection', 'Model X100', 'Studio 54', 'Episode 12', 'Rem', 'ReZero',
    'NASA', 'PSVR', 'iPhoneX', 'PlayStationVR', 'USBDrive', 'McDonald', 'Cafe2024', 'GTA5', 'Vol2', 'Spider-Man', 'Loose Files (GoFile)',
    'Mädchen', '東京 2024', 'Сборник фото', 'Ñandú', 'deadbeef', 'Marin Kitagawa', '2024', 'CatDemon Rem - ReZero']) {
    assert.ok(!N.isGibberish(n), `${n} should look real`);
  }
});

test('random names: scores come with reasons', () => {
  const r = N.randomness('kb03wM');
  assert.ok(r.score >= 0.5);
  assert.ok(r.reasons.includes('digits mixed into letters'));
  assert.deepEqual(N.randomness('Rem Collection'), { score: 0, reasons: [] });
});

test('generic names: camera, phone, screenshot and timestamp names have no real name', () => {
  for (const n of ['IMG_2034', 'IMG_20261025_001', 'DSC_0001', 'PXL_20240101_123456789', 'WhatsApp Image 2024-01-01 at 10.00.00', 'VID-20240101-WA0001',
    'Screenshot_2024-01-01-10-00-00', 'photo_2024-01-01_10-00-00', '0001', '20261025_101010', 'MVIMG_20240101_101010', 'GOPR0042', 'DJI_0001',
    '550e8400-e29b-41d4-a716-446655440000', 'X8d92a']) {
    assert.ok(N.isGenericName(n), `${n} should be generic`);
  }
  for (const n of ['Marin Kitagawa 01', 'New York', 'Rem Photos', 'Final Fantasy 7']) assert.ok(!N.isGenericName(n), `${n} should be a name`);
});

// ---------------------------------------------------------------- file name cleaning

test('file names: cleaning keeps the content name and separates numbering', () => {
  const t = (f) => N.parseFileName(f).title;
  assert.equal(t('Marin_Kitagawa_001.jpg'), 'Marin Kitagawa');
  assert.equal(t('Marin Kitagawa (2).jpg'), 'Marin Kitagawa');
  assert.equal(t('IMG_20261025_001.jpg'), '');
  assert.equal(t('Rem-Photos-01.jpg'), 'Rem Photos');
  assert.equal(t('Elaina_Set_01_003.png'), 'Elaina - Set 01');
  assert.equal(t('X8d92a.jpg'), '');
  assert.equal(t('Marin Kitagawa - Copy.jpg'), 'Marin Kitagawa');
  assert.equal(t('Marin Kitagawa a8D3fG92.jpg'), 'Marin Kitagawa'); // hash fragment
  assert.equal(t('Rem cosplay [1080p].mp4'), 'Rem cosplay');
  assert.equal(t('Rem (twitter.com).jpg'), 'Rem');
  assert.equal(t('IMG_Marin_01.jpg'), 'Marin');
  assert.equal(t('Spider-Man.jpg'), 'Spider-Man');
  assert.equal(t('Marin.Kitagawa.03.jpg'), 'Marin Kitagawa');
  assert.equal(t('東京タワー 01.jpg'), '東京タワー');
  assert.equal(t('Fotos de María (3).jpg'), 'Fotos de María');
});

test('file names: episode, season, volume, part, set and chapter numbers stay', () => {
  const p = (f) => N.parseFileName(f);
  assert.equal(p('Episode 01.mp4').identifier, 'Episode 01');
  assert.equal(p('episode_02.mp4').title, 'Episode 02');
  assert.equal(p('Season 2 Episode 3.mp4').title, 'Season 2 - Episode 3');
  assert.equal(p('Show S01E05.mkv').title, 'Show - S01E05');
  assert.equal(p('Volume 3.jpg').title, 'Volume 3');
  assert.equal(p('Part 1.mp4').title, 'Part 1');
  assert.equal(p('Chapter 5.pdf').title, 'Chapter 5');
  assert.equal(p('Rem Set 02.jpg').title, 'Rem - Set 02');
  assert.equal(p('Marin 01.jpg').identifier, '');
});

// ---------------------------------------------------------------- smart album names (spec examples)

test('smart: camera files take "Parent - Folder" when the folder name is generic', async () => {
  const base = tree(['Rem Collection/Set 01/IMG_0001.jpg', 'Rem Collection/Set 01/IMG_0002.jpg', 'Rem Collection/Set 01/IMG_0003.jpg']);
  // The user picked the "Set 01" folder itself: its parent is outside the chosen folder but still names it.
  const m = await smart(path.join(base, 'Rem Collection', 'Set 01'));
  assert.deepEqual(names(m), ['Rem Collection - Set 01']);
  assert.equal(m.entries[0].sets[0].auto.level, 'medium');
});

test('smart: a random folder takes the name its files share', async () => {
  const base = tree(['X8dk92ks/Marin Kitagawa 01.jpg', 'X8dk92ks/Marin Kitagawa 02.jpg', 'X8dk92ks/Marin Kitagawa 03.jpg']);
  const m = await smart(path.join(base, 'X8dk92ks'));
  assert.deepEqual(names(m), ['Marin Kitagawa']);
  assert.equal(m.entries[0].sets[0].auto.level, 'high');
  assert.equal(m.entries[0].topicName, 'Marin Kitagawa'); // the random topic is replaced too
});

test('smart: nested folders are named by hierarchy', async () => {
  const base = tree(['Rem Collection/Set 01/IMG_001.jpg', 'Rem Collection/Set 01/IMG_002.jpg', 'Rem Collection/Set 02/IMG_003.jpg',
    'Rem Collection/Set 02/IMG_004.jpg', 'Rem Collection/Videos/Video_001.mp4']);
  const m = await smart(path.join(base, 'Rem Collection'));
  assert.deepEqual(names(m), ['Rem Collection - Set 01', 'Rem Collection - Set 02', 'Rem Collection - Videos']);
  assert.ok(m.entries.every((e) => e.topicName === 'Rem Collection'));
});

test('smart: different names in one folder become different albums', async () => {
  const base = tree(['Mix/Marin 01.jpg', 'Mix/Marin 02.jpg', 'Mix/Elaina 01.jpg', 'Mix/Elaina 02.jpg']);
  const m = await smart(path.join(base, 'Mix'));
  assert.deepEqual(m.entries[0].sets.map((s) => [s.name, s.files.map((f) => f.name)]), [
    ['Elaina', ['Elaina 01.jpg', 'Elaina 02.jpg']],
    ['Marin', ['Marin 01.jpg', 'Marin 02.jpg']],
  ]);
});

test('smart: episodes stay separate unless asked to group them', async () => {
  const base = tree(['Show/Episode 01.mp4', 'Show/Episode 02.mp4', 'Show/Episode 03.mp4']);
  const m = await smart(path.join(base, 'Show'));
  assert.deepEqual(names(m), ['Episode 01', 'Episode 02', 'Episode 03']);
  const grouped = await smart(path.join(base, 'Show'), { groupSeries: true });
  assert.deepEqual(names(grouped), ['Episode']);
});

test('smart: numbered titles keep their number unless files form a series', async () => {
  const base = tree(['Games/Resident Evil 4.jpg', 'Games/Resident Evil 4 (2).jpg', 'Games/Final Fantasy 7.jpg', 'Games/Final Fantasy 7 (2).jpg']);
  const m = await smart(path.join(base, 'Games'));
  assert.deepEqual(names(m), ['Final Fantasy 7', 'Resident Evil 4']);
  const series = tree(['S/Studio 1.jpg', 'S/Studio 2.jpg', 'S/Studio 3.jpg']);
  assert.deepEqual(names(await smart(path.join(series, 'S'))), ['Studio']);
});

test('smart: sets within a numbered subset group by "Name - Set N"', async () => {
  const base = tree(['E/Elaina_Set_01_001.png', 'E/Elaina_Set_01_002.png', 'E/Elaina_Set_02_001.png', 'E/Elaina_Set_02_002.png']);
  assert.deepEqual(names(await smart(path.join(base, 'E'))), ['Elaina - Set 01', 'Elaina - Set 02']);
});

test('smart: descriptive one-off file names keep the folder as one album', async () => {
  const base = tree(['Holiday Bali/beach.jpg', 'Holiday Bali/sunset.jpg', 'Holiday Bali/dinner.jpg', 'Holiday Bali/temple.jpg']);
  const m = await smart(path.join(base, 'Holiday Bali'));
  assert.deepEqual(names(m), ['Holiday Bali']);
  assert.equal(m.entries[0].sets[0].files.length, 4);
});

test('smart: a meaningful folder wins over a shorter shared file name it contains', async () => {
  const base = tree(['Rem Collection/Set 01/Rem_001.jpg', 'Rem Collection/Set 01/Rem_002.jpg']);
  assert.deepEqual(names(await smart(path.join(base, 'Rem Collection'))), ['Rem Collection - Set 01']);
  const more = tree(['Marin/Marin Kitagawa 01.jpg', 'Marin/Marin Kitagawa 02.jpg']);
  assert.deepEqual(names(await smart(path.join(more, 'Marin'))), ['Marin Kitagawa']); // the file name is more specific
});

test('smart: camera files mixed with a named series join it', async () => {
  const base = tree(['X/a8D3fG92/Marin 01.jpg', 'X/a8D3fG92/Marin 02.jpg', 'X/a8D3fG92/IMG_0003.jpg']);
  const m = await smart(path.join(base, 'X', 'a8D3fG92'));
  assert.deepEqual(m.entries[0].sets.map((s) => [s.name, s.files.length]), [['Marin', 3]]);
});

test('smart: completely random folder and files keep the name, flagged low, or become Album N', async () => {
  const base = tree(['kb03wM/X8d92a.jpg', 'kb03wM/Q7ps2kd.jpg']);
  const m = await smart(path.join(base, 'kb03wM'));
  assert.deepEqual(names(m), ['kb03wM']);
  assert.equal(m.entries[0].sets[0].auto.level, 'low');
  const renamed = await smart(path.join(base, 'kb03wM'), { renameGibberish: true });
  assert.deepEqual(names(renamed), ['Album 1']);
  assert.equal(renamed.entries[0].topicName, 'Album 1');
});

test('smart: identical folder names in different places are flagged as conflicts in the same topic', async () => {
  const base = tree(['Rem/A/Marin 01.jpg', 'Rem/A/Marin 02.jpg', 'Rem/B/Marin 03.jpg', 'Rem/B/Marin 04.jpg', 'Rem/C/Other 01.jpg', 'Rem/C/Other 02.jpg']);
  const m = await smart(base); // all three folders go into topic "Rem"
  assert.deepEqual(m.entries.map((e) => e.topicName), ['Rem', 'Rem', 'Rem']);
  assert.deepEqual(m.entries.map((e) => e.sets.map((s) => [s.name, s.conflict])), [[['Marin', true]], [['Marin', true]], [['Other', false]]]);
});

test('smart: unicode and other languages', async () => {
  const base = tree(['写真/東京タワー 01.jpg', '写真/東京タワー 02.jpg', '写真/Сборник 01.jpg', '写真/Сборник 02.jpg']);
  assert.deepEqual(names(await smart(path.join(base, '写真'))), ['Сборник', '東京タワー']);
});

test('smart: repeated scans give identical albums and ids', async () => {
  const base = tree(['R/Marin 01.jpg', 'R/Marin 02.jpg', 'R/Elaina 1.jpg', 'R/Elaina 2.jpg', 'R/IMG_1.jpg']);
  const a = await smart(path.join(base, 'R'));
  const b = await smart(path.join(base, 'R'));
  const shape = (m) => m.entries.map((e) => [e.id, e.sets.map((s) => [s.id, s.name, s.files.map((f) => f.name)])]);
  assert.deepEqual(shape(a), shape(b));
});

test('smart: thousands of files group quickly and deterministically', async () => {
  const files = [];
  for (let i = 0; i < 3000; i++) files.push(`Big/${['Marin', 'Elaina', 'Rem'][i % 3]} ${String(i).padStart(4, '0')}.jpg`);
  for (let i = 0; i < 500; i++) files.push(`Big/IMG_${20260000 + i}.jpg`);
  const base = tree(files);
  const t0 = Date.now();
  const m = await smart(path.join(base, 'Big'));
  assert.ok(Date.now() - t0 < 5000);
  assert.deepEqual(m.entries[0].sets.map((s) => [s.name, s.files.length]), [['Elaina', 1000], ['Big', 500], ['Marin', 1000], ['Rem', 1000]]);
  const plan = materialize(m, {});
  assert.equal(plan[0].albums.length, 350); // 3500 files in albums of 10
});

// ---------------------------------------------------------------- other naming modes

test('naming modes: folder only, parent + folder, template', async () => {
  const base = tree(['Rem Collection/Set 01/IMG_001.jpg', 'Rem Collection/Videos/Video_001.mp4']);
  const groups = await scanFolder(path.join(base, 'Rem Collection'));
  const n = (opts) => buildModel(groups, opts).entries.map((e) => e.sets[0].name);
  assert.deepEqual(n({ captionBy: 'folder' }), ['Set 01', 'Videos']);
  assert.deepEqual(n({ captionBy: 'parent' }), ['Rem Collection - Set 01', 'Rem Collection - Videos']);
  assert.deepEqual(n({ captionBy: 'template', nameTemplate: '{folder} ({count} files)' }), ['Set 01 (1 files)', 'Videos (1 files)']);
  assert.deepEqual(n({ captionBy: 'template', nameTemplate: '{parent} / {folder}' }), ['Rem Collection / Set 01', 'Rem Collection / Videos']);
  assert.deepEqual(n({ captionBy: 'template', nameTemplate: '{album}' }), ['Rem Collection - Set 01', 'Rem Collection - Videos']);
});

test('naming memory: saved corrections and topic names are applied on the next scan', async () => {
  const base = tree(['kb03wM/X8d92a.jpg']);
  const groups = await scanFolder(path.join(base, 'kb03wM'));
  const memory = {
    resolveAlbum: ({ name }) => (name === 'kb03wM' ? 'Marin beach day' : null),
    resolveTopic: (name) => (name === 'kb03wM' ? 'Marin' : null),
  };
  const m = buildModel(groups, { captionBy: 'smart', memory });
  assert.equal(m.entries[0].sets[0].name, 'Marin beach day');
  assert.equal(m.entries[0].sets[0].auto.source, 'saved');
  assert.equal(m.entries[0].topicName, 'Marin');
});

test('stable Album N numbering across scans when a memory keeps the aliases', async () => {
  const base = tree(['a/kb03wM (GoFile)/1.jpg', 'a/Wy4dQa (GoFile)/2.jpg']);
  const aliases = new Map();
  const memory = { alias: (n) => { if (!aliases.has(n)) aliases.set(n, `Album ${aliases.size + 1}`); return aliases.get(n); } };
  const first = buildPlan(await scanFolder(path.join(base, 'a')), { renameGibberish: true, memory });
  tree(['a/2Zy6lA (GoFile)/3.jpg'], base); // a new folder sorted before the others
  const second = buildPlan(await scanFolder(path.join(base, 'a')), { renameGibberish: true, memory });
  const topics = (p) => Object.fromEntries(p.map((e) => [e.folder.leaf, e.topicName]));
  assert.equal(topics(first)['kb03wM (GoFile)'], topics(second)['kb03wM (GoFile)']);
  assert.equal(topics(first)['Wy4dQa (GoFile)'], topics(second)['Wy4dQa (GoFile)']);
  assert.equal(topics(second)['2Zy6lA (GoFile)'], 'Album 3');
});

// ---------------------------------------------------------------- captions

test('captions: formats, placement and templates without empty parts', async () => {
  const base = tree(Array.from({ length: 23 }, (_, i) => `Marin Kitagawa/Marin Kitagawa ${String(i + 1).padStart(2, '0')}.jpg`));
  const groups = await scanFolder(path.join(base, 'Marin Kitagawa'));
  const caps = (opts) => buildPlan(groups, { captionBy: 'smart', captionWhere: 'every', ...opts })[0].albums.map((a) => a.caption);
  assert.deepEqual(caps({}), ['Marin Kitagawa', 'Marin Kitagawa', 'Marin Kitagawa']);
  assert.deepEqual(caps({ captionFormat: 'detailed' }), ['Marin Kitagawa — 10 Photos', 'Marin Kitagawa — 10 Photos', 'Marin Kitagawa — 3 Photos']);
  assert.deepEqual(caps({ captionFormat: 'series' }), ['Marin Kitagawa — Part 1 of 3', 'Marin Kitagawa — Part 2 of 3', 'Marin Kitagawa — Part 3 of 3']);
  assert.deepEqual(caps({ captionFormat: 'custom', captionTemplate: '{album} | {count} Files | {part}/{totalParts}' }),
    ['Marin Kitagawa | 10 Files | 1/3', 'Marin Kitagawa | 10 Files | 2/3', 'Marin Kitagawa | 3 Files | 3/3']);
  assert.deepEqual(caps({ captionWhere: 'first' }), ['Marin Kitagawa', '', '']);
  assert.deepEqual(caps({ captionWhere: 'last' }), ['', '', 'Marin Kitagawa']);
  assert.deepEqual(caps({ captionWhere: 'none' }), ['', '', '']);
});

test('captions: folder format, empty template parts and Telegram limits', () => {
  assert.equal(C.applyTemplate('{parent} - {folder}', { parent: '', folder: 'Set 01' }), 'Set 01');
  assert.equal(C.applyTemplate('{album} ({count} files)', { album: 'Rem', count: '' }), 'Rem');
  assert.equal(C.applyTemplate('{album} | {part}/{totalParts}', { album: 'Rem', part: '', totalParts: '' }), 'Rem');
  assert.equal(C.formatCaption('folder', '', { folderPath: 'Rem Collection / Set 01' }), 'Rem Collection / Set 01');
  assert.equal(C.formatCaption('series', '', { album: 'Rem', part: 1, totalParts: 1 }), 'Rem');
  const long = C.sanitize('word '.repeat(400));
  assert.ok([...long].length <= 1024 && long.endsWith('…'));
  assert.equal(C.sanitize('Rem\u0000‮evil\nline'), 'Remevil\nline');
  assert.equal(C.countLabel(['photo', 'photo', 'video']), '2 Photos, 1 Video');
});

test('loose files from several folders are named by their folder in smart mode', async () => {
  const base = tree(['Rem Collection/Set 01/IMG_1.jpg', 'Rem Collection/Set 01/IMG_2.jpg']);
  const groups = await scanSources([path.join(base, 'Rem Collection', 'Set 01', 'IMG_1.jpg'), path.join(base, 'Rem Collection', 'Set 01', 'IMG_2.jpg')]);
  assert.deepEqual(names(buildModel(groups, { captionBy: 'smart' })), ['Rem Collection - Set 01']);
});

// ---------------------------------------------------------------- scanning

test('scanning: include/exclude patterns, size limits, depth, hidden folders, progress', async () => {
  const base = tree(['Lib/a.jpg', 'Lib/b_thumb.jpg', 'Lib/raw/c.jpg', 'Lib/x/y/z/deep.jpg', 'Lib/.hidden/h.jpg', 'Lib/clip.mp4']);
  fs.writeFileSync(path.join(base, 'Lib', 'big.jpg'), Buffer.alloc(2 * 1024 * 1024));
  const root = path.join(base, 'Lib');
  const files = async (opts) => (await scanFolder(root, opts)).flatMap((g) => g.files.map((f) => path.relative(root, f.path).split(path.sep).join('/')));
  assert.deepEqual(await files({ exclude: '*_thumb.jpg, raw/**' }), ['a.jpg', 'big.jpg', 'clip.mp4', 'x/y/z/deep.jpg']);
  assert.deepEqual(await files({ include: '*.mp4' }), ['clip.mp4']);
  assert.deepEqual(await files({ maxSizeMb: 1, maxDepth: 1 }), ['a.jpg', 'b_thumb.jpg', 'clip.mp4', 'raw/c.jpg']);
  assert.deepEqual(await files({ minSizeMb: 1 }), ['big.jpg']);
  assert.ok((await files({ includeHidden: true })).includes('.hidden/h.jpg'));
  const seen = [];
  await scanFolder(root, { onProgress: (p) => seen.push(p) });
  assert.ok(seen[seen.length - 1].done && seen[seen.length - 1].files === 6);
});

test('scanning: symbolic link loops are not followed', async (t) => {
  const base = tree(['Loop/a.jpg']);
  try { fs.symlinkSync(path.join(base, 'Loop'), path.join(base, 'Loop', 'again'), 'dir'); } catch { return t.skip('no symlinks here'); }
  const groups = await scanFolder(path.join(base, 'Loop'));
  assert.equal(groups.length, 1);
});

test('scanning: 5,000 files in 100 folders keep depth-first order', async () => {
  const files = [];
  for (let d = 0; d < 100; d++) for (let i = 0; i < 50; i++) files.push(`Many/Set ${d}/IMG_${i}.jpg`);
  const base = tree(files);
  const groups = await scanFolder(path.join(base, 'Many'));
  assert.equal(groups.length, 100);
  assert.deepEqual(groups.slice(0, 3).map((g) => g.leaf), ['Set 0', 'Set 1', 'Set 2']);
  assert.equal(groups[10].leaf, 'Set 10'); // natural order, not "Set 1, Set 10, Set 11"
});

test('a learned correction is applied next time and forgotten when the name is set back', async () => {
  const { NamingMemory } = require('../src/core/naming-memory');
  const root = tree(['Cosplay/kb03wM/Ganyu Set 01 (1).jpg', 'Cosplay/kb03wM/Ganyu Set 01 (2).jpg']);
  const memory = new NamingMemory(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fgm-')), 'naming.json'));
  const first = await smart(root, { memory });
  const e = first.entries[0], s = e.sets[0];
  memory.correctAlbum({ dir: e.folder.dir || e.folder.path, key: s.id, from: s.name, to: 'Ganyu Lantern Rite', learn: true });
  const second = (await smart(root, { memory })).entries[0].sets[0];
  assert.equal(second.name, 'Ganyu Lantern Rite');
  assert.equal(second.auto.detected, s.name); // the detected name is kept so it can be restored
  memory.correctAlbum({ dir: e.folder.dir || e.folder.path, key: s.id, from: second.auto.detected, to: second.auto.detected });
  assert.equal(memory.snapshot().learned.length, 0);
  assert.equal((await smart(root, { memory })).entries[0].sets[0].name, s.name);
});

test('a leading [release group] tag is dropped, and random folders become "Album N" when asked even under a named parent', async () => {
  assert.equal(N.parseFileName('[SubsPlease] Frieren - 01 (1080p).mkv').base, 'Frieren');
  const root = tree(['Cosplay/2Zy6lA (GoFile)/IMG_2001.jpg', 'Cosplay/2Zy6lA (GoFile)/IMG_2002.jpg']);
  assert.deepEqual(names(await smart(root, { renameGibberish: true })), ['Album 1']);
  assert.deepEqual(names(await smart(root)), ['Cosplay']); // off: the parent folder names it, flagged for review
});
