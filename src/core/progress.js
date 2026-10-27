// Live upload progress for one job: every file, every album and the whole job, from real transferred bytes.
//
// Two byte counts are kept apart:
//   - progress ("logical") bytes: how much of each file Telegram has confirmed, never more than the file and never
//     going back (a retry that uploads a file again doesn't reset it, and isn't counted twice);
//   - network bytes: everything actually sent, retries included. Speeds come from these.
// Speeds use a rolling time window, so a burst or a pause shows up within seconds; the time left is smoothed but
// disappears (stalled) when nothing has moved for a while instead of showing a stale estimate.
'use strict';

const FILE_STATES = ['queued', 'preparing', 'uploading', 'uploaded', 'sending', 'done', 'failed', 'skipped', 'review'];
const ACTIVE = new Set(['preparing', 'uploading', 'uploaded', 'sending']);

/** Bytes per second over the last `windowMs`, from (time, total) samples. */
class RollingRate {
  constructor(windowMs = 5000, now = Date.now) {
    this.windowMs = windowMs;
    this.now = now;
    this.samples = []; // [t, total]
  }

  add(total, t = this.now()) {
    const last = this.samples[this.samples.length - 1];
    if (last && t - last[0] < 100) last[1] = total; // at most ~10 samples a second
    else this.samples.push([t, total]);
    while (this.samples.length > 2 && this.samples[1][0] <= t - this.windowMs) this.samples.shift();
  }

  /** Rate in bytes/s, or 0 when nothing moved in the window. */
  rate(t = this.now()) {
    if (!this.samples.length) return 0;
    const last = this.samples[this.samples.length - 1];
    // The oldest sample inside (or just before) the window; the end is "now" so a stop shows as a falling rate.
    let first = this.samples[0];
    for (const s of this.samples) { if (s[0] <= t - this.windowMs) first = s; else break; }
    const span = Math.max(t - first[0], 1000);
    return Math.max(0, (last[1] - first[1]) / (span / 1000));
  }

  /** Milliseconds since the total last went up. */
  idleMs(t = this.now()) {
    for (let i = this.samples.length - 1; i > 0; i--) if (this.samples[i][1] > this.samples[i - 1][1]) return t - this.samples[i][0];
    return this.samples.length ? t - this.samples[0][0] : Infinity;
  }
}

class ProgressTracker {
  /** opts: { now, windowMs (speed now), etaWindowMs, stallMs (no movement => no time left shown) } */
  constructor({ now = Date.now, windowMs = 5000, etaWindowMs = 30000, stallMs = 15000 } = {}) {
    this.now = now;
    this.stallMs = stallMs;
    this.files = new Map(); // path -> file record
    this.albums = new Map(); // key -> album record
    this.albumOrder = [];
    this.network = 0;
    this.logical = 0;
    this.netRate = new RollingRate(windowMs, now);
    this.logicalRate = new RollingRate(etaWindowMs, now);
    this.startedAt = now();
    this.activeMs = 0; // time spent transferring (not paused, not waiting for Telegram or the network)
    this.activeSince = null;
    this.status = 'starting';
    this.statusDetail = '';
    this.waitUntil = 0;
    this.eta = null;
    this.counts = { total: 0, done: 0, failed: 0, skipped: 0, review: 0 };
    this.bytesTotal = 0;
    this.goneBytes = 0; // bytes of failed and reviewed files that will not be sent
  }

  // ------------------------------------------------------------ set-up

  /** Registers the albums that will be sent: [{ key, title, topic, files: [{ path, name, size }] }]. */
  setAlbums(albums) {
    for (const a of albums) {
      if (this.albums.has(a.key)) continue;
      const rec = { key: a.key, title: a.title || '', topic: a.topic || '', files: a.files.map((f) => f.path), size: 0, status: 'waiting',
        delivered: 0, startedAt: null, doneAt: null, error: '' };
      for (const f of a.files) {
        if (!this.files.has(f.path)) {
          this.files.set(f.path, { path: f.path, name: f.name, album: rec.key, size: f.size || 0, logical: 0, frac: 0, network: 0, status: 'queued',
            rate: new RollingRate(3000, this.now), startedAt: null, doneAt: null });
          this.bytesTotal += f.size || 0;
          this.counts.total++;
        }
        rec.size += f.size || 0;
      }
      this.albums.set(a.key, rec);
      this.albumOrder.push(a.key);
    }
  }

  /** Files left out before sending (already uploaded, duplicates, too big). */
  skipped(n = 1) { this.counts.skipped += n; }

  // ------------------------------------------------------------ events

