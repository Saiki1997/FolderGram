// Local resource use: how much CPU, disk and memory FolderGram's own work may take (ffmpeg, hashing, photo analysis,
// window updates). Telegram pacing is NOT here and nothing in this file can change it: the safety engine
// (telegram-safety.js) and the upload speed preset (concurrency.js) decide what reaches Telegram, whatever profile
// is chosen here.
//
//  - RESOURCE_PROFILES: Low resource / Balanced / High performance.
//  - Limiter: one shared cap on ffmpeg processes for the whole app (thumbnails, video details, splitting, analysis).
//  - ResourceMonitor: samples CPU, memory and event-loop delay; under sustained pressure it steps the limits down to
//    the Low profile, and back up after a calm period (hysteresis, so it doesn't flip back and forth).
//  - Batcher / Coalescer: fewer, larger messages to the window instead of one per log line or progress tick.
'use strict';

const os = require('os');

const cpus = () => Math.max(1, (os.cpus() || []).length);

/** Each value is a ceiling for FolderGram's own local work. uiHz: window updates per second at most. */
const RESOURCE_PROFILES = {
  low: { label: 'Low resource', ffmpeg: 1, hashWorkers: 1, analysis: 2, videoInfo: 2, uiHz: 4, logBatchMs: 250 },
  balanced: { label: 'Balanced', ffmpeg: 2, hashWorkers: 2, analysis: 4, videoInfo: 4, uiHz: 8, logBatchMs: 150 },
  high: { label: 'High performance', ffmpeg: 'cpu/2', hashWorkers: 'cpu/2', analysis: 'cpu', videoInfo: 6, uiHz: 10, logBatchMs: 100 },
};

/** The numbers for a profile on this computer (cpu-relative values resolved and bounded). */
function resolveResourceProfile(name, n = cpus()) {
  const p = RESOURCE_PROFILES[name] || RESOURCE_PROFILES.balanced;
  const v = (x, lo, hi) => Math.max(lo, Math.min(hi, x === 'cpu' ? n : x === 'cpu/2' ? Math.floor(n / 2) : x));
  return { name: RESOURCE_PROFILES[name] ? name : 'balanced', label: p.label, ffmpeg: v(p.ffmpeg, 1, 4), hashWorkers: v(p.hashWorkers, 1, 4),
    analysis: v(p.analysis, 1, 8), videoInfo: v(p.videoInfo, 1, 6), uiHz: v(p.uiHz, 2, 10), logBatchMs: p.logBatchMs };
}

/** Counting semaphore whose limit can change while work is queued. */
class Limiter {
  constructor(limit = 2) { this.limit = Math.max(1, limit); this.active = 0; this.queue = []; this.peak = 0; }
  setLimit(n) { this.limit = Math.max(1, n | 0); this.pump(); }
  async run(fn) {
    await new Promise((resolve) => { this.queue.push(resolve); this.pump(); });
    try { return await fn(); } finally { this.active--; this.pump(); }
  }
  pump() {
    while (this.active < this.limit && this.queue.length) {
      this.active++;
      if (this.active > this.peak) this.peak = this.active;
      this.queue.shift()();
    }
  }
  state() { return { limit: this.limit, active: this.active, waiting: this.queue.length, peak: this.peak }; }
}

/** The app-wide ffmpeg cap (media.js, imaging.js and splitter.js run every process through it). */
const ffmpegLimiter = new Limiter(RESOURCE_PROFILES.balanced.ffmpeg);

/**
 * Collects items and hands them over in groups: at most one flush per `ms`, or at once when `max` items wait.
 * flush(items) is called with an array; nothing is lost on close() (the rest is flushed).
 */
class Batcher {
  constructor(flush, { ms = 150, max = 500, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    Object.assign(this, { onFlush: flush, ms, max, setTimer, clearTimer });
    this.items = [];
    this.timer = null;
  }
  push(item) {
    this.items.push(item);
    if (this.items.length >= this.max) this.flush();
    else if (!this.timer) { this.timer = this.setTimer(() => this.flush(), this.ms); if (this.timer && this.timer.unref) this.timer.unref(); }
  }
  flush() {
    if (this.timer) { this.clearTimer(this.timer); this.timer = null; }
    if (!this.items.length) return;
    const items = this.items;
    this.items = [];
    this.onFlush(items);
  }
  close() { this.flush(); }
}

/**
 * Latest-wins updates at most `hz` times a second, with a trailing update so the last value is never dropped (the
 * old throttle could leave the window showing a stale number when the final tick fell inside the quiet period).
 * final(value) true sends at once (for example the 100% tick).
 */
class Coalescer {
  constructor(send, { hz = 8, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    Object.assign(this, { send, now, setTimer, clearTimer });
    this.setHz(hz);
    this.last = 0;
    this.pending = undefined;
    this.timer = null;
  }
  setHz(hz) { this.interval = 1000 / Math.max(1, hz); }
  push(value, { final = false } = {}) {
    const t = this.now();
    if (final || t - this.last >= this.interval) { this.emit(value, t); return; }
    this.pending = value;
    if (!this.timer) {
      this.timer = this.setTimer(() => { this.timer = null; if (this.pending !== undefined) this.emit(this.pending, this.now()); }, this.interval - (t - this.last));
      if (this.timer && this.timer.unref) this.timer.unref();
    }
  }
  emit(value, t) {
    if (this.timer) { this.clearTimer(this.timer); this.timer = null; }
    this.pending = undefined;
    this.last = t;
    this.send(value);
  }
}

const DEFAULT_THRESHOLDS = { cpuPct: 85, loopDelayMs: 200, freeMemMB: 400, heapPct: 85, enterAfter: 3, leaveAfter: 5 };

/**
 * Samples resources every `intervalMs`. sources (all injectable for tests):
 *  appMetrics() -> [{ cpu: { percentCPUUsage }, memory: { workingSetSize (KB) } }] (Electron app.getAppMetrics),
 *  freemem(), heap() -> { used, limit } (bytes), loopDelayMs() -> p99 of the last period.
 * The pressure state changes only after `enterAfter` busy samples in a row, and goes back after `leaveAfter` calm
 * ones. onChange({ pressure, sample }) is called on each change.
 */
class ResourceMonitor {
  constructor({ intervalMs = 2000, thresholds = {}, appMetrics = null, freemem = os.freemem, heap = null, loopDelayMs = null, onChange = () => {}, onSample = () => {} } = {}) {
    this.intervalMs = intervalMs;
    this.t = { ...DEFAULT_THRESHOLDS, ...thresholds };
    this.appMetrics = appMetrics;
    this.freemem = freemem;
    this.heap = heap || defaultHeap;
    this.loopDelay = loopDelayMs || defaultLoopDelay();
    this.onChange = onChange;
    this.onSample = onSample;
    this.pressure = false;
    this.busyRun = 0;
    this.calmRun = 0;
    this.last = null;
    this.timer = null;
  }

