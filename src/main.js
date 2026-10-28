'use strict';

const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell, nativeTheme, nativeImage, Notification, net, session, powerSaveBlocker } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { scanSources, fileKind } = require('./core/scanner');
const { buildModel, materialize, markConflicts } = require('./core/planner');
const { Telegram } = require('./core/telegram');
const { UploadJob, GENERAL_TOPIC_ID } = require('./core/uploader');
const { UploadHistory } = require('./core/history');
const { HashCache } = require('./core/hashing');
const { UploadQueue } = require('./core/queue');
const { NamingMemory } = require('./core/naming-memory');
const { splitVideo } = require('./core/splitter');
const { readJson, writeJson, writeAtomic, dailyBackup, listBackups } = require('./core/store');
const { toCsv } = require('./core/report');
const V = require('./core/validate');
const { DebugLog } = require('./core/debuglog');

const dataDir = () => app.getPath('userData');
const settingsFile = () => path.join(dataDir(), 'settings.json');
const SECRET_KEYS = ['apiHash', 'botToken'];

let win = null;
const recoveryNotes = []; // shown once the window is up
const onRecover = (m) => recoveryNotes.push(m);

// ---------------------------------------------------------------- storage

const canEncrypt = () => { try { return safeStorage.isEncryptionAvailable(); } catch { return false; } };
const seal = (s) => (canEncrypt() ? `enc:${safeStorage.encryptString(s).toString('base64')}` : s);
const unseal = (s) => {
  if (typeof s !== 'string' || !s.startsWith('enc:')) return s;
  try { return safeStorage.decryptString(Buffer.from(s.slice(4), 'base64')); } catch { return ''; }
};

let settingsCache = null;
function loadSettings() {
  if (!settingsCache) {
    const s = readJson(settingsFile(), {}, { onRecover });
    settingsCache = s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  }
  const s = { ...settingsCache };
  for (const k of SECRET_KEYS) if (s[k]) s[k] = unseal(s[k]);
  return s;
}

function saveSettings(patch) {
  const s = { ...loadSettings(), ...patch };
  const out = { ...s };
  for (const k of SECRET_KEYS) if (out[k]) out[k] = seal(out[k]);
  writeJson(settingsFile(), out);
  settingsCache = out;
  return s;
}

const sessionStore = {
  file: (name) => path.join(dataDir(), `session-${name}.dat`),
  load(name) {
    for (const f of [this.file(name), `${this.file(name)}.bak`]) {
      try {
        const v = unseal(fs.readFileSync(f, 'utf8'));
        if (v) return v;
      } catch { /* try the backup */ }
    }
    return null;
  },
  save(name, value) { writeAtomic(this.file(name), seal(value)); },
  remove(name) { for (const f of [this.file(name), `${this.file(name)}.bak`]) { try { fs.unlinkSync(f); } catch { /* gone */ } } },
};

// Created once the app is ready (they need the data folder).
let history, hashCache, memory, queue;

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

// Development only: FOLDERGRAM_FAKE_TELEGRAM names a module with a stand-in transport for UI tests. Never in the packaged app.
const fakeTransport = !app.isPackaged && process.env.FOLDERGRAM_FAKE_TELEGRAM;
const tg = fakeTransport ? require(path.resolve(fakeTransport)).create() : new Telegram({ store: sessionStore, probeVideo, shrinkPhoto });
// Windows knows when the network is gone: no need to wait for Telegram to time out.
tg.isOnline = () => { try { return net.isOnline(); } catch { return true; } };

// ---------------------------------------------------------------- window

function createWindow() {
  nativeTheme.themeSource = 'dark';
  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 1060, minHeight: 680,
    backgroundColor: '#0e1621',
    title: 'FolderGram',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // The window only ever shows FolderGram's own page.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('close', (e) => {
    if (queue && queue.running) {
      const choice = dialog.showMessageBoxSync(win, { type: 'question', buttons: ['Keep uploading', 'Quit'], defaultId: 0,
        message: 'An upload is still running.', detail: 'FolderGram will offer to resume it next time. Albums already sent are not sent again.' });
      if (choice === 0) e.preventDefault();
      else queue.interrupt();
    }
  });
  win.on('closed', () => { win = null; });
}

