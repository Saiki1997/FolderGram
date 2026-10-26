// Checks done just before a file is sent: it still exists, can be read, hasn't changed since the scan, and its
// content matches its extension well enough for Telegram to accept it as a photo or video.
'use strict';

const fsp = require('fs/promises');

/** Media type from the first bytes of a file: "image", "video", "audio", "empty" or null (unknown). */
function sniff(buf) {
  if (!buf || !buf.length) return 'empty';
  const hex = buf.subarray(0, 12).toString('hex');
  const ascii = buf.subarray(0, 12).toString('latin1');
  if (buf.every((b) => b === 0)) return 'empty';
  if (hex.startsWith('ffd8ff') || hex.startsWith('89504e47') || ascii.startsWith('GIF8') || ascii.startsWith('BM')
    || (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') || hex.startsWith('49492a00') || hex.startsWith('4d4d002a')) return 'image';
  if (ascii.slice(4, 8) === 'ftyp') {
    const brand = ascii.slice(8, 12);
    if (/^(heic|heix|heim|heis|hevc|mif1|msf1|avif)$/.test(brand)) return 'image';
    if (/^(M4A |M4B |M4P )$/.test(brand)) return 'audio';
    return 'video';
  }
  if (hex.startsWith('1a45dfa3') || (ascii.startsWith('RIFF') && ascii.slice(8, 11) === 'AVI') || hex.startsWith('000001ba') || hex.startsWith('000001b3')
    || hex.startsWith('3026b2758e66cf11') || ascii.startsWith('FLV')) return 'video';
  if (ascii.startsWith('ID3') || hex.startsWith('fffb') || hex.startsWith('fff3') || hex.startsWith('fff2') || ascii.startsWith('fLaC') || ascii.startsWith('OggS')
    || (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WAVE') || hex.startsWith('fff1') || hex.startsWith('fff9')) return 'audio';
  return null;
}

const EXPECT = {
  '.jpg': 'image', '.jpeg': 'image', '.png': 'image', '.bmp': 'image', '.gif': 'image', '.webp': 'image', '.heic': 'image', '.heif': 'image',
  '.tif': 'image', '.tiff': 'image',
  '.mp4': 'video', '.mov': 'video', '.m4v': 'video', '.mkv': 'video', '.webm': 'video', '.avi': 'video', '.3gp': 'video', '.wmv': 'video',
  '.flv': 'video', '.mpg': 'video', '.mpeg': 'video', '.ts': 'video',
  '.mp3': 'audio', '.m4a': 'audio', '.aac': 'audio', '.flac': 'audio', '.ogg': 'audio', '.opus': 'audio', '.wav': 'audio',
};

/**
 * Checks one scanned file. Returns { ok, missing, changed, unreadable, detected, warning, asDocument, size, mtime }.
 * `changed` means size or modification time differ from the scan; the caller decides what to do.
 */
async function checkFile(f) {
  let st;
  try {
    st = await fsp.stat(f.path);
  } catch (e) {
    return { ok: false, missing: e.code === 'ENOENT', unreadable: e.code !== 'ENOENT', warning: e.code === 'ENOENT' ? 'file no longer exists' : `can't open the file (${e.code})` };
  }
  if (!st.isFile()) return { ok: false, missing: true, warning: 'not a file any more' };
  const changed = st.size !== f.size || Math.floor(st.mtimeMs / 1000) !== f.mtime;
  if (!st.size) return { ok: false, unreadable: true, changed, warning: 'file is empty' };
  let head;
  try {
    const fh = await fsp.open(f.path, 'r');
    try {
      const buf = Buffer.alloc(Math.min(64, st.size));
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      head = buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  } catch (e) {
    return { ok: false, unreadable: true, changed, warning: `can't read the file (${e.code || e.message})` };
  }
  const detected = sniff(head);
  const expected = EXPECT[f.ext];
  let warning = changed ? 'changed since the scan' : '';
  let asDocument = false;
  if (detected === 'empty') {
    warning = 'starts with empty data and may be damaged; sending it as a file';
    asDocument = !!expected;
  } else if (expected && detected && detected !== expected) {
    warning = `named ${f.ext} but looks like ${detected === 'image' ? 'a picture' : detected === 'video' ? 'a video' : 'audio'}; sending it as a file`;
    asDocument = true;
  }
  return { ok: true, changed, detected, warning, asDocument, size: st.size, mtime: Math.floor(st.mtimeMs / 1000), mtimeMs: st.mtimeMs };
}

module.exports = { sniff, checkFile };
