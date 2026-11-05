// Permanent integrity ledger: foldergram-integrity.sqlite. Topics, uploaded files with their Telegram message ids,
// upload attempts, integrity incidents and rate-limit events. Uses Node's built-in SQLite (node:sqlite), so there is
// no native module to rebuild for Electron. WAL journal with synchronous=FULL: a committed row survives a crash or
// power loss. Rows are only ever added or updated, never deleted, and a topic record is keyed by (chat id, topic id),
// so a new topic with an old name can never overwrite an old record.
'use strict';

const fs = require('fs');
const path = require('path');

let sqlite = null;
function loadSqlite() {
  if (sqlite !== null) return sqlite;
  try {
    // node:sqlite prints an ExperimentalWarning once on some Node versions; it is harmless.
    const prev = process.emitWarning;
    process.emitWarning = (w, ...a) => { if (!/SQLite/i.test(String(w && w.message ? w.message : w))) prev.call(process, w, ...a); };
    try { sqlite = require('node:sqlite'); } finally { process.emitWarning = prev; }
  } catch {
    sqlite = false;
  }
  return sqlite;
}

const FILE_NAME = 'foldergram-integrity.sqlite';

// Each migration runs once, in order, inside a transaction. Never edit a shipped migration: add a new one.
const MIGRATIONS = [
  `CREATE TABLE telegram_topics (
     chat_id TEXT NOT NULL, topic_id INTEGER NOT NULL, original_name TEXT, current_name TEXT, aliases TEXT NOT NULL DEFAULT '[]',
     created_at INTEGER, first_seen_at INTEGER, last_verified_at INTEGER, missing_since INTEGER, status TEXT NOT NULL DEFAULT 'ok',
     protected INTEGER NOT NULL DEFAULT 1, source TEXT, replaced_by INTEGER, replaces INTEGER, extra TEXT,
     PRIMARY KEY (chat_id, topic_id));
   CREATE INDEX telegram_topics_name ON telegram_topics(chat_id, current_name);
   CREATE TABLE uploaded_files (
     id INTEGER PRIMARY KEY AUTOINCREMENT, local_path TEXT NOT NULL, file_name TEXT, size INTEGER, mtime INTEGER, sha256 TEXT,
     uploaded_at INTEGER, chat_id TEXT NOT NULL, topic_id INTEGER, message_id INTEGER, media_id TEXT, album_key TEXT, grouped_id TEXT,
     job_id TEXT, state TEXT NOT NULL, verification TEXT NOT NULL DEFAULT 'unverified', verified_at INTEGER);
   CREATE INDEX uploaded_files_path ON uploaded_files(local_path, size, mtime);
   CREATE INDEX uploaded_files_msg ON uploaded_files(chat_id, message_id);
   CREATE INDEX uploaded_files_topic ON uploaded_files(chat_id, topic_id, id);
   CREATE INDEX uploaded_files_sha ON uploaded_files(sha256) WHERE sha256 IS NOT NULL;
   CREATE INDEX uploaded_files_album ON uploaded_files(album_key);
   CREATE TABLE upload_attempts (
     id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT, album_key TEXT, chat_id TEXT, topic_id INTEGER, started_at INTEGER, finished_at INTEGER,
     request_ids TEXT, messages INTEGER, outcome TEXT NOT NULL DEFAULT 'pending', error_category TEXT, error TEXT, retry_state TEXT);
   CREATE INDEX upload_attempts_album ON upload_attempts(album_key, id);
   CREATE INDEX upload_attempts_open ON upload_attempts(outcome) WHERE outcome IN ('pending','uncertain');
   CREATE TABLE integrity_events (
     id TEXT PRIMARY KEY, chat_id TEXT, topic_id INTEGER, message_id INTEGER, category TEXT NOT NULL, detected_at INTEGER NOT NULL,
     evidence TEXT, severity TEXT, resolution TEXT NOT NULL DEFAULT 'open', resolved_at INTEGER);
   CREATE INDEX integrity_events_chat ON integrity_events(chat_id, detected_at);
   CREATE TABLE rate_limit_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT, chat_id TEXT, topic_id INTEGER, method TEXT, flood_seconds INTEGER, code TEXT,
     category TEXT, at INTEGER NOT NULL, effective_rate INTEGER);
   CREATE INDEX rate_limit_events_at ON rate_limit_events(at);
   CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);`,
  // Keyset pages over a whole chat (deep audit, manifest export) and the status counts: without these, each page of a
  // million-row ledger re-sorted the chat's rows (measured: 73 s to walk 1M message ids, now see bench/RESULTS.md).
  `CREATE INDEX uploaded_files_chat ON uploaded_files(chat_id, id);
   CREATE INDEX uploaded_files_verification ON uploaded_files(verification);`,
];

