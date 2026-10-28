// Folder sync: keeps chosen folders and a Telegram group in step. Each run compares the folders with what the last
// run saw (new, changed, renamed and removed files) and uploads new and changed media through the normal queue,
// with duplicate checks on, so a renamed file is never sent again. Upload-only is the default. Two-way also lists
// albums that appeared on Telegram, to download, and files removed here, whose messages could be deleted; neither
// happens without the user confirming. Files a download wrote are never uploaded back, and messages a sync posted are
// never downloaded back, so the two directions can't feed each other.
'use strict';

const path = require('path');
const crypto = require('crypto');
const { readJson, writeJson } = require('./store');
const { quickFingerprints } = require('./hashing');

const MODES = ['manual', 'interval', 'watch'];
const DIRECTIONS = ['upload', 'two-way'];

/** Cleans a sync profile coming from the window. */
function sanitizeProfile(p, { now = Date.now } = {}) {
  const str = (v, n) => String(v == null ? '' : v).slice(0, n);
  const o = p && typeof p === 'object' ? p : {};
  const sched = o.schedule && typeof o.schedule === 'object' ? o.schedule : {};
  return {
    id: str(o.id, 40) || `s${now().toString(36)}${crypto.randomBytes(3).toString('hex')}`,
    name: str(o.name, 120).trim() || 'Folder sync',
    folders: (Array.isArray(o.folders) ? o.folders : []).map((f) => str(f, 2000)).filter(Boolean).slice(0, 50),
    chat: o.chat && typeof o.chat === 'object' ? { id: str(o.chat.id, 40), title: str(o.chat.title, 256), isForum: !!o.chat.isForum, peer: o.chat.peer || null } : null,
    mode: ['per_folder', 'single', 'none'].includes(o.mode) ? o.mode : 'per_folder',
    topicId: o.topicId ? Math.max(1, Math.floor(Number(o.topicId)) || 1) : null,
    options: o.options && typeof o.options === 'object' ? o.options : {},
    schedule: { type: MODES.includes(sched.type) ? sched.type : 'manual', minutes: Math.min(7 * 24 * 60, Math.max(5, Math.floor(Number(sched.minutes) || 60))) },
    direction: DIRECTIONS.includes(o.direction) ? o.direction : 'upload',
    enabled: o.enabled !== false,
    lastRun: o.lastRun || null,
    lastResult: o.lastResult || null,
  };
}

// ---------------------------------------------------------------- comparing folder snapshots

/**
 * What changed between two snapshots ({ path: { size, mtimeMs } }). A file that disappeared and a new file of the
 * same size and quick fingerprint (fingerprint(file) → string) count as a rename. Returns
 * { added, changed, removed, renamed: [{ from, to }], unchanged } with paths.
 */
async function diffSnapshots(prev, now, fingerprint) {
  const added = [], changed = [], removed = [], unchanged = [];
  for (const [p, f] of Object.entries(now)) {
    const o = prev[p];
    if (!o) added.push(p);
    else if (o.size !== f.size || Math.round(o.mtimeMs) !== Math.round(f.mtimeMs)) changed.push(p);
    else unchanged.push(p);
  }
  for (const p of Object.keys(prev)) if (!now[p]) removed.push(p);
  // Renames: same size first (cheap), then the quick fingerprint (reads 3 × 64 KB).
  const renamed = [];
  if (removed.length && added.length && fingerprint) {
    const bySize = new Map();
    for (const p of removed) {
      const k = prev[p].size;
      if (!bySize.has(k)) bySize.set(k, []);
      bySize.get(k).push(p);
    }
    for (const p of [...added]) {
      const cands = bySize.get(now[p].size);
      if (!cands || !cands.length) continue;
      const fp = await fingerprint(p).catch(() => null);
      if (!fp) continue;
      const i = cands.findIndex((c) => prev[c].q && prev[c].q === fp);
      if (i < 0) continue;
      const from = cands.splice(i, 1)[0];
      renamed.push({ from, to: p });
      added.splice(added.indexOf(p), 1);
      removed.splice(removed.indexOf(from), 1);
    }
  }
  return { added, changed, removed, renamed, unchanged };
}

/** Snapshot of scanned folders (scanner groups): { path: { size, mtimeMs } }, without files a download wrote. */
function snapshotOf(groups, skip = () => false) {
  const out = {};
  for (const g of groups) for (const f of g.files) if (!skip(f.path)) out[f.path] = { size: f.size, mtimeMs: f.mtimeMs };
  return out;
}

