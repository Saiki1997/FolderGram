// Turns scanned folders into an upload plan: which topic each folder goes to, how files are grouped into named
// sets, and how each set is cut into Telegram albums with captions. Pure Node, no Telegram or Electron code.
'use strict';

const path = require('path');
const crypto = require('crypto');
const N = require('./naming');
const C = require('./captions');
const { makeAlbums, fileStem, fileKind, VIDEO_EXT } = require('./scanner');
const O = require('./organize');
const S = require('./naming-suggest');

const NAMING_MODES = ['smart', 'folder', 'parent', 'filename', 'template'];
const sid = (...parts) => crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12);

/** Gives random-looking names a readable stand-in ("Album 1", "Album 2", …): the same one for the same name. */
function renamer(prefix = 'Album', memory = null) {
  const names = new Map();
  const one = (n) => {
    if (!N.isGibberish(n)) return n;
    if (memory && memory.alias) return memory.alias(n, prefix);
    if (!names.has(n)) names.set(n, `${prefix} ${names.size + 1}`);
    return names.get(n);
  };
  return (text) => text.split(' / ').map(one).join(' / ');
}

// ---------------------------------------------------------------- folder context

/** Folder names above the content folder, nearest first, including folders above the chosen root. */
function ancestorNames(folder) {
  const dir = folder.dir || null;
  if (!dir) {
    const parts = folder.path.split(' / ');
    return parts.slice(0, -1).reverse();
  }
  const out = [];
  let cur = path.dirname(dir);
  for (let i = 0; i < 4; i++) {
    const name = path.basename(cur);
    if (!name || cur === path.dirname(cur)) break;
    out.push(name);
    cur = path.dirname(cur);
  }
  return out;
}

/** What the folder's own name and its parents say about the content. */
function folderContext(folder) {
  const leaf = folder.leaf;
  const leafClass = N.classifyFolder(leaf);
  const ancestors = ancestorNames(folder);
  let ancestor = null;
  for (const a of ancestors.slice(0, 3)) {
    const c = N.classifyFolder(a, { asAncestor: true });
    if (c === 'meaningful') { ancestor = a; break; }
    if (c === 'ignored') break; // "Downloads", "Desktop": nothing above it names the content
  }
  const parent = ancestors[0] && N.classifyFolder(ancestors[0], { asAncestor: true }) !== 'ignored' ? ancestors[0] : '';
  let hier;
  if (folder.meta && folder.meta.title) hier = { name: folder.meta.title, confidence: 0.95, source: 'metadata', reasons: [`named in ${folder.meta.file}`] };
  else if (leafClass === 'meaningful') hier = { name: leaf, confidence: 0.85, source: 'folder', reasons: ['meaningful folder name'] };
  else if (leafClass === 'generic' && ancestor) hier = { name: `${ancestor} - ${leaf}`, confidence: 0.65, source: 'parent+folder', reasons: [`"${leaf}" needs its parent folder`] };
  else if (leafClass === 'generic') hier = { name: leaf, confidence: 0.5, source: 'folder', reasons: ['generic folder name'] };
  else if (ancestor) hier = { name: ancestor, confidence: 0.45, source: 'parent', reasons: [`"${leaf}" looks random`] };
  else hier = { name: leaf, confidence: 0.15, source: 'random', reasons: [`"${leaf}" looks random`] };
  return { leaf, leafClass, ancestor, parent, hier };
}

// ---------------------------------------------------------------- smart grouping inside one folder

/**
 * Groups a folder's files by the content name in their file names. Returns { groups, generic } where groups are
 * [{ key, name, files, identifier }] in file order and generic holds files without a usable name.
 */
