// Upload profiles: named sets of upload settings (speed, limits, naming, captions, duplicates, order, quality,
// retries) that can be applied in one click. Built-in profiles only set what they are about and leave the rest as
// it is; a saved profile holds everything the window had when it was saved.
'use strict';

const SEGS = {
  topicBy: ['top', 'each', 'template'], nameMatch: ['exact', 'series', 'loose'], captionWhere: ['last', 'every', 'first'],
  sortBy: ['name', 'date'], speed: ['conservative', 'balanced', 'fast', 'max', 'custom'], mode: ['per_folder', 'single', 'none'],
};
const TOGGLES = ['useAlbums', 'recursive', 'forceDocument', 'includeAllFiles', 'headerMessage', 'skipUploaded', 'skipDuplicates', 'silent', 'premium',
  'splitVideos', 'renameGibberish', 'groupSeries', 'adaptive', 'includeHidden', 'pipeline'];
const INPUTS = {
  captionBy: ['smart', 'folder', 'parent', 'filename', 'template', 'none'], captionFormat: ['simple', 'detailed', 'series', 'folder', 'custom'],
  dupScope: ['chat', 'topic', 'global'], dupProbable: ['skip', 'upload'],
  nameTemplate: 'text', captionTemplate: 'text', topicTemplate: 'text', albumPrefix: 'text', include: 'text', exclude: 'text',
  customFiles: [1, 8], customConnections: [1, 16], maxRetries: [1, 20], minSizeMb: [0, 1e6], maxSizeMb: [0, 1e7], maxDepth: [0, 100], bandwidthMbps: [0, 10000],
};
const TYPES = ['photo', 'video', 'audio', 'other'];

const BUILTIN = [
  { id: 'builtin:quality', name: 'Maximum quality', note: 'Sends originals as files, so Telegram does not compress photos or videos.',
    settings: { toggles: { forceDocument: true, splitVideos: true, skipDuplicates: true }, segs: { speed: 'balanced' } } },
  { id: 'builtin:fast', name: 'Fast upload', note: 'More connections, the next album uploads while one is posted, short pauses.',
    settings: { segs: { speed: 'fast' }, toggles: { pipeline: true, adaptive: true }, delaySec: 0.5, inputs: { bandwidthMbps: 0 } } },
  { id: 'builtin:photos', name: 'Photo archive', note: 'Photos only, sorted by name, caption on the last album, careful duplicate checks.',
    settings: { types: { photo: true, video: false, audio: false, other: false }, segs: { sortBy: 'name', captionWhere: 'last' },
      toggles: { useAlbums: true, skipUploaded: true, skipDuplicates: true }, inputs: { dupProbable: 'skip' } } },
  { id: 'builtin:videos', name: 'Video collection', note: 'Videos only; long videos are split to fit the size limit.',
    settings: { types: { photo: false, video: true, audio: false, other: false }, toggles: { splitVideos: true }, segs: { speed: 'fast', sortBy: 'name' } } },
  { id: 'builtin:anime', name: 'Anime albums', note: 'Series naming: episodes and parts of one title are recognised, one topic per top folder.',
    settings: { segs: { nameMatch: 'series', topicBy: 'top', sortBy: 'name' }, toggles: { groupSeries: true, renameGibberish: true }, inputs: { captionBy: 'smart', captionFormat: 'series' } } },
  { id: 'builtin:low', name: 'Low bandwidth', note: 'Few connections, a 5 Mbit/s limit, longer pauses and more retries.',
    settings: { segs: { speed: 'conservative' }, toggles: { pipeline: false, adaptive: true }, delaySec: 3, inputs: { bandwidthMbps: 5, maxRetries: 10 } } },
  { id: 'builtin:large', name: 'Large file archive', note: 'Files sent as documents, connections added while they help, more retries.',
    settings: { segs: { speed: 'max' }, toggles: { forceDocument: true, splitVideos: true }, inputs: { maxRetries: 10 } } },
];

/** Keeps only known settings with allowed values; anything else is dropped. */
function sanitizeSettings(x) {
  const s = x && typeof x === 'object' ? x : {};
  const out = {};
  if (s.segs && typeof s.segs === 'object') {
    out.segs = {};
    for (const [k, allowed] of Object.entries(SEGS)) if (allowed.includes(s.segs[k])) out.segs[k] = s.segs[k];
  }
  if (s.toggles && typeof s.toggles === 'object') {
    out.toggles = {};
    for (const k of TOGGLES) if (typeof s.toggles[k] === 'boolean') out.toggles[k] = s.toggles[k];
  }
  if (s.inputs && typeof s.inputs === 'object') {
    out.inputs = {};
    for (const [k, rule] of Object.entries(INPUTS)) {
      const v = s.inputs[k];
      if (v == null || v === '') continue;
      if (rule === 'text') out.inputs[k] = String(v).slice(0, 2000);
      else if (Array.isArray(rule) && typeof rule[0] === 'number') { const n = Number(v); if (Number.isFinite(n)) out.inputs[k] = Math.min(rule[1], Math.max(rule[0], n)); }
      else if (rule.includes(v)) out.inputs[k] = v;
    }
  }
  if (s.types && typeof s.types === 'object') {
    out.types = {};
    for (const k of TYPES) if (typeof s.types[k] === 'boolean') out.types[k] = s.types[k];
  }
  const d = Number(s.delaySec);
  if (s.delaySec != null && Number.isFinite(d)) out.delaySec = Math.min(10, Math.max(0, d));
  return out;
}

function sanitizeProfile(p) {
  const x = p && typeof p === 'object' ? p : {};
  const name = String(x.name || '').trim().slice(0, 60);
  if (!name) return null;
  const id = /^p[\w]{1,30}$/.test(x.id || '') ? x.id : `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return { id, name, note: String(x.note || '').slice(0, 200), settings: sanitizeSettings(x.settings), savedAt: Number(x.savedAt) || Date.now() };
}

/** User profiles first (as saved), then the built-in ones. */
function allProfiles(saved) {
  return [...(Array.isArray(saved) ? saved : []).map(sanitizeProfile).filter(Boolean), ...BUILTIN.map((b) => ({ ...b, builtin: true }))];
}

module.exports = { BUILTIN, sanitizeSettings, sanitizeProfile, allProfiles, SEGS, TOGGLES, INPUTS };
