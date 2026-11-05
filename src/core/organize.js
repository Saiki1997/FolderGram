// Organization rules: "files from here go to that topic, with this album name". A rule has conditions (source
// path, folder, parent, file names, extensions, detected title, dates) and actions (topic and album name templates,
// or leave the album out). Rules run in order and the first match wins, after smart naming and before the user's
// own corrections, which always win. Pure functions, so rules can be tried on a path before an upload.
'use strict';

const C = require('./captions');
const N = require('./naming');

/** Ready-made rules the user can add and adjust. */
const PRESETS = [
  { id: 'character-set', name: 'Topic per collection, album per set', description: 'Anime/Marin/Set 01 → topic “Marin”, album “Set 01”',
    when: { depth: '2+' }, then: { topic: '{parent}', album: '{folder}' } },
  { id: 'top-topic', name: 'Topic per top folder, album per folder', description: 'Rem Collection/Set 01 → topic “Rem Collection”, album “Set 01”',
    when: {}, then: { topic: '{top}', album: '{folder}' } },
  { id: 'year', name: 'Topic per year', description: 'Topic from the files’ date, e.g. “2024”; album name unchanged',
    when: {}, then: { topic: '{year}', album: '{album}' } },
  { id: 'videos', name: 'Videos to a “Videos” topic', description: 'Albums that are all videos go to the topic “Videos”',
    when: { ext: 'mp4, mov, mkv, webm, m4v, avi' }, then: { topic: 'Videos', album: '{album}' } },
  { id: 'skip-raw', name: 'Leave out RAW and edits folders', description: 'Folders named raw, edits or psd are not uploaded',
    when: { folder: '/^(raw|raws|edits?|psd)$/' }, then: { skip: true } },
];

/** A condition value: "/regex/" or a wildcard pattern (* and ?), case-insensitive, matched against the whole text. */
function matcher(pattern) {
  const p = String(pattern || '').trim();
  if (!p) return null;
  const re = /^\/(.+)\/([a-z]*)$/i.exec(p);
  if (re) {
    try { return new RegExp(re[1], re[2].includes('i') ? re[2] : `${re[2]}i`); } catch { return { test: () => false, invalid: true }; }
  }
  const alts = p.split(/\s*,\s*/).filter(Boolean)
    .map((g) => g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '.').replace(/\u0000/g, '.*'));
  return new RegExp(`^(?:${alts.join('|')})$`, 'i');
}

const exts = (s) => new Set(String(s || '').split(/[\s,;]+/).map((x) => x.trim().toLowerCase().replace(/^\*?\.?/, '.')).filter((x) => x.length > 1));
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Values a rule can see for one album (set) of one folder. Paths use " / " between folder names, from the source. */
function facts(folder, set, parent) {
  const segs = String(folder.path || folder.leaf || '').split(' / ').filter(Boolean);
  const times = set.files.map((f) => f.mtimeMs || (f.mtime || 0) * 1000).filter(Boolean);
  const first = times.length ? Math.min(...times) : 0;
  const extCount = new Map();
  for (const f of set.files) extCount.set(f.ext, (extCount.get(f.ext) || 0) + 1);
  const ext = [...extCount.entries()].sort((a, b) => b[1] - a[1])[0];
  const values = {
    top: folder.top, folder: folder.leaf, parent: segs.length >= 2 ? segs[segs.length - 2] : parent || '', path: segs.join('/'), album: set.name,
    title: set.name, count: set.files.length, ext: ext ? ext[0].replace(/^\./, '') : '',
    year: first ? day(first).slice(0, 4) : '', month: first ? day(first).slice(0, 7) : '', date: first ? day(first) : '',
  };
  segs.forEach((s, i) => { values[`level${i + 1}`] = s; });
  return { values, segs, first, last: times.length ? Math.max(...times) : 0 };
}

/**
 * Does the rule apply to this album? Returns { ok, why } where why lists the conditions that failed (for the
 * rule tester). Every condition given must hold; file name and extension conditions must hold for every file.
 */
