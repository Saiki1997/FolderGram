// Splits videos that are over Telegram's size limit into playable parts with ffmpeg (bundled via ffmpeg-static).
// Streams are copied, not re-encoded, so splitting is fast and lossless; cuts land on keyframes.
'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

function ffmpegPath() {
  try {
    // In the packaged app the binary lives outside the asar archive.
    return require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');
  } catch {
    return null;
  }
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-20000); });
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, err }));
  });
}

/** Video length in seconds, read from ffmpeg's own report. */
async function duration(bin, file) {
  const { err } = await run(bin, ['-hide_banner', '-i', file]);
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err);
  if (!m) throw new Error(`Couldn't read the length of ${path.basename(file)}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * Split `file` into parts of at most `limitBytes` each. Returns scanner-style file entries in order,
 * named "<name> (part 1 of 3).<ext>", written to a temp folder that the caller removes with cleanup().
 */
async function splitVideo(file, limitBytes, { log = () => {}, tmpRoot = os.tmpdir() } = {}) {
  const bin = ffmpegPath();
  if (!bin) throw new Error('ffmpeg is missing, so the video can\'t be split.');
  const total = await duration(bin, file.path);
  const stem = file.name.replace(/\.[^.]+$/, '');
  const dir = path.join(tmpRoot, 'FolderGram-split', crypto.createHash('sha1').update(`${file.path}|${file.size}|${file.mtime}`).digest('hex').slice(0, 12));

  // Aim below the limit: parts can only end on keyframes, so sizes vary a little.
  let target = limitBytes * 0.9;
  for (let attempt = 1; attempt <= 4; attempt++) {
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true });
    const seconds = Math.max(1, Math.floor(total * (target / file.size)));
    log(`Splitting ${file.name} into ~${Math.ceil(total / seconds)} parts…`);
    const { code, err } = await run(bin, ['-hide_banner', '-loglevel', 'error', '-y', '-i', file.path,
      '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', '-f', 'segment', '-segment_time', String(seconds),
      '-reset_timestamps', '1', path.join(dir, `part%03d${file.ext}`)]);
    if (code !== 0) throw new Error(`ffmpeg couldn't split ${file.name}: ${err.trim().split('\n').pop()}`);
    const names = (await fsp.readdir(dir)).filter((n) => n.startsWith('part')).sort();
    const sizes = await Promise.all(names.map(async (n) => (await fsp.stat(path.join(dir, n))).size));
    if (sizes.every((s) => s <= limitBytes)) {
      // Every part must be a readable video, and together they must cover the whole video.
      let covered = 0;
      for (let i = 0; i < names.length; i++) {
        if (!sizes[i]) throw new Error(`ffmpeg made an empty part while splitting ${file.name}.`);
        covered += await duration(bin, path.join(dir, names[i])).catch(() => { throw new Error(`Part ${i + 1} of ${file.name} isn't playable.`); });
      }
      if (Math.abs(covered - total) > Math.max(2, total * 0.02)) {
        throw new Error(`The parts of ${file.name} add up to ${Math.round(covered)}s, not ${Math.round(total)}s, so they weren't sent.`);
      }
      const parts = [];
      for (let i = 0; i < names.length; i++) {
        const name = `${stem} (part ${i + 1} of ${names.length})${file.ext}`;
        const p = path.join(dir, name);
        await fsp.rename(path.join(dir, names[i]), p);
        parts.push({ path: p, name, ext: file.ext, size: sizes[i], mtime: file.mtime, mtimeMs: file.mtimeMs, partOf: file.path });
      }
      return { parts, cleanup: () => fsp.rm(dir, { recursive: true, force: true }).catch(() => {}) };
    }
    target *= 0.75; // a part came out too big (few keyframes): cut shorter pieces
  }
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  throw new Error(`Couldn't split ${file.name} into parts small enough for Telegram.`);
}

module.exports = { splitVideo, ffmpegPath, duration };