function groupByFileName(files, { groupSeries = false } = {}) {
  const parsed = files.map((f) => ({ f, p: N.parseFileName(f.name) }));
  // A trailing number is a sequence number only when it looks like one: padded ("01"), in brackets, or several
  // files share the name with different numbers. Otherwise it belongs to the title ("Resident Evil 4").
  const byBase = new Map();
  for (const x of parsed) {
    if (x.p.generic || x.p.identifier) continue;
    const k = N.normalizeKey(x.p.base);
    if (!byBase.has(k)) byBase.set(k, []);
    byBase.get(k).push(x);
  }
  const series = new Set();
  for (const [k, xs] of byBase) {
    const nums = new Set(xs.filter((x) => x.p.seq != null).map((x) => x.p.seq));
    if (nums.size >= 2 || xs.some((x) => x.p.seqPadded)) series.add(k);
  }
  const groups = new Map();
  const generic = [];
  const add = (key, name, f, identifier) => {
    if (!groups.has(key)) groups.set(key, { key, name, files: [], identifier });
    groups.get(key).files.push(f);
  };
  for (const { f, p } of parsed) {
    if (p.generic) { generic.push(f); continue; }
    if (p.identifier) {
      if (groupSeries) {
        const word = p.identifier.replace(/[\s.]*\d+$/, '').replace(/\d+$/, '') || p.identifier;
        const name = p.base ? p.base : word;
        add(`s:${N.normalizeKey(name)}`, name, f, false);
      } else {
        add(`i:${N.normalizeKey(p.title)}`, p.title, f, true);
      }
      continue;
    }
    const k = N.normalizeKey(p.base);
    const name = series.has(k) || p.seq == null ? p.base : `${p.base} ${p.seqRaw}`;
    add(`b:${N.normalizeKey(name)}`, name, f, false);
  }
  let list = [...groups.values()];

  // Single files that start with a series' name join it ("Marin Kitagawa bonus.jpg" -> "Marin Kitagawa").
  const multi = list.filter((g) => g.files.length > 1 && !g.identifier);
  for (const g of list.filter((x) => x.files.length === 1 && !x.identifier)) {
    const host = multi.find((m) => m !== g && N.normalizeKey(g.name).startsWith(`${N.normalizeKey(m.name)} `));
    if (host) { host.files.push(...g.files); g.files = []; }
  }
  list = list.filter((g) => g.files.length);
  // Remaining single files that share leading words form one set ("Marin beach", "Marin pool" -> "Marin").
  const singles = list.filter((g) => g.files.length === 1 && !g.identifier);
  const byFirst = new Map();
  for (const g of singles) {
    const first = N.normalizeKey(g.name).split(' ')[0];
    if (!first || first.length < 3) continue;
    if (!byFirst.has(first)) byFirst.set(first, []);
    byFirst.get(first).push(g);
  }
  for (const gs of byFirst.values()) {
    if (gs.length < 2) continue;
    const name = N.commonPrefix(gs.map((g) => g.name));
    if (!name || N.isGenericName(name)) continue;
    const [head, ...rest] = gs;
    head.name = name;
    head.key = `b:${N.normalizeKey(name)}`;
    for (const g of rest) { head.files.push(...g.files); g.files = []; }
  }
  list = list.filter((g) => g.files.length);
  // Keep folder order inside each group.
  const order = new Map(files.map((f, i) => [f, i]));
  for (const g of list) g.files.sort((a, b) => order.get(a) - order.get(b));
  list.sort((a, b) => order.get(a.files[0]) - order.get(b.files[0]));
  return { groups: list, generic };
}

/** Sets for one folder in smart mode: [{ key, name, files, auto }]. */
function smartSets(folder, ctx, opts) {
  const { groups, generic } = groupByFileName(folder.files, opts);
  const hier = ctx.hier;
  const named = groups;
  const folderSet = (files, extra = {}) => ({ key: 'folder', name: hier.name, files, auto: { ...hier, ...extra } });
  if (!named.length || hier.source === 'metadata') return [folderSet(folder.files)];

  const meaningfulCount = folder.files.length - generic.length;
  if (named.length === 1 && !named[0].identifier) {
    const g = named[0];
    const fileCand = { name: g.name, confidence: g.files.length >= 2 ? 0.9 : 0.7, source: 'filename',
      reasons: [g.files.length >= 2 ? `${g.files.length} files share the name` : 'name of the only named file'] };
    let pick;
    if (N.containsWords(hier.name, g.name) && hier.confidence >= 0.5) pick = { ...hier, confidence: Math.max(hier.confidence, 0.85), reasons: [...hier.reasons, 'file names agree'] };
    else if (N.containsWords(g.name, ctx.leaf)) pick = { ...fileCand, confidence: Math.max(fileCand.confidence, 0.9), reasons: [...fileCand.reasons, 'folder name agrees'] };
    else pick = fileCand.confidence >= hier.confidence ? fileCand : hier;
    return [{ key: g.key, name: pick.name, files: folder.files, auto: pick }];
  }

  // Several names: split only when the names form real series (or episodes). Many one-off descriptive names
  // ("beach.jpg", "dog.jpg") mean the folder is one set.
  const inSeries = named.filter((g) => g.files.length > 1 || g.identifier).reduce((a, g) => a + g.files.length, 0);
  if (inSeries < meaningfulCount * 0.5) return [folderSet(folder.files, { reasons: [...hier.reasons, 'file names are all different'] })];
  const sets = [];
  const leftovers = [...generic];
  for (const g of named) {
    if (g.files.length > 1 || g.identifier) {
      sets.push({ key: g.key, name: g.name, files: g.files, auto: { name: g.name, confidence: g.identifier ? 0.85 : 0.9, source: g.identifier ? 'identifier' : 'filename',
        reasons: [g.identifier ? 'numbered episode/part kept separate' : `${g.files.length} files share the name`] } });
    } else {
      leftovers.push(...g.files);
    }
  }
  if (leftovers.length) {
    const order = new Map(folder.files.map((f, i) => [f, i]));
    leftovers.sort((a, b) => order.get(a) - order.get(b));
    sets.push(folderSet(leftovers));
  }
  const order = new Map(folder.files.map((f, i) => [f, i]));
  sets.sort((a, b) => order.get(a.files[0]) - order.get(b.files[0]));
  return sets;
}

