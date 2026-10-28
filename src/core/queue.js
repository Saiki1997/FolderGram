// Persistent upload queue. Jobs run one at a time (they share one Telegram account), survive restarts and
// crashes, can be paused, reordered, scheduled and retried. Each job keeps its plan and a journal of what was
// sent, so a resumed job continues exactly where it stopped.
'use strict';

const EventEmitter = require('events');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { readJson, writeJson, writeAtomic } = require('./store');
const { UploadJob } = require('./uploader');

const FINAL = new Set(['done', 'failed', 'cancelled']);

/** Album and topic progress of one job, kept in an append-only journal next to the job. */
class JobState {
  constructor(file) {
    this.file = file;
    this.albums = new Map();
    this.topics = new Map();
    this.fd = null;
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { /* new job */ }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const r = JSON.parse(line);
        if (r.a) this.albums.set(r.a, { ...(this.albums.get(r.a) || {}), ...r.p });
        else if (r.t) this.topics.set(r.t, r.id);
      } catch { /* torn last line after a crash */ }
    }
  }

  write(rec) {
    try {
      if (this.fd == null) this.fd = fs.openSync(this.file, 'a');
      fs.writeSync(this.fd, `${JSON.stringify(rec)}\n`);
      fs.fdatasyncSync(this.fd);
    } catch { /* the in-memory state still works for this session */ }
  }

  album(key) { return this.albums.get(key) || null; }
  setAlbum(key, patch) {
    this.albums.set(key, { ...(this.albums.get(key) || {}), ...patch });
    this.write({ a: key, p: patch });
  }

  topic(name) { return this.topics.get(name) || null; }
  setTopic(name, id) {
    if (this.topics.get(name) === id) return;
    this.topics.set(name, id);
    this.write({ t: name, id });
  }

  counts() {
    const c = { done: 0, failed: 0, uncertain: 0, sending: 0 };
    for (const a of this.albums.values()) if (a.status && c[a.status] != null) c[a.status]++;
    return c;
  }

  close() {
    if (this.fd != null) { try { fs.closeSync(this.fd); } catch { /* ignore */ } this.fd = null; }
  }
}

/** Plan without the scan's folder file lists (each album has its own files), small enough to store. */
function serializePlan(plan) {
  return plan.map((e) => ({
    id: e.id, topicName: e.topicName, topicId: e.topicId || null, header: e.header,
    folder: { path: e.folder.path, leaf: e.folder.leaf, top: e.folder.top, relPath: e.folder.relPath, dir: e.folder.dir },
    albums: e.albums.map((a) => ({ caption: a.caption, set: a.set, setId: a.setId, part: a.part, totalParts: a.totalParts,
      files: a.files.map((f) => ({ path: f.path, name: f.name, ext: f.ext, size: f.size, mtime: f.mtime, mtimeMs: f.mtimeMs, asDocument: f.asDocument || undefined })) })),
  }));
}

const planCounts = (plan) => ({
  files: plan.reduce((a, e) => a + e.albums.reduce((b, al) => b + al.files.length, 0), 0),
  albums: plan.reduce((a, e) => a + e.albums.length, 0),
  bytes: plan.reduce((a, e) => a + e.albums.reduce((b, al) => b + al.files.reduce((c, f) => c + f.size, 0), 0), 0),
});

/**
 * deps: { dir, transport, history, hashCache, splitVideo, now() }
 * Events: "changed" (list), "log" ({ jobId, text, kind }), "progress" ({ jobId, ... }), "wait", "finished" ({ job, report })
 */
class UploadQueue extends EventEmitter {
  constructor(deps) {
    super();
    this.deps = { now: () => Date.now(), ...deps };
    this.dir = deps.dir;
    fs.mkdirSync(this.dir, { recursive: true });
    this.file = path.join(this.dir, 'queue.json');
    this.jobs = readJson(this.file, [], { onRecover: deps.onRecover });
    if (!Array.isArray(this.jobs)) this.jobs = [];
    // Jobs that were running when FolderGram stopped are offered for resuming.
    for (const j of this.jobs) if (j.status === 'running' || j.status === 'pausing') { j.status = 'interrupted'; j.interruptedAt = this.deps.now(); }
    this.running = null; // { job, upload }
    this.timer = null;
    this.stopped = false;
    this.save();
  }