const send = (channel, payload) => win && !win.isDestroyed() && win.webContents.send(channel, payload);

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
ipcMain.on('prompt:reply', (_e, msg) => {
  const id = msg && Number(msg.id);
  const r = pendingPrompts.get(id);
  if (r) { pendingPrompts.delete(id); r(typeof msg.value === 'string' ? msg.value.slice(0, 256) : null); }
});

// Wrap handlers so errors arrive in the renderer as a readable message. Only FolderGram's own page may call.
function handle(channel, fn) {
  ipcMain.handle(channel, async (e, ...args) => {
    try {
      if (!e.senderFrame || !/^file:/.test(e.senderFrame.url)) throw new Error('Not allowed.');
      return { ok: true, value: await fn(...args) };
    } catch (err) {
      return { ok: false, error: friendlyError(err) };
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
    TOPIC_CLOSED: 'The topic is closed. Reopen it in Telegram, or send these files to another topic.',
    USERNAME_NOT_OCCUPIED: 'No group with that username.',
    USERNAME_INVALID: 'That username is not valid.',
  };
  for (const [k, v] of Object.entries(known)) if (m.includes(k)) return v;
  return m;
}

// ---------------------------------------------------------------- scanning and the plan

const SCAN_KEYS = ['recursive', 'includeAllFiles', 'types', 'sortBy', 'include', 'exclude', 'minSizeMb', 'maxSizeMb', 'includeHidden', 'maxDepth'];
let scan = null; // { key, sources, groups }
let model = null; // current plan model (file objects inside)
let fileTable = []; // id -> file object, for the window's edits
let scanSeq = 0;

const scanKey = (sources, opts) => JSON.stringify([sources, SCAN_KEYS.map((k) => opts[k])]);

/** Plain model for the window: files become ids, so edits can travel back cheaply. */
function serializeModel(m) {
  fileTable = [];
  const ids = new Map();
  const idOf = (f) => {
    if (!ids.has(f)) {
      ids.set(f, fileTable.length);
      fileTable.push(f);
    }
    return ids.get(f);
  };
  const entries = m.entries.map((e) => ({
    id: e.id, topicName: e.topicName, topicAuto: e.topicAuto, topicDetected: e.topicDetected || null, topicSource: e.topicSource, topicId: e.topicId || null, header: e.header,
    path: e.folder.path, leaf: e.folder.leaf, top: e.folder.top, dir: e.folder.dir || '', context: e.context || {},
    sets: e.sets.map((s) => ({ id: s.id, name: s.name, auto: s.auto, conflict: !!s.conflict, fileIds: s.files.map(idOf) })),
    excluded: (e.excluded || []).map(idOf),
  }));
  const files = fileTable.map((f, id) => ({ id, name: f.name, size: f.size, ext: f.ext, kind: fileKind(f), mtime: f.mtime }));
  return { entries, files };
}

/** Applies the window's edits (names, order, moves, exclusions, topic choices) to the model. */
function applyEdits(edits) {
  if (!model) throw new Error('Choose a folder or files first.');
  const byId = new Map(model.entries.map((e) => [e.id, e]));
  const entries = [];
  for (const ed of V.arr(edits && edits.entries, 100000)) {
    const base = byId.get(V.str(ed.id, 64));
    if (!base) continue;
    const sets = [];
    for (const s of V.arr(ed.sets, 100000)) {
      const files = V.arr(s.fileIds, 1000000).map((i) => fileTable[V.int(i, 0, fileTable.length - 1)]).filter(Boolean);
      if (files.length) sets.push({ id: V.str(s.id, 64), name: V.str(s.name, 1024).trim() || 'Album', files, auto: s.auto || {} });
    }
    if (!sets.length) continue;
    entries.push({ ...base, topicName: V.str(ed.topicName, 128).trim() || base.topicName, topicId: ed.topicId ? V.int(ed.topicId, 1, 2 ** 31) : null, sets });
  }
  const m = { entries };
  markConflicts(m.entries);
  return m;
}

function planOptions(o) {
  return {
    captionBy: V.oneOf(o.captionBy, ['smart', 'folder', 'parent', 'filename', 'template', 'none'], 'smart'),
    topicBy: V.oneOf(o.topicBy, ['top', 'each', 'template'], 'top'),
    topicTemplate: V.str(o.topicTemplate, 200), nameTemplate: V.str(o.nameTemplate, 200),
    captionWhere: V.oneOf(o.captionWhere, ['last', 'every', 'first', 'none'], 'last'),
    captionFormat: V.oneOf(o.captionFormat, ['simple', 'detailed', 'series', 'folder', 'custom'], 'simple'),
    captionTemplate: V.str(o.captionTemplate, 300), nameMatch: V.oneOf(o.nameMatch, ['exact', 'series', 'loose'], 'series'),
    renameGibberish: !!o.renameGibberish, albumPrefix: V.str(o.albumPrefix, 60) || 'Album', groupSeries: !!o.groupSeries,
    forceDocument: !!o.forceDocument, useAlbums: o.useAlbums !== false,
  };
}

function scanOptions(o) {
  const types = o.types && typeof o.types === 'object' ? { photo: !!o.types.photo, video: !!o.types.video, audio: !!o.types.audio, other: !!o.types.other } : null;
  return {
    recursive: o.recursive !== false, includeAllFiles: !!o.includeAllFiles, types, sortBy: V.oneOf(o.sortBy, ['name', 'date'], 'name'),
    include: V.str(o.include, 2000), exclude: V.str(o.exclude, 2000), minSizeMb: V.num(o.minSizeMb, 0, 1e6, 0), maxSizeMb: V.num(o.maxSizeMb, 0, 1e6, 0),
    includeHidden: !!o.includeHidden, maxDepth: o.maxDepth ? V.int(o.maxDepth, 0, 1000) : Infinity,
  };
}

handle('sources:scan', async (sources, rawOpts, force) => {
  sources = V.arr(sources, 500).map((p) => V.path(p));
  const opts = V.obj(rawOpts);
  const so = scanOptions(opts);
  const key = scanKey(sources, so);
  const seq = ++scanSeq;
  if (force || !scan || scan.key !== key) {
    const t0 = Date.now();
    const groups = await scanSources(sources, { ...so, onProgress: (p) => send('scan:progress', p), isCancelled: () => seq !== scanSeq });
    if (seq !== scanSeq) return null; // a newer scan replaced this one
    scan = { key, sources, groups, ms: Date.now() - t0 };
    saveSettings({ sources, folder: null });
  }
  model = buildModel(scan.groups, { ...planOptions(opts), memory });
  memory.save(); // new "Album N" stand-ins
  return { ...serializeModel(model), scanMs: scan.ms };
});

handle('plan:captions', (edits, opts) => {
  const m = applyEdits(edits);
  return materialize(m, planOptions(V.obj(opts))).map((e) => ({ id: e.id, albums: e.albums.map((a) => ({ setId: a.setId, caption: a.caption, count: a.files.length })) }));
});

// Thumbnails from the Windows thumbnail cache: small, fast and cached here (LRU).
const thumbCache = new Map();
handle('thumbs:get', async (ids) => {
  const out = {};
  for (const id of V.arr(ids, 64)) {
    const f = fileTable[V.int(id, 0, Math.max(0, fileTable.length - 1))];
    if (!f) continue;
    const k = `${f.path}|${f.mtime}`;
    if (thumbCache.has(k)) { const v = thumbCache.get(k); thumbCache.delete(k); thumbCache.set(k, v); out[id] = v; continue; }
    let url = null;
    try {
      if (nativeImage.createThumbnailFromPath) {
        const img = await nativeImage.createThumbnailFromPath(f.path, { width: 160, height: 160 });
        if (!img.isEmpty()) url = img.toDataURL();
      }
    } catch { /* not supported for this file */ }
    if (!url && fileKind(f) === 'photo' && f.size < 25 * 1024 * 1024) url = pathToFileURL(f.path).href;
    if (url) {
      thumbCache.set(k, url);
      if (thumbCache.size > 600) thumbCache.delete(thumbCache.keys().next().value);
      out[id] = url;
    }
  }
  return out;
});

// ---------------------------------------------------------------- naming memory

handle('naming:get', () => memory.snapshot());
handle('naming:correctAlbum', (c) => {
  c = V.obj(c);
  memory.correctAlbum({ dir: V.str(c.dir, 2000), key: V.str(c.key, 64), from: V.str(c.from, 1024), to: V.str(c.to, 1024), learn: c.learn !== false });
  memory.save();
  return true;
});
handle('naming:correctTopic', (from, to) => { memory.correctTopic(V.str(from, 128), V.str(to, 128)); memory.save(); return true; });
handle('naming:setRules', (rules) => { memory.setRules(V.arr(rules, 200).map(V.obj)); memory.save(); return memory.snapshot(); });
handle('naming:forget', (kind, from) => { memory.forget(V.oneOf(kind, ['learned', 'topics', 'all'], 'learned'), V.str(from, 1024)); memory.save(); return memory.snapshot(); });

// ---------------------------------------------------------------- saved plans

handle('plan:save', async (edits, opts, sources) => {
  const m = applyEdits(edits);
  const r = await dialog.showSaveDialog(win, { title: 'Save album plan', defaultPath: path.join(app.getPath('documents'), 'FolderGram plan.fgplan.json'),
    filters: [{ name: 'FolderGram plan', extensions: ['json'] }] });
  if (r.canceled || !r.filePath) return null;
  const plan = {
    app: 'FolderGram', kind: 'plan', version: 3, savedAt: new Date().toISOString(), sources: V.arr(sources, 500).map((p) => V.path(p)), options: V.obj(opts),
    entries: m.entries.map((e) => ({ id: e.id, topicName: e.topicName, topicAuto: e.topicAuto, topicId: e.topicId || null, header: e.header, context: e.context,
      folder: { path: e.folder.path, leaf: e.folder.leaf, top: e.folder.top, relPath: e.folder.relPath, dir: e.folder.dir },
      sets: e.sets.map((s) => ({ id: s.id, name: s.name, auto: s.auto,
        files: s.files.map((f) => ({ path: f.path, name: f.name, ext: f.ext, size: f.size, mtime: f.mtime, mtimeMs: f.mtimeMs })) })) })),
  };
  writeAtomic(r.filePath, JSON.stringify(plan, null, 1), { backup: false });
  return r.filePath;
});

handle('plan:load', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Open album plan', properties: ['openFile'], filters: [{ name: 'FolderGram plan', extensions: ['json'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  const p = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
  if (!p || p.app !== 'FolderGram' || p.kind !== 'plan' || !Array.isArray(p.entries)) throw new Error('That file is not a FolderGram plan.');
  let missing = 0;
  model = {
    entries: p.entries.map((e) => ({
      ...e, folder: { ...e.folder, files: [] },
      sets: (e.sets || []).map((s) => ({ ...s, files: (s.files || []).filter((f) => { const ok = fs.existsSync(f.path); if (!ok) missing++; return ok; }) })).filter((s) => s.files.length),
    })).filter((e) => e.sets.length),
  };
  for (const e of model.entries) e.folder.files = e.sets.flatMap((s) => s.files);
  markConflicts(model.entries);
  scan = null;
  return { ...serializeModel(model), sources: p.sources || [], options: p.options || {}, missing, file: r.filePaths[0] };
});

// ---------------------------------------------------------------- uploads and the queue

function jobOptions(o) {
  o = V.obj(o);
  const preset = V.oneOf(o.speed, ['conservative', 'balanced', 'fast', 'max', 'custom'], 'balanced');
  return {
    headerMessage: !!o.headerMessage, skipUploaded: o.skipUploaded !== false, skipDuplicates: !!o.skipDuplicates,
    dupScope: V.oneOf(o.dupScope, ['chat', 'topic', 'global'], 'chat'), dupProbable: V.oneOf(o.dupProbable, ['skip', 'upload'], 'skip'),
    forceUpload: V.arr(o.forceUpload, 100000).map((p) => V.path(p)),
    maxFileMb: o.premium ? 4000 : 2000, forceDocument: !!o.forceDocument, silent: !!o.silent, splitVideos: o.splitVideos !== false,
    delayMs: o.delaySec != null ? Math.round(V.num(o.delaySec, 0, 60, 1) * 1000) : null, maxRetries: V.int(o.maxRetries ?? 5, 1, 20),
    bandwidthMbps: V.num(o.bandwidthMbps, 0, 10000, 0), pipeline: o.pipeline !== false,
    concurrency: { preset, adaptive: o.adaptive !== false, custom: preset === 'custom' ? { files: V.int(o.customFiles ?? 3, 1, 8), maxFiles: V.int(o.customFiles ?? 3, 1, 8), connections: V.int(o.customConnections ?? 4, 1, 16) } : null },
  };
}

/** The group's address (type, id, access hash), saved with a job so it can resume after a restart. */
function chatPeer(p) {
  p = V.obj(p);
  const type = V.oneOf(p.type, ['channel', 'chat'], null);
  if (!type || !/^\d{1,20}$/.test(String(p.id || ''))) return null;
  const accessHash = p.accessHash != null && /^-?\d{1,20}$/.test(String(p.accessHash)) ? String(p.accessHash) : null;
  return { type, id: String(p.id), accessHash };
}

/** The plan to upload: the window's edited preview, cut into albums with the chosen caption settings. */
function uploadPlan(edits, opts) {
  return materialize(applyEdits(edits), planOptions(V.obj(opts)));
}

const jobName = (plan) => {
  const tops = [...new Set(plan.map((e) => e.topicName))];
  return tops.length === 1 ? tops[0] : `${tops[0]} + ${tops.length - 1} more`;
};

handle('queue:add', async (spec) => {
  spec = V.obj(spec);
  const chat = V.obj(spec.chat);
  if (!chat.id) throw new Error('Choose a group first.');
  const plan = uploadPlan(spec.edits, spec.options);
  if (!plan.length) throw new Error('Nothing to upload: every album is empty.');
  const mode = V.oneOf(spec.mode, ['per_folder', 'single', 'none'], 'per_folder');
  if (mode === 'per_folder' && !chat.isForum) throw new Error('This group has no topics. Choose "No topics".');
  const overlap = queue.overlap(String(chat.id), plan);
  const job = queue.add({
    name: V.str(spec.name, 200) || jobName(plan), chat: { id: String(chat.id), title: V.str(chat.title, 256), isForum: !!chat.isForum, peer: chatPeer(chat.peer) }, mode,
    topicId: mode === 'single' ? V.int(spec.topicId || GENERAL_TOPIC_ID, 1, 2 ** 31) : null, options: jobOptions(spec.options), plan,
    scheduledAt: spec.scheduledAt ? V.num(spec.scheduledAt, 0, 1e15, 0) || null : null, sources: scan ? scan.sources : [], hold: !!spec.hold,
  });
  dlog.write('job', `queued "${job.name}" → ${job.chat.title} (${mode}), ${plan.length} folders,`,
    `${plan.reduce((n, e) => n + e.albums.length, 0)} albums, ${plan.reduce((n, e) => n + e.albums.reduce((m, al) => m + al.files.length, 0), 0)} files, options`, job.options);
  return { job, overlap };
});
handle('queue:list', () => queue.list());
handle('queue:pause', (id) => { queue.pause(V.str(id, 64)); return true; });
handle('queue:resume', (id) => { queue.resume(V.str(id, 64)); return true; });
handle('queue:cancel', (id) => { queue.cancel(V.str(id, 64)); return true; });
handle('queue:retry', (id) => { queue.retry(V.str(id, 64)); return true; });
handle('queue:remove', (id) => { queue.remove(V.str(id, 64)); return true; });
handle('queue:move', (id, to) => { queue.move(V.str(id, 64), V.int(to, 0, 100000)); return true; });
handle('queue:schedule', (id, at) => { queue.update(V.str(id, 64), { scheduledAt: at ? V.num(at, 0, 1e15, 0) : null }); queue.kick(); return true; });
handle('queue:clearFinished', () => { queue.clearFinished(); return true; });
handle('queue:review', (id, action) => { queue.resolveReview(V.str(id, 64), V.oneOf(action, ['check', 'resend', 'mark'], 'check')); return true; });
handle('queue:report', (id) => queue.report(V.str(id, 64)));

handle('report:export', async (id, format) => {
  const rep = queue.report(V.str(id, 64));
  if (!rep) throw new Error('This job has no report yet.');
  const fmt = V.oneOf(format, ['json', 'csv'], 'json');
  const safe = String(rep.jobName || 'upload').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
  const r = await dialog.showSaveDialog(win, { title: 'Export upload report', defaultPath: path.join(app.getPath('documents'), `FolderGram report - ${safe}.${fmt}`),
    filters: [fmt === 'csv' ? { name: 'CSV', extensions: ['csv'] } : { name: 'JSON', extensions: ['json'] }] });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, fmt === 'csv' ? toCsv(rep) : JSON.stringify(rep, null, 2));
  return r.filePath;
});

