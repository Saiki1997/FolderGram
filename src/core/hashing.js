// File fingerprints for duplicate detection. Quick fingerprints read 3 × 64 KB; full SHA-256 hashes stream the
// file in a worker thread so big files never block the window. Results are cached by path + size + mtime.
'use strict';

const crypto = require('crypto');
const fsp = require('fs/promises');
const fs = require('fs');
const { readJson, writeJson } = require('./store');

const SAMPLE = 65536;

/**
 * Quick fingerprints of a file: `quick` hashes the size and 64 KB from the start, middle and end; `legacy` is the
 * FolderGram 2.x fingerprint (start and end only), so duplicates recorded by older versions are still found.
 */
async function quickFingerprints(f) {
  const fh = await fsp.open(f.path, 'r');
  try {
    const n = Math.min(SAMPLE, f.size);
    const read = async (pos) => {
      const buf = Buffer.alloc(n);
      const { bytesRead } = await fh.read(buf, 0, n, pos);
      return buf.subarray(0, bytesRead);
    };
    const head = await read(0);
    const tail = f.size > n ? await read(f.size - n) : null;
    const mid = f.size > 3 * n ? await read(Math.floor(f.size / 2) - Math.floor(n / 2)) : null;
    const legacy = crypto.createHash('sha1').update(String(f.size)).update(head);
    if (tail) legacy.update(tail);
    const quick = crypto.createHash('sha1').update(`v3|${f.size}|`).update(head);
    if (mid) quick.update(mid);
    if (tail) quick.update(tail);
    return { quick: quick.digest('hex'), legacy: legacy.digest('hex') };
  } finally {
    await fh.close();
  }
}

// ---------------------------------------------------------------- full hashes in worker threads

// Inline source: worker files inside the packaged app.asar can't always be loaded by path.
const WORKER_SRC = `
const { parentPort } = require('worker_threads');
const crypto = require('crypto');
const fs = require('fs');
parentPort.on('message', ({ id, file }) => {
  const h = crypto.createHash('sha256');
  const s = fs.createReadStream(file, { highWaterMark: 1 << 20 });
  s.on('data', (d) => h.update(d));
  s.on('error', (e) => parentPort.postMessage({ id, error: e.code || e.message }));
  s.on('end', () => parentPort.postMessage({ id, hash: h.digest('hex') }));
});`;

class HashPool {
  constructor(size = 2) {
    this.size = size;
    this.workers = [];
    this.queue = [];
    this.waiting = new Map();
    this.seq = 0;
    this.disabled = false;
  }

  spawn() {
    let Worker;
    try { ({ Worker } = require('worker_threads')); } catch { this.disabled = true; return null; }
    const w = new Worker(WORKER_SRC, { eval: true });
    w.busy = false;
    w.on('message', ({ id, hash, error }) => {
      const p = this.waiting.get(id);
      this.waiting.delete(id);
      w.busy = false;
      w.unref(); // idle workers must not keep the app running
      if (p) (error ? p.reject(Object.assign(new Error(`Couldn't read ${p.file}: ${error}`), { code: error })) : p.resolve(hash));
      this.pump();
    });
    w.on('error', () => { this.workers = this.workers.filter((x) => x !== w); this.pump(); });
    w.unref(); // after the listeners, which would otherwise keep the app from exiting
    this.workers.push(w);
    return w;
  }

  /** SHA-256 of a file, hex. */
  hash(file) {
    if (this.disabled) return sha256Stream(file);
    return new Promise((resolve, reject) => {
      this.queue.push({ id: ++this.seq, file, resolve, reject });
      this.pump();
    });
  }

  pump() {
    while (this.queue.length) {
      let w = this.workers.find((x) => !x.busy);
      if (!w && this.workers.length < this.size) w = this.spawn();
      if (!w) {
        if (this.disabled) { const job = this.queue.shift(); sha256Stream(job.file).then(job.resolve, job.reject); continue; }
        return;
      }
      const job = this.queue.shift();
      w.busy = true;
      w.ref();
      this.waiting.set(job.id, job);
      w.postMessage({ id: job.id, file: job.file });
    }
  }

  async close() {
    await Promise.all(this.workers.map((w) => w.terminate()));
    this.workers = [];
  }
}

/** Streams a file through SHA-256 on this thread (used when worker threads are unavailable). */
function sha256Stream(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file, { highWaterMark: 1 << 20 }).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

// ---------------------------------------------------------------- cache

/** Remembers fingerprints by path + size + modification time, so unchanged files are never read twice. */
class HashCache {
  constructor(file, { max = 200000, pool = null } = {}) {
    this.file = file;
    this.max = max;
    this.map = new Map(Object.entries(file ? readJson(file, {}) : {}));
    this.pool = pool || new HashPool(2);
    this.dirty = false;
  }

  static key(f) { return `${f.path}|${f.size}|${Math.round(f.mtimeMs || f.mtime * 1000 || 0)}`; }

  entry(f) { return this.map.get(HashCache.key(f)) || null; }

  put(f, patch) {
    const k = HashCache.key(f);
    const v = { ...(this.map.get(k) || {}), ...patch };
    this.map.delete(k);
    this.map.set(k, v);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    this.dirty = true;
    return v;
  }

  async quick(f) {
    const e = this.entry(f);
    if (e && e.q && e.l) return { quick: e.q, legacy: e.l };
    const r = await quickFingerprints(f);
    this.put(f, { q: r.quick, l: r.legacy });
    return r;
  }

  async sha256(f) {
    const e = this.entry(f);
    if (e && e.s) return e.s;
    const s = await this.pool.hash(f.path);
    this.put(f, { s });
    return s;
  }

  save() {
    if (!this.dirty || !this.file) return;
    writeJson(this.file, Object.fromEntries(this.map), { backup: false });
    this.dirty = false;
  }
}

/** Runs `fn` over `items` with at most `limit` running at once; results keep the input order. */
async function mapLimit(items, limit, fn, shouldStop = () => false) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length && !shouldStop()) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

module.exports = { quickFingerprints, HashPool, HashCache, sha256Stream, mapLimit };