/** Sets for one folder in the older "file name" mode (kept for existing users). */
function legacyFilenameSets(folder, folderCaption, nameMatch) {
  const byStem = new Map();
  for (const f of folder.files) {
    // The "same name" setting is for videos; photo sets are always grouped ignoring numbers ("Rem 01", "Rem 02").
    let stem = fileStem(f.name, VIDEO_EXT.has(f.ext) ? nameMatch : 'loose');
    if (stem && N.isGenericName(stem)) stem = ''; // hashes and phone names use the folder name too
    stem = stem || folderCaption;
    const key = stem.toLowerCase();
    if (!byStem.has(key)) byStem.set(key, { key: `f:${key}`, name: stem, files: [],
      auto: { name: stem, confidence: stem === folderCaption ? 0.6 : 0.8, source: stem === folderCaption ? 'folder' : 'filename', reasons: [] } });
    byStem.get(key).files.push(f);
  }
  return [...byStem.values()];
}

function folderConfidence(name) {
  const c = N.classifyFolder(name);
  return c === 'meaningful' ? 0.85 : c === 'generic' ? 0.6 : 0.2;
}

// ---------------------------------------------------------------- plan model

/**
 * Builds the editable plan model from scanned folders.
 *   captionBy (naming mode): smart | folder | parent | filename | template
 *   topicBy: top | each | template (topicTemplate, e.g. "{top}")
 *   nameTemplate: for "template" naming, e.g. "{parent} - {folder}" or "{album} ({count} files)"
 *   renameGibberish/albumPrefix: random names become "Album 1", "Album 2" (stable when opts.memory is given)
 *   groupSeries: "Episode 01", "Episode 02" share one set instead of staying separate
 *   memory: optional NamingMemory with saved corrections and rules
 * Returns { entries: [{ id, folder, topicName, topicAuto, header, sets: [{ id, name, auto, files }] }] }.
 */
