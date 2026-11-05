// Read-only integrity audits. Nothing here posts, edits or deletes; every request is a read (getForumTopicsByID,
// getMessages, getAdminLog). A message Telegram doesn't return is recorded as "missing", which is not proof of
// deletion or of its cause: access rights, a hidden topic or a temporary failure look the same from outside.
'use strict';

const { validateTopic, STATUS } = require('./topic-protection');

/**
 * level: 'quick' (known topics), 'standard' (topics + a sample of known messages), 'deep' (every known message,
 * resumable: continues from the last checked row next time). deps: { transport, registry, ledger, chat, sample,
 * batch, maxMessages, sleep(ms), isCanceled(), onProgress({ phase, done, total }) }.
 * Returns { topics: { checked, ok, missing, uncertain }, messages: { checked, present, missing }, incidents: [...] }.
 */
async function runAudit(level, deps) {
  const { transport, registry, ledger, chat } = deps;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const canceled = deps.isCanceled || (() => false);
  const progress = deps.onProgress || (() => {});
  const out = { level, topics: { checked: 0, ok: 0, missing: 0, uncertain: 0, inaccessible: 0 }, messages: { checked: 0, present: 0, missing: 0 }, incidents: [] };
  const chatId = String(chat.id);

  // Topics, 100 per request (one request instead of one per topic).
  const known = registry.forChat(chatId).filter((r) => r.topicId !== 1);
  for (let i = 0; i < known.length && !canceled(); i += 100) {
    const part = known.slice(i, i + 100);
    let found = null;
    try {
      found = await transport.getTopicsById(chat, part.map((r) => r.topicId));
    } catch (e) {
      // One failing request: check those one by one, so a single bad id can't hide the rest.
      found = null;
      for (const r of part) {
        const v = await validateTopic(transport, chat, r.topicId);
        tally(r, v.status, v.error);
        await sleep(300);
      }
    }
    if (found) {
      for (const r of part) {
        const t = found.find((x) => Number(x.id) === r.topicId);
        tally(r, !t ? STATUS.MISSING : t.deleted ? STATUS.DELETED : t.closed ? STATUS.CLOSED : t.hidden ? STATUS.HIDDEN : STATUS.OK, null, t);
      }
    }
    progress({ phase: 'topics', done: Math.min(known.length, i + 100), total: known.length });
    await sleep(1000);
  }

  function tally(r, status, error, t) {
    out.topics.checked++;
    if (status === STATUS.UNCERTAIN) { out.topics.uncertain++; return; } // not evidence of anything
    if (status === STATUS.INACCESSIBLE) { out.topics.inaccessible++; registry.setStatus(chatId, r.topicId, status); return; }
    if (status === STATUS.DELETED || status === STATUS.MISSING) {
      out.topics.missing++;
      const wasOk = r.status !== STATUS.DELETED && r.status !== STATUS.MISSING;
      registry.setStatus(chatId, r.topicId, status);
      if (wasOk) out.incidents.push(registry.incident({ chatId, topicId: r.topicId, category: 'missing_topic', severity: 'critical',
        evidence: { audit: level, telegramAnswer: status, name: r.currentName, lastVerifiedAt: r.lastVerifiedAt || null, error } }));
      return;
    }
    out.topics.ok++;
    if (t && t.title) registry.record({ chatId, topicId: r.topicId, name: t.title, source: r.source });
    registry.setStatus(chatId, r.topicId, status);
  }

  if (level === 'quick' || !ledger || !ledger.available || canceled()) return out;

  // Messages: a sample (standard) or everything in bounded batches (deep, resumable).
  const batch = deps.batch || 100;
  const maxMessages = level === 'deep' ? deps.maxMessages || Infinity : deps.sample || 200;
  const metaKey = `deep_audit_after:${chatId}`;
  let after = level === 'deep' ? Number(ledger.meta(metaKey) || 0) : 0;
  let rows = [];
  if (level === 'standard') {
    // Spread the sample over the history instead of only the oldest rows.
    const all = ledger.messageIds(chatId, { afterId: 0, limit: 100000 });
    const step = Math.max(1, Math.floor(all.length / maxMessages));
    for (let i = 0; i < all.length && rows.length < maxMessages; i += step) rows.push(all[i]);
  }
  const missingIds = [];
  for (let done = 0; done < maxMessages && !canceled();) {
    const page = level === 'standard' ? rows.splice(0, batch) : ledger.messageIds(chatId, { afterId: after, limit: Math.min(batch, maxMessages - done) });
    if (!page.length) { if (level === 'deep') ledger.setMeta(metaKey, 0); break; } // finished: next deep audit starts over
    let present;
    try {
      present = await transport.existingMessageIds(chat, page.map((r) => r.message_id));
    } catch {
      break; // uncertain: stop here, nothing is marked
    }
    for (const r of page) {
      out.messages.checked++;
      if (present.has(r.message_id)) { out.messages.present++; ledger.setVerification(chatId, r.message_id, 'confirmed'); }
      else { out.messages.missing++; missingIds.push(r.message_id); ledger.setVerification(chatId, r.message_id, 'missing'); }
    }
    done += page.length;
    after = page[page.length - 1].id;
    if (level === 'deep') ledger.setMeta(metaKey, after);
    progress({ phase: 'messages', done, total: Number.isFinite(maxMessages) ? maxMessages : null });
    await sleep(1500); // reads are paced too
  }
  if (missingIds.length) {
    out.incidents.push(registry.incident({ chatId, category: 'missing_messages', severity: 'warning',
      evidence: { audit: level, count: missingIds.length, messageIds: missingIds.slice(0, 500), note: 'Telegram did not return these messages. The cause is not known from this check.' } }));
  }
  return out;
}

