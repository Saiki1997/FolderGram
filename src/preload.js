'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = async (channel, ...args) => {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

const EVENTS = ['log', 'progress', 'upload:done', 'prompt', 'toast', 'scan:progress', 'queue:changed', 'wait', 'album'];

contextBridge.exposeInMainWorld('fg', {
  getSettings: () => call('settings:get'),
  setSettings: (patch) => call('settings:set', patch),
  login: (creds) => call('auth:login', creds),
  logout: (asBot) => call('auth:logout', asBot),
  listGroups: () => call('groups:list'),
  resolveGroup: (text) => call('groups:resolve', text),
  listTopics: (chat) => call('topics:list', chat),
  createTopic: (chat, title) => call('topics:create', chat, title),
  pickFolders: () => call('folder:pick'),
  pickFiles: () => call('files:pick'),
  scan: (sources, opts, force) => call('sources:scan', sources, opts, force),
  thumbs: (ids) => call('thumbs:get', ids),
  savePlan: (edits, opts, sources) => call('plan:save', edits, opts, sources),
  loadPlan: () => call('plan:load'),
  naming: () => call('naming:get'),
  correctAlbum: (c) => call('naming:correctAlbum', c),
  correctTopic: (from, to) => call('naming:correctTopic', from, to),
  setRules: (rules) => call('naming:setRules', rules),
  forgetNaming: (kind, from) => call('naming:forget', kind, from),
  checkDuplicates: (spec) => call('duplicates:check', spec),
  queueAdd: (spec) => call('queue:add', spec),
  queueList: () => call('queue:list'),
  queuePause: (id) => call('queue:pause', id),
  queueResume: (id) => call('queue:resume', id),
  queueCancel: (id) => call('queue:cancel', id),
  queueRetry: (id) => call('queue:retry', id),
  queueRemove: (id) => call('queue:remove', id),
  queueMove: (id, to) => call('queue:move', id, to),
  queueSchedule: (id, at) => call('queue:schedule', id, at),
  queueClearFinished: () => call('queue:clearFinished'),
  report: (id) => call('queue:report', id),
  exportReport: (id, format) => call('report:export', id, format),
  checkUpdate: () => call('update:check'),
  cancelUpload: () => call('upload:cancel'),
  pauseUpload: (paused) => call('upload:pause', paused),
  pathForFile: (file) => webUtils.getPathForFile(file),
  clearHistory: () => call('history:clear'),
  openData: () => call('data:open'),
  openLogs: () => call('logs:open'),
  saveLog: () => call('logs:save'),
  backups: () => call('data:backups'),
  openExternal: (url) => call('open:external', url),
  on: (channel, fn) => {
    if (!EVENTS.includes(channel)) return;
    ipcRenderer.on(channel, (_e, payload) => fn(payload));
  },
  replyPrompt: (id, value) => ipcRenderer.send('prompt:reply', { id, value }),
});
