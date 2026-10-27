// Delivery checks: after a send whose answer was lost, or when a job resumes with an album that was being sent,
// look at the chat to see whether that album arrived. Pure functions, so the matching is easy to test.
'use strict';

const stem = (name) => String(name || '').replace(/\.[^.]+$/, '').toLowerCase();

/**
 * Finds our album among recent messages.
 *   messages: [{ id, date, out, groupedId, text, media, names: [file names of documents] }] in any order
 *   want: { since (Telegram time, unix s), count, caption, exclude: Set of message ids already known to belong to
 *           other albums, names: file names we sent, skew: seconds of clock difference to allow (default 2) }
 * A match is a group of our own media messages, sent at or after `since`, not already known, with the same number
 * of items and the same caption, and (for documents and videos, which keep their file name) the same file names.
 * Returns { ids, ambiguous } or null.
 */
function matchAlbum(messages, want) {
  const skew = want.skew ?? 2;
  const exclude = want.exclude || new Set();
  const groups = new Map();
  for (const m of messages) {
    if (!m || !m.out || !m.media || m.date < want.since - skew || exclude.has(m.id)) continue;
    const k = m.groupedId ? `g:${m.groupedId}` : `single:${m.id}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(m);
  }
  const caption = want.caption || '';
  const names = want.names ? want.names.map(stem) : null;
  const hits = [];
  for (const ms of groups.values()) {
    if (ms.length !== want.count) continue;
    const text = ms.map((m) => m.text || '').find(Boolean) || '';
    if (text !== caption) continue;
    if (names) {
      // Photos lose their file name on Telegram; documents and videos keep it (a remuxed video ends in .mp4).
      const pool = [...names];
      const ok = ms.every((m) => (m.names || []).every((n) => {
        const i = pool.indexOf(stem(n));
        if (i < 0) return false;
        pool.splice(i, 1);
        return true;
      }));
      if (!ok) continue;
    }
    hits.push(ms.map((m) => m.id).sort((a, b) => a - b));
  }
  if (!hits.length) return null;
  hits.sort((a, b) => a[0] - b[0]);
  return { ids: hits[0], ambiguous: hits.length > 1 };
}

/**
 * The answer of a delivery check as { ids, complete }: ids when the album was found; complete when every message
 * since the send was looked at, so "not found" really means it was not delivered. Older transports returned an
 * array of ids or null, which counts as complete.
 */
function normalizeCheck(r) {
  if (Array.isArray(r)) return { ids: r.length ? r : null, complete: true };
  if (r == null) return { ids: null, complete: true };
  return { ids: r.ids && r.ids.length ? r.ids : null, complete: !!r.complete, ambiguous: !!r.ambiguous };
}

module.exports = { matchAlbum, normalizeCheck };