/**
 * Read-only look at the admin log for deletions (needs admin rights; Telegram keeps about 48 hours). Each deletion
 * of a topic FolderGram knows, or of a message in its ledger, becomes an incident with the actor id as evidence.
 */
async function inspectAdminLog({ transport, registry, ledger, chat }) {
  let events;
  try {
    events = await transport.adminLogDeletions(chat);
  } catch (e) {
    return { available: false, error: e.errorMessage || e.message, deletions: [] };
  }
  const chatId = String(chat.id);
  const incidents = [];
  for (const ev of events) {
    if (ev.kind === 'topic' && ev.topicId && registry.get(chatId, ev.topicId)) {
      incidents.push(registry.incident({ chatId, topicId: ev.topicId, category: 'topic_deleted_admin_log', severity: 'critical',
        evidence: { actorId: ev.actorId, at: ev.at, title: ev.title, source: 'admin log' } }));
    }
  }
  const msgDeletes = events.filter((e) => e.kind === 'message');
  if (msgDeletes.length) {
    incidents.push(registry.incident({ chatId, category: 'messages_deleted_admin_log', severity: 'warning',
      evidence: { count: msgDeletes.length, byActor: countBy(msgDeletes, (e) => e.actorId || 'unknown'), sample: msgDeletes.slice(0, 50), source: 'admin log' } }));
    if (ledger && ledger.available) for (const e of msgDeletes) if (e.messageId) ledger.setVerification(chatId, e.messageId, 'deleted_by_admin_log');
  }
  return { available: true, deletions: events, incidents };
}

const countBy = (arr, f) => arr.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});

/** Plain-language warnings from groupSafety() facts, for the settings screen and before big uploads. */
function groupWarnings(g) {
  const w = [];
  if (g.ttlPeriod) w.push({ level: 'critical', text: `This group has an auto-delete timer (${Math.round(g.ttlPeriod / 3600)} h): Telegram deletes every new message after that time, uploads included. Turn it off in the group settings if you want to keep uploads.` });
  if (g.antispam) w.push({ level: 'warning', text: 'Aggressive Anti-Spam is on in this group: Telegram may delete messages it considers spam, independently of FolderGram. FolderGram never changes this setting.' });
  if (g.slowmodeSeconds) w.push({ level: 'info', text: `Slow mode is on (${g.slowmodeSeconds} s): FolderGram waits that long between posts.` });
  if (g.canDeleteMessages && g.isBot) w.push({ level: 'info', text: 'The uploading bot has the "Delete messages" admin right. FolderGram does not need it for uploads; consider removing it.' });
  if (g.canManageTopics === false) w.push({ level: 'info', text: 'This account cannot manage topics: creating new topics will fail. Existing topics can still be used.' });
  return w;
}

module.exports = { runAudit, inspectAdminLog, groupWarnings };