// ---------------------------------------------------------------- what a sync remembers

/**
 * Per profile: the last snapshot (with quick fingerprints of uploaded files, for renames), which messages hold which
 * file, and every message id the sync posted (never downloaded back).
 */
class SyncState {
  constructor(file) {
    this.file = file;
    const d = readJson(file, {});
    this.files = d.files && typeof d.files === 'object' ? d.files : {};
    this.posted = d.posted && typeof d.posted === 'object' ? d.posted : {}; // path -> [message ids]
    this.own = new Set(Array.isArray(d.own) ? d.own : []);
    this.downloaded = new Set(Array.isArray(d.downloaded) ? d.downloaded : []); // message ids taken from Telegram
    this.runs = Array.isArray(d.runs) ? d.runs : [];
  }

  /** After a job: files it delivered or skipped as already there are now part of the snapshot. */
  recordJob(report, snapshot, fingerprints = {}) {
    const ok = new Set();
    for (const a of (report && report.albums) || []) {
      if (a.status !== 'sent' || !a.paths) continue;
      a.paths.forEach((p, i) => {
        ok.add(p);
        // Messages are in file order when Telegram answered with one id per file.
        const ids = a.messageIds && a.messageIds.length === a.paths.length ? [a.messageIds[i]] : a.messageIds || [];
        this.posted[p] = ids;
      });
      for (const id of a.messageIds || []) this.own.add(id);
    }
    for (const s of (report && report.skipped) || []) if (s && s.path) ok.add(s.path);
    for (const p of ok) if (snapshot[p]) this.files[p] = { ...snapshot[p], q: fingerprints[p] || (this.files[p] && this.files[p].q) || null };
  }

  /** Files gone from the folders (and renames) leave the snapshot; their messages stay listed until dealt with. */
  forget(paths) { for (const p of paths) delete this.files[p]; }

  rename(from, to, snapshot) {
    if (this.files[from]) this.files[to] = { ...this.files[from], ...snapshot[to] };
    delete this.files[from];
    if (this.posted[from]) { this.posted[to] = this.posted[from]; delete this.posted[from]; }
  }

  addRun(r) {
    this.runs.push(r);
    if (this.runs.length > 50) this.runs.shift();
  }

  save() {
    writeJson(this.file, { files: this.files, posted: this.posted, own: [...this.own].slice(-200000), downloaded: [...this.downloaded].slice(-200000), runs: this.runs },
      { backup: false });
  }
}

/** Keeps only the files of a plan (uploader format) that are in `paths`; empty albums and folders are dropped. */
function filterPlan(plan, paths) {
  const want = paths instanceof Set ? paths : new Set(paths);
  return plan.map((e) => ({ ...e, albums: e.albums.map((a) => ({ ...a, files: a.files.filter((f) => want.has(f.path)) })).filter((a) => a.files.length) }))
    .filter((e) => e.albums.length);
}

/**
 * Albums on Telegram that the sync did not post and has not downloaded: candidates to download in two-way mode.
 * albums: library albums [{ ids, ... }].
 */
function newOnTelegram(albums, state) {
  return albums.filter((a) => a.ids.every((id) => !state.own.has(id) && !state.downloaded.has(id)));
}

/** Removed files whose messages are known: candidates to delete from Telegram in two-way mode (only if confirmed). */
function removedWithMessages(removed, state) {
  return removed.filter((p) => state.posted[p] && state.posted[p].length).map((p) => ({ path: p, name: path.basename(p), messageIds: state.posted[p] }));
}

/** When an interval profile is due next (ms), or null. */
function nextRunAt(profile, now = Date.now()) {
  if (!profile.enabled || profile.schedule.type !== 'interval') return null;
  const last = profile.lastRun ? Date.parse(profile.lastRun) : 0;
  return Math.max(now, last + profile.schedule.minutes * 60000);
}

/**
 * Runs sync profiles. deps: { scan(folders, options) → scanner groups, plan(groups, options) → upload plan,
 * enqueue({ profile, plan, name }) → job, stateFile(id) → path, downloadedPaths(folders) → Set of paths a download
 * wrote, telegramAlbums(profile) → library albums (two-way only), fingerprint(path, size) → quick fingerprint,
 * now() }.
 */
