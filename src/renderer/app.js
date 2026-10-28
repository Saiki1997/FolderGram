'use strict';

const $ = (id) => document.getElementById(id);
const C = window.fgCaptions;

const state = {
  loginAs: 'user', mode: 'per_folder', topicBy: 'top', captionWhere: 'last', sortBy: 'name', speed: 'balanced',
  types: { photo: true, video: true, audio: true, other: true }, paused: false, rate: null,
  me: null, groups: [], chat: null, topics: [], sources: [], uploading: false, logCount: 0,
  nameMatch: 'series', thumbsForced: false,
  model: null, // { entries: [{ id, topicName, sets: [{ id, name, auto, fileIds }], excluded }], files: [...] }
  undo: [], redo: [], dirty: false, selected: new Set(), drawer: null, queue: [], runningJob: null, waitUntil: 0,
};
const TOGGLES = ['useAlbums', 'recursive', 'forceDocument', 'includeAllFiles', 'headerMessage', 'skipUploaded', 'skipDuplicates', 'silent', 'premium',
  'splitVideos', 'renameGibberish', 'groupSeries', 'adaptive', 'includeHidden', 'pipeline'];
const INPUTS = ['captionBy', 'nameTemplate', 'captionFormat', 'captionTemplate', 'topicTemplate', 'albumPrefix', 'customFiles', 'customConnections', 'maxRetries', 'dupScope',
  'dupProbable', 'include', 'exclude', 'minSizeMb', 'maxSizeMb', 'maxDepth', 'bandwidthMbps'];
// Changing these needs the disk scanned again; the others only re-plan or re-caption.
const SCAN_INPUTS = ['recursive', 'includeAllFiles', 'include', 'exclude', 'minSizeMb', 'maxSizeMb', 'maxDepth', 'includeHidden'];
const PLAN_INPUTS = ['captionBy', 'nameTemplate', 'topicTemplate', 'albumPrefix', 'renameGibberish', 'groupSeries'];
const CAPTION_INPUTS = ['captionFormat', 'captionTemplate', 'useAlbums', 'forceDocument'];
const COLORS = ['#e17076', '#7bc862', '#e5ca77', '#65aadd', '#a695e7', '#ee7aae', '#6ec9cb', '#faa774'];
const KIND_ICON = { video: '🎬', audio: '🎵', document: '📄', animation: '🎞️', photo: '🖼️' };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initials = (s) => (s || '?').replace(/[^\p{L}\p{N} ]/gu, '').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '#';
const colorFor = (s) => COLORS[[...String(s)].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];
const norm = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/[\s._\-–—]+/g, ' ').replace(/[^\p{L}\p{N} ]/gu, '').trim();
function humanSize(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return i ? `${n.toFixed(1)} ${u[i]}` : `${n} B`;
}
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ---------------------------------------------------------------- small UI pieces

function toast(message, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 8000 : 4000);
}

/** Modal with a text input (or none, for a confirmation). Resolves the value, or null when cancelled. */
function prompt({ title, text = '', placeholder = '', secret = false, okLabel = 'OK', value = '', type = 'text', noInput = false, body = '' }) {
  return new Promise((resolve) => {
    $('modalTitle').textContent = title;
    $('modalText').textContent = text;
    $('modalText').hidden = !text;
    $('modalBody').innerHTML = body;
    const input = $('modalInput');
    input.hidden = noInput;
    input.type = secret ? 'password' : type;
    input.placeholder = placeholder;
    input.value = value;
    $('modalOk').textContent = okLabel;
    $('modal').hidden = false;
    setTimeout(() => (noInput ? $('modalOk') : input).focus(), 30);
    const done = (v) => {
      $('modal').hidden = true;
      $('modalForm').onsubmit = null;
      $('modalCancel').onclick = null;
      resolve(v);
    };
    $('modalForm').onsubmit = (e) => { e.preventDefault(); done(noInput ? true : input.value); };
    $('modalCancel').onclick = () => done(null);
  });
}

async function busy(btn, fn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '…';
  try { return await fn(); } finally { btn.disabled = false; btn.textContent = label; }
}

async function guarded(fn) {
  try { return await fn(); } catch (e) { toast(e.message, 'error'); return undefined; }
}

function setSeg(name, value) {
  state[name] = value;
  document.querySelectorAll(`.seg[data-name="${name}"] button`).forEach((b) => b.classList.toggle('on', b.dataset.value === value));
}

const val = (id) => $(id).value.trim();
function options() {
  const o = Object.fromEntries(TOGGLES.map((k) => [k, $(k).checked]));
  const captionBy = $('captionBy').value;
  return {
    ...o, albumPrefix: val('albumPrefix') || 'Album', nameMatch: state.nameMatch, types: state.types, sortBy: state.sortBy, delaySec: Number($('delaySec').value),
    topicBy: state.topicBy, topicTemplate: val('topicTemplate'), captionBy: captionBy === 'none' ? 'smart' : captionBy, nameTemplate: val('nameTemplate'),
    captionWhere: captionBy === 'none' ? 'none' : state.captionWhere, captionFormat: $('captionFormat').value, captionTemplate: val('captionTemplate'),
    speed: state.speed, customFiles: Number($('customFiles').value) || 3, customConnections: Number($('customConnections').value) || 4, maxRetries: Number($('maxRetries').value) || 5, dupScope: $('dupScope').value,
    dupProbable: $('dupProbable').value, include: val('include'), exclude: val('exclude'), minSizeMb: Number($('minSizeMb').value) || 0,
    maxSizeMb: Number($('maxSizeMb').value) || 0, maxDepth: $('maxDepth').value === '' ? 0 : Number($('maxDepth').value),
    bandwidthMbps: Math.max(0, Number($('bandwidthMbps').value) || 0),
  };
}

function saveOptions() {
  fg.setSettings({ ui: { v: 3, loginAs: state.loginAs, mode: state.mode, topicBy: state.topicBy, sortBy: state.sortBy, types: state.types, nameMatch: state.nameMatch,
    speed: state.speed, showThumbs: $('showThumbs').checked, delaySec: Number($('delaySec').value), captionWhere: state.captionWhere,
    toggles: Object.fromEntries(TOGGLES.map((k) => [k, $(k).checked])), inputs: Object.fromEntries(INPUTS.map((k) => [k, $(k).value])) } });
}

// ---------------------------------------------------------------- tabs

