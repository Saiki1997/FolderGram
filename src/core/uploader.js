// Runs an upload plan against a "transport" (the Telegram client wrapper in telegram.js, or a fake in tests).
'use strict';

const crypto = require('crypto');
const { VIDEO_EXT } = require('./scanner');
const { UploadHistory } = require('./history');
const { HashCache } = require('./hashing');
const { floodSeconds, classify, backoff, errorText, isNetworkError } = require('./retry');
const { normalizeCheck } = require('./reconcile');
const { checkFile } = require('./integrity');
const { AdaptiveConcurrency } = require('./concurrency');
const { normalizeKey } = require('./naming');
const { ProgressTracker } = require('./progress');

const GENERAL_TOPIC_ID = 1;
const MB = 1024 * 1024;

/** In-memory job state; the queue passes a persistent one (see jobs.js) with the same methods. */
class MemoryState {
  constructor() { this.albums = new Map(); this.topics = new Map(); }
  album(key) { return this.albums.get(key) || null; }
  setAlbum(key, patch) { this.albums.set(key, { ...(this.albums.get(key) || {}), ...patch }); }
  topic(name) { return this.topics.get(name) || null; }
  setTopic(name, id) { this.topics.set(name, id); }
  forgetTopic(name) { this.topics.delete(name); }
  /** Message ids of every album already posted by this job, so a delivery check can't mistake one for another. */
  knownMessageIds() { return knownIds(this.albums); }
}