function test(rule, folder, set, parent = '') {
  const w = rule.when || {};
  const { values, segs, first, last } = facts(folder, set, parent);
  const fails = [];
  const check = (label, pattern, text) => {
    const m = matcher(pattern);
    if (m && !m.test(String(text || ''))) fails.push(m.invalid ? `${label}: the pattern is not valid` : `${label} “${text || ''}” doesn't match ${pattern}`);
  };
  check('path', w.path, values.path);
  check('folder', w.folder, values.folder);
  check('parent folder', w.parent, values.parent);
  check('album name', w.title, values.title);
  if (w.depth) {
    const m = /^(\d+)(\+)?$/.exec(String(w.depth).trim());
    if (m && !(m[2] ? segs.length >= Number(m[1]) : segs.length === Number(m[1]))) fails.push(`folder depth ${segs.length} is not ${w.depth}`);
  }
  if (w.file) {
    const m = matcher(w.file);
    const bad = set.files.filter((f) => !m.test(f.name));
    if (bad.length) fails.push(`${bad.length} of ${set.files.length} file names don't match ${w.file} (e.g. “${bad[0].name}”)`);
  }
  if (w.ext) {
    const want = exts(w.ext);
    const bad = set.files.filter((f) => !want.has(f.ext));
    if (bad.length) fails.push(`${bad.length} of ${set.files.length} files are not ${[...want].join(' ')}`);
  }
  if (w.from && first && day(first) < w.from) fails.push(`files from ${day(first)}, before ${w.from}`);
  if (w.to && last && day(last) > w.to) fails.push(`files from ${day(last)}, after ${w.to}`);
  return { ok: !fails.length, why: fails, values };
}

/** What the first matching rule does to an album: { rule, topic, album, skip } or null. */
function apply(rules, folder, set, parent = '') {
  for (const rule of rules || []) {
    if (rule.enabled === false) continue;
    const r = test(rule, folder, set, parent);
    if (!r.ok) continue;
    const t = rule.then || {};
    if (t.skip) return { rule, skip: true };
    const topic = t.topic ? C.sanitize(C.applyTemplate(t.topic, r.values), C.TOPIC_MAX) : '';
    const album = t.album ? C.sanitize(C.applyTemplate(t.album, r.values), 1024) : '';
    return { rule, topic: topic || null, album: album || null, skip: false };
  }
  return null;
}

/**
 * Applies rules to a built model (planner entries). Album names and topics change; the reasons say which rule did
 * it. Albums a rule leaves out move to entry.skippedByRule so the preview can show and restore them.
 */
function applyRules(entries, rules) {
  const active = (rules || []).filter((r) => r && r.enabled !== false);
  if (!active.length) return;
  for (const e of entries) {
    const keep = [];
    for (const s of e.sets) {
      const res = apply(active, e.folder, s, e.context && e.context.parent);
      if (!res) { keep.push(s); continue; }
      const label = res.rule.name || 'a rule';
      if (res.skip) { (e.skippedByRule = e.skippedByRule || []).push({ set: s, rule: label }); continue; }
      if (res.album && res.album !== s.name) {
        s.auto = { ...s.auto, detected: s.auto.detected || s.name, name: res.album, confidence: 0.95, level: N.confidenceLevel(0.95), source: 'rule',
          reasons: [`rule “${label}”`] };
        s.name = res.album;
      }
      if (res.topic && !e.topicByRule) {
        e.topicDetected = e.topicDetected || e.topicName;
        e.topicName = res.topic;
        e.topicAuto = res.topic;
        e.topicSource = 'rule';
        e.topicByRule = label;
      }
      keep.push(s);
    }
    e.sets = keep;
  }
}

/** Cleans rules coming from the window. */
function sanitizeRules(list) {
  const str = (v, n) => String(v == null ? '' : v).slice(0, n);
  return (Array.isArray(list) ? list : []).slice(0, 100).map((r, i) => {
    const w = r && typeof r.when === 'object' && r.when ? r.when : {};
    const t = r && typeof r.then === 'object' && r.then ? r.then : {};
    const when = {};
    for (const k of ['path', 'folder', 'parent', 'file', 'ext', 'title', 'depth', 'from', 'to']) if (w[k]) when[k] = str(w[k], 300).trim();
    for (const k of ['from', 'to']) if (when[k] && !/^\d{4}-\d{2}-\d{2}$/.test(when[k])) delete when[k];
    return {
      id: str(r && r.id, 40) || `o${Date.now().toString(36)}${i}`, name: str(r && r.name, 80).trim() || `Rule ${i + 1}`, enabled: !(r && r.enabled === false),
      when, then: t.skip ? { skip: true } : { topic: str(t.topic, 200), album: str(t.album, 300) },
    };
  });
}

module.exports = { PRESETS, matcher, facts, test, apply, applyRules, sanitizeRules };