function showTab(tab) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  for (const p of ['preview', 'queue', 'library', 'sync', 'history', 'naming']) $(`panel-${p}`).hidden = p !== tab;
  if (tab === 'naming') loadNaming();
  if (tab === 'library') openLibrary();
  if (tab === 'sync') loadSync();
  if (tab === 'history') renderHistory();
  if (tab === 'preview') vlist.refresh();
  if (tab === 'queue') { renderLive(); $('liveFeed').scrollTop = $('liveFeed').scrollHeight; }
}
$('tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) showTab(b.dataset.tab); });

// ---------------------------------------------------------------- account

function showAccount() {
  $('loggedOut').hidden = !!state.me;
  $('loggedIn').hidden = !state.me;
  if (state.me) {
    $('meName').textContent = state.me.name || 'Telegram';
    $('meUser').textContent = `${state.me.bot ? 'Bot' : 'Account'} · @${state.me.username || '—'}`;
    $('meAvatar').textContent = initials(state.me.name);
    $('meAvatar').style.background = colorFor(state.me.name);
  }
  $('phoneField').hidden = state.loginAs !== 'user';
  $('tokenField').hidden = state.loginAs !== 'bot';
  $('groupSearch').placeholder = state.me && state.me.bot ? 'Type the group @username or id, then Enter' : 'Search your groups, or type @username / id';
  updateStart();
}

function creds() {
  return { apiId: val('apiId'), apiHash: val('apiHash'), phone: val('phone'), botToken: val('botToken'), asBot: state.loginAs === 'bot' };
}

async function login(silent = false) {
  const c = creds();
  if (!/^\d+$/.test(c.apiId) || !c.apiHash) return silent || toast('Enter your API ID and API hash from my.telegram.org.', 'error');
  if (c.asBot ? !c.botToken : !c.phone) return silent || toast(c.asBot ? 'Enter the bot token.' : 'Enter your phone number with country code.', 'error');
  await busy($('loginBtn'), () => guarded(async () => {
    state.me = await fg.login(c);
    showAccount();
    toast(`Logged in as ${state.me.name}`, 'ok');
    if (!state.me.bot) await loadGroups();
    else toast('Bots can’t list their chats: type the group’s @username or id. The bot must be an admin with “Manage topics”.');
  }));
}

fg.on('prompt', async ({ id, kind, hint }) => {
  const value = kind === 'code'
    ? await prompt({ title: 'Enter login code', text: 'Telegram sent a code to your Telegram app (or by SMS).', placeholder: '12345', okLabel: 'Log in' })
    : await prompt({ title: 'Two-step verification', text: hint ? `Password hint: ${hint}` : 'Enter your Telegram cloud password.', secret: true, okLabel: 'Continue' });
  fg.replyPrompt(id, value);
});
fg.on('toast', ({ kind, message }) => toast(message, kind));

// ---------------------------------------------------------------- groups & topics

async function loadGroups() {
  await guarded(async () => {
    state.groups = await fg.listGroups();
    renderGroupList();
  });
}

function renderGroupList() {
  const q = $('groupSearch').value.trim().toLowerCase();
  const list = state.groups.filter((g) => !q || g.title.toLowerCase().includes(q) || (g.username || '').toLowerCase().includes(q));
  const box = $('groupList');
  box.innerHTML = list.length
    ? list.slice(0, 80).map((g) => `
      <div class="dd-item" data-id="${esc(g.id)}">
        <div class="avatar" style="background:${colorFor(g.title)}">${esc(initials(g.title))}</div>
        <div class="grow"><div class="dd-title">${esc(g.title)}</div>
        <div class="muted small">${g.username ? '@' + esc(g.username) : esc(g.id)}${g.members ? ` · ${g.members} members` : ''}</div></div>
        ${g.isForum ? '<span class="tag">TOPICS</span>' : ''}
      </div>`).join('')
    : `<div class="dd-empty">${state.groups.length ? 'No match. Press Enter to look it up.' : 'Type a @username or id and press Enter.'}</div>`;
}

async function chooseGroup(chat) {
  state.chat = chat;
  state.topics = [];
  $('groupList').hidden = true;
  $('groupSearch').value = chat.title;
  $('groupInfo').innerHTML = `${chat.isForum ? '<span class="tag">TOPICS ON</span>' : '<span class="tag warn">TOPICS OFF</span>'}
    <span class="muted small">${chat.isForum ? 'Folders can go into their own topics.' : 'Turn on Topics in the group settings to use topics.'}</span>`;
  if (!chat.isForum && state.mode !== 'none') setMode('none');
  fg.setSettings({ lastChat: { id: chat.id, title: chat.title } });
  if (chat.isForum) await loadTopics();
  renderPlan();
  updateStart();
}

async function loadTopics(selectId) {
  if (!state.chat || !state.chat.isForum) return;
  await guarded(async () => {
    state.topics = await fg.listTopics(state.chat);
    const sel = $('topicSelect');
    sel.innerHTML = state.topics.map((t) => `<option value="${t.id}">${esc(t.title)}${t.closed ? ' (closed)' : ''}</option>`).join('');
    if (selectId) sel.value = String(selectId);
    renderPlan();
  });
}

async function newTopic() {
  if (!state.chat) return toast('Choose a group first.', 'error');
  if (!state.chat.isForum) return toast('This group has no topics. Turn on Topics in the group settings.', 'error');
  const title = await prompt({ title: 'New topic', text: `Create a topic in “${state.chat.title}”.`, placeholder: 'Topic name', okLabel: 'Create' });
  if (!title || !title.trim()) return;
  await guarded(async () => {
    const id = await fg.createTopic(state.chat, title.trim());
    await loadTopics(id);
    toast(`Topic “${title.trim()}” created`, 'ok');
  });
}

function setMode(mode) {
  setSeg('mode', mode);
  $('perFolderOpts').hidden = mode !== 'per_folder';
  $('singleOpts').hidden = mode !== 'single';
  $('headerToggle').classList.toggle('disabled', mode === 'per_folder');
  renderPlan();
  saveOptions();
}

/** What the preview should say about a topic name: new, existing, closed, or close to another topic. */
function topicStatus(name, topicId) {
  if (!state.chat || !state.chat.isForum || !state.topics.length) return null;
  if (topicId) {
    const t = state.topics.find((x) => x.id === topicId);
    return { tag: 'MAPPED', cls: '', note: t ? `to “${t.title}”` : '' };
  }
  const k = norm(name);
  const same = state.topics.filter((t) => norm(t.title) === k);
  if (same.length > 1) return { tag: 'AMBIGUOUS', cls: 'warn', note: `${same.length} topics have this name; the first open one is used` };
  if (same.length === 1) return same[0].closed ? { tag: 'CLOSED', cls: 'warn', note: 'this topic is closed; posting may fail' } : { tag: 'EXISTING', cls: '' };
  const similar = state.topics.find((t) => { const n = norm(t.title); return n && (n.startsWith(k) || k.startsWith(n)) && Math.abs(n.length - k.length) <= 3; });
  if (similar) return { tag: 'NEW TOPIC', cls: 'new', note: `similar to existing “${similar.title}”` };
  return { tag: 'NEW TOPIC', cls: 'new' };
}

// ---------------------------------------------------------------- sources and scanning

const BIG_UPLOAD = 500; // above this many files, thumbnails start switched off

function addSources(paths) {
  const known = new Set(state.sources.map((p) => p.toLowerCase()));
  for (const p of paths || []) if (!known.has(p.toLowerCase())) { state.sources.push(p); known.add(p.toLowerCase()); }
  renderSources();
  scan();
}

const shortPath = (p) => {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : p;
};

function renderSources() {
  const n = state.sources.length;
  $('folderPath').textContent = n ? (n === 1 ? state.sources[0] : `${n} folders and files`) : 'Add folders…';
  $('folderSub').textContent = n ? 'Click to add more folders, or drop folders and files here' : 'Click to choose folders, or drop folders and files here';
  $('rescanBtn').disabled = !n;
  $('sources').hidden = n < 2;
  $('sources').innerHTML = state.sources.map((p, i) => `<span class="src-chip" title="${esc(p)}"><span>${esc(shortPath(p))}</span><button data-i="${i}" title="Remove">✕</button></span>`).join('')
    + (n ? '<button class="src-clear" id="clearSources">Clear all</button>' : '');
}

let scanSeq = 0;
async function scan(force = false) {
  const seq = ++scanSeq;
  if (!state.sources.length) {
    setModel(null);
    updateStart();
    return;
  }
  const hadEdits = state.dirty;
  $('folderSub').textContent = 'Scanning…';
  await guarded(async () => {
    const m = await fg.scan(state.sources, options(), force);
    if (!m || seq !== scanSeq) return; // a newer scan started meanwhile
    setModel(m);
    const files = m.files.length;
    if (files > BIG_UPLOAD && !state.thumbsForced) $('showThumbs').checked = false;
    $('thumbHint').textContent = files > BIG_UPLOAD && !$('showThumbs').checked ? `Thumbnails are off above ${BIG_UPLOAD} files to keep FolderGram fast; switch them on any time.` : '';
    if (hadEdits) toast('Albums were rebuilt. Names you corrected are remembered; moves and merges were reset.');
  });
  renderSources();
  updateStart();
}

fg.on('scan:progress', (p) => {
  if (p.checking) { $('progressLabel').textContent = `Checking for duplicates… ${p.done}/${p.total}`; return; }
  if (p.analysing) { $('progressLabel').textContent = `${p.analysing === 'covers' ? 'Looking for covers' : 'Comparing photos and videos'}… ${p.done}/${p.total}`; return; }
  $('folderSub').textContent = p.done ? `Found ${p.files} files in ${p.folders} folders` : `Scanning… ${p.files} files in ${p.folders} folders`;
});

function setModel(m) {
  state.model = m ? { entries: m.entries.map((e) => ({ ...e, excluded: e.excluded || [] })), files: m.files } : null;
  state.suggestions = (m && m.suggestions) || [];
  state.covers = new Map();
  state.undo = [];
  state.redo = [];
  state.dirty = false;
  state.selected.clear();
  closeDrawer();
  renderPlan({ keepScroll: false });
}

// ---------------------------------------------------------------- edits (undo/redo)

const snapshot = () => JSON.stringify(state.model.entries);
/** Records the current plan for undo, then applies `fn`. */
function edit(fn, { structural = true, learn = false } = {}) {
  if (!state.model) return;
  const before = names();
  state.undo.push(snapshot());
  if (state.undo.length > 60) state.undo.shift();
  state.redo = [];
  fn();
  if (structural) state.dirty = true;
  for (const e of state.model.entries) e.sets = e.sets.filter((s) => s.fileIds.length);
  remember(before, learn);
  markConflicts();
  renderPlan();
  if (state.drawer) renderDrawer();
}
function undo() {
  if (!state.undo.length) return;
  const before = names();
  state.redo.push(snapshot());
  state.model.entries = JSON.parse(state.undo.pop());
  remember(before, false);
  markConflicts();
  renderPlan();
  if (state.drawer) renderDrawer();
}
function redo() {
  if (!state.redo.length) return;
  const before = names();
  state.undo.push(snapshot());
  state.model.entries = JSON.parse(state.redo.pop());
  remember(before, false);
  markConflicts();
  renderPlan();
  if (state.drawer) renderDrawer();
}

// Album and topic names before an edit, so the names that changed can be remembered (or forgotten on undo).
function names() {
  const sets = new Map(), topics = new Map();
  for (const e of state.model.entries) {
    topics.set(e.id, e.topicName);
    for (const s of e.sets) sets.set(s.id, s.name);
  }
  return { sets, topics };
}
const detectedName = (s) => (s.auto && (s.auto.detected || s.auto.name)) || s.name;
// Names that came from a parent folder or a stand-in are too general to apply to other folders.
const learnable = (s) => !!s.auto && !['parent', 'random', 'fallback', 'template'].includes(s.auto.source);
function remember(before, learn) {
  const topicsDone = new Set();
  for (const e of state.model.entries) {
    const t = before.topics.get(e.id);
    const from = e.topicDetected || e.topicAuto;
    if (t != null && t !== e.topicName && from && !topicsDone.has(from)) {
      topicsDone.add(from);
      fg.correctTopic(from, e.topicName).catch(() => {});
    }
    for (const s of e.sets) {
      const old = before.sets.get(s.id);
      if (old == null || old === s.name) continue;
      fg.correctAlbum({ dir: e.dir || e.path, key: s.id, from: detectedName(s), to: s.name, learn: learn && learnable(s) }).catch(() => {});
    }
  }
}

function markConflicts() {
  const seen = new Map();
  for (const e of state.model.entries) for (const s of e.sets) {
    const k = `${norm(e.topicName)}|${norm(s.name)}`;
    if (!seen.has(k)) seen.set(k, new Set());
    seen.get(k).add(e.id);
  }
  for (const e of state.model.entries) for (const s of e.sets) s.conflict = seen.get(`${norm(e.topicName)}|${norm(s.name)}`).size > 1;
}

const findSet = (sid) => {
  for (const e of state.model.entries) {
    const i = e.sets.findIndex((s) => s.id === sid);
    if (i >= 0) return { entry: e, set: e.sets[i], index: i };
  }
  return null;
};
let newSetSeq = 0;
const newSetId = () => `u${Date.now().toString(36)}${(newSetSeq++).toString(36)}`;

function renameSet(sid, name) {
  const f = findSet(sid);
  name = name.trim();
  if (!f || !name || name === f.set.name) return;
  // Remembered for this folder, and for the same detected name elsewhere (see Naming rules).
  edit(() => { f.set.name = name; }, { structural: false, learn: true });
}

function renameTopic(oldName, name, entries) {
  name = name.trim().slice(0, 128);
  if (!name || name === oldName) return;
  edit(() => { for (const e of entries) { e.topicName = name; e.topicId = null; } }, { structural: false });
}

function moveSet(sid, toEntryId, beforeSid) {
  const f = findSet(sid);
  const target = state.model.entries.find((e) => e.id === toEntryId);
  if (!f || !target || sid === beforeSid) return;
  edit(() => {
    f.entry.sets.splice(f.index, 1);
    const at = beforeSid ? target.sets.findIndex((s) => s.id === beforeSid) : -1;
    target.sets.splice(at < 0 ? target.sets.length : at, 0, f.set);
  });
}

function mergeSets(ids) {
  const found = ids.map(findSet).filter(Boolean);
  if (found.length < 2) return toast('Select two or more albums to merge.', 'error');
  edit(() => {
    const [head, ...rest] = found;
    for (const r of rest) {
      head.set.fileIds.push(...r.set.fileIds);
      r.set.fileIds = [];
    }
  });
  state.selected.clear();
  toast(`Merged ${found.length} albums into “${found[0].set.name}”.`, 'ok');
}

function excludeFiles(entry, fileIds) {
  const drop = new Set(fileIds);
  edit(() => {
    for (const s of entry.sets) s.fileIds = s.fileIds.filter((id) => !drop.has(id));
    entry.excluded.push(...fileIds);
  });
}

// ---------------------------------------------------------------- the preview

let vlist;
const thumbs = new Map(); // file id -> url (small LRU)
let thumbQueue = new Set();
let thumbTimer = 0;

/** Albums Telegram will receive for a set, with their captions (same rules as the upload). */
function setAlbums(entry, set) {
  const o = options();
  const kinds = set.fileIds.map((id) => (o.forceDocument ? 'document' : state.model.files[id].kind));
  const chunks = C.albumChunks(kinds, o.useAlbums);
  const ctx = entry.context || {};
  return chunks.map((idx, i) => ({
    count: idx.length,
    caption: C.captioned(o.captionWhere, i, chunks.length) ? C.formatCaption(o.captionFormat, o.captionTemplate, {
      album: set.name, kinds: idx.map((j) => kinds[j]), part: i + 1, totalParts: chunks.length, folder: entry.leaf, parent: ctx.parent || '', top: entry.top,
      path: entry.path, folderPath: ctx.parent && ctx.parent !== entry.leaf ? `${ctx.parent} / ${entry.leaf}` : entry.leaf,
    }) : '',
  }));
}

function visibleRows() {
  const m = state.model;
  if (!m) return [];
  const q = norm($('planSearch').value);
  const lowOnly = $('lowOnly').checked;
  const match = (e, s) => {
    if (lowOnly && !(s.auto && s.auto.level === 'low') && !s.conflict) return false;
    if (!q) return true;
    if (norm(s.name).includes(q) || norm(e.path).includes(q) || norm(e.topicName).includes(q)) return true;
    return s.fileIds.some((id) => norm(m.files[id].name).includes(q));
  };
  const perFolder = state.mode === 'per_folder';
  const singleTitle = state.mode === 'single' ? ($('topicSelect').selectedOptions[0]?.textContent || 'General') : (state.chat?.title || 'Group chat');
  const groups = new Map();
  for (const e of m.entries) {
    const sets = e.sets.filter((s) => match(e, s));
    if (!sets.length && (q || lowOnly || !e.excluded.length)) continue; // an emptied folder stays only to restore files
    const key = perFolder ? (e.topicId ? `#${e.topicId}` : norm(e.topicName)) : '__single';
    if (!groups.has(key)) groups.set(key, { name: perFolder ? e.topicName : singleTitle, entries: [] });
    groups.get(key).entries.push({ entry: e, sets });
  }
  const rows = [];
  for (const [key, g] of groups) {
    rows.push({ type: 'topic', key: `t:${key}`, name: g.name, entries: g.entries.map((x) => x.entry) });
    g.entries.forEach((x, i) => rows.push({ type: 'entry', key: `e:${x.entry.id}`, entry: x.entry, sets: x.sets, last: i === g.entries.length - 1 }));
  }
  return rows;
}

function renderPlan({ keepScroll = true } = {}) {
  captionHint();
  renderSuggestBar();
  const m = state.model;
  const has = !!(m && m.entries.length);
  $('emptyState').hidden = has;
  $('stats').hidden = !has;
  $('planTools').hidden = !has;
  $('undoBtn').disabled = !state.undo.length;
  $('redoBtn').disabled = !state.redo.length;
  renderSelBar();
  if (!has) {
    if (state.sources.length && m) {
      $('emptyState').querySelector('h3').textContent = 'No media files found';
      $('emptyState').querySelector('p').textContent = 'Try turning on “Include subfolders” or “Include non-media files”, or check the filters.';
    }
    vlist.setItems([]);
    return;
  }
  const rows = visibleRows();
  vlist.setItems(rows, { keepScroll });
  const perFolder = state.mode === 'per_folder';
  const topics = new Set(m.entries.map((e) => (e.topicId ? `#${e.topicId}` : norm(e.topicName))));
  let albums = 0, files = 0, size = 0, low = 0;
  for (const e of m.entries) for (const s of e.sets) {
    albums += setAlbums(e, s).length;
    files += s.fileIds.length;
    for (const id of s.fileIds) size += m.files[id].size;
    if ((s.auto && s.auto.level === 'low') || s.conflict) low++;
  }
  $('stTopics').textContent = perFolder ? topics.size : m.entries.length;
  $('stTopicsLabel').textContent = perFolder ? 'topics' : 'folders';
  $('stAlbums').textContent = albums;
  $('stFiles').textContent = files;
  $('stSize').textContent = humanSize(size);
  $('lowCount').textContent = low || '';
}

function renderRow(r) {
  if (r.type === 'topic') {
    const st = state.mode === 'per_folder' ? topicStatus(r.name, r.entries[0].topicId) : null;
    const editable = state.mode === 'per_folder';
    return `<div class="topic-head card-top" data-topic="${esc(r.key)}">
      <div class="topic-icon" style="background:${colorFor(r.name)}">${esc(initials(r.name))}</div>
      <div class="grow"><div class="topic-title">${esc(r.name)}${editable ? ' <button class="link-btn" data-act="topic-rename" title="Rename this topic">✎</button>' : ''}</div>
      <div class="muted small">${plural(r.entries.reduce((a, e) => a + e.sets.reduce((b, s) => b + s.fileIds.length, 0), 0), 'file')}${st && st.note ? ` · ${esc(st.note)}` : ''}${r.entries[0].topicSource === 'random' ? ' · random folder name' : ''}</div></div>
      ${editable && state.topics.length ? `<select class="topic-map" data-act="topic-map" title="Send to an existing topic"><option value="">Map to existing topic…</option>${state.topics.map((t) => `<option value="${t.id}"${r.entries[0].topicId === t.id ? ' selected' : ''}>${esc(t.title)}${t.closed ? ' (closed)' : ''}</option>`).join('')}</select>` : ''}
      ${st ? `<span class="tag ${st.cls}">${st.tag}</span>` : ''}
    </div>`;
  }
  const e = r.entry;
  const header = state.mode !== 'per_folder' && $('headerMessage').checked ? ` <span class="tag">“📁 ${esc(e.header)}” first</span>` : '';
  const showThumbs = $('showThumbs').checked;
  return `<div class="topic-body card-mid${r.last ? ' card-end' : ''}" data-entry="${esc(e.id)}">
    <div class="subfolder-name">📁 ${esc(e.path)}${header}${e.topicByRule && state.mode === 'per_folder' ? ` <span class="tag" title="Organization rule">topic by “${esc(e.topicByRule)}”</span>` : ''}${(e.skippedByRule || []).length ? ` <span class="tag" title="${esc(e.skippedByRule.map((x) => `${x.name}: ${x.rule}`).join('\n'))}">${plural(e.skippedByRule.reduce((a, x) => a + x.count, 0), 'file')} left out by a rule</span>` : ''}${e.excluded.length ? ` <button class="link-btn" data-act="restore" title="Put left-out files back">${plural(e.excluded.length, 'file')} left out · restore</button>` : ''}</div>
    <div class="albums" data-drop="${esc(e.id)}">${r.sets.map((s) => setCard(e, s, showThumbs)).join('')}</div>
  </div>`;
}

function setCard(e, s, showThumbs) {
  const m = state.model;
  const kinds = [...new Set(s.fileIds.map((id) => m.files[id].kind))];
  const size = s.fileIds.reduce((a, id) => a + m.files[id].size, 0);
  const albums = setAlbums(e, s);
  const caps = albums.filter((a) => a.caption);
  const level = (s.auto && s.auto.level) || 'medium';
  const why = s.auto ? [s.auto.source && `from ${s.auto.source.replace('+', ' + ')}`, ...(s.auto.reasons || [])].filter(Boolean).join('; ') : '';
  const orig = s.auto && s.auto.original && norm(s.auto.original) !== norm(s.name) ? s.auto.original : '';
  const cover = state.covers && state.covers.get(s.id);
  const coverFirst = cover && cover.fileId != null && cover.better && s.fileIds[0] !== cover.fileId;
  // With a cover suggested, the thumbnails show it first so the card looks like the album would.
  const photoIds = [...(coverFirst ? [cover.fileId] : []), ...s.fileIds.filter((id) => m.files[id].kind === 'photo' && !(coverFirst && id === cover.fileId))].slice(0, 4);
  const grid = showThumbs && photoIds.length
    ? photoIds.map((id) => `<img data-thumb="${id}" ${thumbs.has(id) ? `src="${esc(thumbs.get(id))}"` : ''} alt="">`).join('')
    : `<div class="ph">${kinds.map((k) => KIND_ICON[k] || '📄').join(' ')}</div>`;
  return `<div class="album set${showThumbs ? '' : ' compact'}${state.selected.has(s.id) ? ' selected' : ''}" draggable="true" data-set="${esc(s.id)}" data-entry="${esc(e.id)}">
    <div class="set-top">
      <input type="checkbox" class="sel" data-act="select" ${state.selected.has(s.id) ? 'checked' : ''} title="Select">
      <span class="conf conf-${level}" title="${esc(`${level} confidence${why ? `: ${why}` : ''}`)}">${level === 'high' ? 'High' : level === 'medium' ? 'Medium' : 'Check'}</span>
      ${s.conflict ? '<span class="conf conf-low" title="Another folder in this topic has an album with the same name">Same name</span>' : ''}
    </div>
    <div class="album-grid" data-act="open">${grid}${coverFirst ? '<span class="cover-badge" title="Suggested cover. Open the album to use it.">★ cover suggested</span>' : ''}</div>
    <div class="set-name" data-act="rename" title="Click to rename">${esc(s.name)}</div>
    ${orig ? `<div class="set-orig" title="${esc(orig)}">was “${esc(orig)}”</div>` : ''}
    <div class="album-meta"><span>${plural(s.fileIds.length, 'file')} · ${humanSize(size)}</span><span>${plural(albums.length, 'album')}</span></div>
    ${caps.length ? `<div class="album-caption" title="${esc(caps.map((a) => a.caption).join('\n'))}">${esc(caps[caps.length - 1].caption)}</div>` : '<div class="album-caption none">no caption</div>'}
  </div>`;
}

function afterRow(el) {
  if (!$('showThumbs').checked) return;
  el.querySelectorAll('img[data-thumb]:not([src])').forEach((img) => thumbQueue.add(Number(img.dataset.thumb)));
  if (thumbQueue.size && !thumbTimer) thumbTimer = setTimeout(loadThumbs, 60);
}

async function loadThumbs() {
  thumbTimer = 0;
  const ids = [...thumbQueue].slice(0, 48);
  ids.forEach((id) => thumbQueue.delete(id));
  const got = await fg.thumbs(ids).catch(() => ({}));
  for (const [id, url] of Object.entries(got)) {
    thumbs.set(Number(id), url);
    document.querySelectorAll(`img[data-thumb="${id}"]`).forEach((img) => { img.src = url; });
  }
  while (thumbs.size > 900) thumbs.delete(thumbs.keys().next().value); // keep memory bounded
  if (thumbQueue.size) thumbTimer = setTimeout(loadThumbs, 30);
}

function captionHint() {
  const v = $('captionBy').value;
  const where = { every: 'every album', first: 'the first album', last: 'the last album' }[state.captionWhere] + ' of each set';
  const hints = {
    smart: `Names come from what your files and folders agree on: <b>Rem Collection/Set 01/IMG_001.jpg</b> → <b>Rem Collection - Set 01</b>; <b>X8dk92ks/Marin Kitagawa 01.jpg</b> → <b>Marin Kitagawa</b>. Episodes stay separate. Each name shows how sure FolderGram is; click to fix it.`,
    folder: `The folder’s name is shown under ${where}.`,
    parent: `The parent and folder name, like <b>Rem Collection - Set 01</b>, under ${where}.`,
    filename: `Files with the same name share an album, with that name under ${where}. Photo sets ignore numbers (<b>Rem 01.jpg</b>, <b>Rem 02.jpg</b> → <b>Rem</b>). For videos: ${{
      exact: 'only exactly the same name counts (<b>Marin.mp4</b> and <b>Marin 2.mp4</b> are separate).',
      series: 'a number in brackets is ignored (<b>Marin (1).mp4</b>, <b>Marin (2).mp4</b> together), but <b>Marin 2</b> or <b>Marin-copy</b> get their own album.',
      loose: 'any trailing number or “copy” is ignored (<b>Marin 2</b>, <b>Marin-copy</b> join <b>Marin</b>).',
    }[state.nameMatch]}`,
    template: 'Use <b>{album}</b> (smart name), <b>{folder}</b>, <b>{parent}</b>, <b>{top}</b>, <b>{count}</b>. Empty parts disappear with their separator.',
    none: 'Albums are sent without a caption.',
  };
  $('captionHint').innerHTML = hints[v] || '';
  $('captionWhereWrap').hidden = v === 'none';
  $('nameMatchWrap').hidden = v !== 'filename';
  $('nameTemplateWrap').hidden = v !== 'template';
  $('groupSeriesWrap').hidden = !['smart', 'template'].includes(v);
  $('captionTemplateWrap').hidden = $('captionFormat').value !== 'custom';
  $('topicTemplateWrap').hidden = state.topicBy !== 'template';
  $('customFilesWrap').hidden = state.speed !== 'custom';
}

// Clicks inside the preview.
$('plan').addEventListener('click', async (ev) => {
  const t = ev.target;
  const act = t.closest('[data-act]')?.dataset.act;
  const card = t.closest('.set');
  if (act === 'select' && card) {
    if (t.checked) state.selected.add(card.dataset.set); else state.selected.delete(card.dataset.set);
    card.classList.toggle('selected', t.checked);
    renderSelBar();
    return;
  }
  if (act === 'rename' && card) return inlineRename(t.closest('.set-name'), card.dataset.set);
  if (act === 'open' && card) return openDrawer(card.dataset.set);
  if (act === 'restore') {
    const e = state.model.entries.find((x) => x.id === t.closest('[data-entry]').dataset.entry);
    if (e) edit(() => { e.sets.push({ id: newSetId(), name: `${e.leaf} (restored)`, auto: { level: 'medium', source: 'manual' }, fileIds: e.excluded.splice(0) }); });
    return;
  }
  if (act === 'topic-rename') {
    const row = vlist.items.find((r) => r.key === t.closest('[data-topic]').dataset.topic);
    const name = await prompt({ title: 'Rename topic', text: 'Files keep going into one topic with this name. FolderGram remembers the change.', value: row.name, okLabel: 'Rename' });
    if (name) renameTopic(row.name, name, row.entries);
  }
});
$('plan').addEventListener('change', (ev) => {
  if (ev.target.dataset.act !== 'topic-map') return;
  const row = vlist.items.find((r) => r.key === ev.target.closest('[data-topic]').dataset.topic);
  const id = Number(ev.target.value) || null;
  const t = state.topics.find((x) => x.id === id);
  edit(() => { for (const e of row.entries) { e.topicId = id; if (t) e.topicName = t.title; else e.topicName = e.topicAuto; } }, { structural: false });
});

function inlineRename(el, sid) {
  const f = findSet(sid);
  if (!f) return;
  const input = document.createElement('input');
  input.className = 'inline-edit';
  input.value = f.set.name;
  input.maxLength = 1024;
  el.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    if (save) renameSet(sid, input.value); else vlist.refresh();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); e.stopPropagation(); });
  input.addEventListener('blur', () => finish(true));
}

