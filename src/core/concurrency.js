// How many files upload at once, and how long to pause between albums. Starts from a preset and adapts:
// slows down sharply on Telegram flood waits and network errors, speeds up slowly while things go well.
'use strict';

const os = require('os');

const PRESETS = {
  // connections: parallel connections a big file's parts are spread over (see fastupload.js).
  conservative: { files: 1, maxFiles: 2, delayMs: 2000, workerScale: 0.5, connections: 2 },
  balanced: { files: 3, maxFiles: 4, delayMs: 1000, workerScale: 1, connections: 4 },
  fast: { files: 4, maxFiles: 6, delayMs: 400, workerScale: 1, connections: 8 },
};
const MB = 1024 * 1024;

class AdaptiveConcurrency {
  /** preset: conservative | balanced | fast | custom (with custom: { files, maxFiles, delayMs }). adaptive: false keeps it fixed. */
  constructor({ preset = 'balanced', custom = null, adaptive = true, delayMs = null, freemem = os.freemem } = {}) {
    const base = preset === 'custom' && custom ? { ...PRESETS.balanced, ...custom } : PRESETS[preset] || PRESETS.balanced;
    this.base = { ...base, delayMs: delayMs != null ? delayMs : base.delayMs };
    this.files = this.base.files;
    this.connections = this.base.connections;
    this.delayMs = this.base.delayMs;
    this.adaptive = adaptive;
    this.streak = 0;
    this.cooldown = 0; // albums left before a raised delay starts to relax
    this.freemem = freemem;
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

  success() {
    if (!this.adaptive) return;
    this.streak++;
    if (this.cooldown > 0 && --this.cooldown === 0) this.delayMs = Math.max(this.base.delayMs, Math.round(this.delayMs / 2));
    if (this.streak >= 4) {
      this.streak = 0;
      this.connections = Math.min(this.base.connections, this.connections * 2);
      if (this.files < this.base.maxFiles) this.files++;
    }
  }

  /** Telegram asked to wait: halve parallel uploads and double the pause for a while. */
  flood(seconds) {
    if (!this.adaptive) return;
    this.streak = 0;
    this.files = Math.max(1, Math.floor(this.files / 2));
    this.connections = Math.max(1, Math.floor(this.connections / 2));
    this.delayMs = Math.min(15000, Math.max(this.delayMs * 2, seconds > 30 ? 3000 : 1500));
    this.cooldown = 10;
  }

  failure() {
    if (!this.adaptive) return;
    this.streak = 0;
    this.files = Math.max(1, this.files - 1);
  }

  state() { return { files: this.files, connections: this.connections, delayMs: this.delayMs }; }
}

module.exports = { AdaptiveConcurrency, PRESETS };