  save() {
    writeJson(this.file, this.jobs);
    this.emit('changed', this.list());
  }

  planFile(id) { return path.join(this.dir, `${id}.plan.json`); }
  stateFile(id) { return path.join(this.dir, `${id}.state.jsonl`); }
  reportFile(id) { return path.join(this.dir, `${id}.report.json`); }

  get(id) { return this.jobs.find((j) => j.id === id) || null; }

  list() {
    return this.jobs.map((j) => ({ ...j, running: !!(this.running && this.running.job.id === j.id) }));
  }

  /** Files of `plan` that unfinished jobs to the same group already contain. */
  overlap(chatId, plan) {
    const mine = new Set(plan.flatMap((e) => e.albums.flatMap((a) => a.files.map((f) => f.path))));
    let n = 0;
    for (const j of this.jobs) {
      if (FINAL.has(j.status) || j.chat.id !== chatId) continue;
      const other = readJson(this.planFile(j.id), []);
      for (const e of other) for (const a of e.albums) for (const f of a.files) if (mine.has(f.path)) n++;
    }
    return n;
  }

  /**
   * Adds a job. spec: { name, chat, mode, topicId, options, plan, scheduledAt, sources, start }
   * Returns the job. It starts at once when nothing else runs and it isn't scheduled for later.
   */
  add(spec) {
    const id = `${new Date(this.deps.now()).toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(4).toString('hex')}`;
    writeAtomic(this.planFile(id), JSON.stringify(serializePlan(spec.plan)), { backup: false });
    const job = {
      id, name: spec.name || 'Upload', status: spec.hold ? 'held' : 'queued', createdAt: this.deps.now(), scheduledAt: spec.scheduledAt || null,
      chat: { id: spec.chat.id, title: spec.chat.title, isForum: !!spec.chat.isForum }, mode: spec.mode, topicId: spec.topicId || null,
      options: spec.options || {}, sources: spec.sources || [], totals: planCounts(spec.plan), stats: null, error: null,
    };
    this.jobs.push(job);
    this.save();
    this.kick();
    return job;
  }

  update(id, patch) {
    const j = this.get(id);
    if (!j) throw new Error('That job no longer exists.');
    Object.assign(j, patch);
    this.save();
    return j;
  }

  /** Moves a job to a new position in the queue. */
  move(id, toIndex) {
    const i = this.jobs.findIndex((j) => j.id === id);
    if (i < 0) return;
    const [j] = this.jobs.splice(i, 1);
    this.jobs.splice(Math.max(0, Math.min(this.jobs.length, toIndex)), 0, j);
    this.save();
  }

  /** Pause: a running job stops after its current album; a waiting job is held until resumed. */
  pause(id) {
    const j = this.get(id);
    if (!j) return;
    if (this.running && this.running.job.id === id) { this.running.upload.pause(); j.status = 'paused'; }
    else if (!FINAL.has(j.status)) j.status = 'held';
    this.save();
  }

  resume(id) {
    const j = this.get(id);
    if (!j) return;
    if (this.running && this.running.job.id === id) { this.running.upload.resume(); j.status = 'running'; }
    else if (['held', 'interrupted', 'paused'].includes(j.status)) j.status = 'queued';
    this.save();
    this.kick();
  }

  cancel(id) {
    const j = this.get(id);
    if (!j) return;
    if (this.running && this.running.job.id === id) this.running.upload.cancel(); // finishes as "cancelled"
    else if (!FINAL.has(j.status)) { j.status = 'cancelled'; this.save(); }
  }