// Drag albums to reorder them or move them to another folder.
let dragId = null;
$('plan').addEventListener('dragstart', (e) => {
  const card = e.target.closest('.set');
  if (!card) return;
  dragId = card.dataset.set;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('application/x-fg-set', dragId);
  card.classList.add('dragging');
});
$('plan').addEventListener('dragend', () => { dragId = null; document.querySelectorAll('.dragging, .drop-before').forEach((n) => n.classList.remove('dragging', 'drop-before')); });
$('plan').addEventListener('dragover', (e) => {
  if (!dragId) return;
  const zone = e.target.closest('[data-drop]');
  if (!zone) return;
  e.preventDefault();
  e.stopPropagation();
  document.querySelectorAll('.drop-before').forEach((n) => n.classList.remove('drop-before'));
  const card = e.target.closest('.set');
  if (card && card.dataset.set !== dragId) card.classList.add('drop-before');
});
$('plan').addEventListener('drop', (e) => {
  if (!dragId) return;
  const zone = e.target.closest('[data-drop]');
  if (!zone) return;
  e.preventDefault();
  e.stopPropagation();
  const card = e.target.closest('.set');
  moveSet(dragId, zone.dataset.drop, card ? card.dataset.set : null);
  dragId = null;
});

// ---------------------------------------------------------------- selection toolbar

function renderSelBar() {
  if (state.model) for (const id of [...state.selected]) if (!findSet(id)) state.selected.delete(id);
  $('selBar').hidden = !state.selected.size;
  $('selCount').textContent = `${plural(state.selected.size, 'album')} selected`;
}
$('selClear').onclick = () => { state.selected.clear(); renderPlan(); };
$('selMerge').onclick = () => mergeSets([...state.selected]);
$('selExclude').onclick = () => {
  const found = [...state.selected].map(findSet).filter(Boolean);
  edit(() => { for (const f of found) { f.entry.excluded.push(...f.set.fileIds); f.set.fileIds = []; } });
  state.selected.clear();
};
$('selReset').onclick = () => {
  const found = [...state.selected].map(findSet).filter(Boolean);
  edit(() => { for (const f of found) f.set.name = detectedName(f.set); }, { structural: false });
};
$('selRename').onclick = async () => {
  const found = [...state.selected].map(findSet).filter(Boolean);
  const tpl = await prompt({ title: `Rename ${plural(found.length, 'album')}`, okLabel: 'Rename',
    text: 'Use a template with {name}, {n} (1, 2, 3…), {folder}, {count}, or find => replace (for example “ (GoFile) => ”).', value: '{name}' });
  if (!tpl) return;
  edit(() => {
    found.forEach((f, i) => {
      let name;
      if (tpl.includes('=>')) {
        const [find, rep = ''] = tpl.split('=>');
        name = f.set.name.split(find.trim()).join(rep.trim());
      } else {
        name = C.applyTemplate(tpl, { name: f.set.name, n: i + 1, folder: f.entry.leaf, count: f.set.fileIds.length });
      }
      if (name.trim()) {
        f.set.name = name.trim();
      }
    });
  }, { structural: false });
};
$('undoBtn').onclick = undo;
$('redoBtn').onclick = redo;
document.addEventListener('keydown', (e) => {
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName) || !$('modal').hidden) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
  if (e.key === 'Escape') closeDrawer();
});

// ---------------------------------------------------------------- album drawer: files of one album

function openDrawer(sid) {
  state.drawer = { sid, picked: new Set() };
  $('drawer').hidden = false;
  renderDrawer();
}
function closeDrawer() {
  state.drawer = null;
  $('drawer').hidden = true;
}

function renderDrawer() {
  const d = state.drawer;
  const f = d && findSet(d.sid);
  if (!f) return closeDrawer();
  const m = state.model;
  const { entry, set } = f;
  const cover = state.covers && state.covers.get(set.id);
  $('drawerName').value = set.name;
  const a = set.auto || {};
  const albums = setAlbums(entry, set);
  $('drawerInfo').innerHTML = `
    <div><span class="conf conf-${a.level || 'medium'}">${esc(a.level || 'medium')} confidence</span> ${a.source ? `<span class="muted small">from ${esc(a.source.replace('+', ' + '))}</span>` : ''}</div>
    ${a.reasons && a.reasons.length ? `<div class="muted small">${esc(a.reasons.join('; '))}</div>` : ''}
    ${a.original ? `<div class="muted small">Detected from: “${esc(a.original)}”${a.name && a.name !== set.name ? ` · suggested “${esc(a.name)}”` : ''}</div>` : ''}
    <div class="muted small">📁 ${esc(entry.path)} → ${esc(state.mode === 'per_folder' ? entry.topicName : 'chat')}</div>
    ${cover && cover.better && cover.fileId !== set.fileIds[0] ? `<div class="muted small">★ Suggested cover: “${esc(m.files[cover.fileId].name)}” (${esc(cover.reasons.join(', ') || 'best overall')}). <button class="link-btn" id="drawerUseCover">Put it first</button></div>` : ''}
    ${cover && cover.unreadable && cover.unreadable.length ? `<div class="muted small">⚠ ${plural(cover.unreadable.length, 'photo')} could not be read and may be damaged: ${esc(cover.unreadable.slice(0, 3).map((id) => m.files[id].name).join(', '))}</div>` : ''}
    <div class="cap-list">${albums.map((x, i) => `<div><span class="muted">Album ${i + 1} · ${x.count} files</span> ${x.caption ? `<span class="album-caption inline">${esc(x.caption)}</span>` : '<span class="muted small">no caption</span>'}</div>`).join('')}</div>`;
  const shown = set.fileIds.slice(0, 1500);
  $('drawerFiles').innerHTML = shown.map((id, i) => {
    const file = m.files[id];
    const sug = cover && cover.fileId === id && cover.better ? ` <span class="cover-mark" title="${esc(cover.reasons.join(', '))}">★ suggested cover</span>` : '';
    return `<label class="file-row"><input type="checkbox" data-id="${id}" ${d.picked.has(id) ? 'checked' : ''}><span class="idx">${i + 1}</span>${sug}
      <span class="fname" title="${esc(file.name)}">${KIND_ICON[file.kind] || '📄'} ${esc(file.name)}</span><span class="muted small">${humanSize(file.size)}</span></label>`;
  }).join('') + (set.fileIds.length > shown.length ? `<p class="muted small">…and ${set.fileIds.length - shown.length} more files</p>` : '');
  const others = entry.sets.filter((s) => s.id !== set.id);
  $('drawerMove').innerHTML = `<option value="">Move selected to…</option><option value="__new">A new album</option>${
    others.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}`;
  $('drawerExcluded').innerHTML = entry.excluded.length ? `${plural(entry.excluded.length, 'file')} left out of this folder. <button class="link-btn" id="drawerRestore">Put them back here</button>` : '';
  $('drawerAll').checked = d.picked.size && d.picked.size === set.fileIds.length;
}

$('drawerClose').onclick = closeDrawer;
$('drawerFiles').addEventListener('change', (e) => {
  const id = Number(e.target.dataset.id);
  if (e.target.checked) state.drawer.picked.add(id); else state.drawer.picked.delete(id);
});
$('drawerAll').addEventListener('change', (e) => {
  const f = findSet(state.drawer.sid);
  state.drawer.picked = e.target.checked ? new Set(f.set.fileIds) : new Set();
  renderDrawer();
});
$('drawerName').addEventListener('change', () => state.drawer && renameSet(state.drawer.sid, $('drawerName').value));
$('drawerName').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
$('drawerExclude').onclick = () => {
  const f = findSet(state.drawer.sid);
  if (!state.drawer.picked.size) return toast('Tick the files to leave out.', 'error');
  excludeFiles(f.entry, [...state.drawer.picked]);
  state.drawer.picked.clear();
};
$('drawerMove').onchange = () => {
  const to = $('drawerMove').value;
  $('drawerMove').value = '';
  const d = state.drawer;
  const f = findSet(d.sid);
  if (!to || !d.picked.size) return d.picked.size || toast('Tick the files to move.', 'error');
  const ids = [...d.picked];
  edit(() => {
    f.set.fileIds = f.set.fileIds.filter((id) => !d.picked.has(id));
    if (to === '__new') f.entry.sets.splice(f.index + 1, 0, { id: newSetId(), name: `${f.set.name} (2)`, auto: { level: 'medium', source: 'manual', name: '' }, fileIds: ids });
    else findSet(to).set.fileIds.push(...ids);
  });
  d.picked.clear();
};
$('drawerSplit').onclick = () => {
  const d = state.drawer;
  const f = findSet(d.sid);
  if (!d.picked.size) return toast('Tick the files that should become a new album.', 'error');
  const ids = f.set.fileIds.filter((id) => d.picked.has(id));
  edit(() => {
    f.set.fileIds = f.set.fileIds.filter((id) => !d.picked.has(id));
    f.entry.sets.splice(f.index + 1, 0, { id: newSetId(), name: `${f.set.name} (2)`, auto: { level: 'medium', source: 'manual', name: '' }, fileIds: ids });
  });
  d.picked.clear();
};
/** Moves one file to the front of its album: Telegram shows the first item as the album's cover. */
function makeCover(sid, fileId) {
  const f = findSet(sid);
  if (!f || f.set.fileIds[0] === fileId || !f.set.fileIds.includes(fileId)) return;
  edit(() => { f.set.fileIds = [fileId, ...f.set.fileIds.filter((id) => id !== fileId)]; });
}
$('drawerCover').onclick = () => {
  const d = state.drawer;
  if (d.picked.size !== 1) return toast('Tick one photo to use as the cover.', 'error');
  makeCover(d.sid, [...d.picked][0]);
  d.picked.clear();
};
$('drawerInfo').addEventListener('click', (e) => {
  if (e.target.id !== 'drawerUseCover') return;
  const c = state.covers.get(state.drawer.sid);
  if (c) makeCover(state.drawer.sid, c.fileId);
});
$('drawerExcluded').addEventListener('click', (e) => {
  if (e.target.id !== 'drawerRestore') return;
  const f = findSet(state.drawer.sid);
  edit(() => { f.set.fileIds.push(...f.entry.excluded.splice(0)); });
});

// ---------------------------------------------------------------- naming suggestions

