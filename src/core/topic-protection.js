// Topic protection: a registry of every forum topic FolderGram has used, identified by (chat id, topic id), never by
// name. A topic name is only a label: two topics can share it, a topic can be renamed, and a new topic with the same
// name as a deleted one is a different topic.
//
// Rules enforced here and in the uploader:
//  - a saved topic id is checked with Telegram (channels.getForumTopicsByID) before anything is posted to it;
//  - a network failure while checking is "uncertain", never "missing";
//  - a known topic that Telegram reports deleted or missing pauses the job and records an incident; FolderGram never
//    creates a replacement on its own and never sends that folder's files into another topic;
//  - historical ids are never removed from the registry.
'use strict';

const fs = require('fs');
const path = require('path');
const { writeAtomic } = require('./store');
const { normalizeKey } = require('./naming');

const STATUS = { OK: 'ok', CLOSED: 'closed', HIDDEN: 'hidden', DELETED: 'deleted', MISSING: 'missing', INACCESSIBLE: 'inaccessible', UNCERTAIN: 'uncertain' };

/** JSON file store: small (one record per topic ever used), written atomically with a .bak copy. */
class JsonTopicStore {
  constructor(file) {
    this.file = file;
    this.data = { topics: {}, incidents: [] };
    for (const f of file ? [file, `${file}.bak`] : []) {
      try {
        const d = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (d && typeof d === 'object' && d.topics) { this.data = { topics: d.topics, incidents: Array.isArray(d.incidents) ? d.incidents : [] }; break; }
      } catch { /* missing or damaged: try the backup */ }
    }
  }
  all() { return Object.values(this.data.topics); }
  put(rec) { this.data.topics[`${rec.chatId}|${rec.topicId}`] = rec; this.flush(); }
  incidents() { return this.data.incidents; }
  addIncident(i) { this.data.incidents.push(i); if (this.data.incidents.length > 5000) this.data.incidents.shift(); this.flush(); }
  updateIncident(id, patch) { const i = this.data.incidents.find((x) => x.id === id); if (i) { Object.assign(i, patch); this.flush(); } }
  flush() {
    if (!this.file) return;
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); writeAtomic(this.file, JSON.stringify(this.data)); } catch { /* memory still works */ }
  }
}

/**
 * Writes to the ledger and to the JSON file; reads from the ledger, or from the JSON file when the ledger is new
 * (its records are copied over). Either one alone is enough to rebuild the registry.
 */
class DualTopicStore {
  constructor(primary, mirror) {
    this.primary = primary;
    this.mirror = mirror;
    const have = new Set(primary.all().map((r) => `${r.chatId}|${r.topicId}`));
    for (const r of mirror.all()) if (!have.has(`${r.chatId}|${r.topicId}`)) primary.put(r);
    const haveInc = new Set(primary.incidents().map((i) => i.id));
    for (const i of mirror.incidents()) if (!haveInc.has(i.id)) primary.addIncident(i);
  }
  all() { return this.primary.all(); }
  put(rec) { this.primary.put(rec); this.mirror.put(rec); }
  incidents() { return this.primary.incidents(); }
  addIncident(i) { this.primary.addIncident(i); this.mirror.addIncident(i); }
  updateIncident(id, patch) { this.primary.updateIncident(id, patch); this.mirror.updateIncident(id, patch); }
}

/**
 * store: { all(), put(rec), incidents(), addIncident(i), updateIncident(id, patch) } (JsonTopicStore, or the ledger's).
 * onIncident(incident) is called for every new incident (the window shows it).
 */
class TopicRegistry {
  constructor(store = new JsonTopicStore(null), { now = Date.now, onIncident = () => {} } = {}) {
    this.store = store;
    this.now = now;
    this.onIncident = onIncident;
    this.byKey = new Map();
    for (const r of store.all()) this.byKey.set(`${r.chatId}|${r.topicId}`, r);
  }

  key(chatId, topicId) { return `${String(chatId)}|${Number(topicId)}`; }
  get(chatId, topicId) { return this.byKey.get(this.key(chatId, topicId)) || null; }