  /** Runs a finished job again: albums already sent are skipped, failed and unsent ones go. */
  retry(id) {
    const j = this.get(id);
    if (!j || (this.running && this.running.job.id === id)) return;
    j.status = 'queued';
    j.error = null;
    this.save();
    this.kick();
  }

  remove(id) {
    if (this.running && this.running.job.id === id) throw new Error('Cancel the job before removing it.');
    this.jobs = this.jobs.filter((j) => j.id !== id);
    for (const f of [this.planFile(id), this.stateFile(id), this.reportFile(id)]) fs.rmSync(f, { force: true });
    this.save();
  }

  clearFinished() {
    for (const j of this.jobs.filter((x) => x.status === 'done')) this.remove(j.id);
  }

  report(id) { return readJson(this.reportFile(id), null); }

  /** Starts the next job that is due, or sets a timer for the next scheduled one. */
  kick() {
    if (this.running || this.stopped) return;
    clearTimeout(this.timer);
    const now = this.deps.now();
    const next = this.jobs.find((j) => j.status === 'queued' && (!j.scheduledAt || j.scheduledAt <= now));
    if (next) {
      this.runJob(next).catch((e) => this.emit('log', { jobId: next.id, text: e.message, kind: 'error' }));
      return;
    }
    const later = this.jobs.filter((j) => j.status === 'queued' && j.scheduledAt > now).sort((a, b) => a.scheduledAt - b.scheduledAt)[0];
    if (later) {
      this.timer = setTimeout(() => this.kick(), Math.min(later.scheduledAt - now, 2 ** 31 - 1));
      if (this.timer.unref) this.timer.unref();
    }
  }

  async runJob(job) {
    const plan = readJson(this.planFile(job.id), null);
    if (!plan) {
      Object.assign(job, { status: 'failed', error: 'The saved plan for this job is missing.' });
      this.save();
      return this.kick();
    }
    const state = new JobState(this.stateFile(job.id));
    const ev = (name) => (payload) => this.emit(name, { jobId: job.id, ...payload });
    const upload = new UploadJob(this.deps.transport, job.chat, plan, { ...job.options, mode: job.mode, topicId: job.topicId, splitVideo: this.deps.splitVideo, appVersion: this.deps.appVersion }, {
      log: (text, kind) => this.emit('log', { jobId: job.id, text, kind, at: Date.now() }),
      progress: ev('progress'),
      wait: ev('wait'),
      album: ev('album'),
    }, this.deps.history, { state, hashCache: this.deps.hashCache, jobId: job.id });
    this.running = { job, upload };
    Object.assign(job, { status: 'running', startedAt: job.startedAt || this.deps.now(), error: null });
    this.save();
    let error = null;
    try {
      await upload.run();
    } catch (e) {
      error = e;
    } finally {
      state.close();
      this.running = null;
    }
    const c = state.counts();
    job.stats = { ...upload.stats, albumsDone: c.done, albumsFailed: c.failed + c.uncertain };
    job.finishedAt = this.deps.now();
    if (job.quitting) { job.status = 'interrupted'; delete job.quitting; }
    else if (upload.cancelled) job.status = 'cancelled';
    else if (error) { job.status = 'failed'; job.error = (this.deps.friendlyError || ((e) => e.message))(error); }
    else job.status = upload.stats.failed ? 'failed' : 'done';
    if (job.status === 'failed' && !job.error) job.error = `${upload.stats.failed} file(s) failed. Retry sends only those.`;
    const report = { ...upload.report, jobName: job.name, status: job.status, error: job.error };
    try { writeJson(this.reportFile(job.id), report, { backup: false }); } catch { /* report is optional */ }
    this.save();
    this.emit('finished', { job, report });
    this.kick();
    return job;
  }

  /** App is quitting: stop the running job so it is offered for resuming next time. */
  interrupt() {
    this.stop();
    if (this.running) {
      this.running.job.quitting = true;
      this.running.upload.cancel();
    }
  }

  /** Stops starting new jobs (the running one is left to the caller). */
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }
}

module.exports = { UploadQueue, JobState, serializePlan };