  start() {
    if (this.timer) return this;
    this.timer = setInterval(() => { try { this.tick(); } catch { /* a failed sample is skipped */ } }, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
    return this;
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; if (this.loopDelay.stop) this.loopDelay.stop(); }

  sample() {
    let cpuPct = null;
    let rssMB = null;
    if (this.appMetrics) {
      const m = this.appMetrics() || [];
      cpuPct = m.reduce((a, p) => a + ((p.cpu && p.cpu.percentCPUUsage) || 0), 0);
      rssMB = Math.round(m.reduce((a, p) => a + ((p.memory && p.memory.workingSetSize) || 0), 0) / 1024);
    }
    const h = this.heap();
    return { at: Date.now(), cpuPct: cpuPct == null ? null : Math.round(cpuPct), rssMB, freeMemMB: Math.round(this.freemem() / 1048576),
      heapMB: Math.round(h.used / 1048576), heapPct: h.limit ? Math.round((100 * h.used) / h.limit) : null, loopDelayMs: Math.round(this.loopDelay() || 0) };
  }

  /** Why a sample counts as busy ([] when calm). CPU use is normalised by core count. */
  reasons(s) {
    const r = [];
    if (s.cpuPct != null && s.cpuPct / cpus() > this.t.cpuPct) r.push('cpu');
    if (s.loopDelayMs > this.t.loopDelayMs) r.push('event loop');
    if (s.freeMemMB < this.t.freeMemMB) r.push('memory');
    if (s.heapPct != null && s.heapPct > this.t.heapPct) r.push('heap');
    return r;
  }

  tick(s = this.sample()) {
    s.reasons = this.reasons(s);
    this.last = s;
    if (s.reasons.length) { this.busyRun++; this.calmRun = 0; } else { this.calmRun++; this.busyRun = 0; }
    const was = this.pressure;
    if (!was && this.busyRun >= this.t.enterAfter) this.pressure = true;
    if (was && this.calmRun >= this.t.leaveAfter) this.pressure = false;
    this.onSample(s);
    if (was !== this.pressure) this.onChange({ pressure: this.pressure, sample: s });
    return s;
  }
}

function defaultHeap() {
  const m = process.memoryUsage();
  let limit = 0;
  try { limit = require('v8').getHeapStatistics().heap_size_limit; } catch { /* unknown */ }
  return { used: m.heapUsed, limit };
}

function defaultLoopDelay() {
  try {
    const h = require('perf_hooks').monitorEventLoopDelay({ resolution: 20 });
    h.enable();
    const f = () => { const v = h.percentile(99) / 1e6; h.reset(); return v; };
    f.stop = () => h.disable();
    return f;
  } catch {
    return () => 0;
  }
}

/**
 * Ties it together: the chosen profile, stepped down to Low while the monitor reports pressure. apply(limits) is
 * called with the numbers in force whenever they change (main.js sets the ffmpeg cap, hash workers and UI rate).
 */
class PerformanceManager {
  constructor({ profile = 'balanced', apply = () => {}, monitor = null } = {}) {
    this.apply = apply;
    this.profile = resolveResourceProfile(profile);
    this.monitor = monitor;
    this.pressure = false;
    this.changes = [];
    this.push();
  }
  setProfile(name) { this.profile = resolveResourceProfile(name); this.push(); }
  setPressure(on, reasons = []) {
    if (on === this.pressure) return;
    this.pressure = on;
    this.changes.push({ at: new Date().toISOString(), pressure: on, reasons });
    if (this.changes.length > 50) this.changes.shift();
    this.push();
  }
  /** The profile's numbers, or Low's where lower, while under pressure. */
  limits() {
    if (!this.pressure) return { ...this.profile, throttled: false };
    const low = resolveResourceProfile('low');
    const out = { ...this.profile, throttled: true };
    for (const k of ['ffmpeg', 'hashWorkers', 'analysis', 'videoInfo', 'uiHz']) out[k] = Math.min(this.profile[k], low[k]);
    out.logBatchMs = Math.max(this.profile.logBatchMs, low.logBatchMs);
    return out;
  }
  push() { this.current = this.limits(); this.apply(this.current); }
  status() {
    return { profile: this.profile.name, limits: this.current, pressure: this.pressure, sample: this.monitor && this.monitor.last, changes: this.changes.slice(-10),
      ffmpeg: ffmpegLimiter.state() };
  }
}

module.exports = { RESOURCE_PROFILES, resolveResourceProfile, Limiter, ffmpegLimiter, Batcher, Coalescer, ResourceMonitor, PerformanceManager, DEFAULT_THRESHOLDS };
