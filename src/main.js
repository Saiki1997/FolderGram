'use strict';

const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell, nativeTheme, Notification, net } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { scanSources, buildPlan, fileKind } = require('./core/scanner');
const { Telegram } = require('./core/telegram');
const { UploadJob, UploadHistory, GENERAL_TOPIC_ID } = require('./core/uploader');

const dataDir = () => app.getPath('userData');
const settingsFile = () => path.join(dataDir(), 'settings.json');
const SECRET_KEYS = ['apiHash', 'botToken'];

let win = null;
let job = null;
let lastScan = null;

// ---------------------------------------------------------------- storage

const canEncrypt = () => { try { return safeStorage.isEncryptionAvailable(); } catch { return false; } };
const seal = (s) => (canEncrypt() ? `enc:${safeStorage.encryptString(s).toString('base64')}` : s);
const unseal = (s) => {
  if (typeof s !== 'string' || !s.startsWith('enc:')) return s;
  try { return safeStorage.decryptString(Buffer.from(s.slice(4), 'base64')); } catch { return ''; }
};

function loadSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    for (const k of SECRET_KEYS) if (s[k]) s[k] = unseal(s[k]);
    return s;
  } catch {
    return {};
  }
}

function saveSettings(patch) {
  const s = { ...loadSettings(), ...patch };
  const out = { ...s };
  for (const k of SECRET_KEYS) if (out[k]) out[k] = seal(out[k]);
  fs.writeFileSync(settingsFile(), JSON.stringify(out, null, 2));
  return s;
}

const sessionStore = {
  file: (name) => path.join(dataDir(), `session-${name}.dat`),
  load(name) {
    try { return unseal(fs.readFileSync(this.file(name), 'utf8')); } catch { return null; }
  },
  save(name, value) { fs.writeFileSync(this.file(name), seal(value)); },
  remove(name) { try { fs.unlinkSync(this.file(name)); } catch {} },
};

const history = () => new UploadHistory(path.join(dataDir(), 'uploaded.json'));

// ---------------------------------------------------------------- video metadata via the renderer's <video>

async function probeVideo(filePath) {
  if (!win) return null;
  const url = pathToFileURL(filePath).href;
  try {
    const r = await win.webContents.executeJavaScript(`window.fgProbe(${JSON.stringify(url)})`);
    if (!r) return null;
    return { duration: r.duration, width: r.width, height: r.height, thumb: r.thumb ? Buffer.from(r.thumb, 'base64') : null };
  } catch {
    return null;
  }
}

async function shrinkPhoto(filePath) {
  if (!win) return null;
  const url = pathToFileURL(filePath).href;
  const r = await win.webContents.executeJavaScript(`window.fgShrink(${JSON.stringify(url)})`);
  return r ? { buffer: Buffer.from(r.data, 'base64'), width: r.width, height: r.height } : null;
}

const tg = new Telegram({ store: sessionStore, probeVideo, shrinkPhoto });

// ---------------------------------------------------------------- window

function createWindow() {
  nativeTheme.themeSource = 'dark';
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 1020, minHeight: 680,
    backgroundColor: '#0e1621',
    title: 'FolderGram',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('close', (e) => {
    if (job && !job.cancelled) {
      const choice = dialog.showMessageBoxSync(win, { type: 'question', buttons: ['Keep uploading', 'Quit'], defaultId: 0,
        message: 'An upload is still running.', detail: 'You can resume it later: files already sent are skipped.' });
      if (choice === 0) e.preventDefault();
      else job.cancel();
    }
  });
  win.on('closed', () => { win = null; });
}

const send = (channel, payload) => win && win.webContents.send(channel, payload);

// Ask the renderer for text (login code, password) and wait for the answer.
let promptSeq = 0;
const pendingPrompts = new Map();
function ask(kind, extra = {}) {
  const id = ++promptSeq;
  return new Promise((resolve) => {
    pendingPrompts.set(id, resolve);
    send('prompt', { id, kind, ...extra });
  });
}
ipcMain.on('prompt:reply', (_e, { id, value }) => {
  const r = pendingPrompts.get(id);
  if (r) { pendingPrompts.delete(id); r(value); }
});

// Wrap handlers so errors arrive in the renderer as a readable message.
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (e) {
      return { ok: false, error: friendlyError(e) };
    }
  });
}

function friendlyError(e) {
  const m = (e && (e.errorMessage || e.message)) || String(e);
  const known = {
    API_ID_INVALID: 'The API ID / API hash pair is not valid. Copy them again from my.telegram.org.',
    PHONE_NUMBER_INVALID: 'That phone number is not valid. Include the country code, like +60123456789.',
    PHONE_NUMBER_BANNED: 'This phone number is banned by Telegram.',
    ACCESS_TOKEN_INVALID: 'The bot token is not valid.',
    CHAT_ADMIN_REQUIRED: 'You need to be an admin of this group (with "Manage topics") to do that.',
    CHANNEL_FORUM_MISSING: 'This group has no topics. Turn on Topics in the group settings.',
    CHAT_WRITE_FORBIDDEN: 'You are not allowed to post in this group.',
    USERNAME_NOT_OCCUPIED: 'No group with that username.',
    USERNAME_INVALID: 'That username is not valid.',
  };
  for (const [k, v] of Object.entries(known)) if (m.includes(k)) return v;
  return m;
}

// ---------------------------------------------------------------- IPC

handle('settings:get', () => ({ ...loadSettings(), hasUserSession: tg.hasSession(false), hasBotSession: tg.hasSession(true),
  dataDir: dataDir(), version: app.getVersion() }));