class Ledger {
  /** Opens (or creates) the ledger in `dir`. Returns a NullLedger when SQLite isn't available in this runtime. */
  static open(dir, { onRecover = () => {}, file = FILE_NAME } = {}) {
    const lib = loadSqlite();
    if (!lib) return new NullLedger('SQLite is not available in this version of the app');
    const p = path.join(dir, file);
    fs.mkdirSync(dir, { recursive: true });
    try {
      return new Ledger(lib, p);
    } catch (e) {
      // Damaged: keep it aside (never delete it), restore the newest backup that passes a check, or start fresh.
      const aside = `${p}.corrupt-${Date.now()}`;
      for (const s of ['', '-wal', '-shm']) { try { if (fs.existsSync(p + s)) fs.renameSync(p + s, aside + s); } catch { /* keep going */ } }
      const restored = restoreNewestBackup(lib, dir, p);
      onRecover(`The integrity database was damaged (${e.message}); it was kept as ${path.basename(aside)}${restored ? ` and restored from ${path.basename(restored)}` : ' and a new one was started (it is rebuilt from your job reports)'}.`);
      return new Ledger(lib, p);
    }
  }

  constructor(lib, file) {
    this.file = file;
    this.available = true;
    this.db = new lib.DatabaseSync(file);
    try {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
      const ok = this.db.prepare('PRAGMA quick_check').get();
      if (!ok || Object.values(ok)[0] !== 'ok') throw new Error(`integrity check failed: ${JSON.stringify(ok)}`);
      this.migrate();
    } catch (e) {
      try { this.db.close(); } catch { /* ignore */ }
      throw e;
    }
    this.prepare();
  }

