// How many files upload at once, how many connections a big file uses, and how long to pause between albums.
// Starts from a preset and adapts: slows down sharply on Telegram flood waits and network errors, speeds up slowly
// while things go well. The "max" preset also measures: it tries more connections only while that makes uploads
// measurably faster, and settles on the smallest number that gets the line's full speed.
'use strict';

const os = require('os');

const PRESETS = {
  // connections: parallel connections a big file's parts are spread over (see fastupload.js).
  conservative: { files: 1, maxFiles: 2, delayMs: 2000, workerScale: 0.5, connections: 2, maxConnections: 2 },
  balanced: { files: 3, maxFiles: 4, delayMs: 1000, workerScale: 1, connections: 4, maxConnections: 4 },
  fast: { files: 4, maxFiles: 6, delayMs: 400, workerScale: 1, connections: 8, maxConnections: 8 },
  // Maximum practical speed: starts like Balanced and climbs only while the measured speed improves.
  max: { files: 3, maxFiles: 6, delayMs: 300, workerScale: 1, connections: 4, maxConnections: 16, explore: true },
};
const MB = 1024 * 1024;
const LEVELS = [1, 2, 4, 6, 8, 12, 16];
const BIG_FILE = 20 * MB; // only files over 20 MB use the full number of connections (see connectionsFor)
const GAIN = 1.08; // a level must be 8% faster than the one below to be worth it
const SAMPLES = 2; // big files measured at a level before judging it
const REPROBE_AFTER = 40; // big files after settling before trying one level higher again

class AdaptiveConcurrency {
  /** preset: conservative | balanced | fast | max | custom (custom: { files, maxFiles, connections }). adaptive: false keeps it fixed. */
  constructor({ preset = 'balanced', custom = null, adaptive = true, delayMs = null, freemem = os.freemem } = {}) {
    const base = preset === 'custom' && custom ? { ...PRESETS.balanced, ...custom, maxConnections: custom.connections || PRESETS.balanced.connections }
      : PRESETS[preset] || PRESETS.balanced;
    this.base = { ...base, delayMs: delayMs != null ? delayMs : base.delayMs };
    this.files = this.base.files;
    this.connections = this.base.connections;
    this.ceiling = this.base.maxConnections || this.base.connections; // highest level allowed now (lowered after floods)
    this.delayMs = this.base.delayMs;
    this.adaptive = adaptive;
    this.explore = !!this.base.explore && adaptive;
    this.streak = 0;
    this.cooldown = 0; // albums left before a raised delay starts to relax
    this.freemem = freemem;
    this.rates = new Map(); // connections -> { rate (bytes/s, smoothed), n }
    this.phase = this.explore ? 'climb' : 'fixed';
    this.sinceSettled = 0;
    this.decisions = []; // what the explorer decided and why, for the debug log and the window
  }

  /** Files of the next album to upload at the same time, given their sizes. */
  filesFor(sizes = []) {
    let n = this.files;
    const avg = sizes.length ? sizes.reduce((a, b) => a + b, 0) / sizes.length : 0;
    if (avg > 500 * MB) n = Math.min(n, 2); // each big file already uses up to 8 connections
    if (this.freemem() < 400 * MB) n = 1;
    return Math.max(1, n);
  }

  /** Parallel connections for one file. */
  workersFor(size) {
    const w = size > 20 * MB ? 8 : size > 2 * MB ? 4 : 2;
    return Math.max(1, Math.round(w * this.base.workerScale));
  }

  /** Connections one file's parts are spread over: small files need few. */
  connectionsFor(size) {
    if (size <= 2 * MB) return 1;
    if (size <= 20 * MB) return Math.min(2, this.connections);
    return this.connections;
  }

  /**
   * One finished file upload: { bytes, ms, connections }. The explorer compares the speed of big files at the
   * current number of connections with the level below and moves up while it pays off.
   */
  observe({ bytes, ms, connections }) {
    if (!this.explore || !bytes || !ms || bytes < BIG_FILE || connections !== this.connections) return;
    const rate = bytes / (ms / 1000);
    const r = this.rates.get(connections) || { rate: 0, n: 0 };
    r.rate = r.n ? r.rate * 0.6 + rate * 0.4 : rate;
    r.n++;
    this.rates.set(connections, r);
    if (r.n < SAMPLES) return;
    const i = LEVELS.indexOf(connections);
    const below = LEVELS.slice(0, i).reverse().find((l) => this.rates.has(l) && this.rates.get(l).n >= SAMPLES);
    const up = LEVELS[i + 1];
    if (this.phase === 'settled') {
      if (++this.sinceSettled >= REPROBE_AFTER && up && up <= this.ceiling) { this.phase = 'climb'; this.rates.delete(up); this.decide(up, 'checking again whether more connections help'); }
      return;
    }
    if (below != null && r.rate < this.rates.get(below).rate * GAIN) {
      this.settle(below, `${connections} connections were not faster than ${below} (${mbps(r.rate)} vs ${mbps(this.rates.get(below).rate)})`);
      return;
    }
    if (up && up <= this.ceiling) this.decide(up, `${connections} connections: ${mbps(r.rate)}; trying ${up}`);
    else this.settle(connections, `${connections} connections: ${mbps(r.rate)}, the most allowed`);
  }

  decide(connections, why) {
    this.connections = connections;
    this.decisions.push({ at: Date.now(), connections, why });
    if (this.decisions.length > 50) this.decisions.shift();
  }

  settle(connections, why) {
    this.phase = 'settled';
    this.sinceSettled = 0;
    this.decide(connections, why);
  }

  success() {
    if (!this.adaptive) return;
    this.streak++;
    if (this.cooldown > 0 && --this.cooldown === 0) this.delayMs = Math.max(this.base.delayMs, Math.round(this.delayMs / 2));
    if (this.streak >= 4) {
      this.streak = 0;
      // The explorer owns the number of connections; the others recover towards their preset.
      if (!this.explore) this.connections = Math.min(this.base.connections, this.connections * 2);
      if (this.files < this.base.maxFiles) this.files++;
    }
  }

  /** Telegram asked to wait: halve parallel uploads and double the pause for a while. */
  flood(seconds) {
    if (!this.adaptive) return;
    this.streak = 0;
    this.files = Math.max(1, Math.floor(this.files / 2));
    this.connections = Math.max(1, Math.floor(this.connections / 2));
    if (this.explore) {
      // Telegram said this was too much: don't climb past the level we were at.
      this.ceiling = Math.max(1, Math.min(this.ceiling, this.connections * 2 - 1));
      this.settle(this.connections, `Telegram asked to slow down (${seconds}s wait)`);
    }
    this.delayMs = Math.min(15000, Math.max(this.delayMs * 2, seconds > 30 ? 3000 : 1500));
    this.cooldown = 10;
  }

  failure() {
    if (!this.adaptive) return;
    this.streak = 0;
    this.files = Math.max(1, this.files - 1);
  }

  state() { return { files: this.files, connections: this.connections, delayMs: this.delayMs, phase: this.phase, ceiling: this.ceiling }; }
}

const mbps = (r) => `${(r / MB).toFixed(1)} MB/s`;

module.exports = { AdaptiveConcurrency, PRESETS };