  /**
   * A file moved to `frac` (0..1) of its bytes. bytes: the size actually being sent (a resized photo is smaller than
   * the file). A fraction lower than the last one means the file is being uploaded again from the start.
   */
  fileProgress(path, frac, bytes = null) {
    const f = this.files.get(path);
    if (!f) return false;
    if (f.status === 'failed' || f.status === 'review') return true; // left the job: its bytes no longer count
    frac = Math.min(1, Math.max(0, Number(frac) || 0));
    const size = bytes ?? f.size;
    const sent = frac >= f.frac ? (frac - f.frac) * size : frac * size; // a restart sends from 0 again
    f.frac = frac;
    f.network += sent;
    this.network += sent;
    const logical = Math.round(frac * f.size);
    if (logical > f.logical) {
      this.logical += logical - f.logical;
      f.logical = logical;
    }
    if (!f.startedAt) f.startedAt = this.now();
    if (frac < 1 && ['queued', 'preparing'].includes(f.status)) f.status = 'uploading';
    if (frac >= 1 && ['queued', 'preparing', 'uploading'].includes(f.status)) f.status = 'uploaded';
    f.rate.add(f.network);
    this.touch();
    return true;
  }

  /** Album-level progress for transports that don't report files: spread over the album's files by size. */
  albumProgress(key, frac) {
    const a = this.albums.get(key);
    if (!a) return;
    frac = Math.min(1, Math.max(0, Number(frac) || 0));
    let left = frac * a.size;
    for (const p of a.files) {
      const f = this.files.get(p);
      if (!f || f.status === 'done' || f.status === 'failed') { left -= f ? f.size : 0; continue; }
      const take = Math.min(f.size, Math.max(0, left));
      left -= f.size;
      // Album-level numbers can't tell a restart from a late report, so they only ever move a file forwards.
      if (f.size && take / f.size > f.frac) this.fileProgress(p, take / f.size);
    }
  }

  fileStatus(path, status) {
    const f = this.files.get(path);
    if (!f || !FILE_STATES.includes(status) || ['done', 'failed', 'skipped'].includes(f.status)) return;
    f.status = status;
    if (ACTIVE.has(status) && !f.startedAt) f.startedAt = this.now();
  }

  albumStatus(key, status, detail = {}) {
    const a = this.albums.get(key);
    if (!a) return;
    a.status = status;
    if (status !== 'waiting' && !a.startedAt) a.startedAt = this.now();
    if (detail.error) a.error = detail.error;
    for (const p of a.files) {
      const f = this.files.get(p);
      if (!f) continue;
      if (status === 'sending') this.fileStatus(p, 'sending');
      else if ((status === 'preparing' || status === 'uploading') && f.status === 'queued') this.fileStatus(p, 'preparing');
    }
  }

  /** The album reached Telegram: its files count as done, and as fully uploaded even if no progress came. */
  delivered(key, paths = null) {
    const a = this.albums.get(key);
    if (!a) return;
    for (const p of paths || a.files) {
      const f = this.files.get(p);
      if (!f || f.status === 'done') continue;
      if (f.logical < f.size) { this.logical += f.size - f.logical; f.logical = f.size; }
      f.status = 'done';
      f.doneAt = this.now();
      a.delivered++;
      this.counts.done++;
    }
    a.status = 'done';
    a.doneAt = this.now();
    this.touch();
  }

  /** Files that failed (or are held for review): they no longer count as work left. */
  failed(paths, { review = false, key = null, error = '' } = {}) {
    for (const p of paths) {
      const f = this.files.get(p);
      if (!f || ['done', 'failed', 'review'].includes(f.status)) continue;
      f.status = review ? 'review' : 'failed';
      f.doneAt = this.now();
      this.goneBytes += f.size - f.logical;
      this.counts[review ? 'review' : 'failed']++;
    }
    if (key) this.albumStatus(key, review ? 'review' : 'failed', { error });
  }

  /** Job state: "uploading", "paused", "waiting" (flood wait), "offline", "checking", "done"… */
  setStatus(status, detail = '', waitSeconds = 0) {
    this.status = status;
    this.statusDetail = detail;
    this.waitUntil = waitSeconds ? this.now() + waitSeconds * 1000 : 0;
    if (status === 'uploading') this.touch();
    else this.pauseClock();
  }

  touch() {
    const t = this.now();
    if (this.activeSince == null) this.activeSince = t;
    this.netRate.add(this.network, t);
    this.logicalRate.add(this.logical, t);
  }

  pauseClock() {
    if (this.activeSince != null) { this.activeMs += this.now() - this.activeSince; this.activeSince = null; }
  }

