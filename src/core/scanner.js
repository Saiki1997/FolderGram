// Folder scanning and upload planning. Pure Node, no Telegram or Electron code, so it is easy to test.
'use strict';

const fsp = require('fs/promises');
const path = require('path');
const { isGibberish } = require('./naming');

const PHOTO_EXT = new Set(['.jpg', '.jpeg', '.png', '.bmp']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi', '.3gp', '.wmv', '.flv', '.mpg', '.mpeg', '.ts']);
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wav', '.wma']);
// Sent as files: Telegram would turn these into stickers, or can't show them as photos.
const OTHER_MEDIA_EXT = new Set(['.gif', '.webp', '.heic', '.heif', '.tif', '.tiff', '.raw', '.cr2', '.nef', '.arw', '.dng']);
const MEDIA_EXT = new Set([...PHOTO_EXT, ...VIDEO_EXT, ...AUDIO_EXT, ...OTHER_MEDIA_EXT]);

const ALBUM_MAX = 10; // Telegram's album limit
const SKIP_NAMES = new Set(['thumbs.db', 'desktop.ini']);

// How a file is sent. Files of the same kind can share an album.
const KIND = { PHOTO: 'photo', VIDEO: 'video', AUDIO: 'audio', DOC: 'document', ANIMATION: 'animation' };
// Photos and videos may be mixed in one album; audio and documents only with their own kind.
const ALBUM_CLASS = { photo: 'visual', video: 'visual', audio: 'audio', document: 'document', animation: null };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const naturalCompare = (a, b) => collator.compare(a, b);

function fileKind(file, forceDocument = false) {
  if (forceDocument || file.asDocument) return KIND.DOC;
  if (file.ext === '.gif') return KIND.ANIMATION;
  if (VIDEO_EXT.has(file.ext)) return KIND.VIDEO;
  // Photos over 10 MB are still photos: telegram.js resizes them so they stay in the album.
  if (PHOTO_EXT.has(file.ext)) return KIND.PHOTO;
  if (AUDIO_EXT.has(file.ext)) return KIND.AUDIO;
  return KIND.DOC;
}

/** Display names for a folder relative to the chosen root. */
function folderNames(root, folder) {
  const rel = path.relative(root, folder);
  const rootName = path.basename(root) || root;
  if (!rel) return { leaf: rootName, path: rootName, top: rootName };
  const parts = rel.split(path.sep);
  return { leaf: parts[parts.length - 1], path: parts.join(' / '), top: parts[0] };
}

const CAMERA_NAME = /^(img|image|dsc|dscn|dcim|pxl|vid|mvimg|photo|video|pic|screenshot|wa|p)?[\s._\-#]*\d*$/i;

/**
 * Album name from a file name. `match` decides which names count as the same:
 *   "exact":  only the extension may differ ("Marin.jpg" and "Marin.mp4").
 *   "series": also ignore a trailing "(2)"-style number, the way Windows numbers a series
 *             ("Elaina (11).jpg", "Elaina (12).jpg" -> "Elaina"). "Marin 2", "Marin-copy" stay separate.
 *   "loose":  ignore any trailing numbering or "copy" ("Rem 01", "Rem_03", "Rem - Copy" -> "Rem").
 * Returns "" for camera names with no real name ("IMG_2034.jpg", "0001.jpg").
 */
function fileStem(fileName, match = 'series') {
  let s = fileName.replace(/\.[^.]+$/, '');
  if (match !== 'exact') {
    let prev;
    do {
      prev = s;
      s = s.replace(/\s*[([{]\s*\d+\s*[)\]}]\s*$/, ''); // " (2)", "[03]"
      if (match === 'loose') {
        s = s
          .replace(/[\s._\-#]*(?:part|pt|p|no|vol|img|pic|photo|video|vid)?[\s._\-#]*\d+$/i, '') // " 01", "_p3", "-12"
          .replace(/[\s._\-#]*copy$/i, '') // "name - Copy"
          .replace(/[\s._\-#]+$/, '');
      }
    } while (s !== prev && s);
  }
  s = s.trim();
  return CAMERA_NAME.test(s) ? '' : s;
}

/** Category used by the file type filter: photo, video, audio or other. */
function fileCategory(ext) {
  if (PHOTO_EXT.has(ext)) return 'photo';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  return 'other';
}

/** Turns "*.jpg, raw/**" into one case-insensitive RegExp matched against file names and relative paths. */
function globsToRegExp(patterns) {
  const list = (Array.isArray(patterns) ? patterns : String(patterns || '').split(/[\n,;]+/)).map((p) => p.trim()).filter(Boolean);
  if (!list.length) return null;
  const one = (g) => g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*');
  return new RegExp(`^(?:${list.map(one).join('|')})$`, 'i');
}

/**
 * Filters shared by scanning: { includeAllFiles, types, include, exclude, minSizeMb, maxSizeMb, includeHidden }.
 * include/exclude are glob patterns on the file name or its path below the chosen folder ("raw/**", "*_thumb.jpg").
 */
function makeFilter(opts = {}) {
  const inc = globsToRegExp(opts.include);
  const exc = globsToRegExp(opts.exclude);
  const min = opts.minSizeMb ? opts.minSizeMb * 1024 * 1024 : 0;
  const max = opts.maxSizeMb ? opts.maxSizeMb * 1024 * 1024 : Infinity;
  return {
    name(name, rel) {
      if ((!opts.includeHidden && name.startsWith('.')) || SKIP_NAMES.has(name.toLowerCase())) return false;
      const ext = path.extname(name).toLowerCase();
      if (!opts.includeAllFiles && !MEDIA_EXT.has(ext)) return false;
      if (opts.types && opts.types[fileCategory(ext)] === false) return false;
      if (inc && !inc.test(name) && !inc.test(rel)) return false;
      if (exc && (exc.test(name) || exc.test(rel))) return false;
      return true;
    },
    size: (n) => n >= min && n <= max,
    dir(name, rel) {
      if (!opts.includeHidden && name.startsWith('.')) return false;
      if (exc && (exc.test(name) || exc.test(rel) || exc.test(`${rel}/`))) return false;
      return true;
    },
  };
}

/** Runs async fn over items with at most `limit` at a time; results keep their order. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Reads size and date of the named files, keeping only wanted ones (see makeFilter).
 * sortBy: "name" (natural order, img2 before img10) or "date" (oldest modified first).
 */
async function readFiles(folder, names, opts = {}, relDir = '') {
  const { sortBy = 'name' } = opts;
  const filter = opts.filter || makeFilter(opts);
  const wanted = names.filter((name) => filter.name(name, relDir ? `${relDir}/${name}` : name));
  const stats = await mapLimit(wanted, 64, (name) => fsp.stat(path.join(folder, name)).catch(() => null));
  const media = [];
  wanted.forEach((name, i) => {
    const st = stats[i];
    if (!st || !st.isFile() || !st.size || !filter.size(st.size)) return;
    media.push({ path: path.join(folder, name), name, ext: path.extname(name).toLowerCase(), size: st.size,
      mtime: Math.floor(st.mtimeMs / 1000), mtimeMs: st.mtimeMs });
  });
  media.sort(sortBy === 'date' ? (a, b) => a.mtimeMs - b.mtimeMs || naturalCompare(a.name, b.name) : (a, b) => naturalCompare(a.name, b.name));
  return media;
}

const makeGroup = (names, relPath, files, dir, meta = null) => ({ ...names, relPath, dir, files, totalSize: files.reduce((a, f) => a + f.size, 0),
  ...(meta ? { meta } : {}) });

// A folder can name itself: "foldergram.txt" ("title: …" and "topic: …" lines, or just the title on the first line)
// or ".foldergram.json" ({ "title": …, "topic": … }). These files are read, never uploaded.
const META_NAMES = new Set(['foldergram.txt', '.foldergram.json']);
async function readMeta(dir, names) {
  const name = names.find((n) => META_NAMES.has(n.toLowerCase()));
  if (!name) return null;
  let text;
  try {
    const st = await fsp.stat(path.join(dir, name));
    if (st.size > 64 * 1024) return null;
    text = (await fsp.readFile(path.join(dir, name), 'utf8')).replace(/^\uFEFF/, '');
  } catch { return null; }
  const clean = (v) => String(v || '').replace(/[\u0000-\u001F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 128);
  let meta = {};
  if (name.toLowerCase().endsWith('.json')) {
    try { const j = JSON.parse(text); meta = { title: clean(j.title || j.album), topic: clean(j.topic) }; } catch { return null; }
  } else {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const l of lines) {
      const m = /^(title|album|topic)\s*[:=]\s*(.+)$/i.exec(l);
      if (m) meta[m[1].toLowerCase() === 'topic' ? 'topic' : 'title'] = clean(m[2]);
    }
    if (!meta.title && !meta.topic && lines[0]) meta.title = clean(lines[0]);
  }
  if (!meta.title) delete meta.title;
  if (!meta.topic) delete meta.topic;
  return Object.keys(meta).length ? { ...meta, file: name } : null;
}

/** Folder order: a folder before its subfolders, siblings in natural order (the order of a depth-first walk). */
function compareRel(a, b) {
  const pa = a === '.' ? [] : a.split('/');
  const pb = b === '.' ? [] : b.split('/');
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const c = naturalCompare(pa[i], pb[i]);
    if (c) return c;
  }
  return pa.length - pb.length;
}

/**
 * One group per folder (the root and, if recursive, every subfolder) that holds matching files.
 * Folders are read several at a time. Symbolic links and junctions are not followed, a folder reached twice is
 * read once, and opts.maxDepth limits how deep subfolders go. opts.onProgress({ folders, files }) reports
 * progress; opts.isCancelled() stops early.
 */
async function scanFolder(root, opts = {}) {
  const { recursive = true, maxDepth = Infinity, onProgress = null, isCancelled = () => false } = opts;
  root = path.resolve(root);
  if (!(await fsp.stat(root)).isDirectory()) throw new Error(`Not a folder: ${root}`);
  const filter = makeFilter(opts);
  const groups = [];
  const visited = new Set();
  const counts = { folders: 0, files: 0 };
  let lastReport = 0;
  const queue = [{ dir: root, depth: 0 }];
  let active = 0;

  await new Promise((resolve, reject) => {
    const pump = () => {
      if (isCancelled()) { queue.length = 0; }
      while (active < 8 && queue.length) {
        const item = queue.shift();
        active++;
        visit(item).then(() => { active--; pump(); }, reject);
      }
      if (!active && !queue.length) resolve();
    };
    const visit = async ({ dir, depth }) => {
      let real = dir;
      try { real = await fsp.realpath(dir); } catch { /* keep the path */ }
      if (visited.has(real)) return;
      visited.add(real);
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return; // unreadable folder: skip it
      }
      const rel = path.relative(root, dir).split(path.sep).join('/');
      const files = [];
      for (const e of entries) {
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (recursive && depth < maxDepth && filter.dir(e.name, childRel)) queue.push({ dir: path.join(dir, e.name), depth: depth + 1 });
        } else if (e.isFile()) files.push(e.name); // symbolic links and junctions are neither: not followed
      }
      const meta = await readMeta(dir, files);
      const media = await readFiles(dir, files.filter((n) => !META_NAMES.has(n.toLowerCase())), { ...opts, filter }, rel);
      counts.folders++;
      counts.files += media.length;
      if (media.length) groups.push(makeGroup(folderNames(root, dir), rel || '.', media, dir, meta));
      if (onProgress && Date.now() - lastReport > 150) { lastReport = Date.now(); onProgress({ ...counts }); }
    };
    pump();
  });
  groups.sort((a, b) => compareRel(a.relPath, b.relPath));
  if (onProgress) onProgress({ ...counts, done: true });
  return groups;
}

/**
 * Scan a mix of folders and single files. Folders are scanned as above; loose files are grouped by the
 * folder they are in, which then acts as their topic and caption name.
 */
async function scanSources(sources, opts = {}) {
  const groups = [];
  const looseByDir = new Map();
  for (const src of sources) {
    const st = await fsp.stat(src).catch(() => null);
    if (!st) continue;
    if (st.isDirectory()) {
      groups.push(...(await scanFolder(src, opts)));
    } else if (st.isFile()) {
      const dir = path.dirname(path.resolve(src));
      if (!looseByDir.has(dir)) looseByDir.set(dir, []);
      looseByDir.get(dir).push(path.basename(src));
    }
  }
  for (const [dir, names] of looseByDir) {
    const media = await readFiles(dir, [...new Set(names)].filter((n) => !META_NAMES.has(n.toLowerCase())), opts);
    const name = path.basename(dir) || dir;
    if (media.length) groups.push(makeGroup({ leaf: name, path: name, top: name }, '.', media, dir));
  }
  return groups;
}

/** Split files into albums of up to 10 same-class files, keeping folder order within each class. */
function makeAlbums(files, { forceDocument = false, useAlbums = true } = {}) {
  const byClass = new Map();
  for (const f of files) {
    const kind = fileKind(f, forceDocument);
    const cls = ALBUM_CLASS[kind] || `single:${f.path}`;
    if (!byClass.has(cls)) byClass.set(cls, []);
    byClass.get(cls).push(f);
  }
  const order = ['visual', 'audio', 'document'];
  const keys = [...byClass.keys()].sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 9 : ia) - (ib < 0 ? 9 : ib);
  });
  const albums = [];
  for (const k of keys) {
    const items = byClass.get(k);
    const size = useAlbums && !k.startsWith('single:') ? ALBUM_MAX : 1;
    for (let i = 0; i < items.length; i += size) albums.push(items.slice(i, i + size));
  }
  return albums;
}

/** Scanned folders -> upload plan. See planner.js. */
function buildPlan(folders, opts) {
  return require('./planner').buildPlan(folders, opts);
}

function humanSize(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return i === 0 ? `${n} B` : `${n.toFixed(1)} ${units[i]}`;
}

module.exports = {
  KIND, MEDIA_EXT, PHOTO_EXT, VIDEO_EXT, AUDIO_EXT, ALBUM_MAX,
  fileKind, fileCategory, fileStem, isGibberish, folderNames, scanFolder, scanSources, makeAlbums, buildPlan, humanSize, naturalCompare,
  makeFilter, globsToRegExp,
};
