// Runs an upload plan against a "transport" (the Telegram client wrapper in telegram.js, or a fake in tests).
'use strict';

const crypto = require('crypto');
const { VIDEO_EXT } = require('./scanner');
const { UploadHistory } = require('./history');
const { HashCache } = require('./hashing');
const { floodSeconds, classify, backoff, errorText } = require('./retry');
const { checkFile } = require('./integrity');
const { AdaptiveConcurrency } = require('./concurrency');
const { normalizeKey } = require('./naming');

const GENERAL_TOPIC_ID = 1;
const MB = 1024 * 1024;

/** In-memory job state; the queue passes a persistent one (see jobs.js) with the same methods. */
class MemoryState {
  constructor() { this.albums = new Map(); this.topics = new Map(); }
  album(key) { return this.albums.get(key) || null; }
  setAlbum(key, patch) { this.albums.set(key, { ...(this.albums.get(key) || {}), ...patch }); }
  topic(name) { return this.topics.get(name) || null; }
  setTopic(name, id) { this.topics.set(name, id); }
}

/** Stable 64-bit message ids for one message of one album: retries reuse them, so Telegram can't post twice. */
function randomIds(jobId, albumKey, step, count, variant = 0) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const h = crypto.createHash('sha256').update(`${jobId}|${albumKey}|${step}|${variant}|${i}`).digest();
    out.push(h.readBigInt64LE(0));
  }
  return out;
}

/** Identity of an album inside a job: its topic and the exact files in it. */
const albumKeyOf = (topic, album) => crypto.createHash('sha1').update(`${topic}|${album.setId || album.set || ''}|${album.files.map((f) => f.path).join('\n')}`).digest('hex').slice(0, 20);

/**
 * opts.mode: "per_folder" (topic per plan entry), "single" (opts.topicId), "none" (plain group).
 * opts.dupScope: "chat" (default, same group), "topic" (same topic) or "global" (anywhere you uploaded).
 * opts.dupProbable: "skip" (default) or "upload" for matches that can't be confirmed with a full hash.
 * opts.forceUpload: file paths to send even if they look like duplicates (from the duplicate review).
 * opts.maxRetries: attempts per album for temporary errors (flood waits don't count).
 * opts.concurrency: { preset, custom, adaptive } (see concurrency.js).
 * events: { log(text, kind), progress({ done, total, label, file, stats }), wait({ seconds, reason }), album(info) }
 * extras: { state, hashCache, jobId }
 */
class UploadJob {
  constructor(transport, chat, plan, opts, events, history, extras = {}) {
    this.t = transport;
    this.chat = chat; // { id, title, isForum }
    this.plan = plan;
    this.opts = { mode: 'per_folder', topicId: null, headerMessage: false, skipUploaded: true, skipDuplicates: false, dupScope: 'chat',
      dupProbable: 'skip', forceUpload: [], maxFileMb: 2000, delayMs: null, silent: false, maxRetries: 5, verifyFiles: true, ...opts };
    this.ev = { log() {}, progress() {}, wait() {}, album() {}, ...events };
    this.history = history;
    this.state = extras.state || new MemoryState();
    this.hashes = extras.hashCache || new HashCache(null);
    this.jobId = extras.jobId || crypto.randomBytes(8).toString('hex');
    this.conc = new AdaptiveConcurrency({ ...(this.opts.concurrency || {}), delayMs: this.opts.delayMs });
    this.cancelled = false;
    this.paused = false;
    this.resumeWaiters = [];
    this.sleepers = new Set();
    this.stats = { sent: 0, skipped: 0, failed: 0, duplicates: 0, bytesTotal: 0, bytesDone: 0, startedAt: Date.now(), currentAlbum: '', currentTopic: '' };
    this.report = { jobId: this.jobId, chat: { id: chat.id, title: chat.title }, startedAt: new Date().toISOString(), finishedAt: null, topics: [],
      albums: [], uploaded: [], failed: [], skipped: [], duplicates: [], errors: [], warnings: [] };
    this.uploadedMedia = new Map(); // retries reuse files already uploaded in this session
  }

