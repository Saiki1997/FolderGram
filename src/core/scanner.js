// Folder scanning and upload planning. Pure Node, no Telegram or Electron code, so it is easy to test.
'use strict';

const fsp = require('fs/promises');
const path = require('path');

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
  if (forceDocument) return KIND.DOC;
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

/**
 * types: which categories to include, e.g. { photo: true, video: true, audio: false, other: true }.
 * sortBy: "name" (natural order, img2 before img10) or "date" (oldest modified first).
 */
/** Reads size and date of the named files, keeping only wanted types. Stats run in parallel. */
async function readFiles(folder, names, { includeAllFiles = false, types = null, sortBy = 'name' } = {}) {
  const wanted = names.filter((name) => {
    if (name.startsWith('.') || SKIP_NAMES.has(name.toLowerCase())) return false;
    const ext = path.extname(name).toLowerCase();
    if (!includeAllFiles && !MEDIA_EXT.has(ext)) return false;
    return !(types && types[fileCategory(ext)] === false);
  });
  const stats = await Promise.all(wanted.map((name) => fsp.stat(path.join(folder, name)).catch(() => null)));
  const media = [];
  wanted.forEach((name, i) => {
    const st = stats[i];
    if (!st || !st.isFile() || !st.size) return;
    media.push({ path: path.join(folder, name), name, ext: path.extname(name).toLowerCase(), size: st.size,
      mtime: Math.floor(st.mtimeMs / 1000), mtimeMs: st.mtimeMs });
  });
  media.sort(sortBy === 'date' ? (a, b) => a.mtimeMs - b.mtimeMs || naturalCompare(a.name, b.name) : (a, b) => naturalCompare(a.name, b.name));
  return media;
}

const makeGroup = (names, relPath, files) => ({ ...names, relPath, files, totalSize: files.reduce((a, f) => a + f.size, 0) });

/** One group per folder (the root and, if recursive, every subfolder) that holds matching files. */
async function scanFolder(root, opts = {}) {
  const { recursive = true } = opts;
  root = path.resolve(root);
  if (!(await fsp.stat(root)).isDirectory()) throw new Error(`Not a folder: ${root}`);
  const groups = [];

  const walk = async (folder) => {
    let entries;
    try {
      entries = await fsp.readdir(folder, { withFileTypes: true });
    } catch {
      return; // unreadable folder: skip it
    }
    const files = [];
    const dirs = [];
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) dirs.push(e.name);
      else if (e.isFile()) files.push(e.name);
    }
    const media = await readFiles(folder, files, opts);
    if (media.length) {
      groups.push(makeGroup(folderNames(root, folder), path.relative(root, folder).split(path.sep).join('/') || '.', media));
    }
    if (recursive) for (const d of dirs.sort(naturalCompare)) await walk(path.join(folder, d));
  };
  await walk(root);
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
    const media = await readFiles(dir, [...new Set(names)], opts);
    const name = path.basename(dir) || dir;
    if (media.length) groups.push(makeGroup({ leaf: name, path: name, top: name }, '.', media));
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

/**
 * True for random-looking folder names such as "2Zy6lA (GoFile)", "kb03wM" or "fEQHwf": one short token of
 * mixed-up letters and digits. Real names ("Loose Files (GoFile)", "Rem", "ReZero", "Set 1", "NASA") are kept.
 * A trailing "(site)" or "[tag]" is ignored when judging.
 */
function isGibberish(name) {
  const core = name.replace(/\s*[([{][^)\]}]*[)\]}]\s*$/g, '').trim();
  if (!/^[A-Za-z0-9]{4,16}$/.test(core)) return false; // spaces, punctuation or odd length: treat as a real name
  if (/^\d+$/.test(core)) return false; // plain numbers like "2024"
  const word = core.replace(/\d{1,3}$/, ''); // "Vol2", "Set10" are fine if the letters are a word
  if (/\d/.test(word)) return true; // digits mixed inside letters
  if (!/^(?:[A-Z]?[a-z]+)+$|^[A-Z]+$/.test(word)) return true; // case jumps like "cfLHwd", "kVNZAi"
  const vowels = (word.match(/[aeiouy]/gi) || []).length;
  return vowels / word.length < 0.2; // "xkqztr": no vowels
}

/** Gives random-looking names a readable stand-in ("Album 1", "Album 2", …), the same one for the same name. */
function renamer(prefix = 'Album') {
  const names = new Map();
  const one = (n) => {
    if (!isGibberish(n)) return n;
    if (!names.has(n)) names.set(n, `${prefix} ${names.size + 1}`);
    return names.get(n);
  };
  return (text) => text.split(' / ').map(one).join(' / ');
}

/**
 * Turn scanned folders into an upload plan.
 *   topicBy "top":  nested folders go into the topic of their top-level parent ("Rem/Set 1" -> "Rem").
 *   topicBy "each": every folder gets its own topic ("Rem / Set 1").
 *   captionBy "folder":   albums are captioned with the folder's name.
 *   captionBy "filename": inside each folder, files that share a name form their own albums, captioned
 *                         with that name. For videos, opts.nameMatch says what counts as the same name
 *                         (see fileStem); photos and other files always ignore trailing numbers.
 *   captionWhere "last" | "every" | "none": caption only the last album of each set, every album, or none.
 *   renameGibberish: random folder names (see isGibberish) become "<albumPrefix> 1", "<albumPrefix> 2", …
 * The caption goes on the last item of an album, so Telegram shows it under the album.
 */
function buildPlan(folders, opts = {}) {
  const { topicBy = 'top', captionBy = 'folder', captionWhere = 'last', nameMatch = 'series', forceDocument = false, useAlbums = true,
    renameGibberish = false, albumPrefix = 'Album' } = opts;
  const rename = renameGibberish ? renamer((albumPrefix || 'Album').trim() || 'Album') : (n) => n;
  return folders.map((folder) => {
    const topicName = rename(topicBy === 'each' ? folder.path : folder.top).slice(0, 128);
    // When the folder is inside its topic, its own name is the useful caption; otherwise the full path.
    const folderCaption = rename(topicBy === 'each' ? folder.path : folder.leaf);
    const sets = [];
    if (captionBy === 'filename') {
      const byStem = new Map();
      for (const f of folder.files) {
        // The "same name" setting is for videos; photo sets are always grouped ignoring numbers ("Rem 01", "Rem 02").
        const stem = fileStem(f.name, VIDEO_EXT.has(f.ext) ? nameMatch : 'loose') || folderCaption; // nameless files fall back to the folder name
        const key = stem.toLowerCase();
        if (!byStem.has(key)) byStem.set(key, { name: stem, files: [] });
        byStem.get(key).files.push(f);
      }
      sets.push(...byStem.values());
    } else {
      sets.push({ name: folderCaption, files: folder.files });
    }
    const albums = [];
    for (const set of sets) {
      const parts = makeAlbums(set.files, { forceDocument, useAlbums });
      parts.forEach((files, i) => {
        const captioned = captionWhere === 'every' || (captionWhere === 'last' && i === parts.length - 1);
        albums.push({ files, caption: captioned ? set.name : '', set: set.name });
      });
    }
    return { folder, topicName, header: folderCaption, albums };
  });
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
};