/** Suggestions that still apply to the plan as it is now (renames since the scan make some moot). */
function liveSuggestions() {
  const m = state.model;
  if (!m || !state.suggestions || !state.suggestions.length) return [];
  const sets = new Map();
  for (const e of m.entries) for (const s of e.sets) sets.set(s.id, s);
  const entries = new Map(m.entries.map((e) => [e.id, e]));
  const out = [];
  for (const g of state.suggestions) {
    const from = g.from.map((f) => ({ ...f, refs: f.refs.filter((r) => (g.kind === 'album' ? sets.get(r) && sets.get(r).name === f.name : entries.get(r) && entries.get(r).topicName === f.name)) }))
      .filter((f) => f.refs.length);
    if (from.length) out.push({ ...g, from });
  }
  return out;
}

function renderSuggestBar() {
  const live = liveSuggestions();
  $('suggestBar').hidden = !live.length;
  if (!live.length) return;
  const topics = live.filter((g) => g.kind === 'topic').length;
  $('suggestBar').innerHTML = `<span>💡 ${plural(live.length, 'naming suggestion')}: ${topics ? `${plural(topics, 'topic')} and ` : ''}names that look like the same title spelled differently.</span>
    <span class="grow"></span><button class="btn ghost tool" id="suggestReview">Review…</button>`;
}

$('suggestBar').addEventListener('click', async (e) => {
  if (e.target.id !== 'suggestReview') return;
  const live = liveSuggestions();
  const body = `<div class="sugg-list">${live.map((g, i) => `<label class="sugg-row"><input type="checkbox" data-i="${i}" checked>
    <span><b>${g.kind === 'topic' ? 'Topic' : 'Album'} “${esc(g.to)}”</b> <span class="muted small">· ${esc(g.reason)}</span>
    <div class="from">instead of ${g.from.map((f) => `“${esc(f.name)}” (${plural(f.refs.length, g.kind === 'topic' ? 'folder' : 'album')})`).join(', ')}</div></span></label>`).join('')}</div>`;
  const ok = await prompt({ title: 'Unify names', text: 'Nothing changes until you apply. You can undo it afterwards.', noInput: true, body, okLabel: 'Apply selected' });
  if (!ok) return;
  const picked = [...document.querySelectorAll('.sugg-list input:checked')].map((cb) => live[Number(cb.dataset.i)]);
  if (!picked.length) return;
  const sets = new Map();
  for (const en of state.model.entries) for (const st of en.sets) sets.set(st.id, st);
  edit(() => {
    for (const g of picked) {
      for (const f of g.from) {
        for (const r of f.refs) {
          if (g.kind === 'album') { const st = sets.get(r); if (st) st.name = g.to; } else {
            const en = state.model.entries.find((x) => x.id === r);
            if (en) { en.topicName = g.to; en.topicId = null; }
          }
        }
      }
    }
  }, { structural: false, learn: true });
  toast(`${plural(picked.length, 'name')} unified.`, 'ok');
});

// ---------------------------------------------------------------- similar photos and covers

const planFileIds = () => state.model.entries.flatMap((e) => e.sets.flatMap((s) => s.fileIds));
const fileHome = (id) => {
  for (const e of state.model.entries) for (const s of e.sets) if (s.fileIds.includes(id)) return { entry: e, set: s };
  return null;
};
const qualityText = (q) => [q.width && q.height ? `${q.width}×${q.height}` : '', q.size ? humanSize(q.size) : '', q.format || '',
  q.duration ? `${Math.round(q.duration)} s` : ''].filter(Boolean).join(' · ');

$('similarBtn').onclick = () => busy($('similarBtn'), () => guarded(async () => {
  if (!state.model) return;
  const r = await fg.findSimilar(planFileIds(), {});
  $('progressLabel').textContent = 'Ready';
  if (!r) return;
  if (!r.groups.length) return toast(`No similar photos or videos among ${plural(r.checked, 'file')}.${r.unreadable ? ` ${plural(r.unreadable, 'file')} could not be read.` : ''}`, 'ok');
  const m = state.model;
  const ids = r.groups.flatMap((g) => g.members.map((x) => x.id)).slice(0, 400);
  const got = await fg.thumbs(ids).catch(() => ({}));
  const body = `<p class="muted small">The best copy (most pixels, then least compressed) is outlined. Ticked files are left out of this upload; nothing is deleted from your PC.</p>
    <div class="row"><button type="button" class="btn ghost small" id="simBest">Keep only the best of each</button><button type="button" class="btn ghost small" id="simAll">Keep all</button></div>
    <div class="sugg-list">${r.groups.map((g, gi) => `<div class="sim-group"><div class="muted small">${g.near ? 'Practically identical' : 'Similar'} · ${g.members.length} files</div><div class="sim-items">${
      g.members.map((x) => { const f = m.files[x.id]; const home = fileHome(x.id); return `<label class="sim-item${x.id === g.best ? ' best' : ''}">
        ${got[x.id] ? `<img src="${esc(got[x.id])}" alt="">` : `<div class="ph">${KIND_ICON[x.kind] || '📄'}</div>`}
        <span><input type="checkbox" data-g="${gi}" data-id="${x.id}"> ${esc(f.name)}</span>
        <span class="muted">${esc(qualityText(x.quality))}${x.id === g.best ? ' · best' : ` · ${x.distance} bits apart`}</span>
        <span class="muted">${esc(home ? home.set.name : '')}</span></label>`; }).join('')}</div></div>`).join('')}</div>`;
  const shown = prompt({ title: `${plural(r.groups.length, 'group')} of similar files`, text: `Checked ${plural(r.checked, 'file')}.${r.unreadable ? ` ${plural(r.unreadable, 'file')} could not be read.` : ''}`,
    noInput: true, body, okLabel: 'Leave out ticked' });
  setTimeout(() => {
    const boxes = () => [...document.querySelectorAll('.sim-items input[type=checkbox]')];
    const best = new Set(r.groups.map((g) => g.best));
    if ($('simBest')) $('simBest').onclick = () => boxes().forEach((cb) => { cb.checked = !best.has(Number(cb.dataset.id)); });
    if ($('simAll')) $('simAll').onclick = () => boxes().forEach((cb) => { cb.checked = false; });
  }, 0);
  if (!(await shown)) return;
  const drop = [...document.querySelectorAll('.sim-items input:checked')].map((cb) => Number(cb.dataset.id));
  if (!drop.length) return;
  const byEntry = new Map();
  for (const id of drop) { const h = fileHome(id); if (h) { if (!byEntry.has(h.entry)) byEntry.set(h.entry, []); byEntry.get(h.entry).push(id); } }
  edit(() => {
    for (const [entry, ids2] of byEntry) {
      const set = new Set(ids2);
      for (const st of entry.sets) st.fileIds = st.fileIds.filter((id) => !set.has(id));
      entry.excluded.push(...ids2);
    }
  });
  toast(`${plural(drop.length, 'file')} left out. Use “restore” on a folder to put them back.`, 'ok');
}));

$('coversBtn').onclick = () => busy($('coversBtn'), () => guarded(async () => {
  if (!state.model) return;
  const sets = state.model.entries.flatMap((e) => e.sets).filter((s) => s.fileIds.filter((id) => state.model.files[id].kind === 'photo').length > 1)
    .map((s) => ({ id: s.id, fileIds: s.fileIds }));
  if (!sets.length) return toast('No albums with two or more photos.', 'error');
  const r = await fg.suggestCovers(sets);
  $('progressLabel').textContent = 'Ready';
  if (!r) return;
  state.covers = new Map(r.map((c) => [c.albumId, c]));
  const better = r.filter((c) => c.better && c.fileId != null);
  const broken = r.reduce((a, c) => a + (c.unreadable ? c.unreadable.length : 0), 0);
  renderPlan();
  if (!better.length) return toast(`The first photos already make good covers.${broken ? ` ${plural(broken, 'photo')} could not be read.` : ''}`, 'ok');
  const ok = await prompt({ title: `Better covers for ${plural(better.length, 'album')}`,
    text: `Albums with a better first photo are marked “★ cover suggested”. Put the suggested photo first in all of them now? You can also do it one album at a time, or undo.${broken ? ` ${plural(broken, 'photo')} could not be read and may be damaged.` : ''}`,
    noInput: true, okLabel: 'Use all suggestions' });
  if (!ok) return;
  edit(() => {
    for (const c of better) {
      const f = findSet(c.albumId);
      if (f && f.set.fileIds.includes(c.fileId)) f.set.fileIds = [c.fileId, ...f.set.fileIds.filter((id) => id !== c.fileId)];
    }
  });
  toast(`Covers set for ${plural(better.length, 'album')}.`, 'ok');
}));

// ---------------------------------------------------------------- plan files and duplicates

const edits = () => ({ entries: state.model.entries.map((e) => ({ id: e.id, topicName: e.topicName, topicId: e.topicId || null,
  sets: e.sets.map((s) => ({ id: s.id, name: s.name, fileIds: s.fileIds, auto: s.auto })) })) });

$('savePlanBtn').onclick = () => guarded(async () => {
  const file = await fg.savePlan(edits(), options(), state.sources);
  if (file) toast(`Plan saved: ${file}`, 'ok');
});
$('loadPlanBtn').onclick = () => guarded(async () => {
  const p = await fg.loadPlan();
  if (!p) return;
  state.sources = p.sources || [];
  renderSources();
  setModel(p);
  toast(p.missing ? `Plan opened. ${plural(p.missing, 'file')} no longer exist and were left out.` : 'Plan opened.', p.missing ? 'error' : 'ok');
  updateStart();
});

let forceUpload = new Set();
$('dupBtn').onclick = () => busy($('dupBtn'), () => guarded(async () => {
  if (!state.chat) return toast('Choose the group first: duplicates are checked per group.', 'error');
  const r = await fg.checkDuplicates({ chat: state.chat, mode: state.mode, topicId: state.mode === 'single' ? Number($('topicSelect').value) || 1 : null,
    options: options(), edits: edits() });
  $('progressLabel').textContent = 'Ready';
  if (!r.duplicates.length) return toast(`No duplicates found.${r.skipped ? ` ${plural(r.skipped, 'file')} already uploaded will be skipped.` : ''}`, 'ok');
  const body = `<div class="dup-list">${r.duplicates.map((d, i) => `<label class="file-row"><input type="checkbox" data-i="${i}" ${forceUpload.has(d.path) ? 'checked' : ''}>
    <span class="fname" title="${esc(d.path)}">${esc(d.name)}</span><span class="muted small">${d.certain ? 'same as' : 'probably same as'} ${esc(d.of || 'an earlier upload')}</span></label>`).join('')}</div>`;
  const ok = await prompt({ title: `${plural(r.duplicates.length, 'duplicate')} will be skipped`, text: 'Tick the files you want to upload anyway.', noInput: true, body, okLabel: 'Done' });
  if (!ok) return;
  forceUpload = new Set();
  document.querySelectorAll('.dup-list input:checked').forEach((cb) => forceUpload.add(r.duplicates[Number(cb.dataset.i)].path));
  if (forceUpload.size) toast(`${plural(forceUpload.size, 'file')} will be uploaded anyway.`);
}));

// ---------------------------------------------------------------- upload and queue

function updateStart() {
  const ready = !!(state.me && state.chat && state.model && state.model.entries.some((e) => e.sets.length));
  $('startBtn').disabled = !ready;
  $('queueBtn').disabled = !ready;
  $('cancelBtn').hidden = !state.uploading;
  $('pauseBtn').hidden = !state.uploading;
  $('pauseBtn').textContent = state.paused ? 'Resume' : 'Pause';
  $('startBtn').textContent = state.uploading ? 'Add to queue' : 'Start upload';
}

async function enqueue({ scheduledAt = null, hold = false } = {}) {
  if (state.mode !== 'none' && !state.chat.isForum) return toast('This group has no topics. Choose “No topics”.', 'error');
  const topicId = state.mode === 'single' ? Number($('topicSelect').value) || 1 : null;
  await guarded(async () => {
    const r = await fg.queueAdd({ chat: state.chat, mode: state.mode, topicId, options: { ...options(), forceUpload: [...forceUpload] }, edits: edits(), scheduledAt, hold });
    if (r.overlap) toast(`${plural(r.overlap, 'file')} are also in another queued job. Each file is still sent only once.`);
    if (scheduledAt) toast(`Scheduled for ${new Date(scheduledAt).toLocaleString()}.`, 'ok');
    else if (state.uploading || hold) toast('Added to the queue.', 'ok');
    forceUpload = new Set();
  });
}

$('startBtn').onclick = () => enqueue();
$('queueBtn').onclick = async () => {
  const d = new Date(Date.now() + 3600e3);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const v = await prompt({ title: 'Add to queue', text: 'Start at a set time, or leave it empty to start when the queue gets to it.', type: 'datetime-local', value: local, okLabel: 'Add' });
  if (v === null) return;
  enqueue({ scheduledAt: v ? new Date(v).getTime() : null });
};