function buildModel(folders, opts = {}) {
  const { topicBy = 'top', captionBy = 'folder', nameMatch = 'series', renameGibberish = false, albumPrefix = 'Album', memory = null } = opts;
  const mode = captionBy === 'none' ? 'folder' : (NAMING_MODES.includes(captionBy) ? captionBy : 'folder');
  const rename = renameGibberish ? renamer((albumPrefix || 'Album').trim() || 'Album', memory) : (n) => n;

  const entries = folders.map((folder) => {
    const topicSource = topicBy === 'each' ? folder.path : folder.top;
    const ctx = folderContext(folder);
    const topicName = rename(topicSource);
    // When the folder is inside its topic, its own name is the useful caption; otherwise the full path.
    const folderCaption = rename(topicBy === 'each' ? folder.path : folder.leaf);
    let sets;
    if (mode === 'smart' || mode === 'template') {
      sets = smartSets(folder, ctx, opts).map((s) => {
        // Random folder names with nothing better in the files: "Album N" when asked (as in 2.x), otherwise the
        // parent folder's name or the random name, flagged as low confidence.
        if ((s.auto.source === 'random' || s.auto.source === 'parent') && renameGibberish) {
          const alias = rename(s.auto.source === 'parent' ? folder.leaf : s.name);
          return { ...s, name: alias, auto: { ...s.auto, name: alias, source: 'fallback', reasons: [...s.auto.reasons, `renamed from "${folder.leaf}"`] } };
        }
        return s;
      });
      if (mode === 'template') {
        sets = sets.map((s) => {
          const name = C.applyTemplate(opts.nameTemplate || '{album}', { album: s.name, folder: folder.leaf, parent: ctx.parent, top: folder.top,
            path: folder.path, count: s.files.length }) || s.name;
          return { ...s, name, auto: { ...s.auto, name, source: 'template' } };
        });
      }
    } else if (mode === 'parent') {
      const name = ctx.parent && N.normalizeKey(ctx.parent) !== N.normalizeKey(folder.leaf) ? `${rename(ctx.parent)} - ${rename(folder.leaf)}` : rename(folder.leaf);
      sets = [{ key: 'folder', name, files: folder.files, auto: { name, confidence: folderConfidence(folder.leaf), source: 'parent+folder', reasons: [] } }];
    } else if (mode === 'filename') {
      sets = legacyFilenameSets(folder, folderCaption, nameMatch);
    } else {
      sets = [{ key: 'folder', name: folderCaption, files: folder.files, auto: { name: folderCaption, confidence: folderConfidence(folder.leaf), source: 'folder', reasons: [] } }];
    }
    const id = sid('e', folder.dir || folder.relPath || folder.path);
    const out = {
      id,
      folder,
      topicName,
      topicAuto: topicName,
      topicSource: 'folder',
      header: folderCaption,
      context: { parent: ctx.parent, ancestor: ctx.ancestor, leafClass: ctx.leafClass },
      sets: sets.map((s) => ({ id: sid('s', id, s.key), name: s.name, files: s.files,
        auto: { ...s.auto, name: s.auto.name || s.name, original: s.key === 'folder' ? folder.leaf : s.files[0].name, level: N.confidenceLevel(s.auto.confidence) } })),
    };
    return out;
  });

  if (mode === 'smart' || mode === 'template') smartTopics(entries, topicBy);
  if (topicBy === 'template' && opts.topicTemplate) {
    for (const e of entries) {
      const ctx = e.context;
      e.topicName = C.applyTemplate(opts.topicTemplate, { top: e.folder.top, folder: e.folder.leaf, parent: ctx.parent, path: e.folder.path,
        album: e.sets[0] && e.sets[0].name }) || e.topicName;
      e.topicAuto = e.topicName;
    }
  }
  for (const e of entries) {
    if (e.folder.meta && e.folder.meta.topic) {
      e.topicDetected = e.topicName;
      e.topicName = e.folder.meta.topic;
      e.topicAuto = e.topicName;
      e.topicSource = 'metadata';
    }
  }
  applyDictionary(entries, opts.dictionary);
  O.applyRules(entries, opts.organizeRules);
  applyMemory(entries, memory);
  for (const e of entries) e.topicName = C.sanitize(e.topicName, C.TOPIC_MAX) || 'Uploads';
  markConflicts(entries);
  return { entries };
}

/** The top-level folder of an entry, as an absolute path when known. */
function topDir(folder) {
  if (!folder.dir) return null;
  const depth = folder.relPath && folder.relPath !== '.' ? folder.relPath.split('/').length : 0;
  let d = folder.dir;
  for (let i = 1; i < depth; i++) d = path.dirname(d);
  return d;
}

/**
 * Smart topic names. A random top folder ("X8dk92ks") takes the name its files agree on; a generic one
 * ("Set 01", "Videos") goes into a topic named after the meaningful folder above it ("Rem Collection").
 */
function smartTopics(entries, topicBy) {
  if (topicBy !== 'top') return;
  const byTop = new Map();
  for (const e of entries) {
    const k = topDir(e.folder) || e.folder.top;
    if (!byTop.has(k)) byTop.set(k, []);
    byTop.get(k).push(e);
  }
  for (const es of byTop.values()) {
    const top = es[0].folder.top;
    const cls = N.classifyFolder(top);
    if (cls === 'meaningful') continue;
    const names = new Map();
    for (const e of es) for (const s of e.sets) if (s.auto.confidence >= 0.8 && s.auto.source !== 'folder') names.set(N.normalizeKey(s.name), s.name);
    const td = topDir(es[0].folder);
    const above = td ? folderContext({ leaf: path.basename(td), dir: td, path: top }).ancestor : null;
    let name = null, source = cls;
    if (cls === 'random' && names.size === 1) { name = [...names.values()][0]; source = 'filename'; }
    else if (above) { name = cls === 'generic' ? above : above; source = 'parent'; }
    else if (cls === 'random' && names.size === 1) { name = [...names.values()][0]; source = 'filename'; }
    for (const e of es) {
      if (name && !es[0].topicRenamed) { e.topicName = name; e.topicAuto = name; }
      e.topicSource = name ? source : cls;
    }
  }
}

