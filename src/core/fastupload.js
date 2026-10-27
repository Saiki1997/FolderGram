// Fast uploads: a file's parts go out in parallel over several connections to the account's data center, the way
// Telegram Desktop (and FastTelethon for Python) upload. GramJS on its own sends every part over one connection,
// which caps the speed far below what most lines can do.
'use strict';

const crypto = require('crypto');
const fsp = require('fs/promises');

const PART = 512 * 1024; // the largest part Telegram accepts
const BIG = 10 * 1024 * 1024; // files over 10 MB use the "big file" calls
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A pause that ends early when `stop()` turns true (checked every 250 ms); `tick()` runs on each check. */
async function pause(ms, stop = () => false, tick = () => {}) {
  const end = Date.now() + ms;
  while (Date.now() < end && !stop()) {
    tick();
    await sleep(Math.min(250, end - Date.now()));
  }
}

/**
 * Upload speed limit shared by every upload (token bucket). bytesPerSecond 0 means no limit. A part bigger than one
 * second's budget goes when the bucket is full, so the average still keeps to the limit.
 */
class RateLimiter {
  constructor(bytesPerSecond = 0) { this.set(bytesPerSecond); }

  set(bytesPerSecond) {
    this.rate = Math.max(0, Number(bytesPerSecond) || 0);
    this.tokens = this.rate;
    this.last = Date.now();
  }

  async take(n, stop = () => false) {
    while (this.rate) {
      const now = Date.now();
      this.tokens = Math.min(this.rate, this.tokens + ((now - this.last) / 1000) * this.rate);
      this.last = now;
      if (this.tokens >= n || this.tokens >= this.rate) { this.tokens -= n; return; }
      if (stop()) return;
      await sleep(Math.max(5, Math.min(250, ((Math.min(n, this.rate) - this.tokens) / this.rate) * 1000)));
    }
  }
}

/** A part that gets no answer in time is sent again (Telegram keeps the last copy of a part). */
function withTimeout(p, ms) {
  let timer;
  return Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('TIMEOUT: no answer for a file part')), ms); })])
    .finally(() => clearTimeout(timer));
}

/** A random signed 64-bit id for a file being uploaded. */
const fileId = () => BigInt.asIntN(64, crypto.randomBytes(8).readBigUInt64LE());

/**
 * Pool of extra connections, made on first use and closed after a minute without uploads.
 * connect() -> Promise<sender> where sender has send(request), isConnected(), disconnect().
 */
class SenderPool {
  constructor(connect, { idleMs = 60000 } = {}) {
    this.connect = connect;
    this.idleMs = idleMs;
    this.senders = [];
    this.pending = new Map(); // index -> Promise<sender>
    this.users = 0;
    this.idle = null;
  }

  /** Sender number i (0-based), connecting or reconnecting it when needed. */
  async get(i) {
    const s = this.senders[i];
    if (s && s.isConnected()) return s;
    if (!this.pending.has(i)) {
      const p = (async () => {
        if (s) await Promise.resolve(s.disconnect()).catch(() => {});
        const fresh = await this.connect();
        this.senders[i] = fresh;
        return fresh;
      })().finally(() => this.pending.delete(i));
      this.pending.set(i, p);
    }
    return this.pending.get(i);
  }

  /** Marks the start and end of an upload so idle connections can be closed. */
  hold() { this.users++; clearTimeout(this.idle); }
  release() {
    if (--this.users > 0) return;
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.close(), this.idleMs);
    if (this.idle.unref) this.idle.unref();
  }

  async close() {
    clearTimeout(this.idle);
    const all = this.senders.splice(0);
    await Promise.all(all.map((s) => Promise.resolve(s && s.disconnect()).catch(() => {})));
  }
}

/**
 * Uploads one file. Returns what Telegram's send calls take as the file: { big, id, parts, name }, which the caller
 * turns into InputFile / InputFileBig.
 *
 * file: { name, size, path } or { name, buffer }. api: { saveBigPart(args), savePart(args) } -> request objects.
 * opts: { connections, perConnection, onProgress(frac), isCanceled(), floodSeconds(err), maxFloodSeconds,
 *   onWait(seconds) when Telegram asks to wait before more parts, activity() while waiting, limiter (RateLimiter) }
 */
async function uploadParallel(pool, api, file, opts = {}) {
  const { connections = 4, perConnection = 2, onProgress = () => {}, isCanceled = () => false,
    floodSeconds = () => null, maxFloodSeconds = 60, isDisconnect = () => false, partTimeoutMs = 120000, onWait = () => {}, activity = () => {},
    limiter = null } = opts;
  const size = file.buffer ? file.buffer.length : file.size;
  const parts = Math.max(1, Math.ceil(size / PART));
  const big = size > BIG;
  const id = fileId();
  const fh = file.buffer ? null : await fsp.open(file.path, 'r');
  let next = 0;
  let sent = 0;
  let failed = null;
  pool.hold();
  try {
    const read = async (n) => {
      const start = n * PART;
      const len = Math.min(PART, size - start);
      if (file.buffer) return file.buffer.subarray(start, start + len);
      const buf = Buffer.allocUnsafe(len);
      let got = 0;
      while (got < len) {
        const { bytesRead } = await fh.read(buf, got, len - got, start + got);
        if (!bytesRead) throw new Error(`${file.name} got shorter while uploading`);
        got += bytesRead;
      }
      return buf;
    };
    const worker = async (slot) => {
      const conn = slot % connections;
      while (!failed) {
        if (isCanceled()) throw Object.assign(new Error('USER_CANCELED'), { errorMessage: 'USER_CANCELED' });
        const n = next++;
        if (n >= parts) return;
        const bytes = await read(n);
        const req = big ? api.saveBigPart({ fileId: id, filePart: n, fileTotalParts: parts, bytes }) : api.savePart({ fileId: id, filePart: n, bytes });
        for (let attempt = 1; ; attempt++) {
          if (failed) return;
          let sender;
          try {
            if (limiter) await limiter.take(bytes.length, () => isCanceled() || !!failed);
            sender = await pool.get(conn);
            const ok = await withTimeout(sender.send(req), partTimeoutMs);
            if (ok === false) throw new Error('Telegram did not save a file part');
            break;
          } catch (e) {
            if (isCanceled()) throw Object.assign(new Error('USER_CANCELED'), { errorMessage: 'USER_CANCELED' });
            if (e.connectFailed) throw e; // the caller falls back to a single connection
            const wait = floodSeconds(e);
            if (wait != null) {
              // A long wait goes back to the uploader, which shows it, slows down and retries the album.
              if (wait > maxFloodSeconds) throw e;
              onWait(wait);
              await pause((wait + 1) * 1000, () => isCanceled() || !!failed, activity);
              continue;
            }
            if (attempt >= 5) throw e;
            if (isDisconnect(e) || (sender && !sender.isConnected())) await sleep(500 * attempt);
            else await sleep(1000 * attempt);
          }
        }
        sent += bytes.length;
        onProgress(Math.min(1, sent / (size || 1)));
      }
    };
    const n = Math.max(1, Math.min(parts, connections * perConnection));
    await Promise.all(Array.from({ length: n }, (_, i) => worker(i).catch((e) => { failed = failed || e; })));
    if (failed) throw failed;
    return { big, id, parts, name: file.name };
  } finally {
    pool.release();
    if (fh) await fh.close().catch(() => {});
  }
}

module.exports = { SenderPool, uploadParallel, RateLimiter, PART, pause };
