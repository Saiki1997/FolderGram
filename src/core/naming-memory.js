// Remembers naming decisions between sessions, on this PC only: stable "Album N" stand-ins for random names,
// corrections the user made in the preview, and naming rules.
'use strict';

const { readJson, writeJson } = require('./store');
const { normalizeKey } = require('./naming');

class NamingMemory {
  constructor(file, { onRecover } = {}) {
    this.file = file;
    const d = file ? readJson(file, {}, { onRecover }) : {};
    this.data = {
      aliases: d.aliases || {}, // prefix -> { name: number }
      albums: d.albums || {}, // "<folder>|<set id>" -> name, for one folder
      learned: d.learned || {}, // normalised detected name -> corrected name, anywhere
      topics: d.topics || {}, // normalised detected topic name -> corrected name
      rules: Array.isArray(d.rules) ? d.rules : [], // [{ id, find, replace, regex, scope: album|topic|both, enabled }]
    };
    this.dirty = false;
  }

  /** "Album 3" for a random name: the same number every time, new names get the next free number. */
  alias(name, prefix = 'Album') {
    const map = this.data.aliases[prefix] || (this.data.aliases[prefix] = {});
    if (!map[name]) {
      map[name] = Math.max(0, ...Object.values(map)) + 1;
      this.dirty = true;
    }
    return `${prefix} ${map[name]}`;
  }

  /** Saved name for a set: exact folder correction first, then a learned correction, then rules. */
  resolveAlbum({ dir, key, name }) {
    const exact = this.data.albums[`${dir}|${key}`];
    if (exact) return exact;
    const learned = this.data.learned[normalizeKey(name)];
    if (learned) return learned;
    return this.applyRules(name, 'album');
  }

  resolveTopic(name) {
    return this.data.topics[normalizeKey(name)] || this.applyRules(name, 'topic');
  }

  applyRules(name, scope) {
    let out = name;
    for (const r of this.data.rules) {
      if (r.enabled === false || !(r.scope === scope || r.scope === 'both' || !r.scope)) continue;
      try {
        if (r.regex) out = out.replace(new RegExp(r.find, 'gi'), r.replace || '');
        else if (r.find && out.toLowerCase().includes(String(r.find).toLowerCase())) {
          out = out.replace(new RegExp(String(r.find).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), r.replace || '');
        }
      } catch { /* a bad regex is ignored */ }
    }
    out = out.replace(/\s{2,}/g, ' ').trim();
    return out && out !== name ? out : null;
  }

  /**
   * Records a rename done in the preview. `learn` also applies it to the same detected name in other folders
   * in future scans (the user can remove it in Naming rules).
   */
  correctAlbum({ dir, key, from, to, learn = true }) {
    if (!to || to === from) {
      // Back to the detected name: forget the folder correction and the general one made from it.
      delete this.data.albums[`${dir}|${key}`];
      if (from) delete this.data.learned[normalizeKey(from)];
    } else {
      this.data.albums[`${dir}|${key}`] = to;
      if (learn && from) this.data.learned[normalizeKey(from)] = to;
    }
    this.dirty = true;
  }

  correctTopic(from, to) {
    if (!from) return;
    if (!to || to === from) delete this.data.topics[normalizeKey(from)];
    else this.data.topics[normalizeKey(from)] = to;
    this.dirty = true;
  }

  /** For the Naming rules screen. */
  snapshot() {
    return {
      rules: this.data.rules,
      learned: Object.entries(this.data.learned).map(([from, to]) => ({ from, to })),
      topics: Object.entries(this.data.topics).map(([from, to]) => ({ from, to })),
      aliases: Object.entries(this.data.aliases).flatMap(([prefix, m]) => Object.entries(m).map(([name, n]) => ({ name, alias: `${prefix} ${n}` }))),
      folderCorrections: Object.keys(this.data.albums).length,
    };
  }

  setRules(rules) {
    this.data.rules = (rules || []).slice(0, 200).map((r, i) => ({
      id: String(r.id || `r${Date.now()}${i}`), find: String(r.find || '').slice(0, 300), replace: String(r.replace || '').slice(0, 300),
      regex: !!r.regex, scope: ['album', 'topic', 'both'].includes(r.scope) ? r.scope : 'album', enabled: r.enabled !== false,
    })).filter((r) => r.find);
    this.dirty = true;
  }

  forget(kind, from) {
    if (kind === 'learned') delete this.data.learned[from];
    else if (kind === 'topics') delete this.data.topics[from];
    else if (kind === 'all') { this.data.learned = {}; this.data.topics = {}; this.data.albums = {}; }
    this.dirty = true;
  }

  save() {
    if (!this.dirty || !this.file) return;
    writeJson(this.file, this.data);
    this.dirty = false;
  }
}

module.exports = { NamingMemory };
