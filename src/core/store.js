// Crash-safe files for settings, history, plans and jobs. Writes go to a temp file that is flushed to disk and
// then renamed over the original, the previous version is kept as ".bak", and a damaged file is set aside and
// replaced by the backup instead of being silently overwritten.
'use strict';

const fs = require('fs');
const path = require('path');

const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* not available */ } };

/** Writes `data` (string or Buffer) to `file` atomically, keeping the previous file as `file.bak`. */
function writeAtomic(file, data, { backup = true } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (backup && fs.existsSync(file)) {
    try { fs.copyFileSync(file, `${file}.bak`); } catch { /* best effort */ }
  }
  // Windows antivirus or indexers can hold the file for a moment: retry the rename briefly.
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      if (i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        throw e;
      }
      sleepSync(50 * (i + 1));
    }
  }
}

/**
 * Reads JSON from `file`. If it is missing, returns `fallback`. If it is damaged, the damaged copy is kept as
 * `file.corrupt-<time>` and the `.bak` copy is used (onRecover is told). Never throws for bad content.
 */
function readJson(file, fallback, { onRecover } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') onRecover && onRecover(`Couldn't read ${path.basename(file)}: ${e.message}`);
    return tryBackup(file, fallback, onRecover, false);
  }
  try {
    if (!text.trim()) throw new Error('empty file');
    return JSON.parse(text);
  } catch (e) {
    try { fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* ignore */ }
    return tryBackup(file, fallback, onRecover, true, e.message);
  }
}

function tryBackup(file, fallback, onRecover, damaged, why) {
  try {
    const v = JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8'));
    if (damaged) onRecover && onRecover(`${path.basename(file)} was damaged (${why}); restored the previous copy.`);
    return v;
  } catch {
    if (damaged) onRecover && onRecover(`${path.basename(file)} was damaged (${why}) and had no usable backup; it was kept aside and started fresh.`);
    return typeof fallback === 'function' ? fallback() : fallback;
  }
}

const writeJson = (file, value, opts) => writeAtomic(file, JSON.stringify(value), opts);

/**
 * Copies the given files into backups/<yyyy-mm-dd>/ once a day and keeps the newest `keep` days.
 * Returns the backup folder used, or null if today's backup already exists.
 */
function dailyBackup(dataDir, names, keep = 7, now = new Date()) {
  const root = path.join(dataDir, 'backups');
  const day = now.toISOString().slice(0, 10);
  const dir = path.join(root, day);
  if (fs.existsSync(dir)) return null;
  const present = names.filter((n) => fs.existsSync(path.join(dataDir, n)));
  if (!present.length) return null;
  fs.mkdirSync(dir, { recursive: true });
  for (const n of present) {
    try { fs.copyFileSync(path.join(dataDir, n), path.join(dir, n)); } catch { /* best effort */ }
  }
  const days = fs.readdirSync(root).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  for (const old of days.slice(0, Math.max(0, days.length - keep))) fs.rmSync(path.join(root, old), { recursive: true, force: true });
  return dir;
}

/** Lists backup days, newest first, with the files in each. */
function listBackups(dataDir) {
  const root = path.join(dataDir, 'backups');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse()
    .map((d) => ({ day: d, files: fs.readdirSync(path.join(root, d)) }));
}

module.exports = { writeAtomic, writeJson, readJson, dailyBackup, listBackups };