  migrate() {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
    const row = this.db.prepare('SELECT version FROM schema_version').get();
    let v = row ? row.version : 0;
    if (!row) this.db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
    while (v < MIGRATIONS.length) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[v]);
        this.db.prepare('UPDATE schema_version SET version = ?').run(v + 1);
      });
      v++;
    }
    this.version = v;
  }

  prepare() {
    const p = (sql) => this.db.prepare(sql);
    this.st = {
      putTopic: p(`INSERT INTO telegram_topics (chat_id, topic_id, original_name, current_name, aliases, created_at, first_seen_at, last_verified_at, missing_since,
                   status, protected, source, replaced_by, replaces, extra)
                 VALUES (@chatId, @topicId, @originalName, @currentName, @aliases, @createdAt, @firstSeenAt, @lastVerifiedAt, @missingSince, @status, @protected,
                   @source, @replacedBy, @replaces, @extra)
                 ON CONFLICT(chat_id, topic_id) DO UPDATE SET current_name=excluded.current_name, aliases=excluded.aliases,
                   created_at=COALESCE(telegram_topics.created_at, excluded.created_at), last_verified_at=excluded.last_verified_at,
                   missing_since=excluded.missing_since, status=excluded.status, protected=excluded.protected, replaced_by=excluded.replaced_by,
                   replaces=excluded.replaces, extra=excluded.extra`),
      allTopics: p('SELECT * FROM telegram_topics'),
      addFile: p(`INSERT INTO uploaded_files (local_path, file_name, size, mtime, sha256, uploaded_at, chat_id, topic_id, message_id, media_id, album_key, grouped_id, job_id, state, verification)
                 VALUES (@path, @name, @size, @mtime, @sha256, @uploadedAt, @chatId, @topicId, @messageId, @mediaId, @albumKey, @groupedId, @jobId, @state, @verification)`),
      fileByMsg: p('SELECT id FROM uploaded_files WHERE chat_id = ? AND message_id = ?'),
      startAttempt: p(`INSERT INTO upload_attempts (job_id, album_key, chat_id, topic_id, started_at, request_ids, messages, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`),
      finishAttempt: p('UPDATE upload_attempts SET finished_at = ?, outcome = ?, error_category = ?, error = ?, retry_state = ? WHERE id = ?'),
      openAttempts: p("SELECT * FROM upload_attempts WHERE outcome IN ('pending','uncertain') ORDER BY id"),
      addEvent: p(`INSERT OR IGNORE INTO integrity_events (id, chat_id, topic_id, message_id, category, detected_at, evidence, severity, resolution)
                 VALUES (@id, @chatId, @topicId, @messageId, @category, @detectedAt, @evidence, @severity, @resolution)`),
      updEvent: p('UPDATE integrity_events SET resolution = ?, resolved_at = ? WHERE id = ?'),
      allEvents: p('SELECT * FROM integrity_events ORDER BY detected_at'),
      addRate: p(`INSERT INTO rate_limit_events (account, chat_id, topic_id, method, flood_seconds, code, category, at, effective_rate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      verify: p('UPDATE uploaded_files SET verification = ?, verified_at = ? WHERE chat_id = ? AND message_id = ?'),
      getMeta: p('SELECT value FROM meta WHERE key = ?'),
      setMeta: p('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    };
  }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { try { this.db.exec('ROLLBACK'); } catch { /* ignore */ } throw e; }
  }

  // ---- topics (a store for TopicRegistry)

  topicStore() {
    const self = this;
    return {
      all: () => self.st.allTopics.all().map(rowToTopic),
      put: (r) => self.st.putTopic.run(topicToRow(r)),
      incidents: () => self.st.allEvents.all().map(rowToEvent),
      addIncident: (i) => self.addEvent(i),
      updateIncident: (id, patch) => self.st.updEvent.run(patch.resolution || 'resolved', Date.now(), id),
    };
  }

  // ---- files

  /** Records the files of one delivered album in one transaction. files: [{ path, name, size, mtime, sha256 }]. */
  recordAlbum({ chatId, topicId, jobId, albumKey, files, messageIds = [], groupedId = null, confirmed = true }) {
    const now = Date.now();
    const oneEach = messageIds.length === files.length;
    this.tx(() => {
      files.forEach((f, i) => {
        const messageId = oneEach ? messageIds[i] : null;
        if (messageId != null && this.st.fileByMsg.get(String(chatId), messageId)) return; // already recorded (resume)
        this.st.addFile.run({ path: f.path, name: f.name || path.basename(f.path), size: f.size ?? null, mtime: f.mtime ?? null, sha256: f.sha256 || null,
          uploadedAt: now, chatId: String(chatId), topicId: topicId ?? null, messageId, mediaId: null, albumKey: albumKey || null,
          groupedId: groupedId || null, jobId: jobId || null, state: confirmed ? 'VERIFIED_SENT' : 'UNCERTAIN',
          verification: messageId != null ? 'confirmed' : messageIds.length ? 'album_ids_only' : 'unverified' });
      });
    });
  }

  /** Many rows at once (migration, benchmarks), in bounded transactions. */
  addFilesBatch(rows, batch = 5000) {
    for (let i = 0; i < rows.length; i += batch) {
      this.tx(() => { for (const r of rows.slice(i, i + batch)) this.st.addFile.run({ mediaId: null, groupedId: null, sha256: null, verification: 'unverified', ...r, chatId: String(r.chatId) }); });
    }
  }

  /** Keyset pagination: rows of a chat/topic after `afterId`, oldest first. */
  pageFiles({ chatId, topicId = null, afterId = 0, limit = 200 }) {
    const sql = topicId == null
      ? 'SELECT * FROM uploaded_files WHERE chat_id = ? AND id > ? ORDER BY id LIMIT ?'
      : 'SELECT * FROM uploaded_files WHERE chat_id = ? AND topic_id = ? AND id > ? ORDER BY id LIMIT ?';
    const args = topicId == null ? [String(chatId), afterId, limit] : [String(chatId), topicId, afterId, limit];
    return this.db.prepare(sql).all(...args);
  }

  findFile(p, size, mtime) { return this.db.prepare('SELECT * FROM uploaded_files WHERE local_path = ? AND size = ? AND mtime = ? LIMIT 1').get(p, size, mtime) || null; }
  messageIds(chatId, { afterId = 0, limit = 1000 } = {}) {
    return this.db.prepare('SELECT id, message_id, topic_id FROM uploaded_files WHERE chat_id = ? AND message_id IS NOT NULL AND id > ? ORDER BY id LIMIT ?').all(String(chatId), afterId, limit);
  }
  setVerification(chatId, messageId, state) { this.st.verify.run(state, Date.now(), String(chatId), messageId); }

  // ---- attempts

  startAttempt({ jobId, albumKey, chatId, topicId, requestIds = [], messages }) {
    return Number(this.st.startAttempt.run(jobId || null, albumKey || null, String(chatId), topicId ?? null, Date.now(), JSON.stringify(requestIds.map(String)), messages || 0).lastInsertRowid);
  }
  finishAttempt(id, { outcome, category = null, error = null, retry = null }) { this.st.finishAttempt.run(Date.now(), outcome, category, error ? String(error).slice(0, 500) : null, retry, id); }
  openAttempts() { return this.st.openAttempts.all(); }

  // ---- events

  addEvent(i) {
    this.st.addEvent.run({ id: i.id, chatId: i.chatId != null ? String(i.chatId) : null, topicId: i.topicId ?? null, messageId: i.messageId ?? null, category: i.category,
      detectedAt: typeof i.detectedAt === 'number' ? i.detectedAt : Date.parse(i.detectedAt) || Date.now(), evidence: JSON.stringify(i.evidence || {}),
      severity: i.severity || 'warning', resolution: i.resolution || 'open' });
  }
  addRateEvent(e) {
    this.st.addRate.run(e.account || null, e.chatId != null ? String(e.chatId) : null, e.topicId ?? null, e.method || null, e.seconds ?? null, e.code || null, e.category || null, e.at || Date.now(), e.effectiveRate ?? null);
  }
  rateEvents({ since = 0, limit = 200 } = {}) { return this.db.prepare('SELECT * FROM rate_limit_events WHERE at >= ? ORDER BY id DESC LIMIT ?').all(since, limit); }

  meta(k) { const r = this.st.getMeta.get(k); return r ? r.value : null; }
  setMeta(k, v) { this.st.setMeta.run(k, String(v)); }

  counts() {
    const one = (sql) => Object.values(this.db.prepare(sql).get())[0];
    return {
      files: one('SELECT COUNT(*) FROM uploaded_files'),
      confirmed: one("SELECT COUNT(*) FROM uploaded_files WHERE verification = 'confirmed'"),
      needsVerification: one("SELECT COUNT(*) FROM uploaded_files WHERE verification IN ('unverified','album_ids_only') OR state = 'UNCERTAIN'"),
      missing: one("SELECT COUNT(*) FROM uploaded_files WHERE verification = 'missing'"),
      topics: one('SELECT COUNT(*) FROM telegram_topics'),
      openIncidents: one("SELECT COUNT(*) FROM integrity_events WHERE resolution = 'open'"),
      rateEvents: one('SELECT COUNT(*) FROM rate_limit_events'),
    };
  }

  /** Startup check: "ok" or the problems SQLite found. */
  integrityCheck() { return Object.values(this.db.prepare('PRAGMA integrity_check').get())[0]; }

  /** A consistent copy (VACUUM INTO) in backups/integrity/, the newest `keep` kept. Returns the file. */
  backup(dir, { keep = 7, now = new Date() } = {}) {
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, `foldergram-integrity-${now.toISOString().replace(/[:.]/g, '-')}.sqlite`);
    this.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
    this.db.prepare('VACUUM INTO ?').run(out);
    const all = fs.readdirSync(dir).filter((f) => /^foldergram-integrity-.*\.sqlite$/.test(f)).sort();
    for (const old of all.slice(0, Math.max(0, all.length - keep))) {
      // Old backups are rotated out; this only touches FolderGram's own backup copies.
      try { fs.unlinkSync(path.join(dir, old)); } catch { /* ignore */ }
    }
    return out;
  }

  /**
   * Full integrity check and backup on a worker thread with its own connection, so a large ledger doesn't freeze the
   * app (measured at 1M rows: ~6 s for integrity_check and ~2.5 s for the backup). Resolves { check, backup, ms };
   * if worker threads or SQLite in a worker are unavailable it falls back to doing the same on this thread.
   */
  maintain({ backupDir = null, keep = 7, now = new Date() } = {}) {
    const out = backupDir ? path.join(backupDir, `foldergram-integrity-${now.toISOString().replace(/[:.]/g, '-')}.sqlite`) : null;
    if (backupDir) fs.mkdirSync(backupDir, { recursive: true });
    try { this.db.exec('PRAGMA wal_checkpoint(PASSIVE)'); } catch { /* busy: the worker still reads a consistent snapshot */ }
    const rotate = () => {
      if (!backupDir) return;
      const all = fs.readdirSync(backupDir).filter((f) => /^foldergram-integrity-.*\.sqlite$/.test(f)).sort();
      for (const old of all.slice(0, Math.max(0, all.length - keep))) { try { fs.unlinkSync(path.join(backupDir, old)); } catch { /* ignore */ } }
    };
    const t0 = Date.now();
    const inline = () => {
      const check = this.integrityCheck();
      if (out) this.db.prepare('VACUUM INTO ?').run(out);
      rotate();
      return { check, backup: out, ms: Date.now() - t0, thread: 'main' };
    };
    let Worker;
    try { ({ Worker } = require('worker_threads')); } catch { return Promise.resolve().then(inline); }
    return new Promise((resolve, reject) => {
      let w;
      try {
        w = new Worker(MAINTAIN_SRC, { eval: true, workerData: { file: this.file, out } });
      } catch { resolve(inline()); return; }
      w.once('message', (m) => {
        if (m.unavailable) { try { resolve(inline()); } catch (e) { reject(e); } return; }
        if (m.error) { reject(new Error(m.error)); return; }
        try { rotate(); } catch { /* ignore */ }
        resolve({ check: m.check, backup: out, ms: Date.now() - t0, thread: 'worker' });
      });
      w.once('error', reject);
    });
  }

  /** Checkpoints the WAL into the main file (on idle and on quit). */
  checkpoint() { try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* busy: next time */ } }

  close() { try { this.checkpoint(); this.db.close(); } catch { /* ignore */ } }
}

// Runs in a worker: its own read connection (WAL lets it read while the app writes).
const MAINTAIN_SRC = `
const { parentPort, workerData } = require('worker_threads');
let lib = null;
try { lib = require('node:sqlite'); } catch { parentPort.postMessage({ unavailable: true }); }
if (lib) try {
  const db = new lib.DatabaseSync(workerData.file);
  db.exec('PRAGMA busy_timeout=5000');
  const check = Object.values(db.prepare('PRAGMA integrity_check').get())[0];
  if (workerData.out) db.prepare('VACUUM INTO ?').run(workerData.out);
  db.close();
  parentPort.postMessage({ check });
} catch (e) { parentPort.postMessage({ error: String(e && e.message || e) }); }
`;

function restoreNewestBackup(lib, dir, target) {
  const bdir = path.join(dir, 'backups', 'integrity');
  let files = [];
  try { files = fs.readdirSync(bdir).filter((f) => /^foldergram-integrity-.*\.sqlite$/.test(f)).sort().reverse(); } catch { return null; }
  for (const f of files) {
    const src = path.join(bdir, f);
    try {
      const db = new lib.DatabaseSync(src, { readOnly: true });
      const ok = Object.values(db.prepare('PRAGMA quick_check').get())[0] === 'ok';
      db.close();
      if (!ok) continue;
      fs.copyFileSync(src, target);
      return src;
    } catch { /* try an older one */ }
  }
  return null;
}

const json = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
function rowToTopic(r) {
  return { chatId: r.chat_id, topicId: r.topic_id, originalName: r.original_name, currentName: r.current_name, aliases: json(r.aliases, []), createdAt: r.created_at,
    firstSeenAt: r.first_seen_at, lastVerifiedAt: r.last_verified_at, missingSince: r.missing_since, status: r.status, protected: !!r.protected, source: r.source,
    replacedBy: r.replaced_by, replaces: r.replaces, ...json(r.extra, {}) };
}
function topicToRow(t) {
  const known = new Set(['chatId', 'topicId', 'originalName', 'currentName', 'aliases', 'createdAt', 'firstSeenAt', 'lastVerifiedAt', 'missingSince', 'status', 'protected', 'source', 'replacedBy', 'replaces']);
  const extra = {};
  for (const [k, v] of Object.entries(t)) if (!known.has(k)) extra[k] = v;
  return { chatId: String(t.chatId), topicId: Number(t.topicId), originalName: t.originalName || null, currentName: t.currentName || null, aliases: JSON.stringify(t.aliases || []),
    createdAt: t.createdAt ?? null, firstSeenAt: t.firstSeenAt ?? null, lastVerifiedAt: t.lastVerifiedAt ?? null, missingSince: t.missingSince ?? null, status: t.status || 'ok',
    protected: t.protected === false ? 0 : 1, source: t.source || null, replacedBy: t.replacedBy ?? null, replaces: t.replaces ?? null, extra: JSON.stringify(extra) };
}
function rowToEvent(r) {
  return { id: r.id, chatId: r.chat_id, topicId: r.topic_id, messageId: r.message_id, category: r.category, detectedAt: new Date(r.detected_at).toISOString(),
    evidence: json(r.evidence, {}), severity: r.severity, resolution: r.resolution };
}

/** Same methods, no storage: used when SQLite is missing so uploads still work (the JSON topic registry still protects). */
class NullLedger {
  constructor(why) { this.available = false; this.why = why; }
  topicStore() { return null; }
  recordAlbum() {} addFilesBatch() {} pageFiles() { return []; } findFile() { return null; } messageIds() { return []; } setVerification() {}
  startAttempt() { return null; } finishAttempt() {} openAttempts() { return []; } addEvent() {} addRateEvent() {} rateEvents() { return []; }
  meta() { return null; } setMeta() {} counts() { return null; } integrityCheck() { return 'unavailable'; } backup() { return null; } maintain() { return Promise.resolve({ check: 'unavailable', backup: null }); } checkpoint() {} close() {}
}

/**
 * One-time migration from FolderGram's existing files (nothing is changed or removed there): topic ids from job
 * journals (<id>.state.jsonl) and reports, and delivered files with their message ids from job reports.
 * Returns { topics, files }.
 */
function migrateFromJobs(ledger, registry, jobsDir) {
  const out = { topics: 0, files: 0 };
  if (!ledger.available && !registry) return out;
  if (ledger.available && ledger.meta('migrated_jobs_v1')) return out;
  let queue = [];
  try { queue = JSON.parse(fs.readFileSync(path.join(jobsDir, 'queue.json'), 'utf8')); } catch { /* none */ }
  const chatOf = new Map((Array.isArray(queue) ? queue : []).map((j) => [j.id, j.chat && j.chat.id]));
  let names = [];
  try { names = fs.readdirSync(jobsDir); } catch { return out; }
  for (const n of names) {
    const m = /^(.+)\.(state\.jsonl|report\.json)$/.exec(n);
    if (!m) continue;
    const chatId = chatOf.get(m[1]);
    if (m[2] === 'state.jsonl' && chatId) {
      let txt = '';
      try { txt = fs.readFileSync(path.join(jobsDir, n), 'utf8'); } catch { continue; }
      for (const line of txt.split('\n')) {
        try {
          const r = JSON.parse(line);
          if (r.t && r.id != null && registry && !registry.get(chatId, r.id)) { registry.record({ chatId, topicId: r.id, name: r.t, source: 'migrated', status: 'unverified' }); out.topics++; }
        } catch { /* torn line */ }
      }
    }
    if (m[2] === 'report.json') {
      let rep;
      try { rep = JSON.parse(fs.readFileSync(path.join(jobsDir, n), 'utf8')); } catch { continue; }
      const cid = (rep && rep.chat && rep.chat.id) || chatId;
      if (!cid) continue;
      for (const a of rep.albums || []) {
        if (a.topicId && a.topic && registry && !registry.get(cid, a.topicId)) { registry.record({ chatId: cid, topicId: a.topicId, name: a.topic, source: 'migrated', status: 'unverified' }); out.topics++; }
        if (a.status !== 'sent' || !a.paths || !ledger.available) continue;
        ledger.recordAlbum({ chatId: cid, topicId: a.topicId || null, jobId: rep.jobId || m[1], albumKey: null, files: a.paths.map((p, i) => ({ path: p, name: (a.files || [])[i] })),
          messageIds: a.messageIds || [], confirmed: true });
        out.files += a.paths.length;
      }
    }
  }
  if (ledger.available) ledger.setMeta('migrated_jobs_v1', new Date().toISOString());
  return out;
}

module.exports = { Ledger, NullLedger, migrateFromJobs, FILE_NAME, MIGRATIONS, loadSqlite };
