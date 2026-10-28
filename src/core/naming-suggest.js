// Naming help across folders: the user's dictionary of preferred spellings ("rezero" → "Re:Zero"), and suggestions
// to unify album and topic names that are clearly the same title written differently ("Marin kitagawa",
// "Marin_Kitagawa", "Marin Kitagwa"). Suggestions are never applied on their own: the preview lists them and the
// user picks which to apply. Pure functions.
'use strict';

const N = require('./naming');

// ---------------------------------------------------------------- dictionary

/** Cleans dictionary entries: [{ name, aliases: [] }]. */
function sanitizeDictionary(list) {
  return (Array.isArray(list) ? list : []).slice(0, 2000).map((d) => ({
    name: String((d && d.name) || '').replace(/\s+/g, ' ').trim().slice(0, 128),
    aliases: (Array.isArray(d && d.aliases) ? d.aliases : String((d && d.aliases) || '').split(/[,;\n]+/))
      .map((a) => String(a).replace(/\s+/g, ' ').trim().slice(0, 128)).filter(Boolean).slice(0, 50),
  })).filter((d) => d.name);
}

/** Splits a name into word tokens (with their normalised form) and the text between them. */
function tokens(name) {
  const out = [];
  const re = /[\p{L}\p{N}'’:]+/gu;
  let m;
  while ((m = re.exec(name))) {
    const key = N.normalizeKey(m[0]);
    if (key) out.push({ start: m.index, end: m.index + m[0].length, key });
  }
  return out;
}

/** Compiles the dictionary into a lookup of word sequences, longest first. */
function compileDictionary(dict) {
  const list = [];
  for (const d of sanitizeDictionary(dict)) {
    for (const spelling of [d.name, ...d.aliases]) {
      const words = tokens(spelling).map((t) => t.key);
      if (words.length) list.push({ words, name: d.name });
    }
  }
  list.sort((a, b) => b.words.length - a.words.length);
  return list;
}

/**
 * Replaces dictionary spellings inside a name, on whole words only: with "Marin" → "Marin Kitagawa",
 * "Marin - Set 01" becomes "Marin Kitagawa - Set 01", but "Marina" stays. Returns { name, hits } (hits: the
 * dictionary names used), or null when nothing changed.
 */
function applyDictionary(name, compiled) {
  if (!compiled || !compiled.length || !name) return null;
  const toks = tokens(name);
  if (!toks.length) return null;
  let out = '';
  let pos = 0;
  const hits = [];
  for (let i = 0; i < toks.length;) {
    const hit = compiled.find((d) => d.words.every((w, j) => toks[i + j] && toks[i + j].key === w));
    if (!hit) { i++; continue; }
    const last = toks[i + hit.words.length - 1];
    // "Marin Kitagawa" already says it; don't turn it into "Marin Kitagawa Kitagawa".
    const nameWords = tokens(hit.name).map((t) => t.key);
    const after = toks.slice(i, i + nameWords.length).map((t) => t.key);
    if (nameWords.length > hit.words.length && after.join(' ') === nameWords.join(' ')) {
      const end = toks[i + nameWords.length - 1];
      out += name.slice(pos, toks[i].start) + hit.name;
      pos = end.end;
      i += nameWords.length;
    } else {
      out += name.slice(pos, toks[i].start) + hit.name;
      pos = last.end;
      i += hit.words.length;
    }
    hits.push(hit.name);
  }
  out += name.slice(pos);
  return out !== name ? { name: out, hits } : null;
}

// ---------------------------------------------------------------- similar titles

const digits = (s) => (s.match(/\d+/g) || []).map(Number).join(',');

/** Restricted Damerau-Levenshtein distance, stopping early above `max`. */
function distance(a, b, max = 2) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev2 = new Array(b.length + 1).fill(0);
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur.push(v);
      if (v < best) best = v;
    }
    for (let j = 0; j <= b.length; j++) prev2[j] = prev[j];
    prev = cur;
    if (best > max) return max + 1;
  }
  return prev[b.length];
}

/** Single-character deletions of a key (and the key itself), for finding near matches without comparing all pairs. */
function deletions(k) {
  const out = new Set([k]);
  for (let i = 0; i < k.length; i++) out.add(k.slice(0, i) + k.slice(i + 1));
  return out;
}

/** Prefer the spelling more files use, then one with capital letters and spaces over all-lower or underscores. */
function better(a, b) {
  if (a.count !== b.count) return a.count > b.count ? a : b;
  const score = (s) => (/[A-Z]/.test(s) && /[a-z]/.test(s) ? 2 : 0) + (/_/.test(s) ? -1 : 0) + (/\s/.test(s) ? 1 : 0);
  return score(b.name) > score(a.name) ? b : a;
}