  /** Every known topic of a chat whose current name, original name or an alias matches `name`. */
  byName(chatId, name) {
    const k = normalizeKey(name);
    const out = [];
    for (const r of this.byKey.values()) {
      if (r.chatId !== String(chatId)) continue;
      const names = [r.originalName, r.currentName, ...(r.aliases || [])].map((x) => normalizeKey(x || ''));
      if (names.includes(k)) out.push(r);
    }
    return out;
  }

  forChat(chatId) { return [...this.byKey.values()].filter((r) => r.chatId === String(chatId)); }

  /**
   * Records a topic (new or seen again). Never changes chatId/topicId/originalName of a known record; a different
   * current name becomes an alias.
   */
  record({ chatId, topicId, name, source = 'seen', createdAt = null, status = STATUS.OK }) {
    const k = this.key(chatId, topicId);
    const prev = this.byKey.get(k);
    const now = this.now();
    let rec;
    if (!prev) {
      rec = { chatId: String(chatId), topicId: Number(topicId), originalName: name, currentName: name, aliases: [], createdAt, firstSeenAt: now,
        lastVerifiedAt: status === STATUS.OK ? now : null, status, protected: true, source, replacedBy: null, replaces: null };
    } else {
      rec = { ...prev, aliases: [...(prev.aliases || [])] };
      if (name && name !== prev.currentName) {
        if (!rec.aliases.includes(prev.currentName)) rec.aliases.push(prev.currentName);
        rec.currentName = name;
      }
      if (createdAt && !rec.createdAt) rec.createdAt = createdAt;
    }
    this.byKey.set(k, rec);
    this.store.put(rec);
    return rec;
  }

  setStatus(chatId, topicId, status, extra = {}) {
    const rec = this.get(chatId, topicId);
    if (!rec) return null;
    const next = { ...rec, status, ...extra };
    if (status === STATUS.OK || status === STATUS.CLOSED || status === STATUS.HIDDEN) next.lastVerifiedAt = this.now();
    if (status === STATUS.DELETED || status === STATUS.MISSING) next.missingSince = rec.missingSince || this.now();
    this.byKey.set(this.key(chatId, topicId), next);
    this.store.put(next);
    return next;
  }

  /** A user-approved recovery: `newId` replaces `oldId` for future uploads. The old record stays, marked replaced. */
  approveReplacement(chatId, oldId, newId, { by = 'user', note = '' } = {}) {
    const old = this.get(chatId, oldId);
    if (!old) throw new Error('That topic is not in the registry.');
    this.setStatus(chatId, oldId, old.status, { replacedBy: Number(newId), replacedAt: this.now(), replacementApprovedBy: by, replacementNote: note });
    const nu = this.get(chatId, newId) || this.record({ chatId, topicId: newId, name: old.currentName, source: 'replacement' });
    this.setStatus(chatId, newId, nu.status, { replaces: Number(oldId) });
    return this.get(chatId, newId);
  }

