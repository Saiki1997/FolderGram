// Downloads from Telegram to this PC: whole topics or chosen albums, into "<group>/<topic>/<album>/<file>".
// Pieces go to "<file>.part" first, so an interrupted download continues where it stopped; a finished file gets its
// real name only after its size checks out. A manifest in the destination remembers what was downloaded, so the
// same message is never downloaded twice and the folder sync never uploads it back. Existing files are skipped,
// renamed or overwritten only as the user's policy says (skip by default).
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { readJson, writeJson } = require('./store');
const { RollingRate } = require('./progress');

const CHUNK = 512 * 1024;
const MANIFEST = '.foldergram-downloads.json';
const POLICIES = ['skip', 'rename', 'overwrite'];

/** A file or folder name Windows accepts: no reserved characters or names, no trailing dots or spaces. */
function safeName(name, fallback = 'untitled') {
  let s = String(name || '').replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = `_${s}`;
  if ([...s].length > 120) s = [...s].slice(0, 120).join('').trim();
  return s || fallback;
}

/** "name (2).ext", "name (3).ext"… the first that doesn't exist. */
async function freeName(file) {
  const ext = path.extname(file);
  const base = file.slice(0, file.length - ext.length);
  for (let i = 2; i < 10000; i++) {
    const p = `${base} (${i})${ext}`;
    if (!(await exists(p))) return p;
  }
  throw new Error(`No free name for ${file}`);
}
const exists = (p) => fsp.stat(p).then(() => true, () => false);

class DownloadManifest {
  constructor(dir) {
    this.file = path.join(dir, MANIFEST);
    this.data = readJson(this.file, {});
    if (!this.data || typeof this.data !== 'object' || Array.isArray(this.data)) this.data = {};
  }
  static key(chatId, msgId) { return `${chatId}:${msgId}`; }
  get(chatId, msgId) { return this.data[DownloadManifest.key(chatId, msgId)] || null; }
  set(chatId, msgId, v) { this.data[DownloadManifest.key(chatId, msgId)] = v; }
  /** Relative paths written by downloads: the folder sync leaves these alone. */
  paths() { return new Set(Object.values(this.data).map((v) => v.path)); }
  save() { writeJson(this.file, this.data, { backup: false }); }
}

/**
 * One download job. items: [{ msgId, fileName, size, kind, topic, album, date }] from the library; chat: { id, title }.
 * opts: { dest, policy: skip|rename|overwrite, layout: 'topic/album' | 'topic' | 'flat', verify (sha256 into the
 * manifest), limiter (fastupload RateLimiter) }. events: { progress(snapshot), log(text, level) }.
 */
class DownloadJob {
  constructor(transport, chat, items, opts = {}, events = {}) {
    this.t = transport;
    this.chat = chat;
    this.items = items;
    this.opts = { policy: 'skip', layout: 'topic/album', verify: true, ...opts };
    if (!POLICIES.includes(this.opts.policy)) this.opts.policy = 'skip';
    this.ev = { progress() {}, log() {}, ...events };
    this.cancelled = false;
    this.stats = { files: items.length, done: 0, skipped: 0, failed: 0, bytesTotal: items.reduce((a, i) => a + (i.size || 0), 0), bytesDone: 0, errors: [] };
    this.rate = new RollingRate(5000);
    this.current = null;
  }

  cancel() { this.cancelled = true; }

  /** Where an item goes, relative to the destination folder. */
  relPath(it) {
    const parts = [safeName(this.chat.title, 'Telegram')];
    if (this.opts.layout !== 'flat') parts.push(safeName(it.topic || 'General'));
    if (this.opts.layout === 'topic/album') parts.push(safeName(it.album || dateName(it.date), dateName(it.date)));
    parts.push(safeName(it.fileName, `file_${it.msgId}`));
    return path.join(...parts);
  }

  snapshot() {
    const s = this.stats;
    return { ...s, errors: s.errors.slice(-20), speed: this.rate.rate(), current: this.current,
      percent: s.bytesTotal ? Math.min(100, (100 * s.bytesDone) / s.bytesTotal) : (s.done + s.skipped + s.failed) / Math.max(1, s.files) * 100 };
  }