handle('settings:set', (patch) => { saveSettings(patch); return true; });

handle('auth:login', async (creds) => {
  saveSettings({ apiId: creds.apiId, apiHash: creds.apiHash, phone: creds.phone, botToken: creds.botToken, loginAs: creds.asBot ? 'bot' : 'user' });
  return tg.login(creds, {
    code: () => ask('code'),
    password: (hint) => ask('password', { hint }),
    error: (message) => send('toast', { kind: 'error', message }),
  });
});
handle('auth:logout', (asBot) => tg.logout(asBot));
handle('auth:me', () => tg.me);

handle('groups:list', () => tg.listGroups());
handle('groups:resolve', (text) => tg.resolveGroup(text));
handle('topics:list', (chat) => tg.listTopics(chat));
handle('topics:create', (chat, title) => tg.createTopic(chat, title));

handle('folder:pick', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'multiSelections'], title: 'Choose folders to upload' });
  return r.canceled ? null : r.filePaths;
});
handle('files:pick', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'], title: 'Choose files to upload',
    filters: [
      { name: 'Photos and videos', extensions: ['jpg', 'jpeg', 'png', 'bmp', 'gif', 'webp', 'heic', 'mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', '3gp', 'wmv'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  return r.canceled ? null : r.filePaths;
});

// Keep the plan small for the window: thumbnails only when asked for, at most 4 per album.
function summarize(plan, opts) {
  return plan.map((e) => ({
    topicName: e.topicName,
    path: e.folder.path,
    header: e.header,
    size: e.folder.totalSize,
    fileCount: e.folder.files.length,
    albums: e.albums.map((a) => ({
      count: a.files.length,
      caption: a.caption,
      kinds: [...new Set(a.files.map((f) => fileKind(f, opts.forceDocument)))],
      preview: opts.preview ? a.files.filter((f) => fileKind(f) === 'photo').slice(0, 4).map((f) => pathToFileURL(f.path).href) : [],
    })),
  }));
}

handle('sources:scan', async (sources, opts) => {
  const plan = buildPlan(await scanSources(sources, opts), opts);
  lastScan = { sources, plan };
  saveSettings({ sources, folder: null });
  return summarize(plan, opts);
});

handle('upload:start', async ({ chat, mode, topicId, options }) => {
  if (job) throw new Error('An upload is already running.');
  if (!lastScan) throw new Error('Choose a folder or files first.');
  const plan = buildPlan(await scanSources(lastScan.sources, options), options); // rescan so new files are included
  let lastSent = 0;
  job = new UploadJob(tg, chat, plan, {
    mode, topicId: topicId || GENERAL_TOPIC_ID, headerMessage: options.headerMessage, skipUploaded: options.skipUploaded,
    maxFileMb: options.premium ? 4000 : 2000, forceDocument: options.forceDocument,
    skipDuplicates: options.skipDuplicates, silent: options.silent, delayMs: Math.round((options.delaySec ?? 1) * 1000),
  }, {
    log: (text, kind) => send('log', { text, kind, at: Date.now() }),
    progress: (p) => {
      // At most ~8 updates a second: thousands of small files would otherwise flood the window.
      const now = Date.now();
      if (now - lastSent < 120 && p.done < p.total) return;
      lastSent = now;
      if (win) win.setProgressBar(p.total ? p.done / p.total : 1, { mode: current.paused ? 'paused' : 'normal' });
      send('progress', p);
    },
  }, history());
  const current = job;
  const finish = (payload) => {
    if (win) {
      win.setProgressBar(-1);
      if (!win.isFocused()) win.flashFrame(true);
    }
    if (Notification.isSupported() && !payload.cancelled) {
      const s = payload.stats;
      new Notification({
        title: payload.ok ? 'FolderGram: upload finished' : 'FolderGram: upload stopped',
        body: payload.ok ? `${s.sent} sent, ${s.skipped} skipped, ${s.failed} failed → ${chat.title}` : payload.error,
      }).show();
    }
    send('upload:done', payload);
  };
  current.run()
    .then((stats) => finish({ ok: true, stats, cancelled: current.cancelled }))
    .catch((e) => finish({ ok: false, error: friendlyError(e), stats: current.stats }))
    .finally(() => { job = null; });
  return true;
});
handle('upload:cancel', () => { if (job) job.cancel(); return true; });
handle('upload:pause', (paused) => {
  if (!job) return false;
  if (paused) job.pause(); else job.resume();
  return true;
});
// ---------------------------------------------------------------- updates (GitHub releases)

const RELEASES_API = 'https://api.github.com/repos/Saiki1997/FolderGram/releases/latest';
const newerThan = (a, b) => {
  const pa = a.replace(/^v/, '').split('.').map(Number), pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};
handle('update:check', async () => {
  const res = await net.fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'FolderGram' } });
  if (!res.ok) throw new Error(`Couldn't check for updates (GitHub said ${res.status}).`);
  const r = await res.json();
  const current = app.getVersion();
  const latest = String(r.tag_name || '').replace(/^v/, '');
  const asset = (r.assets || []).find((a) => /portable\.exe$/i.test(a.name));
  return { current, latest, newer: !!latest && newerThan(latest, current), url: r.html_url, download: asset && asset.browser_download_url,
    notes: (r.body || '').slice(0, 600) };
});

handle('history:clear', () => { history().clear(); return true; });
handle('open:external', (url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return true; });

app.setAppUserModelId('app.foldergram'); // needed for Windows notifications
app.whenReady().then(createWindow);
app.on('window-all-closed', async () => {
  await tg.disconnect();
  app.quit();
});
