// Runs an upload plan against a "transport" (the Telegram client wrapper in telegram.js, or a fake in tests).
'use strict';

const crypto = require('crypto');
const fs = require('fs');

const GENERAL_TOPIC_ID = 1;
const MB = 1024 * 1024;

/** Remembers which files were already sent where, so a rerun resumes instead of sending twice. */
class UploadHistory {
  constructor(file) {
    this.file = file;
    try {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      this.data = {};
    }
  }

  /** Content fingerprint: size plus the first and last 64 KB, so renamed copies are recognised. */
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
  add(k) { this.data[k] = Date.now(); }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }

  clear() {
    this.data = {};
    this.save();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * opts.mode: "per_folder" (topic per plan entry), "single" (opts.topicId), "none" (plain group).
 * events: { log(text), progress({done,total,label,file}), album({folder, caption, count}) }
 */
class UploadJob {
  constructor(transport, chat, plan, opts, events, history) {
    this.t = transport;
    this.chat = chat; // { id, title, isForum }
    this.plan = plan;
    this.opts = { mode: 'per_folder', topicId: null, headerMessage: false, skipUploaded: true, skipDuplicates: false,
      maxFileMb: 2000, delayMs: 1200, silent: false, ...opts };
    this.ev = { log() {}, progress() {}, ...events };
    this.history = history;
    this.cancelled = false;
    this.paused = false;
    this.resumeWaiters = [];
    this.stats = { sent: 0, skipped: 0, failed: 0 };
  }

  cancel() {
    this.cancelled = true;
    this.resume();
  }

  /** Pause takes effect after the album that is uploading now. */
  pause() { this.paused = true; }

  resume() {
    this.paused = false;
    this.resumeWaiters.splice(0).forEach((r) => r());
  }

  async waitIfPaused() {
    if (!this.paused) return;
    this.ev.log('Paused.', 'warn');
    await new Promise((r) => this.resumeWaiters.push(r));
    if (!this.cancelled) this.ev.log('Resumed.', 'info');
  }

  dupKey(fp) { return `dup:${this.chat.id}:${fp}`; }

  historyKey(entry, f) {
    const topic = this.opts.mode === 'per_folder' ? `t:${entry.topicName}` : `${this.opts.mode}:${this.opts.topicId}`;
    return UploadHistory.key(this.chat.id, topic, f);
  }

  async run() {
    const { opts, ev } = this;
    const limit = opts.maxFileMb * MB;
    let topics = new Map();
    if (opts.mode === 'per_folder') {
      if (!this.chat.isForum) throw new Error('This group has no topics. Turn on Topics in the group settings, or choose "No topics".');
      for (const t of await this.t.listTopics(this.chat)) topics.set(t.title.trim().toLowerCase(), t.id);
    }

    // Drop files that are too big or already sent, so the progress bar only counts real work.
    const work = [];
    const seen = new Set();
    for (const entry of this.plan) {
      const albums = [];
      for (const album of entry.albums) {
        const files = album.files.filter((f) => {
          if (f.size > limit) {
            ev.log(`Skipped, too big (${Math.round(f.size / MB)} MB): ${f.name}`, 'warn');
            this.stats.skipped++;
            return false;
          }
          if (opts.skipUploaded && this.history.has(this.historyKey(entry, f))) {
            this.stats.skipped++;
            return false;
          }
          if (opts.skipDuplicates) {
            try {
              f.fp = UploadHistory.fingerprint(f);
            } catch {
              return true; // unreadable now; the upload will report it
            }
            if (seen.has(f.fp) || this.history.has(this.dupKey(f.fp))) {
              ev.log(`Skipped duplicate: ${f.name}`, 'warn');
              this.stats.skipped++;
              this.stats.duplicates = (this.stats.duplicates || 0) + 1;
              return false;
            }
            seen.add(f.fp);
          }
          return true;
        });
        if (files.length) albums.push({ ...album, files });
      }
      // Keep a caption that belonged to a now-skipped album, so the name still appears after the media.
      if (albums.length) {
        for (const a of entry.albums) {
          if (!a.caption) continue;
          const kept = albums.filter((x) => x.set === a.set);
          if (kept.length && !kept.some((x) => x.caption)) kept[kept.length - 1].caption = a.caption;
        }
        work.push({ ...entry, albums });
      }
    }
    if (this.stats.skipped) ev.log(`${this.stats.skipped} file(s) skipped (already uploaded or too big).`);
    const total = work.reduce((a, e) => a + e.albums.reduce((b, al) => b + al.files.reduce((c, f) => c + f.size, 0), 0), 0);
    if (!work.length) {
      ev.log('Nothing new to upload.');
      ev.progress({ done: 1, total: 1, label: 'Nothing to upload' });
      return this.stats;
    }

    let done = 0;
    for (const entry of work) {
      await this.waitIfPaused();
      if (this.cancelled) break;
      const topicId = await this.topicFor(entry, topics);
      const fileCount = entry.albums.reduce((a, al) => a + al.files.length, 0);
      ev.log(`📁 ${entry.folder.path} → ${opts.mode === 'per_folder' ? `topic "${entry.topicName}"` : 'chat'} (${fileCount} files)`, 'folder');
      if (opts.mode !== 'per_folder' && opts.headerMessage) {
        await this.withRetry(() => this.t.sendText(this.chat, `📁 ${entry.header}`, topicId, opts), 'header');
      }

      for (const album of entry.albums) {
        await this.waitIfPaused();
        if (this.cancelled) break;
        const bytes = album.files.reduce((a, f) => a + f.size, 0);
        const label = album.files.length === 1 ? album.files[0].name : `${album.files.length} files · ${album.files[0].name}…`;
        const base = done;
        const onProgress = (frac, file) => ev.progress({ done: base + Math.round(bytes * frac), total, label, file });
        const ok = await this.withRetry(() => this.t.sendAlbum(this.chat, album.files, album.caption, topicId, opts, onProgress), label);
        done += bytes;
        ev.progress({ done, total, label });
        if (ok) {
          this.stats.sent += album.files.length;
          for (const f of album.files) {
            this.history.add(this.historyKey(entry, f));
            if (f.fp) this.history.add(this.dupKey(f.fp));
          }
          this.history.save();
          ev.log(`  ✓ ${label}${album.caption ? `  — “${album.caption}”` : ''}`, 'ok');
        } else {
          this.stats.failed += album.files.length;
          if (!this.cancelled) ev.log(`  ✗ Failed: ${label}`, 'error');
        }
        if (opts.delayMs) await sleep(opts.delayMs);
      }
    }
    ev.log(`${this.cancelled ? 'Cancelled' : 'Finished'}: ${this.stats.sent} sent, ${this.stats.skipped} skipped, ${this.stats.failed} failed.`, 'done');
    return this.stats;
  }

  async topicFor(entry, topics) {
    if (this.opts.mode === 'none') return null;
    if (this.opts.mode === 'single') return this.opts.topicId === GENERAL_TOPIC_ID ? null : this.opts.topicId;
    const key = entry.topicName.trim().toLowerCase();
    if (!topics.has(key)) {
      this.ev.log(`Creating topic "${entry.topicName}"`, 'info');
      topics.set(key, await this.t.createTopic(this.chat, entry.topicName));
    }
    const id = topics.get(key);
    return id === GENERAL_TOPIC_ID ? null : id;
  }

  async withRetry(fn, what) {
    for (let attempt = 1; attempt <= 4; attempt++) {
      if (this.cancelled) return false;
      try {
        await fn();
        return true;
      } catch (e) {
        const wait = floodSeconds(e);
        if (wait != null) {
          this.ev.log(`Telegram asked to slow down, waiting ${wait}s…`, 'warn');
          await sleep((wait + 1) * 1000);
          attempt--; // flood waits don't count as failures
          continue;
        }
        this.ev.log(`  ${what}: attempt ${attempt} failed: ${e.errorMessage || e.message}`, 'warn');
        if (attempt < 4) await sleep(3000 * attempt);
      }
    }
    return false;
  }
}

function floodSeconds(e) {
  if (e && typeof e.seconds === 'number' && /FLOOD/i.test(e.errorMessage || e.message || '')) return e.seconds;
  const m = /FLOOD_WAIT_(\d+)/.exec((e && (e.errorMessage || e.message)) || '');
  return m ? Number(m[1]) : null;
}

module.exports = { UploadJob, UploadHistory, GENERAL_TOPIC_ID, floodSeconds };
