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
  for (const p of ['preview', 'queue', 'history', 'naming']) $(`panel-${p}`).hidden = p !== tab;
  if (tab === 'naming') loadNaming();
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
  $('folderSub').textContent = p.done ? `Found ${p.files} files in ${p.folders} folders` : `Scanning… ${p.files} files in ${p.folders} folders`;
});

function setModel(m) {
  state.model = m ? { entries: m.entries.map((e) => ({ ...e, excluded: e.excluded || [] })), files: m.files } : null;
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
    <div class="subfolder-name">📁 ${esc(e.path)}${header}${e.excluded.length ? ` <button class="link-btn" data-act="restore" title="Put left-out files back">${plural(e.excluded.length, 'file')} left out · restore</button>` : ''}</div>
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
  const photoIds = s.fileIds.filter((id) => m.files[id].kind === 'photo').slice(0, 4);
  const grid = showThumbs && photoIds.length
    ? photoIds.map((id) => `<img data-thumb="${id}" ${thumbs.has(id) ? `src="${esc(thumbs.get(id))}"` : ''} alt="">`).join('')
    : `<div class="ph">${kinds.map((k) => KIND_ICON[k] || '📄').join(' ')}</div>`;
  return `<div class="album set${showThumbs ? '' : ' compact'}${state.selected.has(s.id) ? ' selected' : ''}" draggable="true" data-set="${esc(s.id)}" data-entry="${esc(e.id)}">
    <div class="set-top">
      <input type="checkbox" class="sel" data-act="select" ${state.selected.has(s.id) ? 'checked' : ''} title="Select">
      <span class="conf conf-${level}" title="${esc(`${level} confidence${why ? `: ${why}` : ''}`)}">${level === 'high' ? 'High' : level === 'medium' ? 'Medium' : 'Check'}</span>
      ${s.conflict ? '<span class="conf conf-low" title="Another folder in this topic has an album with the same name">Same name</span>' : ''}
    </div>
    <div class="album-grid" data-act="open">${grid}</div>
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
  $('drawerName').value = set.name;
  const a = set.auto || {};
  const albums = setAlbums(entry, set);
  $('drawerInfo').innerHTML = `
    <div><span class="conf conf-${a.level || 'medium'}">${esc(a.level || 'medium')} confidence</span> ${a.source ? `<span class="muted small">from ${esc(a.source.replace('+', ' + '))}</span>` : ''}</div>
    ${a.reasons && a.reasons.length ? `<div class="muted small">${esc(a.reasons.join('; '))}</div>` : ''}
    ${a.original ? `<div class="muted small">Detected from: “${esc(a.original)}”${a.name && a.name !== set.name ? ` · suggested “${esc(a.name)}”` : ''}</div>` : ''}
    <div class="muted small">📁 ${esc(entry.path)} → ${esc(state.mode === 'per_folder' ? entry.topicName : 'chat')}</div>
    <div class="cap-list">${albums.map((x, i) => `<div><span class="muted">Album ${i + 1} · ${x.count} files</span> ${x.caption ? `<span class="album-caption inline">${esc(x.caption)}</span>` : '<span class="muted small">no caption</span>'}</div>`).join('')}</div>`;
  const shown = set.fileIds.slice(0, 1500);
  $('drawerFiles').innerHTML = shown.map((id, i) => {
    const file = m.files[id];
    return `<label class="file-row"><input type="checkbox" data-id="${id}" ${d.picked.has(id) ? 'checked' : ''}><span class="idx">${i + 1}</span>
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
$('drawerExcluded').addEventListener('click', (e) => {
  if (e.target.id !== 'drawerRestore') return;
  const f = findSet(state.drawer.sid);
  edit(() => { f.set.fileIds.push(...f.entry.excluded.splice(0)); });
});

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
  await fg.setRules(rules);
  toast('Rules saved. Rescanning to apply them.', 'ok');
  loadNaming();
  scan();
});
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