function knownIds(albums) {
  const out = new Set();
  for (const a of albums.values()) for (const id of a.messageIds || []) out.add(id);
  return out;
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

const albumLabel = (album) => (album.files.length === 1 ? album.files[0].name : `${album.files.length} files · ${album.files[0].name}…`);

/** Identity of an album inside a job: its topic and the exact files in it. */
const albumKeyOf = (topic, album) => crypto.createHash('sha1').update(`${topic}|${album.setId || album.set || ''}|${album.files.map((f) => f.path).join('\n')}`).digest('hex').slice(0, 20);

/**
 * opts.mode: "per_folder" (topic per plan entry), "single" (opts.topicId), "none" (plain group).
 * opts.dupScope: "chat" (default, same group), "topic" (same topic) or "global" (anywhere you uploaded).
 * opts.dupProbable: "skip" (default) or "upload" for matches that can't be confirmed with a full hash.
 * opts.forceUpload: file paths to send even if they look like duplicates (from the duplicate review).
 * opts.maxRetries: attempts per album for temporary errors (flood waits don't count).
 * opts.concurrency: { preset, custom, adaptive } (see concurrency.js). opts.bandwidthMbps: upload speed limit, 0 for none.
 * opts.pipeline: false turns off uploading the next album while the current one is posted.
 * opts.stallMs: an attempt with no progress for this long is given up as uncertain and retried (default 150 s).
 * opts.reconcileTrustMs: an album cut off mid-send longer ago than this is only sent again once Telegram confirms
 *   it isn't there; if that can't be checked it is held for review (default 15 min; Telegram drops repeats sooner).
 * opts.reviewAction: "resend" or "mark" (as sent) for albums held for review, once the user has looked.
 * events: { log(text, kind), progress({ done, total, label, file, stats, phase }), wait({ seconds, reason }), album(info) }
 * extras: { state, hashCache, jobId }
 */
class UploadJob {
  constructor(transport, chat, plan, opts, events, history, extras = {}) {
    this.t = transport;
    this.chat = chat; // { id, title, isForum }
    this.plan = plan;
    this.opts = { mode: 'per_folder', topicId: null, headerMessage: false, skipUploaded: true, skipDuplicates: false, dupScope: 'chat',
      dupProbable: 'skip', forceUpload: [], maxFileMb: 2000, delayMs: null, silent: false, maxRetries: 5, verifyFiles: true, stallMs: 150000,
      reconcileTrustMs: 15 * 60000, reviewAction: null, ...opts };
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
    this.stats = { sent: 0, skipped: 0, failed: 0, duplicates: 0, review: 0, bytesTotal: 0, bytesDone: 0, startedAt: Date.now(), currentAlbum: '', currentTopic: '',
      offlineMs: 0, stalls: 0 };
    this.report = { jobId: this.jobId, chat: { id: chat.id, title: chat.title }, startedAt: new Date().toISOString(), finishedAt: null, topics: [],
      albums: [], uploaded: [], failed: [], skipped: [], duplicates: [], review: [], errors: [], warnings: [] };
    this.uploadedMedia = new Map(); // retries reuse files already uploaded in this session
    this.preloaded = new Set(); // albums already being uploaded ahead of their turn
    this.activityAt = 0; // last progress of an upload running ahead (keeps the watchdog from firing on the album waiting for it)
    this.progress = extras.progress || new ProgressTracker();
    // Waits change the job's status line (flood wait, no connection, retry countdown).
    const wait = this.ev.wait;
    this.ev.wait = (w) => {
      if (w.seconds) this.progress.setStatus(w.reason === 'flood' ? 'waiting' : w.reason === 'offline' ? 'offline' : 'retrying', w.reason, w.seconds);
      else if (!this.cancelled && !this.paused) this.progress.setStatus('uploading');
      wait(w);
      // Nothing moves during a wait, so no progress event would tell the window: send one now.
      if (this.progress.bytesTotal) this.emitProgress(this.stats.currentAlbum || '');
    };
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
    this.progress.setStatus('paused');
    this.emitProgress('Paused');
    this.ev.log('Paused.', 'warn');
    await new Promise((r) => this.resumeWaiters.push(r));
    if (!this.cancelled) { this.progress.setStatus('uploading'); this.ev.log('Resumed.', 'info'); }
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
    if (this.t.setBandwidthLimit) this.t.setBandwidthLimit(Math.round((this.opts.bandwidthMbps || 0) * 125000)); // Mbit/s -> bytes/s
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
    // The version and upload mode head every job's log, so a pasted log shows what ran.
    if (opts.appVersion) ev.log(`FolderGram ${opts.appVersion} · ${this.t.uploadMode ? this.t.uploadMode() : 'upload'}`, 'info');
    let topics = new Map();
    this.progress.setStatus('checking', 'Checking files');
    if (opts.mode === 'per_folder') {
      if (!this.chat.isForum) throw new Error('This group has no topics. Turn on Topics in the group settings, or choose "No topics".');
      topics = await this.loadTopics();
    }
    const work = await this.prepare();
    this.stats.bytesTotal = work.reduce((a, e) => a + e.albums.reduce((b, al) => b + al.files.reduce((c, f) => c + f.size, 0), 0), 0);
    this.progress.skipped(this.stats.skipped);
    this.progress.setAlbums(work.flatMap((e) => e.albums.map((al) => ({ key: al.key, title: al.caption || al.set || albumLabel(al), topic: opts.mode === 'per_folder' ? e.topicName : '', files: al.files }))));
    if (!work.length) {
      ev.log(this.cancelled ? 'Cancelled.' : 'Nothing new to upload.');
      this.progress.setStatus('done');
      ev.progress({ done: 1, total: 1, label: 'Nothing to upload', stats: this.stats, snapshot: () => this.progress.snapshot() });
      return this.stats;
    }
    this.progress.setStatus('uploading');

    // Every album in order, so the next one can be uploaded while the current one is posted.
    this.sequence = work.flatMap((entry) => entry.albums.map((album) => ({ entry, album })));
    this.topicsMap = topics;
    let entryDone = null;
    let topicRef = null;
    for (let i = 0; i < this.sequence.length; i++) {
      const { entry, album } = this.sequence[i];
      await this.waitIfPaused();
      if (this.cancelled) break;
      if (entry !== entryDone) {
        // First album of a folder: its topic, and the optional "📁 folder" message.
        entryDone = entry;
        topicRef = await this.startEntry(entry, topics);
        if (!topicRef) { i = this.sequence.findIndex((x, j) => j > i && x.entry !== entry) - 1; if (i < -1) break; continue; }
      }
      this.current = i;
      const label = albumLabel(album);
      this.stats.currentAlbum = album.caption || album.set || label;
      const onProgress = (frac, name, detail) => {
        if (!(detail && detail.path && this.progress.fileProgress(detail.path, detail.frac, detail.bytes))) this.progress.albumProgress(album.key, frac);
        this.emitProgress(label, name);
      };
      const sent = await this.sendAlbumChecked(entry, album, topicRef, label, onProgress);
      this.emitProgress(label);
      if (sent > 0) {
        this.stats.sent += sent;
        ev.log(`  ✓ ${label}${album.caption ? `  — “${album.caption}”` : ''}`, 'ok');
      } else if (sent === 0 && !this.cancelled) {
        ev.log(`  ✗ Failed: ${label}`, 'error');
      }
      if (!this.cancelled) {
        this.preloadNext(); // in case the album was posted without a send step (already in Telegram, marked as sent)
        await this.sleep(this.conc.delayMs);
      }
    }
    this.progress.setStatus(this.cancelled ? 'cancelled' : 'done');
    this.emitProgress('');
    ev.log(`${this.cancelled ? 'Cancelled' : 'Finished'}: ${this.stats.sent} sent, ${this.stats.skipped} skipped, ${this.stats.failed} failed${
      this.stats.review ? `, ${this.stats.review} to check` : ''}.`, 'done');
    return this.stats;
  }

  /** Progress event for the window: job bytes (never going back) plus a snapshot of every file and album. */
  emitProgress(label, file) {
    const p = this.progress;
    this.stats.bytesDone = Math.max(this.stats.bytesDone, p.logical);
    this.ev.progress({ done: Math.min(this.stats.bytesDone, p.bytesTotalLive()), total: p.bytesTotalLive(), label, file, stats: this.stats, snapshot: () => p.snapshot() });
  }

  /** Finds or creates the folder's topic and posts its header. Returns { id } or null when the folder fails. */
  async startEntry(entry, topics) {
    const { opts, ev } = this;
    let topicId;
    try {
      topicId = await this.topicFor(entry, topics);
    } catch (e) {
      // The topic couldn't be created or found: this folder fails, the others continue.
      const n = entry.albums.reduce((a, al) => a + al.files.length, 0);
      ev.log(`✗ Topic "${entry.topicName}": ${errorText(e)}`, 'error');
      this.stats.failed += n;
      for (const al of entry.albums) {
        this.failAlbum(entry, al, e);
        this.progress.failed(al.files.map((f) => f.path), { key: al.key, error: errorText(e) });
      }
      this.emitProgress('');
      return null;
    }
    if (opts.mode === 'per_folder' && !this.report.topics.includes(entry.topicName)) this.report.topics.push(entry.topicName);
    this.stats.currentTopic = opts.mode === 'per_folder' ? entry.topicName : '';
    const fileCount = entry.albums.reduce((a, al) => a + al.files.length, 0);
    ev.log(`📁 ${entry.folder.path} → ${opts.mode === 'per_folder' ? `topic "${entry.topicName}"` : 'chat'} (${fileCount} files)`, 'folder');
    if (opts.mode !== 'per_folder' && opts.headerMessage && !this.state.album(`header|${entry.id || entry.folder.path}`)?.done) {
      const ok = await this.withRetry(() => this.t.sendText(this.chat, `📁 ${entry.header}`, topicId, opts), 'header');
      if (ok === true) this.state.setAlbum(`header|${entry.id || entry.folder.path}`, { done: true });
    }
    return { id: topicId };
  }

  /**
   * Pipelining: while album N is being posted (and during the pause after it), album N+1's files are uploaded and
   * stored, so the connection doesn't sit idle between albums. Only one album ahead; nothing is posted early.
   */
  preloadNext() {
    if (this.opts.pipeline === false || !this.t.preload || this.cancelled || this.current == null) return;
    const next = this.sequence && this.sequence[this.current + 1];
    if (!next || this.preloaded.has(next.album.key)) return;
    this.preloaded.add(next.album.key);
    const { album } = next;
    const st = this.state.album(album.key);
    const limit = this.opts.maxFileMb * MB;
    if ((st && ['done', 'review'].includes(st.status)) || album.files.some((f) => f.size > limit)) return; // split videos are cut at their turn
    const ctl = { ...this.control(album.key, 0, new Set(), [], album.files), isCanceled: () => this.cancelled, activity: () => { this.activityAt = Date.now(); } };
    const onProgress = (frac, name, detail) => {
      this.activityAt = Date.now();
      if (detail && detail.path) this.progress.fileProgress(detail.path, detail.frac, detail.bytes);
      this.emitProgress(albumLabel(album), name);
    };
    this.progress.albumStatus(album.key, 'uploading');
    this.t.preload(this.chat, album.files, this.opts, onProgress, ctl).catch((e) => {
      // Not a failure: the album uploads again at its turn, with retries.
      if (this.t.dlog) this.t.dlog.write('upload', `uploading ahead for "${albumLabel(album)}" stopped:`, e);
    });
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
          if (++checked % 200 === 0) ev.progress({ phase: 'checking', done: 0, total: 0, checked, totalFiles, label: `Checking files… ${checked}/${totalFiles}`, stats: this.stats });
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

  /**
   * Checks the album's files on disk, sends it, records the result. Returns the number of files sent, 0 when it
   * failed, or -1 when it is held for review (delivery couldn't be confirmed) or the job was cancelled.
   */
  async sendAlbumChecked(entry, album, topicRef, label, onProgress) {
    const key = album.key || albumKeyOf(this.topicKey(entry), album);
    let files = album.files;
    if (this.opts.verifyFiles) {
      files = [];
      for (const f of album.files) {
        const c = await checkFile(f);
        if (!c.ok) {
          this.ev.log(`  ✗ ${f.name}: ${c.warning}`, 'error');
          this.progress.failed([f.path]);
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
      if (!files.length) return 0;
    }
    const prev = this.state.album(key) || {};
    // Cut off mid-send by a crash, a quit or a lost answer in an earlier run: Telegram may have it already.
    // (A run that stopped while still uploading files, before the send call, posted nothing: phase "upload".)
    const resumed = ['uncertain', 'review'].includes(prev.status) || (prev.status === 'sending' && prev.phase !== 'upload');
    // Albums held for review: the user chose "Send again" or "Mark as sent" (opts.reviewAction).
    const forced = prev.status === 'review' && this.opts.reviewAction === 'resend';
    const markSent = prev.status === 'review' && this.opts.reviewAction === 'mark';
    const holdIfUnconfirmed = resumed && !forced && Date.now() - (prev.sendAt || prev.startedAt || 0) > this.opts.reconcileTrustMs;
    this.state.setAlbum(key, { status: 'sending', phase: 'upload', topic: entry.topicName, caption: album.caption, files: files.map((f) => f.path),
      startedAt: prev.startedAt || Date.now() });
    this.progress.albumStatus(key, 'uploading');
    if (!this.preloaded.has(key)) this.ev.log(`  ↑ Uploading ${label}`, 'step');
    // Hash small files while they upload, so later duplicates can be confirmed even if these files are moved.
    const hashing = this.opts.skipDuplicates ? Promise.all(files.filter((f) => f.size <= 256 * MB).map((f) => this.hashes.sha256(f).catch(() => null))) : null;
    let result = markSent ? { ok: true, messageIds: prev.messageIds || [], reconciled: true }
      : await this.sendWithSplits({ ...album, files }, topicRef.id, label, onProgress, key, { mustConfirm: resumed && !forced, holdIfUnconfirmed });
    if (markSent) this.ev.log(`  ✓ Marked as sent: ${label}`, 'ok');
    // The topic was deleted in Telegram since it was looked up: find or create it again, once.
    if (!result.ok && !this.cancelled && /TOPIC_DELETED|TOPIC_ID_INVALID/.test(errorText(result.error)) && this.opts.mode === 'per_folder' && !entry.topicId) {
      this.ev.log(`Topic "${entry.topicName}" no longer exists in Telegram; looking for it again.`, 'warn');
      this.state.forgetTopic(entry.topicName);
      if (this.topicsMap) this.topicsMap.delete(normalizeKey(entry.topicName));
      try {
        this.topicsMap = await this.loadTopics();
        topicRef.id = await this.topicFor(entry, this.topicsMap);
        this.state.setAlbum(key, { steps: [], messageIds: [], topicRetry: (prev.topicRetry || 0) + 1 });
        result = await this.sendWithSplits({ ...album, files }, topicRef.id, label, onProgress, key, { variant: `t${topicRef.id}` });
      } catch (e) {
        result = { ok: false, error: e };
      }
    }
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
        messageIds: result.messageIds || [], reconciled: !!result.reconciled || undefined });
      for (const f of files) this.report.uploaded.push({ name: f.name, path: f.path, size: f.size, topic: entry.topicName, album: album.set || '' });
      this.ev.album({ key, status: 'done', topic: entry.topicName, caption: album.caption });
      this.progress.delivered(key, files.map((f) => f.path));
      return files.length;
    }
    if (this.cancelled && result.cancelled) {
      this.state.setAlbum(key, { status: result.uncertain ? 'uncertain' : 'pending' });
      return -1;
    }
    if (result.review) {
      const msg = "Telegram couldn't confirm whether this album arrived before FolderGram stopped. Check the topic, then choose Send again or Mark as sent.";
      this.state.setAlbum(key, { status: 'review', error: errorText(result.error) || msg });
      this.stats.review += files.length;
      this.report.review.push({ key, topic: entry.topicName, caption: album.caption || '', set: album.set || '', files: files.map((f) => f.name),
        startedAt: prev.startedAt || null, error: errorText(result.error) });
      this.progress.failed(files.map((f) => f.path), { review: true, key });
      this.ev.log(`  ⚠ Held for review: ${label}. ${msg}`, 'warn');
      this.ev.album({ key, status: 'review', topic: entry.topicName, caption: album.caption });
      return -1;
    }
    this.stats.failed += files.length;
    this.failAlbum(entry, { ...album, files }, result.error, key, result.uncertain);
    this.progress.failed(files.map((f) => f.path), { key, error: errorText(result.error) });
    return 0;
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
  async sendWithSplits(album, topicId, label, onProgress, key, { mustConfirm = false, holdIfUnconfirmed = false, variant = '' } = {}) {
    const limit = this.opts.maxFileMb * MB;
    const st = this.state.album(key) || {};
    const doneSteps = new Set(st.steps || []);
    const messageIds = [...(st.messageIds || [])];
    let reconciled = false;
    const sinceMs = st.startedAt || Date.now();
    let confirmNext = mustConfirm; // the first message not yet marked sent is the one that may have been cut off
    const sendChunk = async (files, caption, cb, chunk) => {
      const ctl = this.control(variant ? `${key}${variant}` : key, chunk, doneSteps, messageIds, files, key);
      const confirm = confirmNext && !ctl.isDone(0);
      if (!ctl.isDone(0)) confirmNext = false;
      const r = await this.withRetry((a) => this.t.sendAlbum(this.chat, files, caption, topicId, this.opts, (frac, name, detail) => { a.touch(); cb(frac, name, detail); },
        { ...ctl, isCanceled: () => this.cancelled || a.aborted, activity: () => a.touch() }), label, {
        reconcile: this.t.findRecentAlbum ? async (since) => {
          const exclude = this.state.knownMessageIds ? this.state.knownMessageIds() : new Set();
          for (const id of messageIds) exclude.add(id); // earlier messages of this same album
          const found = normalizeCheck(await this.t.findRecentAlbum(this.chat, topicId, { since, count: files.length, caption, exclude, names: files.map((f) => f.name) }));
          if (found.ids) { reconciled = true; messageIds.push(...found.ids); }
          return found;
        } : null,
        since: this.telegramTime(sinceMs),
        mustConfirm: confirm,
        holdIfUnconfirmed,
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

  /**
   * What the transport needs to send one chunk safely: stable ids, done-steps, cancel and concurrency. idKey makes
   * the message ids (normally the album key; different after the album moved to a re-created topic).
   */
  control(idKey, chunk, doneSteps, messageIds, files, key = idKey) {
    return {
      randomIds: (step, count, variant = 0) => randomIds(this.jobId, idKey, `${chunk}.${step}`, count, variant),
      isDone: (step) => doneSteps.has(`${chunk}.${step}`),
      stepDone: (step, ids = []) => {
        doneSteps.add(`${chunk}.${step}`);
        messageIds.push(...ids);
        this.state.setAlbum(key, { steps: [...doneSteps], messageIds: [...messageIds] });
      },
      isCanceled: () => this.cancelled,
      sending: () => {
        this.state.setAlbum(key, { phase: 'send', sendAt: Date.now() });
        this.progress.albumStatus(key, 'sending');
        this.preloadNext();
      },
      fileStatus: (path, status) => this.progress.fileStatus(path, status),
      note: (text) => this.ev.log(`  ${text}`, 'step'),
      observe: (o) => this.conc.observe(o),
      onWait: (seconds) => {
        // Every part in flight gets the same answer: slow down once per wait, not once per part.
        if (Date.now() < (this.partFloodUntil || 0)) return;
        this.partFloodUntil = Date.now() + seconds * 1000;
        this.conc.flood(seconds);
        this.ev.log(`Telegram asked to slow down file parts, waiting ${seconds}s…`, 'warn');
      },
      log: (text, kind) => this.ev.log(text, kind),
      concurrency: () => this.conc.filesFor(files.map((f) => f.size)),
      workersFor: (size) => this.conc.workersFor(size),
      connectionsFor: (size) => this.conc.connectionsFor(size),
      mediaCache: this.uploadedMedia,
    };
  }

  /** A local time (ms) as Telegram's clock reads it (unix s), for comparing with message dates. */
  telegramTime(ms) {
    const offset = this.t.serverNow ? this.t.serverNow() - Math.floor(Date.now() / 1000) : 0;
    return Math.floor(ms / 1000) + offset;
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
   * Waits while the connection to Telegram is down. Returns true when it is fine (the failure was something else and
   * counts as an attempt), false after an outage (the attempt doesn't count). Waits as long as it takes; Cancel
   * ends the wait at once. Transports without checkConnection are assumed to be connected.
   */
  async waitForConnection() {
    const t = this.t;
    if (!t.checkConnection) return true;
    if (await t.checkConnection().catch(() => false)) return true;
    const started = Date.now();
    this.ev.log('Connection to Telegram lost. Waiting for it to come back…', 'warn');
    let ok = false;
    for (let i = 0; !this.cancelled; i++) {
      const ms = Math.min(30000, (this.opts.offlineBaseMs ?? 2000) * 2 ** Math.min(i, 4));
      this.ev.wait({ seconds: Math.ceil(ms / 1000), reason: 'offline' });
      await this.sleep(ms);
      if (this.cancelled) break;
      // Every third failed check, ask for a fresh connection in case the old one is open but silent.
      if (t.ensureConnected) await t.ensureConnected({ nudge: i % 3 === 2 }).catch(() => {});
      if (await t.checkConnection().catch(() => false)) { ok = true; break; }
    }
    this.ev.wait({ seconds: 0, reason: 'offline' });
    this.stats.offlineMs += Date.now() - started;
    if (ok) this.ev.log(`Reconnected after ${Math.max(1, Math.round((Date.now() - started) / 1000))} s. Continuing.`, 'info');
    return false;
  }

  /** One try of a call: Cancel and the watchdog end it through `aborted`; progress calls `touch()`. */
  newAttempt() {
    const a = { aborted: false, last: Date.now() };
    a.touch = () => { a.last = Date.now(); };
    return a;
  }

  /**
   * Watchdog: an attempt with no progress for opts.stallMs (a call Telegram never answers, an upload that stopped
   * moving) is given up as uncertain, so the retry, with the same message ids, can't post twice. Cancel ends it too.
   */
  watch(p, a) {
    const stallMs = this.opts.stallMs;
    Promise.resolve(p).catch(() => {}); // a given-up attempt may still fail later; nobody waits for it then
    return new Promise((resolve, reject) => {
      let timer = null;
      const end = (fn) => (v) => { clearInterval(timer); this.sleepers.delete(onCancel); fn(v); };
      // Cancel() wakes every sleeper: that ends a call that never answers too.
      const onCancel = end(() => { a.aborted = true; reject(Object.assign(new Error('USER_CANCELED'), { errorMessage: 'USER_CANCELED' })); });
      this.sleepers.add(onCancel);
      if (stallMs) {
        timer = setInterval(() => {
          if (Date.now() - Math.max(a.last, this.activityAt) <= stallMs) return;
          a.aborted = true;
          this.stats.stalls++;
          // Uploads that never finished must not be waited for again by the retry.
          for (const [k, v] of this.uploadedMedia) if (v && v.pending) this.uploadedMedia.delete(k);
          end(reject)(Object.assign(new Error(`STALLED: no progress for ${Math.round(stallMs / 1000)} s`), { errorMessage: 'STALLED' }));
        }, Math.max(10, Math.min(2000, stallMs / 4)));
      }
      Promise.resolve(p).then(end(resolve), end(reject));
    });
  }

  /**
   * Runs fn(attempt) with retries. Returns true on success; otherwise { error, uncertain, cancelled, review } (or false
   * for simple calls). Flood waits are honoured exactly and don't count as attempts; neither do connection outages,
   * which are waited out. RANDOM_ID_DUPLICATE means Telegram already has the message, which counts as success.
   * After an uncertain failure (or with mustConfirm, for an album cut off in an earlier run) `reconcile` checks
   * whether the message arrived before sending it again. When that can't be checked: with holdIfUnconfirmed the album
   * is held for review, otherwise it is sent again with the same message ids, which Telegram drops if it has them.
   */
  async withRetry(fn, what, { reconcile = null, since = Math.floor(Date.now() / 1000), throwPermanent = false, mustConfirm = false, holdIfUnconfirmed = false } = {}) {
    let uncertain = mustConfirm;
    let lastError = null;
    let outages = 0;
    const MAX_OUTAGES = 30; // an outage costs no attempt, but a link that keeps dropping must still end
    for (let attempt = 1; attempt <= this.opts.maxRetries; attempt++) {
      if (this.cancelled) return { cancelled: true, uncertain, error: lastError };
      if (uncertain && reconcile) {
        let check;
        try { check = normalizeCheck(await reconcile(since)); } catch (e) { check = { ids: null, complete: false, error: e }; }
        if (check.ids) {
          this.ev.log(`  ${what}: Telegram already has it, not sending again.`, 'info');
          return true;
        }
        if (check.complete) {
          uncertain = false; // every message since the send was checked: it isn't there, so sending can't post twice
        } else {
          if (check.error && isNetworkError(check.error) && outages < MAX_OUTAGES && !(await this.waitForConnection())) { outages++; attempt--; continue; }
          if (holdIfUnconfirmed) return { review: true, uncertain: true, error: check.error || null };
        }
      }
      const a = this.newAttempt();
      try {
        await this.watch(fn(a), a);
        return true;
      } catch (e) {
        a.aborted = true;
        lastError = e;
        this.lastError = e;
        const kind = classify(e);
        if (this.t.dlog) this.t.dlog.write('retry', `${what} attempt ${attempt}: ${kind}:`, e);
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
        if (/STALLED/.test(errorText(e))) this.ev.log(`  ${what}: no progress for a while; trying again.`, 'warn');
        // No connection: wait for it instead of using up attempts (a Wi-Fi drop would otherwise fail every album).
        if (isNetworkError(e) && outages < MAX_OUTAGES && !(await this.waitForConnection())) { outages++; attempt--; continue; }
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
