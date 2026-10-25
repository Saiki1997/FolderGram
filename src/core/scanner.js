// Folder scanning and upload planning. Pure Node, no Telegram or Electron code, so it is easy to test.
'use strict';

const fs = require('fs');
const path = require('path');

const PHOTO_EXT = new Set(['.jpg', '.jpeg', '.png', '.bmp']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi', '.3gp', '.wmv', '.flv', '.mpg', '.mpeg', '.ts']);
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wav', '.wma']);
// Sent as files: Telegram would turn these into stickers, or can't show them as photos.
const OTHER_MEDIA_EXT = new Set(['.gif', '.webp', '.heic', '.heif', '.tif', '.tiff', '.raw', '.cr2', '.nef', '.arw', '.dng']);
const MEDIA_EXT = new Set([...PHOTO_EXT, ...VIDEO_EXT, ...AUDIO_EXT, ...OTHER_MEDIA_EXT]);

const PHOTO_MAX_BYTES = 10 * 1024 * 1024; // Telegram rejects compressed photos above 10 MB
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
  if (PHOTO_EXT.has(file.ext) && file.size <= PHOTO_MAX_BYTES) return KIND.PHOTO;
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

/**
 * Album name from a file name: drop the extension and trailing numbering, so
 * "Rem cosplay 01.jpg", "Rem cosplay (2).jpg" and "Rem cosplay_03.mp4" all give "Rem cosplay".
 * Returns "" when nothing useful is left (e.g. "0001.jpg", "IMG_2034.jpg").
 */
function fileStem(fileName) {
  let s = fileName.replace(/\.[^.]+$/, '');
  let prev;
  do {
    prev = s;
    s = s
      .replace(/\s*[([{]\s*\d+\s*[)\]}]\s*$/, '') // " (2)", "[03]"
      .replace(/[\s._\-#]*(?:part|pt|p|no|vol|img|pic|photo|video|vid)?[\s._\-#]*\d+$/i, '') // " 01", "_p3", "-12"
      .replace(/[\s._\-#]*copy$/i, '') // "name - Copy"
      .replace(/[\s._\-#]+$/, '');
  } while (s !== prev && s);
  s = s.trim();
  // Camera-style names ("IMG_2034", "DSC0001") carry no useful name.
  return /^(img|image|dsc|dscn|dcim|pxl|vid|mvimg|photo|video|pic|screenshot|wa|p)?$/i.test(s) ? '' : s;
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
function scanFolder(root, { recursive = true, includeAllFiles = false, types = null, sortBy = 'name' } = {}) {
  root = path.resolve(root);
  if (!fs.statSync(root).isDirectory()) throw new Error(`Not a folder: ${root}`);
  const groups = [];

  const walk = (folder) => {
    let entries;
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch (e) {
      return; // unreadable folder: skip it
    }
    const files = [];
    const dirs = [];
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) dirs.push(e.name);
      else if (e.isFile()) files.push(e.name);
    }
    const media = [];
    for (const name of files.sort(naturalCompare)) {
      if (SKIP_NAMES.has(name.toLowerCase())) continue;
      const ext = path.extname(name).toLowerCase();
      if (!includeAllFiles && !MEDIA_EXT.has(ext)) continue;
      if (types && types[fileCategory(ext)] === false) continue;
      const full = path.join(folder, name);
      const st = fs.statSync(full);
      if (!st.size) continue;
      media.push({ path: full, name, ext, size: st.size, mtime: Math.floor(st.mtimeMs / 1000), mtimeMs: st.mtimeMs });
    }
    if (sortBy === 'date') media.sort((a, b) => a.mtimeMs - b.mtimeMs || naturalCompare(a.name, b.name));
    if (media.length) {
      groups.push({
        ...folderNames(root, folder), // leaf, path, top
        relPath: path.relative(root, folder).split(path.sep).join('/') || '.',
        files: media,
        totalSize: media.reduce((a, f) => a + f.size, 0),
      });
    }
    if (recursive) for (const d of dirs.sort(naturalCompare)) walk(path.join(folder, d));
  };
  walk(root);
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
 * Turn scanned folders into an upload plan.
 *   topicBy "top":  nested folders go into the topic of their top-level parent ("Rem/Set 1" -> "Rem").
 *   topicBy "each": every folder gets its own topic ("Rem / Set 1").
 *   captionBy "folder":   albums are captioned with the folder's name.
 *   captionBy "filename": inside each folder, files that share a name (minus numbering, so
 *                         "Rem 01.jpg" and "Rem 02.jpg") form their own albums, captioned with that name.
 *   captionWhere "last" | "every" | "none": caption only the last album of each set, every album, or none.
 * The caption goes on the last item of an album, so Telegram shows it under the album.
 */
function buildPlan(folders, opts = {}) {
  const { topicBy = 'top', captionBy = 'folder', captionWhere = 'last', forceDocument = false, useAlbums = true } = opts;
  return folders.map((folder) => {
    const topicName = (topicBy === 'each' ? folder.path : folder.top).slice(0, 128);
    // When the folder is inside its topic, its own name is the useful caption; otherwise the full path.
    const folderCaption = topicBy === 'each' ? folder.path : folder.leaf;
    const sets = [];
    if (captionBy === 'filename') {
      const byStem = new Map();
      for (const f of folder.files) {
        const stem = fileStem(f.name) || folderCaption; // nameless files fall back to the folder name
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
  fileKind, fileCategory, fileStem, folderNames, scanFolder, makeAlbums, buildPlan, humanSize, naturalCompare,
};