// Duplicate review: runs the same checks as an upload, without sending anything.
handle('duplicates:check', async (spec) => {
  spec = V.obj(spec);
  const chat = V.obj(spec.chat);
  const plan = uploadPlan(spec.edits, spec.options);
  const opts = { ...jobOptions(spec.options), skipDuplicates: true, forceUpload: [], mode: V.oneOf(spec.mode, ['per_folder', 'single', 'none'], 'per_folder'),
    topicId: spec.topicId || null };
  const dry = new UploadJob(tg, { id: String(chat.id || 'none'), title: '', isForum: true }, plan, opts, {
    progress: (p) => send('scan:progress', { checking: true, done: p.done, total: p.total }),
  }, history, { hashCache });
  await dry.prepare();
  hashCache.save();
  return { duplicates: dry.report.duplicates, skipped: dry.report.skipped.length };
});

// Older "Start upload" calls go through the queue too.
handle('upload:cancel', () => { if (queue.running) queue.cancel(queue.running.job.id); return true; });
handle('upload:pause', (paused) => {
  if (!queue.running) return false;
  if (paused) queue.pause(queue.running.job.id); else queue.resume(queue.running.job.id);
  return true;
});

// ---------------------------------------------------------------- account, groups, topics

handle('settings:get', () => ({ ...loadSettings(), hasUserSession: tg.hasSession(false), hasBotSession: tg.hasSession(true),
  dataDir: dataDir(), version: app.getVersion(), recovery: recoveryNotes.splice(0) }));