/**
 * Groups names that are the same title spelled differently. items: [{ name, count, ref }]. Two names are the same
 * title when they normalise the same (case, _ . -), have the same words in another order, or differ by one typo
 * in a title of 6+ letters (two in 12+), and always have the same numbers ("Set 01" never matches "Set 02").
 * Returns [{ to, from: [{ name, count, refs }], reason }], biggest first.
 */
function similarTitles(items, { dictionary = null } = {}) {
  const spell = new Map(); // exact spelling -> { name, count, refs }
  for (const it of items) {
    const name = String(it.name || '').trim();
    if (!name) continue;
    if (!spell.has(name)) spell.set(name, { name, count: 0, refs: [] });
    const s = spell.get(name);
    s.count += it.count || 1;
    if (it.ref != null) s.refs.push(it.ref);
  }
  const list = [...spell.values()];
  const parent = list.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const why = new Map();
  const join = (i, j, reason) => {
    const a = find(i), b = find(j);
    if (a === b) return;
    parent[b] = a;
    why.set(a, why.get(a) || reason);
  };
  const keyOf = list.map((s) => N.normalizeKey(s.name));
  const by = (fn) => {
    const m = new Map();
    list.forEach((s, i) => { const k = fn(i); if (!k) return; if (!m.has(k)) m.set(k, []); m.get(k).push(i); });
    return m;
  };
  for (const g of by((i) => keyOf[i]).values()) for (const j of g.slice(1)) join(g[0], j, 'same name, different spelling');
  for (const g of by((i) => keyOf[i].split(' ').sort().join(' ')).values()) {
    for (const j of g.slice(1)) if (keyOf[g[0]].split(' ').length > 1) join(g[0], j, 'same words in another order');
  }
  // Typos: candidates share a one-letter deletion; then the real distance decides.
  const letters = keyOf.map((k) => k.replace(/\d+/g, '#'));
  const del = new Map();
  letters.forEach((k, i) => {
    if (k.replace(/[^\p{L}]/gu, '').length < 6) return;
    for (const d of deletions(k)) { if (!del.has(d)) del.set(d, []); del.get(d).push(i); }
  });
  for (const g of del.values()) {
    if (g.length < 2 || g.length > 50) continue;
    for (let x = 0; x < g.length; x++) for (let y = x + 1; y < g.length; y++) {
      const i = g[x], j = g[y];
      if (find(i) === find(j) || digits(keyOf[i]) !== digits(keyOf[j])) continue;
      const len = Math.min(letters[i].length, letters[j].length);
      const d = distance(letters[i], letters[j], 2);
      if (d === 0 || d > (len >= 12 ? 2 : 1)) continue;
      join(i, j, 'looks like a typo');
    }
  }
  const groups = new Map();
  list.forEach((s, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(s); });
  const compiled = dictionary ? compileDictionary(dictionary) : null;
  const out = [];
  for (const [root, members] of groups) {
    if (members.length < 2) continue;
    let pick = members.reduce(better);
    let reason = why.get(root) || 'similar names';
    const fromDict = compiled && members.map((m) => applyDictionary(m.name, compiled)).find(Boolean);
    if (fromDict) { pick = { name: fromDict.name, count: 0 }; reason = 'your dictionary'; }
    else if (compiled) {
      const exact = compiled.find((d) => members.some((m) => N.normalizeKey(m.name) === d.words.join(' ')));
      if (exact) { pick = { name: exact.name, count: 0 }; reason = 'your dictionary'; }
    }
    const from = members.filter((m) => m.name !== pick.name);
    if (from.length) out.push({ to: pick.name, from, reason, files: members.reduce((a, m) => a + m.count, 0) });
  }
  return out.sort((a, b) => b.files - a.files);
}

/**
 * Suggestions for a built model: album names and topic names. Each: { kind: 'album'|'topic', to, reason,
 * from: [{ name, count, refs }] } where refs are set ids (albums) or entry ids (topics).
 */
function suggestForModel(entries, { dictionary = null } = {}) {
  const albums = [];
  const topics = [];
  for (const e of entries) {
    topics.push({ name: e.topicName, count: e.sets.reduce((a, s) => a + s.files.length, 0), ref: e.id });
    // Album names are compared without the part that comes from the folder number, so "Set 01" names stay apart.
    for (const s of e.sets) albums.push({ name: s.name, count: s.files.length, ref: s.id });
  }
  return [
    ...similarTitles(topics, { dictionary }).map((g) => ({ kind: 'topic', ...g })),
    ...similarTitles(albums, { dictionary }).map((g) => ({ kind: 'album', ...g })),
  ];
}

module.exports = { sanitizeDictionary, compileDictionary, applyDictionary, similarTitles, suggestForModel, distance };