  async run() {
    const dest = this.opts.dest;
    await fsp.mkdir(dest, { recursive: true });
    const manifest = new DownloadManifest(dest);
    try {
      for (const it of this.items) {
        if (this.cancelled) break;
        try {
          await this.one(it, manifest);
        } catch (e) {
          if (this.cancelled || (e && e.errorMessage === 'USER_CANCELED')) break;
          this.stats.failed++;
          this.stats.errors.push({ file: it.fileName, error: (e && (e.errorMessage || e.message)) || String(e) });
          this.ev.log(`✗ ${it.fileName}: ${(e && (e.errorMessage || e.message)) || e}`, 'error');
        }
        manifest.save();
        this.ev.progress(this.snapshot());
      }
    } finally {
      manifest.save();
    }
    this.current = null;
    this.ev.progress(this.snapshot());
    return this.snapshot();
  }

  async one(it, manifest) {
    const dest = this.opts.dest;
    const known = manifest.get(this.chat.id, it.msgId);
    if (known && (await fsp.stat(path.join(dest, known.path)).then((st) => st.size === known.size, () => false))) {
      this.skip(it, `already downloaded as ${known.path}`);
      return;
    }
    let target = path.join(dest, this.relPath(it));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const part = `${target}.part`;
    if (await exists(target)) {
      const st = await fsp.stat(target);
      if (this.opts.policy === 'skip') {
        // The same name and size: most likely this very file, from before the manifest knew it.
        if (it.size && st.size === it.size) manifest.set(this.chat.id, it.msgId, { path: path.relative(dest, target), size: st.size, at: Date.now(), adopted: true });
        this.skip(it, `${path.basename(target)} already exists`);
        return;
      }
      if (this.opts.policy === 'rename') target = await freeName(target);
    }
    this.current = { name: it.fileName, size: it.size, done: 0 };
    // Resume: keep whole 512 KB pieces of an earlier attempt.
    let offset = 0;
    try { offset = Math.floor((await fsp.stat(part)).size / CHUNK) * CHUNK; } catch { /* new download */ }
    if (offset && it.size && offset > it.size) offset = 0;
    const fh = await fsp.open(part, offset ? 'r+' : 'w');
    let pos = offset;
    try {
      if (offset) await fh.truncate(offset);
      if (offset) this.ev.log(`↻ ${it.fileName}: continuing at ${Math.round(offset / 1024 / 1024)} MB`, 'info');
      this.stats.bytesDone += offset;
      this.current.done = offset;
      await this.t.downloadMessageFile(this.chat, it.msgId, {
        offset,
        limiter: this.opts.limiter || null,
        isCanceled: () => this.cancelled,
        onChunk: async (buf) => {
          await fh.write(buf, 0, buf.length, pos);
          pos += buf.length;
          this.stats.bytesDone += buf.length;
          this.current.done = pos;
          this.rate.add(this.stats.bytesDone);
          this.ev.progress(this.snapshot());
        },
      });
      await fh.sync();
    } finally {
      await fh.close();
    }
    // Check before giving it its name: a short file is left as .part to continue later.
    const size = (await fsp.stat(part)).size;
    if (it.size && size !== it.size) throw new Error(`size ${size} instead of ${it.size}; it will continue next time`);
    if (this.opts.policy === 'overwrite') await fsp.rm(target, { force: true });
    else if (await exists(target)) target = await freeName(target); // appeared meanwhile: never replace it
    await fsp.rename(part, target);
    const entry = { path: path.relative(dest, target), size, at: Date.now() };
    if (this.opts.verify) entry.sha256 = await sha256(target);
    manifest.set(this.chat.id, it.msgId, entry);
    this.stats.done++;
    this.ev.log(`↓ ${entry.path}`, 'ok');
  }

  skip(it, why) {
    this.stats.skipped++;
    this.stats.bytesTotal -= it.size || 0;
    this.ev.log(`↷ ${it.fileName}: ${why}`, 'info');
  }
}

const dateName = (unix) => (unix ? new Date(unix * 1000).toISOString().slice(0, 10) : 'Undated');

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

module.exports = { DownloadJob, DownloadManifest, safeName, MANIFEST, POLICIES };
