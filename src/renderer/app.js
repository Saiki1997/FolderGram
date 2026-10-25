'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  loginAs: 'user', mode: 'per_folder', topicBy: 'top', captionBy: 'folder', captionWhere: 'last', sortBy: 'name',
  types: { photo: true, video: true, audio: true, other: true }, paused: false, speed: null,
  me: null, groups: [], chat: null, topics: [], sources: [], plan: [], uploading: false, logCount: 0,
  nameMatch: 'series', thumbsForced: false,
};
const TOGGLES = ['useAlbums', 'recursive', 'forceDocument', 'includeAllFiles', 'headerMessage', 'skipUploaded', 'skipDuplicates', 'silent', 'premium', 'splitVideos'];
const PLAN_KEYS = ['useAlbums', 'recursive', 'forceDocument', 'includeAllFiles'];
const COLORS = ['#e17076', '#7bc862', '#e5ca77', '#65aadd', '#a695e7', '#ee7aae', '#6ec9cb', '#faa774'];

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initials = (s) => (s || '?').replace(/[^\p{L}\p{N} ]/gu, '').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '#';
const colorFor = (s) => COLORS[[...String(s)].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];
function humanSize(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return i ? `${n.toFixed(1)} ${u[i]}` : `${n} B`;
}

// ---------------------------------------------------------------- small UI pieces

function toast(message, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : 3500);
}