handle('settings:set', (patch) => {
  patch = V.obj(patch);
  const allowed = ['ui', 'lastChat', 'sources'];
  saveSettings(Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k))));
  return true;
});

handle('auth:login', async (creds) => {
  creds = V.obj(creds);
  const c = { apiId: V.str(creds.apiId, 20), apiHash: V.str(creds.apiHash, 64), phone: V.str(creds.phone, 32), botToken: V.str(creds.botToken, 128), asBot: !!creds.asBot };
  saveSettings({ apiId: c.apiId, apiHash: c.apiHash, phone: c.phone, botToken: c.botToken, loginAs: c.asBot ? 'bot' : 'user' });
  return tg.login(c, {
    code: () => ask('code'),
    password: (hint) => ask('password', { hint }),
    error: (message) => send('toast', { kind: 'error', message }),
  });
});
handle('auth:logout', (asBot) => tg.logout(!!asBot));
handle('auth:me', () => tg.me);

handle('groups:list', () => tg.listGroups());
handle('groups:resolve', (text) => tg.resolveGroup(V.str(text, 200)));
handle('topics:list', (chat) => tg.listTopics(V.obj(chat)));
handle('topics:create', (chat, title) => tg.createTopic(V.obj(chat), V.str(title, 128)));

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

handle('history:clear', () => { history.clear(); return true; });
handle('data:open', () => shell.openPath(dataDir()));
handle('logs:open', () => shell.openPath(logsDir()));
handle('logs:save', async () => {
  const newest = dlog && dlog.list().find((f) => f.endsWith('.log'));
  if (!newest) return { ok: false, error: 'There is no log yet.' };
  const r = await dialog.showSaveDialog(win, { title: 'Save debug log', defaultPath: path.join(app.getPath('desktop'), path.basename(newest)),
    filters: [{ name: 'Log file', extensions: ['log', 'txt'] }] });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  fs.copyFileSync(newest, r.filePath);
  shell.showItemInFolder(r.filePath);
  return { ok: true, path: r.filePath };
});
handle('data:backups', () => listBackups(dataDir()));
handle('open:external', (url) => { if (/^https:\/\/[^\s]+$/.test(String(url))) shell.openExternal(String(url)); return true; });