  activeTime(t = this.now()) { return this.activeMs + (this.activeSince != null ? t - this.activeSince : 0); }

  // ------------------------------------------------------------ the numbers

  /** Seconds left, smoothed; null when nothing has moved for a while (a real stall shows as "stalled"). */
  timeLeft(t = this.now()) {
    const left = Math.max(0, this.bytesTotalLive() - this.logical);
    if (!left) return 0;
    if (this.netRate.idleMs(t) > this.stallMs && this.logicalRate.idleMs(t) > this.stallMs) { this.eta = null; return null; }
    const recent = this.logicalRate.rate(t);
    const active = this.activeTime(t) / 1000;
    const overall = active > 1 ? this.logical / active : 0;
    const rate = recent && overall ? 0.6 * recent + 0.4 * overall : recent || overall;
    if (!rate) return null;
    const raw = left / rate;
    // Smooth, but follow quickly when the estimate grows a lot (a slowdown must not be hidden).
    this.eta = this.eta == null || raw > this.eta * 1.5 ? raw : this.eta * 0.7 + raw * 0.3;
    return this.eta;
  }

  /** Total bytes still to do or done (failed and reviewed files drop out). */
  bytesTotalLive() { return this.bytesTotal - this.goneBytes; }

  snapshot({ maxFiles = 12, maxAlbums = 12 } = {}) {
    const t = this.now();
    const total = this.bytesTotalLive();
    const files = [];
    for (const f of this.files.values()) {
      if (!ACTIVE.has(f.status)) continue;
      const speed = f.status === 'uploading' ? f.rate.rate(t) : 0;
      const album = this.albums.get(f.album);
      files.push({ path: f.path, name: f.name, album: album ? album.title : '', topic: album ? album.topic : '', size: f.size, uploaded: f.logical,
        percent: f.size ? (100 * f.logical) / f.size : 100, speed, eta: speed > 0 ? (f.size - f.logical) / speed : null, status: f.status });
    }
    // Files moving bytes first; uploaded files waiting to be posted last.
    const RANK = { uploading: 0, preparing: 1, sending: 2, uploaded: 3 };
    files.sort((a, b) => (RANK[a.status] ?? 4) - (RANK[b.status] ?? 4));
    files.length = Math.min(files.length, maxFiles);
    // The album being sent, the next ones, and the most recent finished ones.
    const albums = [];
    const order = this.albumOrder;
    const firstOpen = order.findIndex((k) => !['done', 'failed', 'review'].includes(this.albums.get(k).status));
    const from = Math.max(0, (firstOpen < 0 ? order.length : firstOpen) - 4);
    for (const k of order.slice(from, from + maxAlbums)) {
      const a = this.albums.get(k);
      let up = 0, uploaded = 0, current = '';
      for (const p of a.files) {
        const f = this.files.get(p);
        if (!f) continue;
        up += f.logical;
        if (f.logical >= f.size) uploaded++;
        if (!current && (f.status === 'uploading' || f.status === 'preparing')) current = f.name;
      }
      albums.push({ key: a.key, title: a.title, topic: a.topic, count: a.files.length, size: a.size, uploaded, delivered: a.delivered, current,
        percent: a.size ? (100 * up) / a.size : a.status === 'done' ? 100 : 0, status: a.status, error: a.error });
    }
    const active = this.activeTime(t) / 1000;
    const c = this.counts;
    const moving = ['uploading', 'done'].includes(this.status);
    return {
      status: this.status, detail: this.statusDetail, waitSeconds: this.waitUntil > t ? Math.ceil((this.waitUntil - t) / 1000) : 0,
      files: { total: c.total, done: c.done, failed: c.failed, skipped: c.skipped, review: c.review, remaining: Math.max(0, c.total - c.done - c.failed - c.review) },
      bytes: { total, uploaded: Math.min(this.logical, total), remaining: Math.max(0, total - this.logical), network: Math.round(this.network) },
      percent: total ? Math.min(100, (100 * this.logical) / total) : 100,
      // While waiting (no connection, flood wait, paused) nothing is moving: no speed, and no time left to promise.
      speed: moving ? this.netRate.rate(t) : 0, averageSpeed: active > 0 ? this.network / active : 0, eta: moving ? this.timeLeft(t) : null,
      stalled: this.status === 'uploading' && this.netRate.idleMs(t) > this.stallMs,
      elapsed: (t - this.startedAt) / 1000, activeSeconds: active,
      activeFiles: files, albums,
    };
  }
}

module.exports = { ProgressTracker, RollingRate, FILE_STATES };