function formatEta(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '';
  if (sec < 60) return `${Math.ceil(sec)}s left`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s left`;
  return `${Math.floor(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m left`;
}

fg.on('progress', ({ jobId, done, total, label, file, stats, phase, checked, totalFiles, snapshot }) => {
  state.uploading = true;
  state.runningJob = jobId;
  if (phase === 'checking') {
    // Before sending: files are counted and checked, which is not upload progress.
    $('progressFill').style.width = `${totalFiles ? ((100 * checked) / totalFiles).toFixed(1) : 0}%`;
    $('progressPct').textContent = `${checked} / ${totalFiles} files checked`;
    $('progressLabel').textContent = label;
    updateStart();
    return;
  }
  // Speeds and time left come from the main process, measured on real transferred bytes (rolling window).
  const s = snapshot || null;
  const pct = s ? s.percent : total ? (100 * done) / total : 100;
  const eta = s && s.eta != null && done < total ? ` · ${formatEta(s.eta)}` : s && s.stalled ? ' · no progress right now' : '';
  $('progressFill').style.width = `${pct.toFixed(1)}%`;
  $('progressPct').textContent = `${pct.toFixed(1)}% · ${humanSize(done)} / ${humanSize(total)}${eta}`;
  if (state.waitUntil < Date.now()) $('progressLabel').textContent = file ? `Uploading ${file}` : label;
  if (stats) {
    $('liveStats').hidden = false;
    $('liveStats').innerHTML = [s && s.speed > 0 && `${humanSize(Math.round(s.speed))}/s now`, s && s.averageSpeed > 0 && `${humanSize(Math.round(s.averageSpeed))}/s average`,
      `${humanSize(Math.max(0, total - done))} left`, `✓ ${stats.sent}`, stats.failed && `✗ ${stats.failed}`, stats.skipped && `skipped ${stats.skipped}`,
      stats.duplicates && `duplicates ${stats.duplicates}`, stats.currentTopic && `topic “${esc(stats.currentTopic)}”`,
      stats.currentAlbum && `album “${esc(stats.currentAlbum)}”`].filter(Boolean).map((x) => `<span>${x}</span>`).join('');
  }
  if (s) { state.snapshot = s; scheduleLive(); }
  updateStart();
  updateJobProgress(jobId, done, total);
});

// ---------------------------------------------------------------- live uploads panel

const FILE_STATUS = { queued: ['Waiting', 'dim'], preparing: ['Preparing', 'warn'], uploading: ['Uploading', 'run'], uploaded: ['Uploaded', 'ok'],
  sending: ['Posting', 'run'], done: ['Delivered', 'ok'], failed: ['Failed', 'err'], review: ['Check', 'warn'] };
const ALBUM_STATUS = { waiting: ['Waiting', 'dim'], uploading: ['Uploading', 'run'], preparing: ['Preparing', 'warn'], sending: ['Posting', 'run'], done: ['Delivered', 'ok'],
  failed: ['Failed', 'err'], review: ['Check', 'warn'] };
const JOB_STATUS = { starting: 'Starting…', checking: 'Checking files…', uploading: 'Uploading', paused: 'Paused', waiting: 'Telegram asked to wait',
  offline: 'No connection to Telegram, waiting for it', retrying: 'Retrying shortly', done: 'Finished', cancelled: 'Cancelled' };
let liveTimer = 0;
let liveAt = 0;
/** Draws the live panel at most 4 times a second, and only while it is on screen. */
function scheduleLive() {
  if (liveTimer || $('panel-queue').hidden) return;
  liveTimer = setTimeout(() => { liveTimer = 0; liveAt = Date.now(); renderLive(); }, Math.max(0, 250 - (Date.now() - liveAt)));
}
const speedText = (b) => (b > 0 ? `${humanSize(Math.round(b))}/s` : '—');
const etaText = (sec) => (sec == null ? '—' : sec < 1 ? 'under 1 s' : formatEta(sec).replace(' left', ''));
const pillHtml = ([label, cls]) => `<span class="pill ${cls}">${label}</span>`;

function renderLive() {
  const s = state.snapshot;
  $('live').hidden = !s;
  if (!s) return;
  const running = state.queue.some((j) => j.running);
  const waitLeft = state.waitUntil > Date.now() ? Math.ceil((state.waitUntil - Date.now()) / 1000) : 0;
  const wait = running && s.status !== 'uploading' && waitLeft ? ` (${waitLeft} s)` : '';
  $('livePct').textContent = `${s.percent.toFixed(1)}%`;
  $('liveStatus').textContent = `${(running ? JOB_STATUS[s.status] : JOB_STATUS[s.status === 'done' ? 'done' : 'cancelled']) || s.status}${wait}${s.stalled ? ' · no progress for a while' : ''}`;
  $('liveFill').style.width = `${s.percent.toFixed(1)}%`;
  $('liveFill').classList.toggle('complete', s.status === 'done');
  const f = s.files;
  const cells = [
    ['Uploaded', `${humanSize(s.bytes.uploaded)} / ${humanSize(s.bytes.total)}`], ['Files delivered', `${f.done.toLocaleString()} / ${f.total.toLocaleString()}`],
    ['Remaining', `${f.remaining.toLocaleString()} files · ${humanSize(s.bytes.remaining)}`], ['Failed', f.failed.toLocaleString()],
    ['Skipped', f.skipped.toLocaleString()], f.review ? ['To check', f.review.toLocaleString()] : null,
    ['Speed now', speedText(s.speed)], ['Average speed', speedText(s.averageSpeed)], ['Time left', s.stalled ? 'waiting for progress' : etaText(s.eta)],
    ['Sent over the network', humanSize(s.bytes.network)],
  ].filter(Boolean);
  $('liveGrid').innerHTML = cells.map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join('');
  $('liveFiles').innerHTML = s.activeFiles.length ? s.activeFiles.map((x) => `<div class="lrow">
      <div class="lrow-top"><span class="lrow-name" title="${esc(x.path)}">${esc(x.name)}</span>${pillHtml(FILE_STATUS[x.status] || [x.status, ''])}</div>
      <div class="progress"><div class="progress-fill${x.percent >= 100 ? ' complete' : ''}" style="width:${x.percent.toFixed(1)}%"></div></div>
      <div class="lrow-sub"><span>${humanSize(x.uploaded)} / ${humanSize(x.size)} · ${Math.floor(x.percent)}%</span><span>${speedText(x.speed)}</span><span>${x.eta != null ? `${etaText(x.eta)} left` : ''}</span>
        <span>${esc(x.album)}${x.topic ? ` → ${esc(x.topic)}` : ''}</span></div></div>`).join('')
    : '<p class="muted small">Nothing is uploading right now.</p>';
  $('liveAlbums').innerHTML = s.albums.map((a) => `<div class="lrow${a.status === 'done' ? ' done' : ''}">
      <div class="lrow-top"><span class="lrow-name">${esc(a.title)}</span>${pillHtml(ALBUM_STATUS[a.status] || [a.status, ''])}</div>
      <div class="progress"><div class="progress-fill${a.status === 'done' ? ' complete' : ''}" style="width:${a.percent.toFixed(1)}%"></div></div>
      <div class="lrow-sub"><span>${a.count} media · ${humanSize(a.size)}</span><span>${a.uploaded}/${a.count} uploaded</span>${a.topic ? `<span>→ ${esc(a.topic)}</span>` : ''}
        ${a.current ? `<span>now: ${esc(a.current)}</span>` : ''}${a.error ? `<span class="err-text">${esc(a.error)}</span>` : ''}</div></div>`).join('');
}

let waitTimer = 0;
fg.on('wait', ({ seconds, reason }) => {
  clearInterval(waitTimer);
  if (!seconds) { state.waitUntil = 0; return; }
  state.waitUntil = Date.now() + seconds * 1000;
  const tick = () => {
    const left = Math.ceil((state.waitUntil - Date.now()) / 1000);
    if (left <= 0) { clearInterval(waitTimer); state.waitUntil = 0; return; }
    $('progressLabel').textContent = reason === 'flood' ? `Telegram asked to wait: ${left}s… (Cancel stops at once)`
      : reason === 'offline' ? `No connection to Telegram. Checking again in ${left}s…` : `Retrying in ${left}s…`;
    scheduleLive();
  };
  tick();
  waitTimer = setInterval(tick, 500);
});

fg.on('upload:done', ({ stats, cancelled, job }) => {
  state.uploading = !!state.queue.find((j) => j.running && j.id !== job.id);
  state.paused = false;
  $('liveStats').hidden = true;
  const summary = `${stats.sent || 0} sent · ${stats.skipped || 0} skipped · ${stats.failed || 0} failed`;
  if (job.status === 'interrupted') return;
  $('progressLabel').textContent = `${cancelled ? 'Cancelled' : job.status === 'done' ? 'Finished' : 'Stopped'} · ${job.name} · ${summary}`;
  if (job.status === 'done') $('progressFill').classList.add('complete');
  toast(cancelled ? 'Upload cancelled. Retry it from the queue to continue.' : job.error && job.status === 'failed' ? `${job.name}: ${job.error}` : `Upload finished: ${summary}`,
    job.status === 'done' ? 'ok' : cancelled ? 'info' : 'error');
  updateStart();
  if (state.mode === 'per_folder') loadTopics();
});

fg.on('log', ({ text, kind, at }) => {
  const line = document.createElement('div');
  line.className = kind ? `l-${kind}` : '';
  const t = new Date(at || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  line.innerHTML = `<time>${t}</time>${esc(text)}`;
  $('log').append(line);
  while ($('log').childElementCount > 1500) $('log').firstElementChild.remove(); // keep the activity panel light
  $('log').scrollTop = $('log').scrollHeight;
  // The Uploads tab has its own, shorter feed.
  const feed = $('liveFeed');
  feed.append(line.cloneNode(true));
  while (feed.childElementCount > 300) feed.firstElementChild.remove();
  if (!$('panel-queue').hidden) feed.scrollTop = feed.scrollHeight;
  if ($('logPanel').hidden) {
    state.logCount++;
    $('logBadge').hidden = false;
    $('logBadge').textContent = state.logCount;
  }
});

// ---------------------------------------------------------------- queue panel

const STATUS = {
  queued: ['Waiting', ''], running: ['Uploading', 'run'], paused: ['Paused', 'warn'], held: ['On hold', 'warn'], done: ['Done', 'ok'],
  failed: ['Some failed', 'err'], cancelled: ['Cancelled', 'warn'], interrupted: ['Interrupted', 'warn'], review: ['Check needed', 'warn'],
};
const ENDED = ['done', 'failed', 'cancelled', 'review'];
const jobProgress = new Map();

function renderQueue() {
  const list = state.queue.filter((j) => !['done'].includes(j.status) || j.running);
  const open = state.queue.filter((j) => !ENDED.includes(j.status)).length;
  $('queueBadge').hidden = !open;
  $('queueBadge').textContent = open;
  $('queueList').innerHTML = list.length ? list.map((j, i) => {
    const [label, cls] = STATUS[j.status] || [j.status, ''];
    const sched = j.status === 'queued' && j.scheduledAt && j.scheduledAt > Date.now() ? `Starts ${new Date(j.scheduledAt).toLocaleString()}` : '';
    const s = j.stats;
    const p = jobProgress.get(j.id);
    return `<div class="job" data-id="${esc(j.id)}">
      <div class="job-main">
        <div class="job-title">${esc(j.name)} <span class="pill ${cls}">${sched ? 'Scheduled' : label}</span></div>
        <div class="muted small">→ ${esc(j.chat.title)} · ${plural(j.totals.files, 'file')} · ${plural(j.totals.albums, 'album')} · ${humanSize(j.totals.bytes)}${sched ? ` · ${esc(sched)}` : ''}</div>
        ${s ? `<div class="muted small">✓ ${s.sent || 0} sent · ${s.skipped || 0} skipped · ${s.failed || 0} failed${s.duplicates ? ` · ${s.duplicates} duplicates` : ''}</div>` : ''}
        ${j.error ? `<div class="small err-text">${esc(j.error)}</div>` : ''}
        ${j.running ? `<div class="progress thin"><div class="progress-fill" style="width:${p ? (100 * p).toFixed(1) : 0}%"></div></div>` : ''}
      </div>
      <div class="job-actions">
        <button class="icon-btn sm" data-q="up" ${i === 0 ? 'disabled' : ''} title="Move up">▲</button>
        <button class="icon-btn sm" data-q="down" ${i === list.length - 1 ? 'disabled' : ''} title="Move down">▼</button>
        ${j.running || j.status === 'queued' ? `<button class="btn ghost tool" data-q="pause">${j.status === 'paused' ? 'Resume' : 'Pause'}</button>` : ''}
        ${['held', 'paused', 'interrupted'].includes(j.status) ? '<button class="btn primary tool" data-q="resume">Resume</button>' : ''}
        ${['failed', 'cancelled'].includes(j.status) ? '<button class="btn primary tool" data-q="retry">Retry</button>' : ''}
        ${j.status === 'review' ? `<button class="btn ghost tool" data-q="check" title="Look in Telegram again for the albums that may have arrived">Check again</button>
          <button class="btn primary tool" data-q="resend" title="Send the albums that couldn't be checked again">Send again</button>
          <button class="btn ghost tool" data-q="mark" title="They are in Telegram: record them as sent">Mark as sent</button>` : ''}
        ${!ENDED.includes(j.status) && !j.running ? '<button class="btn ghost tool" data-q="schedule">Schedule</button>' : ''}
        ${j.running || !ENDED.includes(j.status) ? '<button class="btn danger tool" data-q="cancel">Cancel</button>' : '<button class="btn ghost tool" data-q="remove">Remove</button>'}
      </div>
    </div>`;
  }).join('') : '<p class="muted pad">No jobs. Press <b>Start upload</b> or <b>Add to queue</b> in the preview.</p>';
  const interrupted = state.queue.find((j) => j.status === 'interrupted');
  $('resumeBanner').hidden = !interrupted || state.resumeDismissed === interrupted.id;
  if (interrupted) {
    const st = interrupted.stats;
    $('resumeTitle').textContent = `“${interrupted.name}” was interrupted${st && st.albumsDone ? ` after ${plural(st.albumsDone, 'album')}` : ''}. Resume where it stopped?`;
    $('resumeGo').onclick = () => fg.queueResume(interrupted.id);
    $('resumeLater').onclick = () => { state.resumeDismissed = interrupted.id; $('resumeBanner').hidden = true; };
  }
}

function updateJobProgress(jobId, done, total) {
  jobProgress.set(jobId, total ? done / total : 0);
  const bar = document.querySelector(`.job[data-id="${CSS.escape(jobId)}"] .progress-fill`);
  if (bar) bar.style.width = `${(100 * jobProgress.get(jobId)).toFixed(1)}%`;
}

$('queueList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-q]');
  if (!b) return;
  const id = b.closest('.job').dataset.id;
  const j = state.queue.find((x) => x.id === id);
  const idx = state.queue.indexOf(j);
  const act = b.dataset.q;
  await guarded(async () => {
    if (act === 'up') await fg.queueMove(id, idx - 1);
    if (act === 'down') await fg.queueMove(id, idx + 1);
    if (act === 'pause') await (j.status === 'paused' ? fg.queueResume(id) : fg.queuePause(id));
    if (act === 'resume') await fg.queueResume(id);
    if (act === 'retry') await fg.queueRetry(id);
    if (['check', 'resend', 'mark'].includes(act)) await fg.queueReview(id, act);
    if (act === 'cancel') await fg.queueCancel(id);
    if (act === 'remove') await fg.queueRemove(id);
    if (act === 'schedule') {
      const v = await prompt({ title: 'Schedule job', text: 'Start this job at:', type: 'datetime-local', okLabel: 'Schedule' });
      if (v !== null) await fg.queueSchedule(id, v ? new Date(v).getTime() : null);
    }
  });
});
$('clearFinishedBtn').onclick = () => guarded(() => fg.queueClearFinished());

fg.on('queue:changed', (list) => {
  state.queue = list;
  state.uploading = list.some((j) => j.running);
  state.paused = list.some((j) => j.running && j.status === 'paused');
  renderQueue();
  updateStart();
  if (!$('panel-history').hidden) renderHistory();
});

// ---------------------------------------------------------------- history and reports

function renderHistory() {
  const done = state.queue.filter((j) => ENDED.includes(j.status)).sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
  $('historyList').innerHTML = done.length ? done.map((j) => {
    const [label, cls] = STATUS[j.status];
    const s = j.stats || {};
    return `<div class="job clickable" data-h="${esc(j.id)}"><div class="job-main">
      <div class="job-title">${esc(j.name)} <span class="pill ${cls}">${label}</span></div>
      <div class="muted small">${j.finishedAt ? new Date(j.finishedAt).toLocaleString() : ''} → ${esc(j.chat.title)} · ✓ ${s.sent || 0} · ✗ ${s.failed || 0} · skipped ${s.skipped || 0}</div>
    </div></div>`;
  }).join('') : '<p class="muted pad">Finished uploads appear here.</p>';
}

$('historyList').addEventListener('click', async (e) => {
  const row = e.target.closest('[data-h]');
  if (!row) return;
  document.querySelectorAll('[data-h]').forEach((r) => r.classList.toggle('on', r === row));
  const id = row.dataset.h;
  const r = await guarded(() => fg.report(id));
  if (!r) { $('reportView').innerHTML = '<p class="muted">No report for this job.</p>'; return; }
  const dur = r.startedAt && r.finishedAt ? Math.round((new Date(r.finishedAt) - new Date(r.startedAt)) / 1000) : 0;
  $('reportView').innerHTML = `
    <div class="report-head"><div><h3>${esc(r.jobName)}</h3><div class="muted small">${esc(r.chat.title)} · ${new Date(r.startedAt).toLocaleString()} · ${formatEta(dur).replace(' left', '') || '0s'}</div></div>
      <div class="btn-row"><button class="btn ghost tool" data-x="json">Export JSON</button><button class="btn ghost tool" data-x="csv">Export CSV</button>
      ${r.failed.length ? '<button class="btn primary tool" data-x="retry">Retry failed</button>' : ''}</div></div>
    <div class="stats mini"><div class="stat"><b>${r.uploaded.length}</b><span>uploaded</span></div><div class="stat"><b>${r.failed.length}</b><span>failed</span></div>
      <div class="stat"><b>${r.duplicates.length}</b><span>duplicates</span></div><div class="stat"><b>${r.skipped.length}</b><span>skipped</span></div></div>
    ${r.topics.length ? `<p class="small"><b>Topics:</b> ${r.topics.map(esc).join(', ')}</p>` : ''}
    ${r.errors.length ? `<p class="small err-text"><b>Errors:</b> ${r.errors.map(esc).join(' · ')}</p>` : ''}
    <table class="rtable"><thead><tr><th>Album</th><th>Topic</th><th>Files</th><th>Result</th></tr></thead><tbody>
    ${r.albums.slice(0, 500).map((a) => `<tr><td>${esc(a.caption || a.set || '—')}</td><td>${esc(a.topic)}</td><td>${a.files.length}</td><td class="${a.status === 'sent' ? 'ok-text' : 'err-text'}">${esc(a.status === 'sent' ? 'sent' : a.error || 'failed')}</td></tr>`).join('')}
    </tbody></table>
    ${r.failed.length ? `<h4>Failed files</h4><ul class="small">${r.failed.slice(0, 300).map((f) => `<li>${esc(f.name)} — <span class="err-text">${esc(f.error)}</span></li>`).join('')}</ul>` : ''}
    ${(r.review || []).length ? `<h4>Albums to check in Telegram</h4><p class="small muted">FolderGram stopped while sending these and couldn't confirm whether they arrived. Look in the topic, then use Send again or Mark as sent in the queue.</p>
      <ul class="small">${r.review.slice(0, 300).map((a) => `<li>${esc(a.caption || a.set || a.files[0] || '')} (${a.files.length} files) → ${esc(a.topic)}</li>`).join('')}</ul>` : ''}
    ${r.duplicates.length ? `<h4>Skipped duplicates</h4><ul class="small">${r.duplicates.slice(0, 300).map((f) => `<li>${esc(f.name)} ${f.of ? `= ${esc(f.of)}` : ''}</li>`).join('')}</ul>` : ''}`;
  $('reportView').onclick = async (ev) => {
    const x = ev.target.dataset.x;
    if (x === 'retry') return guarded(async () => { await fg.queueRetry(id); toast('Retrying the failed files.', 'ok'); showTab('queue'); });
    if (x) { const file = await guarded(() => fg.exportReport(id, x)); if (file) toast(`Report saved: ${file}`, 'ok'); }
  };
});

// ---------------------------------------------------------------- naming rules panel

let rules = [];
async function loadNaming() {
  const snap = await guarded(() => fg.naming());
  if (!snap) return;
  rules = snap.rules.map((r) => ({ ...r }));
  renderRules();
  dict = (snap.dictionary || []).map((d) => ({ name: d.name, aliases: d.aliases.join(', ') }));
  renderDict();
  org = (snap.organize || []).map((r) => JSON.parse(JSON.stringify(r)));
  renderOrg();
  if (!presets) {
    presets = await fg.organizePresets().catch(() => []);
    $('orgPreset').innerHTML = `<option value="">＋ Add a rule from a preset…</option>${presets.map((p, i) => `<option value="${i}">${esc(p.name)} (${esc(p.description)})</option>`).join('')}`;
  }
  $('learnedList').innerHTML = (snap.learned.length || snap.topics.length)
    ? [...snap.learned.map((x) => ({ ...x, kind: 'learned' })), ...snap.topics.map((x) => ({ ...x, kind: 'topics' }))].map((x) => `<div class="kv">
      <span class="muted">${x.kind === 'topics' ? 'Topic' : 'Album'}</span><span>${esc(x.from)}</span><span>→</span><b>${esc(x.to)}</b>
      <button class="link-btn" data-forget="${esc(x.kind)}" data-from="${esc(x.from)}">Forget</button></div>`).join('')
      + (snap.folderCorrections ? `<p class="muted small">${plural(snap.folderCorrections, 'folder-specific name')} ${snap.folderCorrections === 1 ? 'is' : 'are'} also remembered.</p>` : '')
    : '<p class="muted small">Rename an album or topic in the preview and FolderGram uses that name next time it sees the same folder or name.</p>';
  $('aliasList').innerHTML = snap.aliases.length
    ? snap.aliases.slice(0, 300).map((a) => `<div class="kv"><span>${esc(a.name)}</span><span>→</span><b>${esc(a.alias)}</b></div>`).join('')
    : '<p class="muted small">Turn on “Rename random folder names” to give names like kb03wM a stand-in that stays the same in every scan.</p>';
}
function renderRules() {
  $('rulesList').innerHTML = rules.length ? rules.map((r, i) => `<div class="rule" data-i="${i}">
    <input data-k="find" value="${esc(r.find)}" placeholder="Find">
    <input data-k="replace" value="${esc(r.replace)}" placeholder="Replace with">
    <select data-k="scope"><option value="album"${r.scope === 'album' ? ' selected' : ''}>Albums</option><option value="topic"${r.scope === 'topic' ? ' selected' : ''}>Topics</option><option value="both"${r.scope === 'both' ? ' selected' : ''}>Both</option></select>
    <label class="toggle"><input type="checkbox" data-k="regex" ${r.regex ? 'checked' : ''}><span></span>Regex</label>
    <label class="toggle"><input type="checkbox" data-k="enabled" ${r.enabled !== false ? 'checked' : ''}><span></span>On</label>
    <button class="icon-btn sm" data-del="${i}" title="Delete">✕</button></div>`).join('') : '<p class="muted small">No rules yet.</p>';
}
$('rulesList').addEventListener('input', (e) => {
  const row = e.target.closest('.rule');
  if (!row) return;
  const r = rules[Number(row.dataset.i)];
  const k = e.target.dataset.k;
  r[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
});
$('rulesList').addEventListener('click', (e) => {
  if (e.target.dataset.del == null) return;
  rules.splice(Number(e.target.dataset.del), 1);
  renderRules();
});
$('addRuleBtn').onclick = () => { rules.push({ find: '', replace: '', scope: 'album', regex: false, enabled: true }); renderRules(); };
$('saveRulesBtn').onclick = () => guarded(async () => {
  for (const r of rules) if (r.regex) { try { new RegExp(r.find); } catch { throw new Error(`“${r.find}” is not a valid regex.`); } }
  for (const r of org) for (const v of Object.values(r.when || {})) {
    const re = /^\/(.+)\/([a-z]*)$/i.exec(String(v).trim());
    if (re) { try { new RegExp(re[1], re[2]); } catch { throw new Error(`Rule “${r.name}”: ${v} is not a valid regex.`); } }
  }
  await fg.setRules(rules);
  await fg.setDictionary(dict.map((d) => ({ name: d.name, aliases: d.aliases })));
  await fg.setOrganize(org);
  toast('Rules saved. Rescanning to apply them.', 'ok');
  loadNaming();
  scan();
});
// Dictionary: preferred spellings.
let dict = [];
function renderDict() {
  $('dictList').innerHTML = dict.length ? dict.map((d, i) => `<div class="dict-row" data-i="${i}">
    <input data-k="name" value="${esc(d.name)}" placeholder="Preferred: Marin Kitagawa">
    <input data-k="aliases" value="${esc(d.aliases)}" placeholder="Also written as: Marin, Kitagawa Marin">
    <button class="icon-btn sm" data-del="${i}" title="Delete">✕</button></div>`).join('') : '<p class="muted small">No names yet.</p>';
}
$('dictList').addEventListener('input', (e) => { const row = e.target.closest('.dict-row'); if (row) dict[Number(row.dataset.i)][e.target.dataset.k] = e.target.value; });
$('dictList').addEventListener('click', (e) => { if (e.target.dataset.del != null) { dict.splice(Number(e.target.dataset.del), 1); renderDict(); } });
$('addDictBtn').onclick = () => { dict.push({ name: '', aliases: '' }); renderDict(); };

// Organization rules: conditions → topic and album names, first match wins.
let org = [];
let presets = null;
const ORG_WHEN = [['path', 'Folder path', 'Anime/*/*'], ['folder', 'Folder name', 'Set *'], ['parent', 'Parent folder', 'Marin'], ['file', 'File names', '*.jpg'],
  ['ext', 'Extensions', 'mp4, mov'], ['title', 'Detected album name', '/cosplay/'], ['depth', 'Depth', '2+'], ['from', 'Files from', 'YYYY-MM-DD'], ['to', 'Files until', 'YYYY-MM-DD']];
function renderOrg() {
  $('orgList').innerHTML = org.length ? org.map((r, i) => `<div class="org-rule" data-i="${i}">
    <div class="head"><input data-k="name" value="${esc(r.name)}" placeholder="Rule name">
      <label class="toggle"><input type="checkbox" data-k="enabled" ${r.enabled !== false ? 'checked' : ''}><span></span>On</label>
      <button class="icon-btn sm" data-move="-1" title="Check earlier" ${i ? '' : 'disabled'}>↑</button><button class="icon-btn sm" data-move="1" title="Check later" ${i < org.length - 1 ? '' : 'disabled'}>↓</button>
      <button class="icon-btn sm" data-del="${i}" title="Delete">✕</button></div>
    <div class="muted small">When (leave empty to ignore; all filled ones must match)</div>
    <div class="grid">${ORG_WHEN.map(([k, label, ph]) => `<label class="f">${label}<input data-w="${k}" value="${esc((r.when || {})[k] || '')}" placeholder="${esc(ph)}"></label>`).join('')}</div>
    <div class="muted small">Then</div>
    <div class="grid">
      <label class="f">Topic<input data-t="topic" value="${esc((r.then || {}).topic || '')}" placeholder="{parent}" ${r.then && r.then.skip ? 'disabled' : ''}></label>
      <label class="f">Album name<input data-t="album" value="${esc((r.then || {}).album || '')}" placeholder="{folder}" ${r.then && r.then.skip ? 'disabled' : ''}></label>
      <label class="toggle"><input type="checkbox" data-t="skip" ${r.then && r.then.skip ? 'checked' : ''}><span></span>Leave these albums out</label>
    </div></div>`).join('') : '<p class="muted small">No organization rules. Smart naming decides topics and albums.</p>';
}
$('orgList').addEventListener('input', (e) => {
  const row = e.target.closest('.org-rule');
  if (!row) return;
  const r = org[Number(row.dataset.i)];
  const t = e.target;
  if (t.dataset.k) r[t.dataset.k] = t.type === 'checkbox' ? t.checked : t.value;
  else if (t.dataset.w) { r.when = r.when || {}; if (t.value.trim()) r.when[t.dataset.w] = t.value; else delete r.when[t.dataset.w]; }
  else if (t.dataset.t) {
    r.then = r.then || {};
    if (t.dataset.t === 'skip') { r.then = t.checked ? { skip: true } : { topic: '', album: '' }; renderOrg(); } else r.then[t.dataset.t] = t.value;
  }
});
$('orgList').addEventListener('click', (e) => {
  const row = e.target.closest('.org-rule');
  if (!row) return;
  const i = Number(row.dataset.i);
  if (e.target.dataset.del != null) { org.splice(i, 1); renderOrg(); }
  if (e.target.dataset.move) { const j = i + Number(e.target.dataset.move); [org[i], org[j]] = [org[j], org[i]]; renderOrg(); }
});
$('orgPreset').onchange = () => {
  const p = presets && presets[Number($('orgPreset').value)];
  $('orgPreset').value = '';
  if (!p) return;
  org.push({ name: p.name, enabled: true, when: { ...p.when }, then: { ...p.then } });
  renderOrg();
  toast('Rule added. Try a path to check it, then Save rules.', 'ok');
};
$('addOrgBtn').onclick = () => { org.push({ name: `Rule ${org.length + 1}`, enabled: true, when: {}, then: { topic: '', album: '' } }); renderOrg(); };

// Naming simulator: uses the rules as they are on screen, saved or not.
$('tryBtn').onclick = () => guarded(async () => {
  const text = $('tryPath').value.trim();
  if (!text) return;
  const r = await fg.tryNaming(text, options(), org);
  if (!r) return;
  const a = r.auto || {};
  $('tryResult').innerHTML = `${r.skipped ? `<div><b>Left out</b> by “${esc(r.skipped)}”</div>` : `
    <div>Topic: <b>${esc(r.topic)}</b> <span class="muted small">(${esc(r.topicSource || 'folder')})</span></div>
    <div>Album: <b>${esc(r.album)}</b> <span class="muted small">${esc(a.level || '')} confidence${a.source ? `, from ${esc(a.source)}` : ''}</span></div>
    ${a.reasons && a.reasons.length ? `<div class="muted small">${esc(a.reasons.join('; '))}</div>` : ''}
    ${r.detected && (r.detected.album !== r.album || r.detected.topic !== r.topic) ? `<div class="muted small">Without rules, dictionary and corrections: topic “${esc(r.detected.topic)}”, album “${esc(r.detected.album)}”</div>` : ''}`}
    ${r.rules.map((x) => `<div class="${x.ok ? 'ok' : 'no'} small">${x.ok ? '✓' : '✗'} ${esc(x.name)}${x.enabled === false ? ' (off)' : ''}${x.ok ? '' : `: ${esc(x.why.join('; '))}`}</div>`).join('')}`;
});
$('tryPath').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('tryBtn').click(); });

$('learnedList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-forget]');
  if (!b) return;
  await guarded(() => fg.forgetNaming(b.dataset.forget, b.dataset.from));
  loadNaming();
});
$('forgetAllBtn').onclick = async () => {
  const ok = await prompt({ title: 'Forget all corrections?', text: 'Names you corrected in the preview will be detected again from scratch.', noInput: true, okLabel: 'Forget' });
  if (ok) { await guarded(() => fg.forgetNaming('all')); loadNaming(); }
};

// ---------------------------------------------------------------- library: what is on Telegram

const lib = { chatId: null, topics: [], dups: new Set(), topic: null, albums: [], done: false, picked: new Set(), thumbs: new Map(), loading: false };
const libChat = () => state.chat;

async function openLibrary() {
  const chat = libChat();
  $('libGroup').textContent = chat ? `· ${chat.title}` : '';
  if (!chat) { $('libAlbums').innerHTML = '<p class="muted">Choose the group in the sidebar first.</p>'; $('libTopicList').innerHTML = ''; return; }
  if (lib.chatId === chat.id && lib.topics.length) return renderLibTopics();
  Object.assign(lib, { chatId: chat.id, topics: [], topic: null, albums: [], picked: new Set() });
  $('libTopicList').innerHTML = '<p class="muted small">Loading topics…</p>';
  const r = await guarded(() => fg.libraryTopics(chat));
  if (!r) return;
  lib.topics = r.topics;
  lib.dups = new Set(r.duplicates.flat());
  renderLibTopics();
  if (lib.topics.length) chooseLibTopic(lib.topics[0]);
}

function renderLibTopics() {
  const q = norm($('libTopicSearch').value);
  $('libTopicList').innerHTML = lib.topics.filter((t) => !q || norm(t.title).includes(q)).map((t) => `<div class="lib-topic${lib.topic && lib.topic.id === t.id ? ' on' : ''}" data-id="${t.id ?? ''}">
    <span class="grow">${esc(t.title)}</span>${t.closed ? '<span class="tag">closed</span>' : ''}${lib.dups.has(t.id) ? '<span class="tag warn" title="Another topic has the same name">twice</span>' : ''}</div>`).join('')
    || '<p class="muted small">No topics.</p>';
}
$('libTopicSearch').addEventListener('input', renderLibTopics);
$('libTopicList').addEventListener('click', (e) => {
  const row = e.target.closest('.lib-topic');
  if (!row) return;
  const t = lib.topics.find((x) => String(x.id ?? '') === row.dataset.id);
  if (t) chooseLibTopic(t);
});

async function chooseLibTopic(t) {
  Object.assign(lib, { topic: t, albums: [], done: false, picked: new Set() });
  $('libTopicTitle').textContent = t.title;
  $('libRename').disabled = !t.id || t.id === 1;
  renderLibTopics();
  renderLibAlbums();
  await loadLibPage(true);
}

async function loadLibPage(reset = false) {
  // Choosing another topic while a page is still loading starts over for that topic; the late answer is dropped.
  if (!reset && (lib.loading || lib.done)) return;
  const seq = (lib.seq = (lib.seq || 0) + 1);
  lib.loading = true;
  $('libMore').hidden = true;
  if (!lib.albums.length) $('libAlbums').innerHTML = '<p class="muted">Loading albums…</p>';
  const topic = lib.topic;
  try {
    const r = await guarded(() => fg.libraryPage(libChat(), topic.id, reset));
    if (seq !== lib.seq) return;
    if (r) { lib.albums.push(...r.albums); lib.done = r.done; }
  } finally {
    if (seq === lib.seq) lib.loading = false;
  }
  renderLibAlbums();
}
$('libMore').onclick = () => loadLibPage();
$('libAlbums').addEventListener('scroll', (e) => {
  const el = e.target;
  if (el.scrollTop + el.clientHeight > el.scrollHeight - 300) loadLibPage();
});

const kindsText = (k) => Object.entries(k).map(([kind, n]) => `${n} ${kind === 'photo' ? (n === 1 ? 'photo' : 'photos') : kind === 'video' ? (n === 1 ? 'video' : 'videos') : kind === 'document' ? (n === 1 ? 'file' : 'files') : kind}`).join(', ');
const dateText = (unix) => new Date(unix * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

function renderLibAlbums() {
  const q = norm($('libSearch').value);
  const kind = $('libKind').value;
  const shown = lib.albums.filter((a) => (!q || norm(a.title || a.caption).includes(q)) && (!kind || a.kinds[kind]));
  $('libAlbums').innerHTML = shown.length ? shown.map((a) => {
    const vis = a.items.filter((m) => m.kind === 'photo' || m.kind === 'video').slice(0, 4);
    return `<div class="lib-album${lib.picked.has(a.key) ? ' sel' : ''}" data-key="${esc(a.key)}">
      <input type="checkbox" class="pick" ${lib.picked.has(a.key) ? 'checked' : ''} title="Select for download">
      <div class="thumbs${vis.length === 1 ? ' one' : ''}">${vis.map((m) => `<img data-lthumb="${m.id}" ${lib.thumbs.has(m.id) ? `src="${esc(lib.thumbs.get(m.id))}"` : ''} alt="">`).join('') || `<div class="ph">${KIND_ICON[a.items[0].kind] || '📄'}</div>`}</div>
      <div class="title" title="${esc(a.caption)}">${esc(a.title || '(no caption)')}</div>
      <div class="muted">${esc(kindsText(a.kinds))} · ${humanSize(a.size)} · ${esc(dateText(a.date))}</div>
      <div class="acts"><button class="link-btn" data-act="open">Open in Telegram</button>${a.caption ? '<button class="link-btn" data-act="caption">Edit caption…</button>' : ''}</div>
    </div>`;
  }).join('') : `<p class="muted">${lib.loading ? 'Loading albums…' : lib.albums.length ? 'No albums match.' : 'No media in this topic.'}</p>`;
  $('libMore').hidden = lib.done || lib.loading;
  $('libDownloadSel').disabled = !lib.picked.size;
  $('libDownloadSel').textContent = lib.picked.size ? `Download ${plural(lib.picked.size, 'album')}…` : 'Download selected…';
  loadLibThumbs();
}
$('libSearch').addEventListener('input', renderLibAlbums);
$('libKind').addEventListener('change', renderLibAlbums);

let libThumbBusy = false;
async function loadLibThumbs() {
  if (libThumbBusy) return;
  const ids = [...document.querySelectorAll('img[data-lthumb]:not([src])')].map((i) => Number(i.dataset.lthumb)).filter((id) => !lib.thumbs.has(id)).slice(0, 24);
  if (!ids.length) return;
  libThumbBusy = true;
  try {
    const got = await fg.libraryThumbs(libChat(), ids).catch(() => ({}));
    for (const [id, url] of Object.entries(got)) {
      lib.thumbs.set(Number(id), url);
      document.querySelectorAll(`img[data-lthumb="${id}"]`).forEach((img) => { img.src = url; });
    }
    while (lib.thumbs.size > 800) lib.thumbs.delete(lib.thumbs.keys().next().value);
    for (const id of ids) if (!lib.thumbs.has(id)) lib.thumbs.set(id, ''); // none: don't ask again
  } finally {
    libThumbBusy = false;
  }
  if (Object.keys(ids).length) setTimeout(loadLibThumbs, 50);
}

$('libAlbums').addEventListener('click', async (e) => {
  const card = e.target.closest('.lib-album');
  if (!card) return;
  const a = lib.albums.find((x) => x.key === card.dataset.key);
  if (!a) return;
  if (e.target.classList.contains('pick')) {
    if (e.target.checked) lib.picked.add(a.key); else lib.picked.delete(a.key);
    card.classList.toggle('sel', e.target.checked);
    $('libDownloadSel').disabled = !lib.picked.size;
    $('libDownloadSel').textContent = lib.picked.size ? `Download ${plural(lib.picked.size, 'album')}…` : 'Download selected…';
    return;
  }
  const act = e.target.dataset.act;
  if (act === 'open') guarded(() => fg.libraryOpen(libChat(), a.ids[0], lib.topic.id));
  if (act === 'caption') {
    const text = await prompt({ title: 'Edit caption on Telegram', text: 'The new caption replaces the old one for everyone in the group.', value: a.caption, okLabel: 'Change caption' });
    if (text == null || text === a.caption) return;
    // FolderGram puts the caption on one message of the album: the one Telegram returned it from.
    const target = a.captionId || a.ids[0];
    await guarded(async () => { await fg.editCaption(libChat(), target, text); a.caption = text; a.title = text.split('\n')[0]; renderLibAlbums(); toast('Caption changed.', 'ok'); });
  }
});

$('libRename').onclick = async () => {
  const t = lib.topic;
  if (!t || !t.id || t.id === 1) return;
  const name = await prompt({ title: 'Rename topic on Telegram', text: 'Everyone in the group sees the new name.', value: t.title, okLabel: 'Rename' });
  if (!name || name.trim() === t.title) return;
  await guarded(async () => {
    await fg.renameTopic(libChat(), t.id, name.trim());
    t.title = name.trim();
    $('libTopicTitle').textContent = t.title;
    renderLibTopics();
    toast('Topic renamed.', 'ok');
  });
};

$('libCompare').onclick = () => busy($('libCompare'), () => guarded(async () => {
  if (!lib.topic) return;
  if (!state.model) return toast('Choose a folder first: the comparison uses the albums in Album preview.', 'error');
  const t = norm(lib.topic.title);
  const perFolder = state.mode === 'per_folder';
  const sets = state.model.entries.filter((e) => !perFolder || norm(e.topicName) === t).flatMap((e) => e.sets.map((x) => ({ name: x.name, count: x.fileIds.length })));
  if (!sets.length) return toast(`No albums in the preview go to “${lib.topic.title}”.`, 'error');
  const r = await fg.libraryCompare(libChat(), lib.topic.id, sets);
  const row = (x) => `<div>${esc(x.title)} <span class="muted small">${x.local != null ? `${x.local} here` : ''}${x.local != null && x.telegram != null ? ' · ' : ''}${x.telegram != null ? `${x.telegram} on Telegram` : ''}</span></div>`;
  const body = `<div class="check-list">
    <h4>Not on Telegram yet (${r.onlyLocal.length})</h4>${r.onlyLocal.map(row).join('') || '<p class="muted small">None.</p>'}
    <h4>Different number of files (${r.both.filter((x) => x.differs).length})</h4>${r.both.filter((x) => x.differs).map(row).join('') || '<p class="muted small">None.</p>'}
    <h4>Only on Telegram (${r.onlyTelegram.length})</h4>${r.onlyTelegram.map(row).join('') || '<p class="muted small">None.</p>'}
    <p class="muted small">${plural(r.both.filter((x) => !x.differs).length, 'album')} match. Albums are matched by caption title.${r.untitled ? ` ${plural(r.untitled, 'album')} on Telegram have no caption and could not be matched.` : ''}</p></div>`;
  await prompt({ title: `“${lib.topic.title}”: preview vs Telegram`, noInput: true, body, okLabel: 'Close' });
}));

$('libChecks').onclick = () => busy($('libChecks'), () => guarded(async () => {
  const chat = libChat();
  if (!chat) return toast('Choose the group first.', 'error');
  const r = await fg.libraryChecks(chat);
  const body = `<div class="check-list">
    <h4>Topics with the same name (${r.duplicates.length})</h4>${r.duplicates.map((g) => `<div>${g.map((t) => `“${esc(t.title)}”`).join(' and ')}</div>`).join('') || '<p class="muted small">None.</p>'}
    <h4>Albums that look like they belong in another topic (${r.misplaced.length})</h4>${r.misplaced.map((m) => `<div>${esc(m.album.caption.split('\n')[0])} <span class="muted small">→ “${esc(m.suggested.title)}”?</span></div>`).join('') || '<p class="muted small">None.</p>'}
    <h4>Albums FolderGram sent that lost messages (${r.incomplete.length})</h4>${r.incomplete.map((a, i) => `<div>${esc(a.caption || a.topic)} <span class="muted small">${a.missing.length} of ${a.messageIds.length} messages gone</span>
      ${a.paths ? ` <button type="button" class="link-btn" data-resend="${i}">Send the missing files again</button>` : ''}</div>`).join('') || `<p class="muted small">None of ${plural(r.checkedAlbums, 'album')} from upload reports.</p>`}
    <p class="muted small">Telegram can't move messages between topics; to move an album, send it again to the right topic and delete the old one in Telegram.</p></div>`;
  setTimeout(() => {
    document.querySelectorAll('[data-resend]').forEach((b) => { b.onclick = () => guarded(async () => {
      const a = r.incomplete[Number(b.dataset.resend)];
      const res = await fg.resendMissing(chat, a);
      b.replaceWith(Object.assign(document.createElement('span'), { className: 'muted small', textContent: `queued${res.gone.length ? `; ${plural(res.gone.length, 'file')} no longer on this PC` : ''}` }));
      refreshQueue();
    }); });
  }, 0);
  await prompt({ title: `Checks for ${chat.title}`, noInput: true, body, okLabel: 'Close' });
}));

