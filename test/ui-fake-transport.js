// Stand-in Telegram for trying the app window without an account (development only, never packaged):
//   FOLDERGRAM_FAKE_TELEGRAM=test/ui-fake-transport.js npm start
// It is the real Telegram class (so the real upload, pipelining and progress code runs) over a pretend network:
// file parts move at FAKE_MBPS (default 12 MB/s, shared), each request takes FAKE_RTT_MS, and FAKE_OFFLINE_AT_S /
// FAKE_OFFLINE_FOR_S make the connection drop once during the upload.
'use strict';

const { Api } = require('telegram');
const { Telegram } = require('../src/core/telegram');

const MB = 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function create() {
  const rate = Number(process.env.FAKE_MBPS || 12) * MB;
  const rtt = Number(process.env.FAKE_RTT_MS || 120);
  const offlineAt = process.env.FAKE_OFFLINE_AT_S ? Date.now() + Number(process.env.FAKE_OFFLINE_AT_S) * 1000 : 0;
  const offlineFor = Number(process.env.FAKE_OFFLINE_FOR_S || 0) * 1000;
  const offline = () => offlineAt && Date.now() >= offlineAt && Date.now() < offlineAt + offlineFor;
  const t = new Telegram({ store: { load: () => 'fake', save() {}, remove() {} }, shrinkPhoto: async () => null });
  let busyUntil = Date.now();
  // One shared line: each part waits its turn, then takes size / rate.
  const transfer = async (bytes) => {
    const start = Math.max(Date.now(), busyUntil);
    busyUntil = start + (bytes / rate) * 1000;
    await sleep(busyUntil - Date.now() + rtt / 2);
  };
  const net = async () => { await sleep(rtt); if (offline()) throw Object.assign(new Error('Not connected'), { errorMessage: 'Not connected' }); };
  let id = 1n;
  let msg = 1000;
  const topics = [{ id: 1, title: 'General' }, { id: 7, title: 'Cosplay' }];
  t.uploadFast = async (file, size, onFrac, ctl) => {
    const parts = Math.max(1, Math.ceil(size / (512 * 1024)));
    for (let i = 0; i < parts; i++) {
      if (ctl.isCanceled && ctl.isCanceled()) throw Object.assign(new Error('USER_CANCELED'), { errorMessage: 'USER_CANCELED' });
      if (offline()) { await sleep(300); throw Object.assign(new Error('Not connected'), { errorMessage: 'Not connected' }); }
      await transfer(Math.min(512 * 1024, size - i * 512 * 1024));
      onFrac((i + 1) / parts);
    }
    return new Api.InputFile({ id: id++, parts, name: file.name, md5Checksum: '' });
  };
  t.client = {
    connected: true,
    connect: async () => {},
    invoke: async (req) => {
      await net();
      if (req instanceof Api.messages.UploadMedia) {
        return new Api.MessageMediaPhoto({ photo: new Api.Photo({ id: id++, accessHash: 1n, fileReference: Buffer.alloc(0), date: 0, sizes: [], dcId: 1 }) });
      }
      if (req instanceof Api.messages.SendMultiMedia || req instanceof Api.messages.SendMedia) {
        const n = req.multiMedia ? req.multiMedia.length : 1;
        return new Api.Updates({ updates: Array.from({ length: n }, () => new Api.UpdateMessageID({ id: ++msg, randomId: 1n })), users: [], chats: [], date: 0, seq: 0 });
      }
      if (req instanceof Api.messages.GetReplies || req instanceof Api.messages.GetHistory) return new Api.messages.Messages({ messages: [], chats: [], users: [] });
      return true;
    },
    uploadFile: async ({ file }) => new Api.InputFile({ id: id++, parts: 1, name: file.name, md5Checksum: '' }),
  };
  const group = new Api.Channel({ id: 4242n, accessHash: 99n, title: 'Test group (stand-in)', forum: true, megagroup: true, photo: new Api.ChatPhotoEmpty(), date: 0 });
  t.login = async () => { t.me = { name: 'Test user', username: 'test', bot: false }; return t.me; };
  t.logout = async () => { t.me = null; };
  t.hasSession = () => true;
  t.listGroups = async () => [t.info(group)];
  t.resolveGroup = async () => t.info(group);
  t.listTopics = async () => { await net(); return topics.map((x) => ({ ...x, closed: false, hidden: false })); };
  t.createTopic = async (_chat, title) => { await net(); const n = { id: topics.length + 10, title }; topics.push(n); return n.id; };
  t.sendText = async () => { await net(); };
  t.videoInfo = async () => null; // no ffmpeg on pretend files
  return t;
}

module.exports = { create };
