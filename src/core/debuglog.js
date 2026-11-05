// Debug log on disk: one file per day in <data>/logs, the last 7 days kept, each day capped at 20 MB (the oldest half
// is moved to a ".1" file). Every upload step, connection and full Telegram error goes here, so a problem can be
// looked at after the fact. Login codes, passwords, API hashes and session strings are never written.
'use strict';

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 20 * 1024 * 1024;
const KEEP_DAYS = 7;
const SECRET = /(apiHash|api_hash|password|botToken|authKey|sessionString)(["'\s:=]+)([^\s,"'}]+)/gi;

/** Short, safe text for any value, including errors with GramJS' extra fields. */
function describe(v) {
  if (v instanceof Error || (v && v.errorMessage)) {
    const e = v;
    const bits = [e.errorMessage, e.code != null ? `code ${e.code}` : '', e.seconds != null ? `${e.seconds}s` : '', e.message];
    const stack = String(e.stack || '').split('\n').slice(1, 4).map((s) => s.trim()).join(' | ');
    return `${[...new Set(bits.filter(Boolean))].join(' · ')}${stack ? ` [${stack}]` : ''}`;
  }
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'object' && v !== null) {
    try { return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : Buffer.isBuffer(x) ? `<${x.length} bytes>` : x)); } catch { return String(v); }
  }
  return String(v);
}

class DebugLog {
  constructor(dir, { now = () => new Date() } = {}) {
    this.dir = dir;
    this.now = now;
    this.fd = null;
    this.day = '';
    this.size = 0;
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* logging is best effort */ }
    this.prune();
  }

  file(day = this.today()) { return path.join(this.dir, `foldergram-${day}.log`); }
  today() { return this.now().toISOString().slice(0, 10); }

  open() {
    const day = this.today();
    if (this.fd != null && day === this.day) return;
    this.close();
    this.day = day;
    try {
      this.fd = fs.openSync(this.file(day), 'a');
      this.size = fs.fstatSync(this.fd).size;
    } catch { this.fd = null; }
  }

  /** area: "upload", "telegram", "queue"…; parts are joined with spaces (errors and objects are described). */
  write(area, ...parts) {
    this.open();
    if (this.fd == null) return;
    const text = parts.map((p) => (typeof p === 'string' ? p : describe(p))).join(' ').replace(SECRET, '$1$2***').replace(/\r?\n/g, ' ⏎ ');
    const line = `${this.now().toISOString()} [${area}] ${text}\n`;
    try {
      fs.writeSync(this.fd, line);
      this.size += Buffer.byteLength(line);
      if (this.size > MAX_BYTES) this.roll();
    } catch { /* disk full or similar: keep going without the log */ }
  }

  roll() {
    const f = this.file(this.day);
    this.close();
    try { fs.renameSync(f, `${f}.1`); } catch { /* ignore */ }
    this.open();
  }

  prune() {
    try {
      const files = fs.readdirSync(this.dir).filter((n) => /^foldergram-\d{4}-\d{2}-\d{2}\.log(\.1)?$/.test(n)).sort();
      const days = [...new Set(files.map((n) => n.slice(11, 21)))].sort();
      const old = new Set(days.slice(0, Math.max(0, days.length - KEEP_DAYS)));
      for (const n of files) if (old.has(n.slice(11, 21))) fs.rmSync(path.join(this.dir, n), { force: true });
    } catch { /* ignore */ }
  }

  /** Log files, newest first. */
  list() {
    try {
      return fs.readdirSync(this.dir).filter((n) => n.startsWith('foldergram-')).sort().reverse().map((n) => path.join(this.dir, n));
    } catch { return []; }
  }

  close() {
    if (this.fd != null) { try { fs.closeSync(this.fd); } catch { /* ignore */ } this.fd = null; }
  }
}

/** A logger that does nothing, for tests and before the data folder is known. */
const nullLog = { write() {} };

module.exports = { DebugLog, nullLog, describe };