// ---------------------------------------------------------------- downloads

let dlDest = null;
async function askDownload(what) {
  const dest = await fg.pickDownloadFolder();
  if (!dest) return null;
  const body = `<div class="check-list">
    <label class="f">If a file with the same name is already there<select id="dlPolicy"><option value="skip">Leave it, skip the download</option><option value="rename">Keep both: add (2) to the new one</option><option value="overwrite">Replace it</option></select></label>
    <label class="f">Folders<select id="dlLayout"><option value="topic/album">Group / Topic / Album / files</option><option value="topic">Group / Topic / files</option><option value="flat">Group / files</option></select></label>
    <label class="f">Speed limit (Mbit/s, empty for none)<input id="dlLimit" type="number" min="0" step="1"></label></div>`;
  const ok = await prompt({ title: `Download ${what}`, text: `To ${dest}. Interrupted downloads continue where they stopped; files already downloaded are skipped.`, noInput: true, body, okLabel: 'Download' });
  if (!ok) return null;
  return { dest, policy: $('dlPolicy').value, layout: $('dlLayout').value, bandwidthMbps: Number($('dlLimit').value) || 0 };
}
$('libDownloadSel').onclick = () => guarded(async () => {
  const albums = lib.albums.filter((a) => lib.picked.has(a.key));
  if (!albums.length) return;
  const o = await askDownload(plural(albums.length, 'album'));
  if (!o) return;
  dlDest = o.dest;
  await fg.startDownload({ chat: libChat(), ...o, albums: albums.map((a) => ({ title: a.title, topic: lib.topic.title, date: a.date, items: a.items })) });
  $('dlBar').hidden = false;
});
$('libDownloadTopic').onclick = () => guarded(async () => {
  if (!lib.topic) return;
  const o = await askDownload(`the topic “${lib.topic.title}”`);
  if (!o) return;
  dlDest = o.dest;
  await fg.startDownload({ chat: libChat(), ...o, topic: { id: lib.topic.id, title: lib.topic.title } });
  $('dlBar').hidden = false;
});
fg.on('download:progress', (p) => {
  $('dlBar').hidden = false;
  const left = p.files - p.done - p.skipped - p.failed;
  $('dlText').textContent = p.finished
    ? `Download ${p.status}: ${p.done} downloaded, ${p.skipped} skipped, ${p.failed} failed.`
    : `Downloading ${p.current ? p.current.name : ''} · ${p.done}/${p.files} files · ${humanSize(p.bytesDone)} of ${humanSize(p.bytesTotal)}${p.speed > 0 ? ` · ${humanSize(Math.round(p.speed))}/s` : ''}${left ? '' : ''}`;
  $('dlFill').style.width = `${(p.percent || 0).toFixed(1)}%`;
  $('dlCancel').hidden = !!p.finished;
  if (p.finished) toast($('dlText').textContent, p.failed ? 'error' : 'ok');
});
$('dlCancel').onclick = () => fg.cancelDownload();
$('dlOpen').onclick = () => dlDest && fg.openDownloadFolder(dlDest);