class SyncRunner {
  constructor(deps) {
    this.deps = { now: Date.now, fingerprint: quickOf, downloadedPaths: () => new Set(), ...deps };
    this.running = new Set();
    this.pending = new Map(); // profile id -> { snapshot, fingerprints, jobId }
  }

  state(id) { return new SyncState(this.deps.stateFile(id)); }

  /**
   * One run: compares the folders with the last run and queues an upload of new and changed files. Returns
   * { changes: { added, changed, removed, renamed }, jobId, newOnTelegram, removedOnTelegram, note }.
   */
  async run(profile) {
    if (this.running.has(profile.id)) return { note: 'already running' };
    // The upload from the last run is still queued or sending: running again now would queue the same files twice.
    const prev = this.pending.get(profile.id);
    if (prev && this.deps.jobActive && this.deps.jobActive(prev.jobId)) return { note: 'the last sync upload is still running' };
    this.running.add(profile.id);
    try {
      const st = this.state(profile.id);
      const skip = this.deps.downloadedPaths(profile.folders);
      const groups = await this.deps.scan(profile.folders, profile.options);
      const snap = snapshotOf(groups, (p) => skip.has(p));
      const fps = {};
      const d = await diffSnapshots(st.files, snap, async (p) => (fps[p] = await this.deps.fingerprint(p, snap[p].size)));
      for (const r of d.renamed) st.rename(r.from, r.to, snap);
      const send = [...d.added, ...d.changed];
      // Fingerprints of what is sent, so a later rename of these files is recognised.
      for (const p of send) if (!fps[p]) fps[p] = await this.deps.fingerprint(p, snap[p].size).catch(() => null);
      let jobId = null;
      if (send.length) {
        const plan = filterPlan(this.deps.plan(groups, profile.options), new Set(send));
        if (plan.length) {
          const job = await this.deps.enqueue({ profile, plan, name: `${profile.name}: ${send.length} new` });
          jobId = job.id;
          this.pending.set(profile.id, { snapshot: snap, fingerprints: fps, jobId });
        }
      }
      const out = { at: new Date(this.deps.now()).toISOString(), changes: { added: d.added.length, changed: d.changed.length, removed: d.removed.length, renamed: d.renamed.length },
        renamed: d.renamed.slice(0, 200), jobId };
      if (profile.direction === 'two-way') {
        out.removedOnTelegram = removedWithMessages(d.removed, st);
        if (this.deps.telegramAlbums) out.newOnTelegram = newOnTelegram(await this.deps.telegramAlbums(profile), st);
      }
      // Removed files leave the snapshot now (their message ids stay until the user decides).
      st.forget(d.removed.filter((p) => !(st.posted[p] && st.posted[p].length && profile.direction === 'two-way')));
      st.addRun({ at: out.at, ...out.changes, jobId });
      st.save();
      return out;
    } finally {
      this.running.delete(profile.id);
    }
  }

  /** A sync job finished: what it delivered becomes part of the profile's snapshot. */
  jobFinished(profileId, jobId, report) {
    const p = this.pending.get(profileId);
    const st = this.state(profileId);
    if (p && p.jobId === jobId) {
      st.recordJob(report, p.snapshot, p.fingerprints);
      this.pending.delete(profileId);
    } else {
      // After a restart the snapshot is gone: record what the report says was delivered, with today's file facts.
      const snap = {};
      for (const a of (report && report.albums) || []) for (const q of a.paths || []) snap[q] = { size: null, mtimeMs: null };
      st.recordJob(report, snap);
      for (const q of Object.keys(snap)) delete st.files[q]; // unknown size: compared afresh next run, dup check skips them
    }
    st.save();
  }

  /** Messages were deleted from Telegram after the user confirmed: forget them. */
  forgetRemoved(profileId, paths) {
    const st = this.state(profileId);
    for (const p of paths) { delete st.posted[p]; delete st.files[p]; }
    st.save();
  }

  /** Telegram messages were downloaded (two-way): never offer or upload them again. */
  markDownloaded(profileId, messageIds) {
    const st = this.state(profileId);
    for (const id of messageIds) st.downloaded.add(id);
    st.save();
  }
}

const quickOf = (p, size) => quickFingerprints({ path: p, size }).then((r) => r.quick);

module.exports = { SyncRunner, sanitizeProfile, diffSnapshots, snapshotOf, SyncState, filterPlan, newOnTelegram, removedWithMessages, nextRunAt, quickOf, MODES, DIRECTIONS };
