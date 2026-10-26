// Upload history: which files were already sent where. Kept in memory for fast lookups, made durable with an
// append-only journal written after every album, and compacted into uploaded.json (the same format FolderGram
// 2.x used, so older versions can still read it).
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { readJson, writeJson } = require('./store');

const COMPACT_AFTER = 5000; // journal lines

class UploadHistory {
  constructor(file, { onRecover } = {}) {
    this.file = file;
    this.journal = `${file}.journal`;
    this.data = readJson(file, {}, { onRecover });
    if (!this.data || typeof this.data !== 'object' || Array.isArray(this.data)) this.data = {};
    this.lines = 0;
    this.replay();
    this.fd = null;
  }

  /** Applies journal lines written after the last compaction (a torn last line from a crash is ignored). */
  replay() {
    let text;
    try { text = fs.readFileSync(this.journal, 'utf8'); } catch { return; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const [k, v] = JSON.parse(line);
        if (v === null) delete this.data[k]; else this.data[k] = v;
        this.lines++;
      } catch { /* torn line */ }
    }
  }

  /** Content fingerprint used by FolderGram 2.x: size plus the first and last 64 KB. Kept for compatibility. */
  static fingerprint(f) {
    const h = crypto.createHash('sha1').update(String(f.size));
    const fd = fs.openSync(f.path, 'r');
    try {
      const n = Math.min(65536, f.size);
      const buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, 0);
      h.update(buf);
      if (f.size > n) {
        fs.readSync(fd, buf, 0, n, f.size - n);
        h.update(buf);
      }
    } finally {
      fs.closeSync(fd);
    }
    return h.digest('hex');
  }

  static key(chatId, topic, f) {
    return crypto.createHash('sha1').update(`${chatId}|${topic}|${f.path}|${f.size}|${f.mtime}`).digest('hex');
  }

  has(k) { return Object.prototype.hasOwnProperty.call(this.data, k); }
  get(k) { return this.has(k) ? this.data[k] : undefined; }
  get size() { return Object.keys(this.data).length; }

  /** Records keys and makes them durable right away. */
  add(k, v = Date.now()) { this.addMany([[k, v]]); }

  addMany(pairs) {
    if (!pairs.length) return;
    for (const [k, v] of pairs) this.data[k] = v;
    try {
      if (this.fd == null) this.fd = fs.openSync(this.journal, 'a');
      fs.writeSync(this.fd, pairs.map((p) => JSON.stringify(p)).join('\n') + '\n');
      fs.fdatasyncSync(this.fd);
      this.lines += pairs.length;
    } catch {
      this.lines = COMPACT_AFTER; // the journal is unusable: compact now so nothing is lost
    }
    if (this.lines >= COMPACT_AFTER) this.save();
  }

  /** Writes everything into uploaded.json and empties the journal. */
  save() {
    writeJson(this.file, this.data);
    this.closeJournal();
    try { fs.writeFileSync(this.journal, ''); } catch { /* ignore */ }
    this.lines = 0;
  }

  closeJournal() {
    if (this.fd != null) {
      try { fs.closeSync(this.fd); } catch { /* ignore */ }
      this.fd = null;
    }
  }

  clear() {
    this.data = {};
    this.save();
  }
}

module.exports = { UploadHistory };