function prompt({ title, text = '', placeholder = '', secret = false, okLabel = 'OK', value = '' }) {
  return new Promise((resolve) => {
    $('modalTitle').textContent = title;
    $('modalText').textContent = text;
    $('modalText').hidden = !text;
    const input = $('modalInput');
    input.type = secret ? 'password' : 'text';
    input.placeholder = placeholder;
    input.value = value;
    $('modalOk').textContent = okLabel;
    $('modal').hidden = false;
    setTimeout(() => input.focus(), 30);
    const done = (v) => {
      $('modal').hidden = true;
      $('modalForm').onsubmit = null;
      $('modalCancel').onclick = null;
      resolve(v);
    };
    $('modalForm').onsubmit = (e) => { e.preventDefault(); done(input.value); };
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

function options() {
  const o = Object.fromEntries(TOGGLES.map((k) => [k, $(k).checked]));
  return { ...o, preview: true, nameMatch: state.nameMatch, types: state.types, sortBy: state.sortBy, delaySec: Number($('delaySec').value), topicBy: state.topicBy, captionBy: state.captionBy === 'none' ? 'folder' : state.captionBy,
    captionWhere: state.captionBy === 'none' ? 'none' : state.captionWhere };
}

function saveOptions() {
  fg.setSettings({ ui: { loginAs: state.loginAs, mode: state.mode, topicBy: state.topicBy, captionBy: state.captionBy,
    sortBy: state.sortBy, types: state.types, nameMatch: state.nameMatch, showThumbs: $('showThumbs').checked, delaySec: Number($('delaySec').value),
    captionWhere: state.captionWhere, toggles: Object.fromEntries(TOGGLES.map((k) => [k, $(k).checked])) } });
}

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
  return { apiId: $('apiId').value.trim(), apiHash: $('apiHash').value.trim(), phone: $('phone').value.trim(),
    botToken: $('botToken').value.trim(), asBot: state.loginAs === 'bot' };
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
    sel.innerHTML = state.topics.map((t) => `<option value="${t.id}">${esc(t.title)}</option>`).join('');
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

// ---------------------------------------------------------------- folder & plan

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
async function scan() {
  const seq = ++scanSeq;
  if (!state.sources.length) {
    state.plan = [];
    renderPlan();
    updateStart();
    return;
  }
  $('folderSub').textContent = 'Scanning…';
  await guarded(async () => {
    const plan = await fg.scan(state.sources, options());
    if (seq !== scanSeq) return; // a newer scan started meanwhile
    state.plan = plan;
    const files = plan.reduce((a, e) => a + e.fileCount, 0);
    if (files > BIG_UPLOAD && !state.thumbsForced) $('showThumbs').checked = false;
    $('thumbHint').textContent = files > BIG_UPLOAD ? `Off by default above ${BIG_UPLOAD} files, to keep FolderGram fast.` : '';
    renderPlan();
  });
  renderSources();
  updateStart();
}

function captionHint() {
  const where = state.captionWhere === 'every' ? 'every album' : 'the last album of each set';
  const hints = {
    folder: `The folder’s name is shown under ${where}.`,
    filename: `Files with the same name share an album, with that name under ${where}. Photo sets ignore numbers (<b>Rem 01.jpg</b>, <b>Rem 02.jpg</b> → <b>Rem</b>). For videos: ${{
      exact: 'only exactly the same name counts (<b>Marin.mp4</b> and <b>Marin 2.mp4</b> are separate).',
      series: 'a number in brackets is ignored (<b>Marin (1).mp4</b>, <b>Marin (2).mp4</b> together), but <b>Marin 2</b> or <b>Marin-copy</b> get their own album.',
      loose: 'any trailing number or “copy” is ignored (<b>Marin 2</b>, <b>Marin-copy</b> join <b>Marin</b>).',
    }[state.nameMatch]}`,
    none: 'Albums are sent without a caption.',
  };
  $('captionHint').innerHTML = hints[state.captionBy];
  $('captionWhereWrap').hidden = state.captionBy === 'none';
  $('nameMatchWrap').hidden = state.captionBy !== 'filename';
}

function renderPlan() {
  captionHint();
  const plan = state.plan;
  $('emptyState').hidden = plan.length > 0;
  $('stats').hidden = !plan.length;
  $('planTools').hidden = !plan.length;
  document.querySelectorAll('.topic').forEach((n) => n.remove());
  if (!plan.length) {
    if (state.sources.length) {
      $('emptyState').querySelector('h3').textContent = 'No media files found';
      $('emptyState').querySelector('p').textContent = 'Try turning on “Include subfolders” or “Include non-media files”.';
    }
    return;
  }

  const perFolder = state.mode === 'per_folder';
  const singleTitle = state.mode === 'single' ? ($('topicSelect').selectedOptions[0]?.textContent || 'General') : (state.chat?.title || 'Group chat');
  const groups = new Map();
  for (const e of plan) {
    const key = perFolder ? e.topicName : singleTitle;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const existing = new Set(state.topics.map((t) => t.title.trim().toLowerCase()));
  const thumbs = $('showThumbs').checked;
  const html = [];
  for (const [name, entries] of groups) {
    const files = entries.reduce((a, e) => a + e.fileCount, 0);
    const size = entries.reduce((a, e) => a + e.size, 0);
    let tag = '';
    if (perFolder && state.chat?.isForum && state.topics.length) {
      tag = existing.has(name.trim().toLowerCase()) ? '<span class="tag">EXISTING TOPIC</span>' : '<span class="tag new">NEW TOPIC</span>';
    }
    html.push(`<div class="topic">
      <div class="topic-head">
        <div class="topic-icon" style="background:${colorFor(name)}">${esc(initials(name))}</div>
        <div><div class="topic-title">${esc(name)}</div><div class="muted small">${files} files · ${humanSize(size)}</div></div>
        ${tag}
      </div>
      <div class="topic-body">${entries.map((e) => `
        <div class="subfolder">
          <div class="subfolder-name">📁 ${esc(e.path)}${!perFolder && $('headerMessage').checked ? ` <span class="tag">“📁 ${esc(e.header)}” first</span>` : ''}</div>
          <div class="albums">${e.albums.slice(0, MAX_ALBUMS_SHOWN).map((a) => albumCard(a, thumbs)).join('')}${e.albums.length > MAX_ALBUMS_SHOWN
            ? `<div class="more-albums">+ ${e.albums.length - MAX_ALBUMS_SHOWN} more albums<br>(all will be sent)</div>` : ''}</div>
        </div>`).join('')}
      </div></div>`);
  }
  $('plan').insertAdjacentHTML('beforeend', html.join(''));
  $('stTopics').textContent = perFolder ? groups.size : plan.length;
  $('stTopicsLabel').textContent = perFolder ? 'topics' : 'folders';
  $('stAlbums').textContent = plan.reduce((a, e) => a + e.albums.length, 0);
  $('stFiles').textContent = plan.reduce((a, e) => a + e.fileCount, 0);
  $('stSize').textContent = humanSize(plan.reduce((a, e) => a + e.size, 0));
}

const MAX_ALBUMS_SHOWN = 12; // per folder; the rest is summarised so huge folders stay quick to show

function albumCard(a, showThumbs) {
  const icon = { video: '🎬', audio: '🎵', document: '📄', animation: '🎞️', photo: '🖼️' };
  const thumbs = showThumbs && a.preview.length
    ? a.preview.map((u) => `<img src="${esc(u)}" loading="lazy" decoding="async" alt="">`).join('')
    : `<div class="ph">${a.kinds.map((k) => icon[k] || '📄').join(' ')}</div>`;
  return `<div class="album${showThumbs ? '' : ' compact'}">
    <div class="album-grid">${thumbs}</div>
    <div class="album-meta"><span>${a.count} ${a.count === 1 ? 'file' : 'files'}</span><span>${a.kinds.map((k) => icon[k]).join('')}</span></div>
    ${a.caption ? `<div class="album-caption" title="${esc(a.caption)}">${esc(a.caption)}</div>` : ''}
  </div>`;
}

// ---------------------------------------------------------------- upload

function updateStart() {
  $('startBtn').disabled = state.uploading || !state.me || !state.chat || !state.plan.length;
  $('startBtn').hidden = state.uploading;
  $('cancelBtn').hidden = !state.uploading;
  $('pauseBtn').hidden = !state.uploading;
  $('pauseBtn').textContent = state.paused ? 'Resume' : 'Pause';
}

async function start() {
  if (state.mode !== 'none' && !state.chat.isForum) return toast('This group has no topics. Choose “No topics”.', 'error');
  const topicId = state.mode === 'single' ? Number($('topicSelect').value) || 1 : null;
  await guarded(async () => {
    await fg.startUpload({ chat: state.chat, mode: state.mode, topicId, options: options() });
    state.uploading = true;
    state.paused = false;
    state.speed = null;
    $('progressFill').classList.remove('complete');
    $('progressFill').style.width = '0%';
    $('progressLabel').textContent = 'Starting…';
    updateStart();
  });
}

function formatEta(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '';
  if (sec < 60) return `${Math.ceil(sec)}s left`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s left`;
  return `${Math.floor(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m left`;
}

fg.on('progress', ({ done, total, label, file }) => {
  const pct = total ? (100 * done) / total : 100;
  // Upload speed as a moving average, for "time left".
  const now = Date.now();
  const sp = state.speed;
  if (!sp || done < sp.done) state.speed = { at: now, done, rate: 0 };
  else if (now - sp.at >= 1000) {
    const rate = (done - sp.done) / ((now - sp.at) / 1000);
    state.speed = { at: now, done, rate: sp.rate ? sp.rate * 0.7 + rate * 0.3 : rate };
  }
  const rate = state.speed.rate;
  const extra = rate > 0 && done < total ? ` · ${humanSize(Math.round(rate))}/s · ${formatEta((total - done) / rate)}` : '';
  $('progressFill').style.width = `${pct.toFixed(1)}%`;
  $('progressPct').textContent = `${pct.toFixed(1)}% · ${humanSize(done)} / ${humanSize(total)}${extra}`;
  $('progressLabel').textContent = file ? `Uploading ${file}` : label;
});

fg.on('upload:done', ({ ok, error, stats, cancelled }) => {
  state.uploading = false;
  updateStart();
  const summary = `${stats.sent} sent · ${stats.skipped} skipped · ${stats.failed} failed`;
  if (!ok) {
    toast(error, 'error');
    $('progressLabel').textContent = `Stopped: ${error}`;
  } else {
    $('progressLabel').textContent = `${cancelled ? 'Cancelled' : 'Finished'} · ${summary}`;
    if (!cancelled) $('progressFill').classList.add('complete');
    toast(cancelled ? 'Upload cancelled' : `Upload finished: ${summary}`, stats.failed ? 'error' : 'ok');
  }
  if (state.mode === 'per_folder') loadTopics();
});

fg.on('log', ({ text, kind, at }) => {
  const line = document.createElement('div');
  line.className = kind ? `l-${kind}` : '';
  const t = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  line.innerHTML = `<time>${t}</time>${esc(text)}`;
  $('log').append(line);
  while ($('log').childElementCount > 1500) $('log').firstElementChild.remove(); // keep the activity panel light
  $('log').scrollTop = $('log').scrollHeight;
  if ($('logPanel').hidden) {
    state.logCount++;
    $('logBadge').hidden = false;
    $('logBadge').textContent = state.logCount;
  }
});

// ---------------------------------------------------------------- wiring

document.querySelectorAll('.seg').forEach((seg) => {
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const name = seg.dataset.name;
    if (name === 'mode') return setMode(b.dataset.value);
    setSeg(name, b.dataset.value);
    if (name === 'loginAs') showAccount();
    if (['topicBy', 'captionBy', 'captionWhere', 'sortBy', 'nameMatch'].includes(name)) scan();
    captionHint();
    saveOptions();
  });
});

TOGGLES.forEach((k) => $(k).addEventListener('change', () => {
  saveOptions();
  if (PLAN_KEYS.includes(k)) scan(); else renderPlan();
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
  renderPlan();
});
$('rescanBtn').onclick = scan;
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

// Drag a folder from Explorer onto the window.
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('drop').hidden = false; });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop').hidden = true; } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('drop').hidden = true;
  const paths = [...e.dataTransfer.files].map((f) => fg.pathForFile(f)).filter(Boolean);
  if (paths.length) addSources(paths);
});
$('startBtn').onclick = start;
$('cancelBtn').onclick = () => { fg.cancelUpload(); $('progressLabel').textContent = 'Cancelling after the current file…'; };
$('clearHistoryBtn').onclick = async () => {
  const ok = await prompt({ title: 'Forget upload history?', text: 'The next upload will send every file again, even ones already sent. Type YES to confirm.', placeholder: 'YES', okLabel: 'Forget' });
  if (ok && ok.trim().toUpperCase() === 'YES') { await guarded(() => fg.clearHistory()); toast('Upload history cleared', 'ok'); }
};
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

(async () => {
  const s = await guarded(() => fg.getSettings()) || {};
  $('apiId').value = s.apiId || '';
  $('apiHash').value = s.apiHash || '';
  $('phone').value = s.phone || '';
  $('botToken').value = s.botToken || '';
  const ui = s.ui || {};
  ['loginAs', 'topicBy', 'captionBy', 'captionWhere', 'sortBy', 'nameMatch'].forEach((k) => ui[k] && setSeg(k, ui[k]));
  if (ui.types) {
    Object.assign(state.types, ui.types);
    document.querySelectorAll('#typeChips button').forEach((b) => b.classList.toggle('on', !!state.types[b.dataset.type]));
  }
  if (ui.delaySec != null) { $('delaySec').value = ui.delaySec; $('delayLabel').textContent = `${ui.delaySec} s`; }
  if (ui.toggles) TOGGLES.forEach((k) => { if (k in ui.toggles) $(k).checked = !!ui.toggles[k]; });
  $('showThumbs').checked = ui.showThumbs !== false;
  setMode(ui.mode || 'per_folder');
  showAccount();
  state.sources = s.sources || (s.folder ? [s.folder] : []);
  $('appVersion').textContent = `v${s.version}`;
  renderSources();
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