/** The user's preferred spellings ("Marin" → "Marin Kitagawa"), on album and topic names. */
function applyDictionary(entries, dictionary) {
  const compiled = dictionary && dictionary.length ? S.compileDictionary(dictionary) : null;
  if (!compiled || !compiled.length) return;
  for (const e of entries) {
    const t = S.applyDictionary(e.topicName, compiled);
    if (t) { e.topicDetected = e.topicDetected || e.topicName; e.topicName = t.name; e.topicAuto = t.name; e.topicSource = 'dictionary'; }
    for (const s of e.sets) {
      const r = S.applyDictionary(s.name, compiled);
      if (!r) continue;
      s.auto = { ...s.auto, detected: s.auto.detected || s.name, name: r.name, reasons: [...(s.auto.reasons || []), `your dictionary: ${r.hits.join(', ')}`] };
      s.name = r.name;
    }
  }
}

/** Saved corrections and rules from earlier sessions. */
function applyMemory(entries, memory) {
  if (!memory) return;
  for (const e of entries) {
    const t = memory.resolveTopic && memory.resolveTopic(e.topicName);
    if (t && t !== e.topicName) { e.topicDetected = e.topicDetected || e.topicName; e.topicName = t; e.topicAuto = t; e.topicSource = 'saved'; }
    for (const s of e.sets) {
      const n = memory.resolveAlbum && memory.resolveAlbum({ dir: e.folder.dir || e.folder.path, key: s.id, name: s.name });
      if (n && n !== s.name) {
        s.auto = { ...s.auto, name: n, detected: s.auto.detected || s.name, confidence: 1, level: 'high', source: 'saved', reasons: [`your earlier correction of "${s.name}"`] };
        s.name = n;
      }
    }
  }
}

/** Flags sets that would get the same caption in the same topic although they come from different folders. */
function markConflicts(entries) {
  const seen = new Map();
  for (const e of entries) {
    for (const s of e.sets) {
      s.conflict = false;
      const k = `${N.normalizeKey(e.topicName)}|${N.normalizeKey(s.name)}`;
      if (!seen.has(k)) seen.set(k, []);
      seen.get(k).push({ e, s });
    }
  }
  for (const list of seen.values()) {
    if (new Set(list.map((x) => x.e.id)).size > 1) for (const x of list) x.s.conflict = true;
  }
}

// ---------------------------------------------------------------- albums and captions

/**
 * Cuts every set into Telegram albums and writes the captions. Returns the plan the uploader runs:
 * [{ id, folder, topicName, header, albums: [{ files, caption, set, setId, part, totalParts }] }].
 *   captionWhere: last | every | first | none
 *   captionFormat: simple | detailed | series | folder | custom (captionTemplate)
 */
function materialize(model, opts = {}) {
  const { captionWhere = 'last', captionFormat = 'simple', captionTemplate = '', forceDocument = false, useAlbums = true } = opts;
  return model.entries.map((e) => {
    const albums = [];
    const ctx = e.context || {};
    for (const set of e.sets) {
      if (!set.files.length) continue;
      const parts = makeAlbums(set.files, { forceDocument, useAlbums });
      parts.forEach((files, i) => {
        const caption = C.captioned(captionWhere, i, parts.length)
          ? C.formatCaption(captionFormat, captionTemplate, {
            album: set.name, kinds: files.map((f) => fileKind(f, forceDocument)), part: i + 1, totalParts: parts.length,
            folder: e.folder.leaf, parent: ctx.parent || '', top: e.folder.top, path: e.folder.path,
            folderPath: ctx.parent && ctx.parent !== e.folder.leaf ? `${ctx.parent} / ${e.folder.leaf}` : e.folder.leaf,
          })
          : '';
        albums.push({ files, caption, set: set.name, setId: set.id, part: i + 1, totalParts: parts.length });
      });
    }
    return { id: e.id, folder: e.folder, topicName: e.topicName, topicId: e.topicId || null, header: e.header, albums };
  });
}

/** Scanned folders -> upload plan, in one step. */
function buildPlan(folders, opts = {}) {
  return materialize(buildModel(folders, opts), opts);
}

module.exports = { NAMING_MODES, buildModel, materialize, buildPlan, renamer, folderContext, groupByFileName, smartSets, markConflicts };