// ---------------------------------------------------------------- folder sync

let syncProfiles = [];
async function loadSync() {
  syncProfiles = (await guarded(() => fg.syncList())) || [];
  renderSync();
}
fg.on('sync:changed', (list) => { syncProfiles = list; if (!$('panel-sync').hidden) renderSync(); });

const SCHEDULE = { manual: 'Only when I click Sync now', interval: 'Every … minutes while FolderGram is open', watch: 'When files change (watch the folders)' };
function renderSync() {
  $('syncList').innerHTML = syncProfiles.length ? syncProfiles.map((p) => {
    const r = p.result;
    const last = p.lastResult;
    return `<div class="sync-card" data-id="${esc(p.id)}">
      <div class="head"><input data-k="name" value="${esc(p.name)}" class="grow"><label class="toggle"><input type="checkbox" data-k="enabled" ${p.enabled ? 'checked' : ''}><span></span>On</label>
        <button class="btn primary small" data-act="run">Sync now</button><button class="icon-btn sm" data-act="remove" title="Delete this sync (nothing on Telegram or your PC is touched)">✕</button></div>
      <div class="muted small">📁 ${p.folders.map(esc).join(', ')} → ${esc(p.chat.title)}${p.mode === 'per_folder' ? ' (topic per folder)' : p.mode === 'single' ? ' (one topic)' : ''}</div>
      <div class="grid">
        <label class="f">When<select data-k="schedule">${Object.entries(SCHEDULE).map(([k, v]) => `<option value="${k}"${p.schedule.type === k ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
        <label class="f">Minutes<input type="number" min="5" data-k="minutes" value="${p.schedule.minutes}" ${p.schedule.type === 'interval' ? '' : 'disabled'}></label>
        <label class="f">Direction<select data-k="direction"><option value="upload"${p.direction === 'upload' ? ' selected' : ''}>Upload only</option><option value="two-way"${p.direction === 'two-way' ? ' selected' : ''}>Two-way (asks before changing Telegram or downloading)</option></select></label>
      </div>
      <div class="result">${last ? `Last run ${esc(new Date(last.at).toLocaleString())}: ${last.error ? `<span class="err-text">${esc(last.error)}</span>` : last.note ? esc(last.note)
        : `${last.added || 0} new, ${last.changed || 0} changed, ${last.renamed || 0} renamed, ${last.removed || 0} removed${last.jobId ? ' · upload queued' : ' · nothing to upload'}`}` : 'Not run yet.'}
        ${p.nextRunAt ? `<div class="muted small">Next run ${esc(new Date(p.nextRunAt).toLocaleTimeString())}</div>` : ''}${p.watching ? '<div class="muted small">Watching the folders.</div>' : ''}
        ${r && r.removedOnTelegram && r.removedOnTelegram.length ? `<div>${r.removedOnTelegram.length === 1 ? '1 file removed here is' : `${r.removedOnTelegram.length} files removed here are`} still on Telegram. <button class="link-btn" data-act="delete">Review and delete from Telegram…</button></div>` : ''}
        ${r && r.newOnTelegram && r.newOnTelegram.length ? `<div>${r.newOnTelegram.length === 1 ? '1 album on Telegram isn’t' : `${r.newOnTelegram.length} albums on Telegram aren’t`} in these folders. <button class="link-btn" data-act="download">Review and download…</button></div>` : ''}
      </div></div>`;
  }).join('') : '<p class="muted">No syncs yet. Choose folders and a group, then “New sync from current choices”.</p>';
}

$('syncNew').onclick = () => guarded(async () => {
  if (!state.chat) return toast('Choose the group first.', 'error');
  const folders = state.sources.filter(Boolean);
  if (!folders.length) return toast('Choose the folders to sync first.', 'error');
  const name = await prompt({ title: 'New folder sync', text: `${folders.join(', ')} → ${state.chat.title}, with the naming and upload settings chosen now.`, value: folders[0].split(/[\\/]/).pop(), okLabel: 'Create' });
  if (!name) return;
  await fg.syncSave({ name, folders, chat: state.chat, mode: state.mode, topicId: state.mode === 'single' ? Number($('topicSelect').value) || 1 : null, options: options(),
    schedule: { type: 'manual', minutes: 60 }, direction: 'upload' });
  loadSync();
});

$('syncList').addEventListener('change', (e) => guarded(async () => {
  const card = e.target.closest('.sync-card');
  const p = card && syncProfiles.find((x) => x.id === card.dataset.id);
  if (!p) return;
  const k = e.target.dataset.k;
  const next = { ...p, schedule: { ...p.schedule } };
  if (k === 'name') next.name = e.target.value;
  if (k === 'enabled') next.enabled = e.target.checked;
  if (k === 'schedule') next.schedule.type = e.target.value;
  if (k === 'minutes') next.schedule.minutes = Number(e.target.value) || 60;
  if (k === 'direction') next.direction = e.target.value;
  await fg.syncSave(next);
}));

$('syncList').addEventListener('click', (e) => guarded(async () => {
  const card = e.target.closest('.sync-card');
  const p = card && syncProfiles.find((x) => x.id === card.dataset.id);
  const act = e.target.dataset.act;
  if (!p || !act) return;
  if (act === 'run') {
    e.target.disabled = true;
    try { await fg.syncRun(p.id); refreshQueue(); } finally { e.target.disabled = false; }
  }
  if (act === 'remove') {
    const ok = await prompt({ title: `Delete the sync “${p.name}”?`, text: 'Only the sync setting is removed. Nothing on Telegram or on your PC changes.', noInput: true, okLabel: 'Delete sync' });
    if (ok) await fg.syncRemove(p.id);
  }
  if (act === 'delete') {
    const list = p.result.removedOnTelegram;
    const body = `<div class="check-list">${list.map((x, i) => `<label class="file-row"><input type="checkbox" data-i="${i}"><span class="fname" title="${esc(x.path)}">${esc(x.name)}</span>
      <span class="muted small">${plural(x.messageIds.length, 'message')}</span></label>`).join('')}</div>`;
    const ok = await prompt({ title: 'Delete from Telegram?', text: 'These files were removed from your folders. Tick the ones whose messages should be deleted from the group for everyone. This cannot be undone.', noInput: true, body, okLabel: 'Delete ticked from Telegram' });
    if (!ok) return;
    const paths = [...document.querySelectorAll('.check-list input:checked')].map((cb) => list[Number(cb.dataset.i)].path);
    if (!paths.length) return;
    const r = await fg.syncDeleteRemoved(p.id, paths);
    toast(`${plural(r.deleted, 'message')} deleted from Telegram.`, 'ok');
  }
  if (act === 'download') {
    const list = p.result.newOnTelegram;
    const body = `<div class="check-list">${list.map((a, i) => `<label class="file-row"><input type="checkbox" data-i="${i}" checked><span class="fname">${esc(a.title || '(no caption)')}</span>
      <span class="muted small">${esc(a.topic || '')} · ${esc(kindsText(a.kinds))} · ${humanSize(a.size)}</span></label>`).join('')}</div>`;
    const ok = await prompt({ title: 'Download to your folders?', text: `Ticked albums are downloaded into ${p.folders[0]}, by topic and album. They won't be uploaded back.`, noInput: true, body, okLabel: 'Download ticked' });
    if (!ok) return;
    const keys = [...document.querySelectorAll('.check-list input:checked')].map((cb) => list[Number(cb.dataset.i)].key);
    if (!keys.length) return;
    dlDest = p.folders[0];
    const r = await fg.syncDownloadNew(p.id, keys);
    if (r) toast(`${r.done} downloaded, ${r.skipped} skipped, ${r.failed} failed.`, r.failed ? 'error' : 'ok');
  }
}));

