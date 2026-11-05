// The Telegram side of a collection: messages grouped into albums page by page, compared with the folders on this
// PC, and checks across topics (same title twice, albums that look like they belong elsewhere, albums FolderGram
// sent that have lost messages since). Reads only; changes go through telegram.js after the user confirms.
'use strict';

const N = require('./naming');

/**
 * Turns pages of messages (newest first) into albums. An album can be cut by the end of a page, so the oldest
 * group of a page is held back until the next page shows whether it continues. add(items, last) returns the
 * albums that are complete.
 */
class AlbumPager {
  constructor() { this.held = null; }

  add(items, last = false) {
    const all = this.held ? [...this.held, ...items] : [...items];
    const albums = groupAlbums(all);
    this.held = null;
    if (!last && albums.length && albums[albums.length - 1].groupedId) {
      const tail = albums.pop();
      this.held = all.filter((m) => tail.ids.includes(m.id));
    }
    return albums;
  }
}

/** Groups messages (newest first) by album: [{ key, groupedId, ids, date, caption, count, kinds, size, items }]. */
function groupAlbums(items) {
  const out = [];
  const byGroup = new Map();
  for (const m of items) {
    const key = m.groupedId ? `g${m.groupedId}` : `m${m.id}`;
    let a = byGroup.get(key);
    if (!a) {
      a = { key, groupedId: m.groupedId || null, ids: [], date: m.date, caption: '', count: 0, kinds: {}, size: 0, items: [], topicId: m.topicId || null };
      byGroup.set(key, a);
      out.push(a);
    }
    a.items.push(m);
    a.ids.push(m.id);
    a.count++;
    a.size += m.size || 0;
    a.kinds[m.kind] = (a.kinds[m.kind] || 0) + 1;
    a.date = Math.max(a.date, m.date);
    if (m.caption && !a.caption) a.caption = m.caption;
  }
  // Inside an album, oldest message first (the order it was sent in).
  for (const a of out) { a.items.sort((x, y) => x.id - y.id); a.ids.sort((x, y) => x - y); }
  return out;
}

/** The album title in a caption: the first line, without a trailing "(2/3)" part counter or file count. */
function captionTitle(caption) {
  const first = String(caption || '').split('\n')[0].trim();
  return first.replace(/\s*\(\s*\d+\s*\/\s*\d+\s*\)\s*$/, '').replace(/\s+[—–-]\s+Part \d+ of \d+\s*$/i, '')
    .replace(/\s*[·|—–-]\s*\d+\s+(?:photos?|videos?|files?|items?|songs?|GIFs?)\b.*$/i, '').trim();
}

/**
 * Local albums (from the preview) against Telegram albums of the same topic, by title. Returns
 * { both: [{ title, local, telegram }], onlyLocal: [...], onlyTelegram: [...] }; counts that differ are flagged.
 */
function compareCollections(localSets, telegramAlbums) {
  const tg = new Map();
  // FolderGram captions the last album of a set by default: albums without a caption just before a captioned one
  // (in the order they were sent) are part of its set.
  let pending = 0;
  let untitled = 0;
  for (const a of [...telegramAlbums].sort((x, y) => x.ids[0] - y.ids[0])) {
    const k = N.normalizeKey(captionTitle(a.caption));
    if (!k) { pending += a.count; untitled++; continue; }
    if (!tg.has(k)) tg.set(k, { title: captionTitle(a.caption), count: 0, albums: [] });
    const t = tg.get(k);
    t.count += a.count + pending;
    t.albums.push(a);
    pending = 0;
    untitled = 0;
  }
  const both = [];
  const onlyLocal = [];
  const seen = new Set();
  for (const s of localSets) {
    const k = N.normalizeKey(s.name);
    const t = tg.get(k);
    if (t) { seen.add(k); both.push({ title: s.name, local: s.count, telegram: t.count, differs: s.count !== t.count }); } else onlyLocal.push({ title: s.name, local: s.count });
  }
  const onlyTelegram = [...tg.entries()].filter(([k]) => !seen.has(k)).map(([, t]) => ({ title: t.title, telegram: t.count }));
  return { both, onlyLocal, onlyTelegram, untitled };
}

/** Topics whose titles are the same apart from case, spacing and punctuation. */
function duplicateTopics(topics) {
  const by = new Map();
  for (const t of topics) {
    const k = N.normalizeKey(t.title);
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(t);
  }
  return [...by.values()].filter((g) => g.length > 1);
}

/**
 * Albums whose caption names another topic and not their own ("Rem - Set 02" in the topic "Marin"). Returns
 * [{ album, topicId, suggested: { id, title } }].
 */
function misplacedAlbums(topics, albumsByTopic) {
  const named = topics.filter((t) => t.id !== 1 && N.normalizeKey(t.title).length >= 3);
  const out = [];
  for (const [topicId, albums] of albumsByTopic) {
    const own = topics.find((t) => t.id === topicId);
    for (const a of albums) {
      const title = captionTitle(a.caption);
      if (!title) continue;
      if (own && N.containsWords(title, own.title)) continue;
      const other = named.filter((t) => t.id !== topicId && N.containsWords(title, t.title))
        .sort((x, y) => N.normalizeKey(y.title).length - N.normalizeKey(x.title).length)[0];
      if (other) out.push({ album: { key: a.key, ids: a.ids, caption: a.caption, count: a.count }, topicId, suggested: { id: other.id, title: other.title } });
    }
  }
  return out;
}

/**
 * Albums FolderGram sent (from job reports) checked against what is in the chat now. reports: [{ topic, caption,
 * files, messageIds }]; existing: Set of message ids still there. Returns albums with messages gone.
 */
function incompleteAlbums(reports, existing) {
  const out = [];
  for (const a of reports) {
    const ids = a.messageIds || [];
    if (!ids.length) continue;
    const missing = ids.filter((id) => !existing.has(id));
    if (missing.length) out.push({ topic: a.topic, caption: a.caption, files: a.files, paths: a.paths || null, messageIds: ids, missing, allGone: missing.length === ids.length });
  }
  return out;
}

module.exports = { AlbumPager, groupAlbums, captionTitle, compareCollections, duplicateTopics, misplacedAlbums, incompleteAlbums };
