// Stand-in Telegram for trying the app window without an account (development only, never packaged):
//   FOLDERGRAM_FAKE_TELEGRAM=test/ui-fake-transport.js npm start
// It is the real Telegram class (so the real upload, pipelining and progress code runs) over a pretend network:
// file parts move at FAKE_MBPS (default 12 MB/s, shared), each request takes FAKE_RTT_MS, and FAKE_OFFLINE_AT_S /
// FAKE_OFFLINE_FOR_S make the connection drop once during the upload. The group already holds a few albums (and keeps
// whatever is "sent" to it), so the library, downloads and folder sync have something to read.
'use strict';

const { Api } = require('telegram');
const bigInt = require('big-integer');
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
  // The pretend chat: Api.Message objects, as Telegram returns them, so the real reading code runs over them.
  const chatMsgs = [];
  const sizeOf = (m) => (m.media.document ? Number(m.media.document.size) : m.media.photo.sizes[m.media.photo.sizes.length - 1].size);
  const photoMedia = (bytes = 300000) => new Api.MessageMediaPhoto({ photo: new Api.Photo({ id: id++, accessHash: 1n, fileReference: Buffer.from('r'), date: 0, dcId: 2,
    sizes: [new Api.PhotoSize({ type: 'm', w: 320, h: 240, size: 9000 }), new Api.PhotoSize({ type: 'y', w: 1280, h: 960, size: bytes })] }) });
  const videoMedia = (name, bytes) => new Api.MessageMediaDocument({ document: new Api.Document({ id: id++, accessHash: 1n, fileReference: Buffer.from('r'), date: 0, dcId: 2, mimeType: 'video/mp4', size: bigInt(bytes),
    thumbs: [new Api.PhotoSize({ type: 'm', w: 320, h: 180, size: 8000 })], attributes: [new Api.DocumentAttributeVideo({ w: 1920, h: 1080, duration: 12 }), new Api.DocumentAttributeFilename({ fileName: name })] }) });
  const post = (topicId, medias, caption, date) => {
    const g = medias.length > 1 ? bigInt(Date.now()).multiply(1000).add(msg) : null;
    medias.forEach((media, i) => chatMsgs.push(new Api.Message({ id: ++msg, peerId: new Api.PeerChannel({ channelId: 4242n }), date: date || Math.floor(Date.now() / 1000), out: true,
      message: i === 0 ? caption || '' : '', media, groupedId: g || undefined,
      replyTo: topicId && topicId !== 1 ? new Api.MessageReplyHeader({ forumTopic: true, replyToMsgId: topicId, replyToTopId: topicId }) : undefined })));
  };
  const day = (d) => Math.floor(Date.parse(d) / 1000);
  post(7, [photoMedia(410000), photoMedia(380000), photoMedia(395000)], 'Spring shoot', day('2025-04-02'));
  post(7, [photoMedia(500000), videoMedia('backstage.mp4', 2600000)], 'Backstage — Part 1 of 2', day('2025-04-03'));
  post(7, [photoMedia(450000)], '', day('2025-04-03'));
  post(7, [photoMedia(420000), photoMedia(430000)], 'Summer', day('2025-07-11'));
  post(1, [photoMedia(250000), photoMedia(260000)], 'Welcome', day('2025-01-10'));
  // Download contents: the same bytes every time for a message, so a resumed file matches a whole one.
  const bytesOf = (m, offset, limit) => {
    const total = sizeOf(m);
    const n = Math.max(0, Math.min(limit, total - offset));
    const b = Buffer.alloc(n);
    for (let i = 0; i < n; i++) b[i] = (m.id * 31 + offset + i) & 255;
    return b;
  };
  const findByFile = (loc) => chatMsgs.find((m) => String((m.media.document || m.media.photo).id) === String(loc.id));
  const historyOf = (req) => {
    const topic = req instanceof Api.messages.GetReplies ? req.msgId : null;
    let list = chatMsgs.filter((m) => (topic ? m.replyTo && m.replyTo.replyToTopId === topic : true)).sort((a, b) => b.id - a.id);
    if (req.offsetId) list = list.filter((m) => m.id < req.offsetId);
    return new Api.messages.Messages({ messages: list.slice(0, req.limit || 100), chats: [], users: [] });
  };
  const thumbJpeg = (seed) => {
    try {
      const { nativeImage } = require('electron');
      const w = 64; const h = 48; const px = Buffer.alloc(w * h * 4);
      for (let i = 0; i < w * h; i++) { px[i * 4] = (seed * 70 + i / 20) & 255; px[i * 4 + 1] = (seed * 40) & 255; px[i * 4 + 2] = 160; px[i * 4 + 3] = 255; }
      return nativeImage.createFromBitmap(px, { width: w, height: h }).toJPEG(80);
    } catch { return null; }
  };
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
        const items = req.multiMedia || [req];
        const topic = req.replyTo && (req.replyTo.topMsgId || req.replyTo.replyToMsgId);
        const first = msg + 1;
        post(topic || 1, items.map((x) => (x.media instanceof Api.InputMediaUploadedDocument ? videoMedia(x.media.file && x.media.file.name || 'file.bin', 1000000) : photoMedia())),
          items[0].message);
        return new Api.Updates({ updates: items.map((_x, i) => new Api.UpdateMessageID({ id: first + i, randomId: 1n })), users: [], chats: [], date: 0, seq: 0 });
      }
      if (req instanceof Api.messages.GetReplies || req instanceof Api.messages.GetHistory) return historyOf(req);
      if (req instanceof Api.channels.GetMessages) {
        const want = new Set(req.id.map((x) => x.id));
        return new Api.messages.Messages({ messages: chatMsgs.filter((m) => want.has(m.id)), chats: [], users: [] });
      }
      if (req instanceof Api.channels.EditForumTopic) { const tp = topics.find((x) => x.id === req.topicId); if (tp) tp.title = req.title; return true; }
      if (req instanceof Api.messages.EditMessage) { const m = chatMsgs.find((x) => x.id === req.id); if (m) m.message = req.message; return true; }
      if (req instanceof Api.channels.DeleteMessages) {
        for (const x of req.id) { const i = chatMsgs.findIndex((m) => m.id === x); if (i >= 0) chatMsgs.splice(i, 1); }
        return true;
      }
      return true;
    },
    uploadFile: async ({ file }) => new Api.InputFile({ id: id++, parts: 1, name: file.name, md5Checksum: '' }),
    getSender: async (dc) => ({ dc }),
    invokeWithSender: async (req) => {
      await net();
      const m = findByFile(req.location);
      if (!m) throw Object.assign(new Error('FILE_REFERENCE_EXPIRED'), { errorMessage: 'FILE_REFERENCE_EXPIRED' });
      const b = bytesOf(m, Number(req.offset), req.limit);
      await transfer(b.length);
      return new Api.upload.File({ type: new Api.storage.FileUnknown(), mtime: 0, bytes: b });
    },
    downloadMedia: async (m) => { await net(); return thumbJpeg(m.id); },
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
  // For UI test scripts (Playwright's app.evaluate): post an album "from someone else" into a topic.
  globalThis.__fakeTelegram = { topics, post: (topicTitle, n, caption) => {
    const tp = topics.find((x) => x.title === topicTitle);
    post(tp ? tp.id : 1, Array.from({ length: n }, () => photoMedia(200000 + n)), caption);
  } };
  return t;
}

module.exports = { create };