async function refreshQueue() {
  state.queue = await guarded(() => fg.queueList()) || [];
  renderQueue();
}

// ---------------------------------------------------------------- wiring

document.querySelectorAll('.seg').forEach((seg) => {
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const name = seg.dataset.name;
    if (name === 'mode') return setMode(b.dataset.value);
    setSeg(name, b.dataset.value);
    if (name === 'loginAs') showAccount();
    if (['topicBy', 'sortBy', 'nameMatch'].includes(name)) scan();
    if (name === 'captionWhere') renderPlan();
    captionHint();
    saveOptions();
  });
});

TOGGLES.forEach((k) => $(k).addEventListener('change', () => {
  saveOptions();
  if (SCAN_INPUTS.includes(k) || PLAN_INPUTS.includes(k)) scan(); else renderPlan();
  captionHint();
}));
let inputTimer;
INPUTS.forEach((k) => $(k).addEventListener(['captionBy', 'captionFormat', 'dupScope', 'dupProbable'].includes(k) ? 'change' : 'input', () => {
  captionHint();
  clearTimeout(inputTimer);
  inputTimer = setTimeout(() => {
    saveOptions();
    if (SCAN_INPUTS.includes(k) || PLAN_INPUTS.includes(k)) scan();
    else if (CAPTION_INPUTS.includes(k)) renderPlan();
  }, k === 'captionBy' || k === 'captionFormat' ? 0 : 450);
}));

$('loginBtn').onclick = () => login();
['apiId', 'apiHash', 'phone', 'botToken'].forEach((k) => $(k).addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); }));
$('logoutBtn').onclick = async () => {
  await guarded(() => fg.logout(state.me && state.me.bot));
  state.me = null; state.groups = []; state.chat = null;
  $('groupSearch').value = '';
  $('groupInfo').innerHTML = '<span class="muted small">No group selected</span>';
  showAccount();
};

$('groupSearch').addEventListener('focus', () => { renderGroupList(); $('groupList').hidden = false; });
$('groupSearch').addEventListener('input', () => { renderGroupList(); $('groupList').hidden = false; });
$('groupSearch').addEventListener('keydown', async (e) => {
  if (e.key === 'Escape') $('groupList').hidden = true;
  if (e.key !== 'Enter') return;
  if (!state.me) return toast('Log in first.', 'error');
  const text = $('groupSearch').value.trim();
  const match = state.groups.find((g) => g.title.toLowerCase() === text.toLowerCase());
  if (match) return chooseGroup(match);
  const chat = await guarded(() => fg.resolveGroup(text));
  if (chat) chooseGroup(chat);
});
$('groupList').addEventListener('mousedown', (e) => {
  const item = e.target.closest('.dd-item');
  if (item) chooseGroup(state.groups.find((g) => g.id === item.dataset.id));
});
$('groupSearch').addEventListener('blur', () => setTimeout(() => { $('groupList').hidden = true; }, 150));
$('refreshGroups').onclick = () => (state.me ? busy($('refreshGroups'), loadGroups) : toast('Log in first.', 'error'));
$('newTopicBtn').onclick = newTopic;
$('topicSelect').onchange = renderPlan;

$('pickFolder').onclick = async () => addSources(await guarded(() => fg.pickFolders()));
$('addFilesBtn').onclick = async () => addSources(await guarded(() => fg.pickFiles()));
$('sources').addEventListener('click', (e) => {
  if (e.target.id === 'clearSources') state.sources = [];
  else if (e.target.dataset.i != null) state.sources.splice(Number(e.target.dataset.i), 1);
  else return;
  renderSources();
  scan();
});
$('showThumbs').addEventListener('change', () => {
  state.thumbsForced = $('showThumbs').checked;
  $('thumbHint').textContent = '';
  saveOptions();
  vlist.heights.clear();
  renderPlan();
});
let searchTimer;
$('planSearch').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => renderPlan({ keepScroll: false }), 200); });
$('lowOnly').addEventListener('change', () => renderPlan({ keepScroll: false }));
$('rescanBtn').onclick = () => scan(true);
$('pauseBtn').onclick = async () => {
  state.paused = !state.paused;
  await guarded(() => fg.pauseUpload(state.paused));
  if (state.paused) $('progressLabel').textContent = 'Pausing after the current album…';
  updateStart();
};
$('typeChips').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const t = b.dataset.type;
  state.types[t] = !state.types[t];
  if (!Object.values(state.types).some(Boolean)) state.types[t] = true; // keep at least one type
  b.classList.toggle('on', state.types[t]);
  saveOptions();
  scan();
});
$('delaySec').addEventListener('input', () => { $('delayLabel').textContent = `${$('delaySec').value} s`; });
$('delaySec').addEventListener('change', saveOptions);
const showPrefix = () => {
  $('albumPrefixWrap').hidden = !$('renameGibberish').checked;
  const p = val('albumPrefix') || 'Album';
  $('prefixExample').textContent = `${p} 1`;
};
$('renameGibberish').addEventListener('change', showPrefix);
$('albumPrefix').addEventListener('input', showPrefix);

// Drag a folder from Explorer onto the window.
let dragDepth = 0;
const fromOutside = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => { if (!fromOutside(e)) return; e.preventDefault(); dragDepth++; $('drop').hidden = false; });
window.addEventListener('dragleave', (e) => { if (!fromOutside(e)) return; if (--dragDepth <= 0) { dragDepth = 0; $('drop').hidden = true; } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('drop').hidden = true;
  if (!fromOutside(e)) return;
  const paths = [...e.dataTransfer.files].map((f) => fg.pathForFile(f)).filter(Boolean);
  if (paths.length) addSources(paths);
});
$('cancelBtn').onclick = () => { fg.cancelUpload(); $('progressLabel').textContent = 'Cancelling…'; };
$('clearHistoryBtn').onclick = async () => {
  const ok = await prompt({ title: 'Forget upload history?', text: 'The next upload will send every file again, even ones already sent. Type YES to confirm.', placeholder: 'YES', okLabel: 'Forget' });
  if (ok && ok.trim().toUpperCase() === 'YES') { await guarded(() => fg.clearHistory()); toast('Upload history cleared', 'ok'); }
};
$('openDataBtn').onclick = () => guarded(() => fg.openData());
$('openLogsBtn').onclick = () => guarded(() => fg.openLogs());
$('saveLogBtn').onclick = () => guarded(async () => {
  const r = await fg.saveLog();
  if (r && r.ok) toast('Log saved', 'ok');
  else if (r && r.error) toast(r.error, 'warn');
});
$('logToggle').onclick = () => {
  $('logPanel').hidden = !$('logPanel').hidden;
  state.logCount = 0;
  $('logBadge').hidden = true;
};
$('logClose').onclick = () => { $('logPanel').hidden = true; };
document.querySelectorAll('[data-link]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); fg.openExternal(a.dataset.link); }));

// ---------------------------------------------------------------- updates

async function checkUpdate(quiet) {
  try {
    const u = await fg.checkUpdate();
    if (u.newer) {
      $('updateTitle').textContent = `FolderGram ${u.latest}`;
      $('updateBanner').hidden = false;
      $('updateGet').onclick = () => fg.openExternal(u.url);
    } else if (!quiet) {
      toast(`You have the latest version (${u.current}).`, 'ok');
    }
  } catch (e) {
    if (!quiet) toast(e.message, 'error');
  }
}
$('checkUpdate').onclick = (e) => { e.preventDefault(); checkUpdate(false); };
$('updateLater').onclick = () => { $('updateBanner').hidden = true; };

// ---------------------------------------------------------------- boot

vlist = new VirtualList({
  container: $('plan'), top: $('vtop'), rows: $('vrows'), bottom: $('vbottom'),
  render: renderRow, key: (r) => r.key, after: afterRow,
  estimate: (r) => {
    if (r.type === 'topic') return 62;
    const perRow = Math.max(1, Math.floor(($('plan').clientWidth - 60) / 184));
    return 44 + Math.ceil(r.sets.length / perRow) * ($('showThumbs').checked ? 222 : 174);
  },
});

(async () => {
  const s = await guarded(() => fg.getSettings()) || {};
  $('apiId').value = s.apiId || '';
  $('apiHash').value = s.apiHash || '';
  $('phone').value = s.phone || '';
  $('botToken').value = s.botToken || '';
  const ui = s.ui || {};
  ['loginAs', 'topicBy', 'captionWhere', 'sortBy', 'nameMatch', 'speed'].forEach((k) => ui[k] && setSeg(k, ui[k]));
  if (ui.types) {
    Object.assign(state.types, ui.types);
    document.querySelectorAll('#typeChips button').forEach((b) => b.classList.toggle('on', !!state.types[b.dataset.type]));
  }
  if (ui.delaySec != null) { $('delaySec').value = ui.delaySec; $('delayLabel').textContent = `${ui.delaySec} s`; }
  if (ui.toggles) TOGGLES.forEach((k) => { if (k in ui.toggles) $(k).checked = !!ui.toggles[k]; });
  if (ui.inputs) INPUTS.forEach((k) => { if (ui.inputs[k] != null && ui.inputs[k] !== '') $(k).value = ui.inputs[k]; });
  // Settings from 2.x: carry over the album-name choice, and offer the new smart naming once.
  if (!ui.v) {
    if (ui.albumPrefix) $('albumPrefix').value = ui.albumPrefix;
    if (ui.captionBy === 'none') $('captionBy').value = 'none';
    else if (ui.captionBy === 'filename') $('captionBy').value = 'filename';
    else $('captionBy').value = 'smart';
    if (s.ui) setTimeout(() => toast('New in 3.0: Smart album names. You can switch back to “Folder name” under Albums & captions.'), 1500);
  }
  $('showThumbs').checked = ui.showThumbs !== false;
  showPrefix();
  setMode(ui.mode || 'per_folder');
  showAccount();
  captionHint();
  state.sources = s.sources || (s.folder ? [s.folder] : []);
  $('appVersion').textContent = `v${s.version}`;
  for (const note of s.recovery || []) toast(note, 'error');
  renderSources();
  state.queue = await guarded(() => fg.queueList()) || [];
  renderQueue();
  if (state.sources.length) scan();
  setTimeout(() => checkUpdate(true), 3000);
  // Reconnect automatically when a saved session exists.
  if ((state.loginAs === 'bot' ? s.hasBotSession : s.hasUserSession) && s.apiId && s.apiHash) {
    await login(true);
    if (s.lastChat && state.groups.length) {
      const g = state.groups.find((x) => x.id === s.lastChat.id);
      if (g) chooseGroup(g);
    }
  }
})();