  incident({ chatId, topicId = null, messageId = null, category, evidence = {}, severity = 'warning' }) {
    const i = { id: `inc-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, chatId: String(chatId), topicId, messageId, category,
      detectedAt: new Date(this.now()).toISOString(), evidence, severity, resolution: 'open' };
    this.store.addIncident(i);
    this.onIncident(i);
    return i;
  }

  incidents({ open = false } = {}) { const all = this.store.incidents(); return open ? all.filter((i) => i.resolution === 'open') : all; }
  resolveIncident(id, resolution = 'resolved') { this.store.updateIncident(id, { resolution, resolvedAt: new Date(this.now()).toISOString() }); }

  counts(chatId = null) {
    const all = [...this.byKey.values()].filter((r) => !chatId || r.chatId === String(chatId));
    return {
      protected: all.filter((r) => r.protected).length,
      missing: all.filter((r) => r.status === STATUS.DELETED || r.status === STATUS.MISSING).length,
      inaccessible: all.filter((r) => r.status === STATUS.INACCESSIBLE).length,
      incidents: this.incidents({ open: true }).filter((i) => !chatId || i.chatId === String(chatId)).length,
    };
  }
}

/**
 * Asks Telegram about one topic. transport.getTopicsById(chat, ids) -> [{ id, title, closed, hidden, deleted }]
 * (a deleted topic comes back as { id, deleted: true } or not at all). Returns { status, title?, error? }:
 *  ok | closed | hidden | deleted | missing (Telegram answered and the topic is not there) |
 *  inaccessible (no rights to read the group any more) | uncertain (network or unexplained failure: not proof).
 */
async function validateTopic(transport, chat, topicId) {
  if (!transport.getTopicsById) return { status: STATUS.UNCERTAIN, error: 'this connection cannot check topics' };
  let list;
  try {
    list = await transport.getTopicsById(chat, [Number(topicId)]);
  } catch (e) {
    const m = String((e && (e.errorMessage || e.message)) || e);
    if (/TOPIC_ID_INVALID|TOPIC_DELETED/.test(m)) return { status: STATUS.MISSING, error: m };
    if (/CHANNEL_PRIVATE|CHAT_ADMIN_REQUIRED|CHANNEL_INVALID|USER_BANNED_IN_CHANNEL|CHAT_FORBIDDEN/.test(m)) return { status: STATUS.INACCESSIBLE, error: m };
    return { status: STATUS.UNCERTAIN, error: m };
  }
  if (!Array.isArray(list)) return { status: STATUS.UNCERTAIN, error: 'no answer' };
  const t = list.find((x) => Number(x.id) === Number(topicId));
  if (!t) return { status: STATUS.MISSING };
  if (t.deleted) return { status: STATUS.DELETED };
  if (t.closed) return { status: STATUS.CLOSED, title: t.title };
  if (t.hidden) return { status: STATUS.HIDDEN, title: t.title };
  return { status: STATUS.OK, title: t.title };
}

/** Error that stops a job because a protected topic needs the user (missing, ambiguous, inaccessible). */
class TopicProtectionError extends Error {
  constructor(message, { kind, chatId, topicId = null, topicName = '', incident = null } = {}) {
    super(message);
    this.errorMessage = 'TOPIC_PROTECTION';
    this.topicProtection = true;
    this.safetyStop = true;
    Object.assign(this, { kind, chatId, topicId, topicName, incident });
  }
}

/** A plain-text incident report (for export): no tokens, sessions or local secrets. */
function incidentReport(registry, chatId, { title = '' } = {}) {
  const lines = [`FolderGram integrity report — ${title || chatId}`, `Generated ${new Date().toISOString()}`, ''];
  lines.push('Known topics (chat id | topic id | original name | current name | status | last verified | missing since):');
  for (const r of registry.forChat(chatId)) {
    lines.push(`${r.chatId} | ${r.topicId} | ${r.originalName} | ${r.currentName} | ${r.status} | ${r.lastVerifiedAt ? new Date(r.lastVerifiedAt).toISOString() : '-'} | ${r.missingSince ? new Date(r.missingSince).toISOString() : '-'}${r.replacedBy ? ` | replaced by ${r.replacedBy} (approved by ${r.replacementApprovedBy})` : ''}`);
  }
  lines.push('', 'Incidents:');
  for (const i of registry.incidents().filter((x) => x.chatId === String(chatId))) {
    lines.push(`${i.detectedAt} | ${i.category} | topic ${i.topicId ?? '-'} | message ${i.messageId ?? '-'} | ${i.resolution} | ${JSON.stringify(i.evidence)}`);
  }
  lines.push('', 'Notes: a missing answer from Telegram is not proof that content was deleted. FolderGram never deletes topics while uploading.',
    'The reason a topic or message disappeared can only be confirmed from Telegram itself (Recent Actions keeps 48 hours).',
    'This report covers metadata only; it is not a backup of the media.');
  return lines.join('\n');
}

module.exports = { TopicRegistry, JsonTopicStore, DualTopicStore, validateTopic, TopicProtectionError, incidentReport, STATUS };
