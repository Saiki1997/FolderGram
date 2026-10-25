'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = async (channel, ...args) => {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

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
  scan: (sources, opts) => call('sources:scan', sources, opts),
  checkUpdate: () => call('update:check'),
  startUpload: (cfg) => call('upload:start', cfg),
  cancelUpload: () => call('upload:cancel'),
  pauseUpload: (paused) => call('upload:pause', paused),
  pathForFile: (file) => webUtils.getPathForFile(file),
  clearHistory: () => call('history:clear'),
  openExternal: (url) => call('open:external', url),
  on: (channel, fn) => {
    if (!['log', 'progress', 'upload:done', 'prompt', 'toast'].includes(channel)) return;
    ipcRenderer.on(channel, (_e, payload) => fn(payload));
  },
  replyPrompt: (id, value) => ipcRenderer.send('prompt:reply', { id, value }),
});