  cancel() {
    this.cancelled = true;
    for (const s of this.sleepers) s();
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

  /** A pause that Cancel ends at once. */
  sleep(ms) {
    if (this.cancelled || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); this.sleepers.delete(done); resolve(); };
      const timer = setTimeout(done, ms);
      this.sleepers.add(done);
    });
  }

  topicKey(entry) {
    return this.opts.mode === 'per_folder' ? `t:${entry.topicName}` : `${this.opts.mode}:${this.opts.topicId}`;
  }

  historyKey(entry, f) { return UploadHistory.key(this.chat.id, this.topicKey(entry), f); }

  /** History keys that mark a fingerprint as sent, for each duplicate scope. */
  dupKeys(entry, fp) {
    return { chat: `dup:${this.chat.id}:${fp}`, topic: `dupt:${this.chat.id}:${this.topicKey(entry)}:${fp}`, global: `dupg:${fp}` };
  }

  async run() {
    try {
      return await this.runPlan();
    } finally {
      this.report.finishedAt = new Date().toISOString();
      this.report.stats = { ...this.stats };
      try { this.history.save(); } catch (e) { this.ev.log(`Couldn't save the upload history: ${e.message}`, 'error'); }
      try { this.hashes.save(); } catch { /* cache only */ }
    }
  }

  async runPlan() {
    const { opts, ev } = this;
    let topics = new Map();
    if (opts.mode === 'per_folder') {
      if (!this.chat.isForum) throw new Error('This group has no topics. Turn on Topics in the group settings, or choose "No topics".');
      topics = await this.loadTopics();
    }
    const work = await this.prepare();
    this.stats.bytesTotal = work.reduce((a, e) => a + e.albums.reduce((b, al) => b + al.files.reduce((c, f) => c + f.size, 0), 0), 0);
    const total = this.stats.bytesTotal;
    if (!work.length) {
      ev.log(this.cancelled ? 'Cancelled.' : 'Nothing new to upload.');
      ev.progress({ done: 1, total: 1, label: 'Nothing to upload', stats: this.stats });
      return this.stats;
    }

    let done = 0;
    for (const entry of work) {
      await this.waitIfPaused();
      if (this.cancelled) break;
      let topicId;
      try {
        topicId = await this.topicFor(entry, topics);
      } catch (e) {
        // The topic couldn't be created or found: this folder fails, the others continue.
        const n = entry.albums.reduce((a, al) => a + al.files.length, 0);
        ev.log(`✗ Topic "${entry.topicName}": ${errorText(e)}`, 'error');
        this.stats.failed += n;
        for (const al of entry.albums) this.failAlbum(entry, al, e);
        done += entry.albums.reduce((a, al) => a + al.files.reduce((b, f) => b + f.size, 0), 0);
        continue;
      }
      if (opts.mode === 'per_folder' && !this.report.topics.includes(entry.topicName)) this.report.topics.push(entry.topicName);
      this.stats.currentTopic = opts.mode === 'per_folder' ? entry.topicName : '';
      const fileCount = entry.albums.reduce((a, al) => a + al.files.length, 0);
      ev.log(`📁 ${entry.folder.path} → ${opts.mode === 'per_folder' ? `topic "${entry.topicName}"` : 'chat'} (${fileCount} files)`, 'folder');
      if (opts.mode !== 'per_folder' && opts.headerMessage && !this.state.album(`header|${entry.id || entry.folder.path}`)?.done) {
        const ok = await this.withRetry(() => this.t.sendText(this.chat, `📁 ${entry.header}`, topicId, opts), 'header');
        if (ok === true) this.state.setAlbum(`header|${entry.id || entry.folder.path}`, { done: true });
      }

      for (const album of entry.albums) {
        await this.waitIfPaused();
        if (this.cancelled) break;
        const bytes = album.files.reduce((a, f) => a + f.size, 0);
        const label = album.files.length === 1 ? album.files[0].name : `${album.files.length} files · ${album.files[0].name}…`;
        this.stats.currentAlbum = album.caption || album.set || label;
        const base = done;
        const onProgress = (frac, file) => {
          this.stats.bytesDone = base + Math.round(bytes * frac);
          ev.progress({ done: this.stats.bytesDone, total, label, file, stats: this.stats });
        };
        const ok = await this.sendAlbumChecked(entry, album, topicId, label, onProgress);
        done += bytes;
        this.stats.bytesDone = done;
        ev.progress({ done, total, label, stats: this.stats });
        if (ok) {
          this.stats.sent += album.files.length;
          ev.log(`  ✓ ${label}${album.caption ? `  — “${album.caption}”` : ''}`, 'ok');
        } else if (!this.cancelled) {
          ev.log(`  ✗ Failed: ${label}`, 'error');
        }
        if (!this.cancelled) await this.sleep(this.conc.delayMs);
      }
    }
    ev.log(`${this.cancelled ? 'Cancelled' : 'Finished'}: ${this.stats.sent} sent, ${this.stats.skipped} skipped, ${this.stats.failed} failed.`, 'done');
    return this.stats;
  }

  async loadTopics() {
    const topics = new Map();
    let list = [];
    await this.withRetry(async () => { list = await this.t.listTopics(this.chat); }, 'topic list', { throwPermanent: true });
    for (const t of list) {
      const k = normalizeKey(t.title);
      const prev = topics.get(k);
      if (prev && !prev.closed && !t.closed) this.report.warnings.push(`Two topics are called "${t.title}"; using the first one.`);
      if (!prev || (prev.closed && !t.closed)) topics.set(k, { id: t.id, title: t.title, closed: !!t.closed });
    }
    return topics;
  }

  // ------------------------------------------------------------ before sending: skip, dedupe, check

  /** Drops files that are too big or already sent and finds duplicates, so the progress bar only counts real work. */
  async prepare() {
    const { opts, ev } = this;
    const limit = opts.maxFileMb * MB;
    const force = new Set(opts.forceUpload || []);
    const work = [];
    const seen = new Map(); // quick fingerprint -> first file in this job
    let checked = 0;
    const totalFiles = this.plan.reduce((a, e) => a + e.albums.reduce((b, al) => b + al.files.length, 0), 0);
    for (const entry of this.plan) {
      const albums = [];
      for (const album of entry.albums) {
        const key = albumKeyOf(this.topicKey(entry), album);
        const st = this.state.album(key);
        if (st && st.status === 'done') { this.stats.skipped += album.files.length; continue; }
        const files = [];
        for (const f of album.files) {
          if (this.cancelled) return [];
          if (++checked % 200 === 0) ev.progress({ done: checked, total: totalFiles, label: `Checking files… ${checked}/${totalFiles}`, stats: this.stats });
          if (f.size > limit && !this.canSplit(f)) {
            ev.log(`Skipped, too big (${Math.round(f.size / MB)} MB): ${f.name}`, 'warn');
            this.skip(f, 'too big');
            continue;
          }
          if (opts.skipUploaded && this.history.has(this.historyKey(entry, f))) {
            this.skip(f, 'already uploaded');
            continue;
          }
          if (opts.skipDuplicates && !force.has(f.path)) {
            const dup = await this.duplicateOf(entry, f, seen);
            if (dup) {
              ev.log(`Skipped duplicate${dup.certain ? '' : ' (probable)'}: ${f.name}${dup.of ? ` = ${dup.of}` : ''}`, 'warn');
              this.stats.skipped++;
              this.stats.duplicates++;
              this.report.duplicates.push({ name: f.name, path: f.path, of: dup.of || '', certain: dup.certain });
              continue;
            }
          }
          files.push(f);
        }
        if (files.length) albums.push({ ...album, files, key: files.length === album.files.length ? key : albumKeyOf(this.topicKey(entry), { ...album, files }) });
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
    if (this.stats.skipped) ev.log(`${this.stats.skipped} file(s) skipped (already uploaded, duplicates or too big).`);
    return work;
  }

  skip(f, reason) {
    this.stats.skipped++;
    this.report.skipped.push({ name: f.name, path: f.path, reason });
  }

  /**
   * Is `f` a duplicate of a file sent before or earlier in this job? Quick fingerprints find candidates; a full
   * SHA-256 confirms them when both files can be read. Returns { certain, of } or null.
   */
  async duplicateOf(entry, f, seen) {
    let fp;
    try {
      fp = await this.hashes.quick(f);
    } catch {
      return null; // unreadable now; the upload will report it
    }
    f.fp = fp.quick;
    const verify = async (other) => {
      try {
        return (await this.hashes.sha256(f)) === (await this.hashes.sha256(other));
      } catch {
        return null;
      }
    };
    const first = seen.get(fp.quick);
    if (first) {
      const same = await verify(first);
      if (same === true) return { certain: true, of: first.name };
      if (same === null) return this.probable({ n: first.name });
    } else {
      seen.set(fp.quick, f);
    }
    const keys = this.dupKeys(entry, fp.quick);
    let rec = this.history.get(keys[this.opts.dupScope] || keys.chat);
    if (typeof rec === 'string') rec = this.history.get(rec); // topic and global keys point at the group's record
    if (rec !== undefined) {
      if (rec && typeof rec === 'object') {
        if (rec.s) {
          const mine = await this.hashes.sha256(f).catch(() => null);
          if (mine) return mine === rec.s ? { certain: true, of: rec.n || '' } : null;
        }
        if (rec.p && rec.p !== f.path) {
          const original = { path: rec.p, size: rec.z, mtime: rec.m, mtimeMs: rec.mm, ext: '' };
          const c = await checkFile(original);
          if (c.ok && !c.changed) {
            const same = await verify(original);
            if (same !== null) return same ? { certain: true, of: rec.n || '' } : null;
          }
        }
      }
      return this.probable(rec);
    }
    // FolderGram 2.x recorded only its older fingerprint, per group.
    if (this.opts.dupScope !== 'topic' && this.history.has(`dup:${this.chat.id}:${fp.legacy}`)) return this.probable(null);
    return null;
  }

  probable(rec) {
    if (this.opts.dupProbable === 'upload') return null;
    return { certain: false, of: rec && typeof rec === 'object' ? rec.n || '' : '' };
  }

  // ------------------------------------------------------------ sending

  /** Checks the album's files on disk, sends it, records the result. */
  async sendAlbumChecked(entry, album, topicId, label, onProgress) {
    const key = album.key || albumKeyOf(this.topicKey(entry), album);
    let files = album.files;
    if (this.opts.verifyFiles) {
      files = [];
      for (const f of album.files) {
        const c = await checkFile(f);
        if (!c.ok) {
          this.ev.log(`  ✗ ${f.name}: ${c.warning}`, 'error');
          this.stats.failed++;
          this.report.failed.push({ name: f.name, path: f.path, error: c.warning, topic: entry.topicName });
          continue;
        }
        if (c.warning) {
          this.ev.log(`  ⚠ ${f.name}: ${c.warning}`, 'warn');
          this.report.warnings.push(`${f.name}: ${c.warning}`);
        }
        files.push(c.changed || c.asDocument ? { ...f, size: c.size, mtime: c.mtime, mtimeMs: c.mtimeMs, asDocument: c.asDocument || f.asDocument } : f);
      }
      if (!files.length) return false;
    }
    const prev = this.state.album(key) || {};
    this.state.setAlbum(key, { status: 'sending', topic: entry.topicName, caption: album.caption, files: files.map((f) => f.path), startedAt: prev.startedAt || Date.now() });
    // Hash small files while they upload, so later duplicates can be confirmed even if these files are moved.
    const hashing = this.opts.skipDuplicates ? Promise.all(files.filter((f) => f.size <= 256 * MB).map((f) => this.hashes.sha256(f).catch(() => null))) : null;
    const result = await this.sendWithSplits({ ...album, files }, topicId, label, onProgress, key);
    if (hashing) await hashing;
    if (result.ok) {
      const pairs = [];
      for (const f of files) {
        pairs.push([this.historyKey(entry, f), Date.now()]);
        if (f.fp) {
          const rec = { t: Date.now(), n: f.name, p: f.path, z: f.size, m: f.mtime, mm: f.mtimeMs };
          const e = this.hashes.entry(f);
          if (e && e.s) rec.s = e.s;
          const keys = this.dupKeys(entry, f.fp);
          pairs.push([keys.chat, rec], [keys.topic, keys.chat], [keys.global, keys.chat]);
        }
      }
      this.history.addMany(pairs);
      this.conc.success();
      this.state.setAlbum(key, { status: 'done', doneAt: Date.now(), messageIds: result.messageIds || [], reconciled: !!result.reconciled });
      this.report.albums.push({ topic: entry.topicName, caption: album.caption || '', set: album.set || '', files: files.map((f) => f.name), status: 'sent',
        messageIds: result.messageIds || [] });
      for (const f of files) this.report.uploaded.push({ name: f.name, path: f.path, size: f.size, topic: entry.topicName, album: album.set || '' });
      this.ev.album({ key, status: 'done', topic: entry.topicName, caption: album.caption });
      return true;
    }
    if (this.cancelled && result.cancelled) {
      this.state.setAlbum(key, { status: result.uncertain ? 'uncertain' : 'pending' });
      return false;
    }
    this.stats.failed += files.length;
    this.failAlbum(entry, { ...album, files }, result.error, key, result.uncertain);
    return false;
  }

  failAlbum(entry, album, error, key = albumKeyOf(this.topicKey(entry), album), uncertain = false) {
    const msg = errorText(error);
    this.state.setAlbum(key, { status: uncertain ? 'uncertain' : 'failed', error: msg });
    this.report.albums.push({ topic: entry.topicName, caption: album.caption || '', set: album.set || '', files: album.files.map((f) => f.name), status: 'failed', error: msg });
    for (const f of album.files) this.report.failed.push({ name: f.name, path: f.path, error: msg, topic: entry.topicName });
    if (msg && !this.report.errors.includes(msg)) this.report.errors.push(msg);
    this.ev.album({ key, status: 'failed', topic: entry.topicName, caption: album.caption, error: msg });
  }

  /** Videos over the size limit can be cut into parts when splitting is on. */
  canSplit(f) {
    return !!(this.opts.splitVideos && this.opts.splitVideo && VIDEO_EXT.has(f.ext));
  }

  /**
   * Send an album; videos over the limit are first cut into parts that take their place, in order.
   * More than 10 items are sent as several albums, with the caption on the last one. Each message keeps its own
   * stable ids and done-state, so a retry or a resumed job continues where it stopped instead of re-posting.
   */
  async sendWithSplits(album, topicId, label, onProgress, key) {
    const limit = this.opts.maxFileMb * MB;
    const st = this.state.album(key) || {};
    const doneSteps = new Set(st.steps || []);
    const messageIds = [...(st.messageIds || [])];
    let reconciled = false;
    const sendChunk = async (files, caption, cb, chunk) => {
      const ctl = this.control(key, chunk, doneSteps, messageIds, files);
      const r = await this.withRetry(() => this.t.sendAlbum(this.chat, files, caption, topicId, this.opts, cb, ctl), label, {
        reconcile: this.t.findRecentAlbum ? async (since) => {
          const found = await this.t.findRecentAlbum(this.chat, topicId, { since, count: files.length, caption });
          if (found) { reconciled = true; messageIds.push(...found); }
          return !!found;
        } : null,
        since: st.startedAt ? Math.floor(st.startedAt / 1000) : Math.floor(Date.now() / 1000),
      });
      return r;
    };
    const finish = (r) => (r === true ? { ok: true, messageIds, reconciled } : { ok: false, ...r });

    if (!album.files.some((f) => f.size > limit)) return finish(await sendChunk(album.files, album.caption, onProgress, 0));

    const cleanups = [];
    try {
      const files = [];
      for (const f of album.files) {
        if (f.size <= limit) { files.push(f); continue; }
        const { parts, cleanup } = await this.opts.splitVideo(f, limit, { log: (t) => this.ev.log(`  ${t}`, 'info') });
        cleanups.push(cleanup);
        this.ev.log(`  ${f.name} → ${parts.length} parts`, 'info');
        files.push(...parts);
      }
      const totalBytes = files.reduce((a, f) => a + f.size, 0) || 1;
      let before = 0;
      for (let i = 0, chunk = 0; i < files.length; i += 10, chunk++) {
        if (this.cancelled) return { ok: false, cancelled: true };
        const part = files.slice(i, i + 10);
        const chunkBytes = part.reduce((a, f) => a + f.size, 0);
        const start = before;
        const last = i + 10 >= files.length;
        const r = await sendChunk(part, last ? album.caption : '', (frac, file) => onProgress((start + frac * chunkBytes) / totalBytes, file), chunk);
        if (r !== true) return finish(r);
        before += chunkBytes;
      }
      return { ok: true, messageIds, reconciled };
    } catch (e) {
      this.ev.log(`  ✗ ${e.message}`, 'error');
      return { ok: false, error: e };
    } finally {
      for (const c of cleanups) await c();
    }
  }

  /** What the transport needs to send one chunk safely: stable ids, done-steps, cancel and concurrency. */
  control(key, chunk, doneSteps, messageIds, files) {
    return {
      randomIds: (step, count, variant = 0) => randomIds(this.jobId, key, `${chunk}.${step}`, count, variant),
      isDone: (step) => doneSteps.has(`${chunk}.${step}`),
      stepDone: (step, ids = []) => {
        doneSteps.add(`${chunk}.${step}`);
        messageIds.push(...ids);
        this.state.setAlbum(key, { steps: [...doneSteps], messageIds: [...messageIds] });
      },
      isCanceled: () => this.cancelled,
      concurrency: () => this.conc.filesFor(files.map((f) => f.size)),
      workersFor: (size) => this.conc.workersFor(size),
      connectionsFor: (size) => this.conc.connectionsFor(size),
      mediaCache: this.uploadedMedia,
    };
  }

  async topicFor(entry, topics) {
    if (this.opts.mode === 'none') return null;
    if (this.opts.mode === 'single') return this.opts.topicId === GENERAL_TOPIC_ID ? null : this.opts.topicId;
    if (entry.topicId) return entry.topicId === GENERAL_TOPIC_ID ? null : entry.topicId; // mapped by hand in the preview
    const saved = this.state.topic(entry.topicName);
    if (saved) return saved === GENERAL_TOPIC_ID ? null : saved;
    const key = normalizeKey(entry.topicName);
    let t = topics.get(key);
    if (t && t.closed) this.ev.log(`Topic "${t.title}" is closed; posting may fail. Reopen it in Telegram or map the folder to another topic.`, 'warn');
    if (!t) {
      this.ev.log(`Creating topic "${entry.topicName}"`, 'info');
      let id = null;
      let attempt = 0;
      const ok = await this.withRetry(async () => {
        // After a lost reply the topic may exist already: look before creating a second one.
        if (attempt++ > 0) {
          const again = await this.loadTopics();
          const found = again.get(key);
          if (found) { id = found.id; return; }
        }
        id = await this.t.createTopic(this.chat, entry.topicName);
      }, `topic "${entry.topicName}"`);
      if (ok !== true || id == null) throw new Error(this.lastError ? errorText(this.lastError) : `Couldn't create topic "${entry.topicName}"`);
      t = { id, title: entry.topicName, closed: false };
      topics.set(key, t);
    }
    this.state.setTopic(entry.topicName, t.id);
    return t.id === GENERAL_TOPIC_ID ? null : t.id;
  }

  /**
   * Runs fn with retries. Returns true on success; otherwise { error, uncertain, cancelled } (or false for simple
   * calls). Flood waits are honoured exactly and don't count as attempts. RANDOM_ID_DUPLICATE means Telegram
   * already has the message, which counts as success. After an uncertain failure, `reconcile` can check whether
   * the message arrived before sending it again.
   */
  async withRetry(fn, what, { reconcile = null, since = Math.floor(Date.now() / 1000), throwPermanent = false } = {}) {
    let uncertain = false;
    let lastError = null;
    for (let attempt = 1; attempt <= this.opts.maxRetries; attempt++) {
      if (this.cancelled) return { cancelled: true, uncertain, error: lastError };
      if (uncertain && reconcile) {
        try {
          if (await reconcile(since)) {
            this.ev.log(`  ${what}: Telegram already has it, not sending again.`, 'info');
            return true;
          }
        } catch { /* couldn't check: send again with the same ids, Telegram drops repeats */ }
      }
      try {
        await fn();
        return true;
      } catch (e) {
        lastError = e;
        this.lastError = e;
        const kind = classify(e);
        if (kind === 'delivered') return true;
        if (kind === 'cancelled' || this.cancelled) return { cancelled: true, uncertain, error: e };
        if (kind === 'flood') {
          const wait = floodSeconds(e);
          this.conc.flood(wait);
          this.ev.log(`Telegram asked to slow down, waiting ${wait}s…`, 'warn');
          this.ev.wait({ seconds: wait + 1, reason: 'flood' });
          await this.sleep((wait + 1) * 1000);
          this.ev.wait({ seconds: 0, reason: 'flood' });
          attempt--; // flood waits don't count as failures
          continue;
        }
        if (kind === 'permanent') {
          this.ev.log(`  ${what}: ${errorText(e)} (not retrying)`, 'error');
          if (throwPermanent) throw e;
          return { error: e, uncertain };
        }
        if (kind === 'uncertain') uncertain = true;
        this.conc.failure();
        this.ev.log(`  ${what}: attempt ${attempt} failed: ${errorText(e)}`, 'warn');
        if (attempt < this.opts.maxRetries) {
          const ms = backoff(attempt, { baseMs: this.opts.retryBaseMs ?? 2000 });
          this.ev.wait({ seconds: Math.ceil(ms / 1000), reason: 'retry' });
          await this.sleep(ms);
          if (this.t.ensureConnected) await this.t.ensureConnected().catch(() => {});
        }
      }
    }
    if (throwPermanent && lastError) throw lastError;
    return { error: lastError, uncertain };
  }
}

module.exports = { UploadJob, UploadHistory, MemoryState, GENERAL_TOPIC_ID, floodSeconds, randomIds, albumKeyOf };