// ---------------------------------------------------------------- start-up and shutdown

const logsDir = () => path.join(dataDir(), 'logs');
let dlog = null;

/** Writes the start of a session to the debug log: versions and the settings that change how uploads run (no secrets). */
function logStart() {
  const s = loadSettings();
  dlog.write('app', `FolderGram ${app.getVersion()} on ${process.platform} ${require('os').release()} ${process.arch},`,
    `Electron ${process.versions.electron}, ${require('os').cpus().length} CPUs, ${Math.round(require('os').totalmem() / 1073741824)} GB RAM`);
  dlog.write('app', `signed in as ${s.loginAs || 'user'}, data folder ${dataDir()}`);
}

function startServices() {
  const dir = dataDir();
  dlog = new DebugLog(logsDir());
  tg.dlog = dlog;
  try { logStart(); } catch { /* the log is best effort */ }
  try { dailyBackup(dir, ['settings.json', 'uploaded.json', 'naming.json']); } catch { /* best effort */ }
  history = new UploadHistory(path.join(dir, 'uploaded.json'), { onRecover });
  hashCache = new HashCache(path.join(dir, 'hash-cache.json'));
  memory = new NamingMemory(path.join(dir, 'naming.json'), { onRecover });
  queue = new UploadQueue({ dir: path.join(dir, 'jobs'), transport: tg, appVersion: app.getVersion(), history, hashCache, splitVideo, friendlyError, onRecover });
  let lastProgress = 0;
  queue.on('changed', (list) => send('queue:changed', list));
  queue.on('log', (l) => { dlog.write('job', l.kind ? `(${l.kind})` : '', l.text); send('log', l); });
  queue.on('wait', (w) => { if (w.seconds) dlog.write('job', `waiting ${w.seconds}s (${w.reason})`); send('wait', w); });
  queue.on('album', (a) => send('album', a));
  queue.on('progress', (p) => {
    // At most ~8 updates a second: thousands of small files would otherwise flood the window.
    const now = Date.now();
    if (now - lastProgress < 120 && p.done < p.total) return;
    lastProgress = now;
    if (win) {
      if (p.phase === 'checking') win.setProgressBar(2, { mode: 'indeterminate' });
      else win.setProgressBar(p.total ? Math.min(1, p.done / p.total) : 1, { mode: queue.running && queue.running.upload.paused ? 'paused' : 'normal' });
    }
    // The snapshot (every file and album) is built only for what is actually sent to the window.
    send('progress', { ...p, snapshot: typeof p.snapshot === 'function' ? p.snapshot() : p.snapshot || null });
  });
  // Keep Windows from sleeping while a job runs (the screen may still turn off).
  let blocker = null;
  queue.on('changed', () => {
    const busy = !!queue.running;
    if (busy && blocker == null) { blocker = powerSaveBlocker.start('prevent-app-suspension'); dlog.write('app', 'keeping the PC awake during the upload'); }
    else if (!busy && blocker != null) { powerSaveBlocker.stop(blocker); blocker = null; }
  });
  queue.on('finished', ({ job }) => {
    dlog.write('job', `job "${job.name}" ended: ${job.status}`, job.stats || {}, job.error ? `error: ${job.error}` : '');
    if (win) {
      win.setProgressBar(-1);
      if (!win.isFocused()) win.flashFrame(true);
    }
    const s = job.stats || {};
    if (Notification.isSupported() && job.status !== 'cancelled' && job.status !== 'interrupted') {
      new Notification({
        title: job.status === 'done' ? 'FolderGram: upload finished' : job.status === 'review' ? 'FolderGram: please check some albums' : 'FolderGram: upload stopped',
        body: `${job.name}: ${s.sent || 0} sent, ${s.skipped || 0} skipped, ${s.failed || 0} failed → ${job.chat.title}`,
      }).show();
    }
    send('upload:done', { ok: ['done', 'failed', 'review'].includes(job.status), error: job.error, stats: s, cancelled: job.status === 'cancelled', job });
  });
}

function flushAll() {
  for (const f of [() => history && history.save(), () => hashCache && hashCache.save(), () => memory && memory.save()]) {
    try { f(); } catch { /* keep going */ }
  }
}

// A bug anywhere must not take the app down silently in the middle of an upload: log it and keep going.
process.on('unhandledRejection', (e) => { try { dlog && dlog.write('app', 'unhandled rejection:', e); } catch { /* ignore */ } });
process.on('uncaughtException', (e) => { try { dlog && dlog.write('app', 'uncaught exception:', e); } catch { /* ignore */ } });

app.setAppUserModelId('app.foldergram'); // needed for Windows notifications
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  startServices();
  createWindow();
});
// On quit, a running job is stopped and marked "interrupted" so it is offered for resuming next time.
let quitReady = false;
app.on('before-quit', (e) => {
  if (quitReady) return;
  e.preventDefault();
  quitReady = true;
  let finished = false;
  const finish = async () => {
    if (finished) return;
    finished = true;
    flushAll();
    try { await Promise.race([tg.disconnect(), new Promise((r) => setTimeout(r, 2000))]); } catch { /* quitting anyway */ }
    app.quit();
  };
  if (queue && queue.running) {
    queue.once('finished', finish);
    queue.interrupt();
    setTimeout(finish, 5000); // never hang the quit on a stuck upload
  } else {
    if (queue) queue.stop();
    finish();
  }
});
app.on('window-all-closed', () => app.quit());
