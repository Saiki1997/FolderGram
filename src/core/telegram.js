// Telegram side, using GramJS (MTProto). MTProto allows 2 GB uploads (4 GB with Premium) for accounts and
// bots alike, unlike the HTTP Bot API's 50 MB limit.
'use strict';

const path = require('path');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { CustomFile } = require('telegram/client/uploads');
const { getInputMedia, getPeerId } = require('telegram/Utils');
const { fileKind, KIND } = require('./scanner');
const { sanitize, CAPTION_MAX } = require('./captions');
const media = require('./media');
const { MTProtoSender } = require('telegram/network');
const { SenderPool, uploadParallel } = require('./fastupload');
const { floodSeconds } = require('./retry');
const { mapLimit } = require('./hashing');

const MB = 1024 * 1024;
const PHOTO_MAX_BYTES = 10 * MB; // Telegram's limit for photos (bigger images must be resized or sent as files)

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.bmp': 'image/bmp', '.gif': 'image/gif',
  '.webp': 'image/webp', '.heic': 'image/heic', '.heif': 'image/heif', '.tif': 'image/tiff', '.tiff': 'image/tiff',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.webm': 'video/webm', '.avi': 'video/x-msvideo', '.3gp': 'video/3gpp', '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv', '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg', '.ts': 'video/mp2t',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg', '.wav': 'audio/wav', '.wma': 'audio/x-ms-wma',
};
const mimeOf = (ext) => MIME[ext] || 'application/octet-stream';
const isPhotoError = (e) => /PHOTO_|IMAGE_PROCESS_FAILED|MEDIA_INVALID/.test((e && e.errorMessage) || '');

class Telegram {
  /**
   * store: { load(name) -> string|null, save(name, string), remove(name) } for the login session.
   * probeVideo(filePath) -> Promise<{duration,width,height,thumb?:Buffer}|null>, optional.
   * shrinkPhoto(filePath) -> Promise<{buffer:Buffer,width,height}|null>, optional: JPEG at most 2560 px.
   */
  constructor({ store, probeVideo, shrinkPhoto }) {
    this.store = store;
    this.probeVideo = probeVideo || (async () => null);
    this.pool = null; // extra upload connections, see fastupload.js
    this.fastUpload = true;
    this.videoMeta = new Map(); // path|size|mtime -> probe result, so retries don't probe again
    this.shrinkPhoto = shrinkPhoto || (async () => null);
    this.client = null;
    this.entities = new Map(); // chat id -> entity
    this.me = null;
  }

  /** prompts: { code(): Promise<string>, password(hint): Promise<string> } */
  async login({ apiId, apiHash, asBot, phone, botToken }, prompts) {
    await this.disconnect();
    const name = asBot ? 'bot' : 'user';
    const session = new StringSession(this.store.load(name) || '');
    const client = new TelegramClient(session, Number(apiId), apiHash, {
      // Flood waits longer than 5 s come back to FolderGram, which shows them and lets Cancel interrupt them.
      connectionRetries: 5, deviceModel: 'FolderGram', appVersion: '3.0', floodSleepThreshold: 5,
    });
    client.setLogLevel('error');
    let failure = null;
    await client.start(asBot ? { botAuthToken: botToken } : {
      phoneNumber: async () => phone,
      phoneCode: async () => {
        const c = await prompts.code();
        if (!c) throw new Error('Login cancelled');
        return c.trim();
      },
      password: async (hint) => {
        const p = await prompts.password(hint);
        if (!p) throw new Error('Login cancelled');
        return p;
      },
      onError: async (e) => {
        // Wrong code or password: GramJS asks again. Anything else: stop.
        if (/PHONE_CODE_INVALID|PASSWORD_HASH_INVALID/.test(e.errorMessage || '')) {
          prompts.error && prompts.error(e.errorMessage === 'PHONE_CODE_INVALID' ? 'That code is wrong, try again.' : 'Wrong password, try again.');
          return false;
        }
        failure = e;
        return true;
      },
    });
    if (failure) {
      await client.disconnect().catch(() => {});
      throw failure;
    }
    this.client = client;
    this.store.save(name, client.session.save());
    const me = await client.getMe();
    this.me = { name: [me.firstName, me.lastName].filter(Boolean).join(' ') || me.username, username: me.username, bot: !!me.bot };
    return this.me;
  }

  async logout(asBot) {
    if (this.client) {
      try { await this.client.invoke(new Api.auth.LogOut()); } catch {}
      await this.disconnect();
    }
    this.store.remove(asBot ? 'bot' : 'user');
    this.me = null;
  }

  async disconnect() {
    if (this.pool) { const p = this.pool; this.pool = null; await p.close(); }
    if (this.client) {
      const c = this.client;
      this.client = null;
      await c.destroy().catch(() => {});
    }
  }

  hasSession(asBot) { return !!this.store.load(asBot ? 'bot' : 'user'); }

  /** Reconnects after a network drop (GramJS also retries on its own). */
  async ensureConnected() {
    if (this.client && !this.client.connected) await this.client.connect();
  }

  /**
   * Looks for an album we may already have posted (after a lost reply): our own grouped messages in the topic,
   * sent since `since` (unix seconds), with `count` items and the same caption. Returns their ids or null.
   */
  async findRecentAlbum(chat, topicId, { since, count, caption }) {
    const peer = this.entity(chat);
    const res = topicId
      ? await this.client.invoke(new Api.messages.GetReplies({ peer, msgId: topicId, offsetId: 0, offsetDate: 0, addOffset: 0, limit: 40, maxId: 0, minId: 0, hash: 0n }))
      : await this.client.invoke(new Api.messages.GetHistory({ peer, offsetId: 0, offsetDate: 0, addOffset: 0, limit: 40, maxId: 0, minId: 0, hash: 0n }));
    const mine = (res.messages || []).filter((m) => m instanceof Api.Message && m.out && m.date >= since - 5 && m.media);
    const groups = new Map();
    for (const m of mine) {
      const k = m.groupedId ? String(m.groupedId) : `single:${m.id}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(m);
    }
    const want = sanitize(caption || '', CAPTION_MAX);
    for (const ms of groups.values()) {
      if (ms.length !== count) continue;
      const text = ms.map((m) => m.message || '').find(Boolean) || '';
      if (text === want) return ms.map((m) => m.id).sort((a, b) => a - b);
    }
    return null;
  }

  info(entity) {
    const id = getPeerId(entity).toString();
    this.entities.set(id, entity);
    return { id, title: entity.title || entity.firstName || id, isForum: !!entity.forum, username: entity.username || null,
      members: entity.participantsCount || null };
  }

  async listGroups() {
    const out = [];
    for await (const d of this.client.iterDialogs({})) {
      if (d.isGroup) out.push(this.info(d.entity));
    }
    return out;
  }

  /** @username, t.me/name link, or numeric id like -1001234567890. */
  async resolveGroup(text) {
    let t = text.trim().replace(/^https?:\/\/(t|telegram)\.me\//i, '').replace(/^@/, '');
    const target = /^-?\d+$/.test(t) ? t : t.split('/')[0];
    const entity = await this.client.getEntity(target);
    return this.info(entity);
  }

  entity(chat) {
    const e = this.entities.get(String(chat.id));
    if (!e) throw new Error('Pick the group again.');
    return e;
  }

  async listTopics(chat) {
    const channel = this.entity(chat);
    const topics = [];
    let offsetDate = 0, offsetId = 0, offsetTopic = 0;
    for (;;) {
      const res = await this.client.invoke(new Api.channels.GetForumTopics({ channel, offsetDate, offsetId, offsetTopic, limit: 100 }));
      const batch = res.topics.filter((t) => t instanceof Api.ForumTopic);
      topics.push(...batch);
      if (!batch.length || res.topics.length < 100 || topics.length >= res.count) break;
      const last = batch[batch.length - 1];
      const msg = res.messages.find((m) => m.id === last.topMessage);
      offsetTopic = last.id;
      offsetId = last.topMessage;
      offsetDate = msg ? msg.date : 0;
    }
    return topics.map((t) => ({ id: t.id, title: t.title, closed: !!t.closed, hidden: !!t.hidden }));
  }

  async createTopic(chat, title) {
    const res = await this.client.invoke(new Api.channels.CreateForumTopic({ channel: this.entity(chat), title: title.slice(0, 128) }));
    for (const u of res.updates || []) {
      const m = u.message;
      if (m instanceof Api.MessageService && m.action instanceof Api.MessageActionTopicCreate) return m.id;
    }
    throw new Error(`Telegram did not return the new topic id for "${title}"`);
  }

  replyTo(topicId) {
    return topicId ? new Api.InputReplyToMessage({ replyToMsgId: topicId, topMsgId: topicId }) : undefined;
  }

  async sendText(chat, text, topicId, opts = {}) {
    await this.client.invoke(new Api.messages.SendMessage({ peer: this.entity(chat), message: text, replyTo: this.replyTo(topicId), silent: !!opts.silent }));
  }

  /**
   * One more connection to the account's own data center, authorised with the same key, for uploading parts.
   * Built like GramJS' own upload connection, but several of them.
   */
  async connectUploader() {
    let sender = null;
    let timer;
    try {
      const c = this.client;
      const dcId = c.session.dcId;
      sender = new MTProtoSender(c.session.getAuthKey(dcId), {
        logger: c._log, dcId, retries: c._connectionRetries, delay: c._retryDelay, autoReconnect: c._autoReconnect,
        connectTimeout: c._timeout, authKeyCallback: c._authKeyCallback.bind(c), isMainSender: true,
        onConnectionBreak: () => {}, client: c, securityChecks: c._securityChecks, _exportedSenderPromises: new Map(),
        reconnectRetries: c._reconnectRetries,
      });
      // GramJS retries a failed connect forever; give up after 20 s so the upload can fall back.
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), 20000); });
      return await Promise.race([c._connectSender(sender, dcId), timeout]);
    } catch (e) {
      if (sender) sender.disconnect().catch(() => {});
      throw Object.assign(new Error(`Couldn't open an upload connection: ${e.message}`), { connectFailed: true });
    } finally {
      clearTimeout(timer);
    }
  }

  async upload(file, onFrac, ctl = {}) {
    const size = file.buffer ? file.buffer.length : file.size;
    if (this.fastUpload) {
      try {
        return await this.uploadFast(file, size, onFrac, ctl);
      } catch (e) {
        // A connection problem with the extra connections: use GramJS' own single-connection upload instead.
        if (!e.connectFailed) throw e;
        this.fastUpload = false;
      }
    }
    // Bigger files get more parallel connections; small ones don't need them.
    const workers = ctl.workersFor ? ctl.workersFor(size) : size > 20 * MB ? 8 : size > 2 * MB ? 4 : 2;
    const custom = file.buffer ? new CustomFile(file.name, file.buffer.length, '', file.buffer) : new CustomFile(file.name, file.size, file.path);
    const progress = (p) => onFrac(p);
    // GramJS stops the upload between parts when its progress callback says it was cancelled.
    Object.defineProperty(progress, 'isCanceled', { get: () => !!(ctl.isCanceled && ctl.isCanceled()) });
    return this.client.uploadFile({ file: custom, workers, onProgress: progress });
  }

  /** Parts sent in parallel over several connections (fastupload.js). */
  async uploadFast(file, size, onFrac, ctl) {
    if (!this.pool) this.pool = new SenderPool(() => this.connectUploader());
    // Small files don't need many connections; big ones use the speed setting's number.
    const max = ctl.connectionsFor ? ctl.connectionsFor(size) : size > 20 * MB ? 4 : 2;
    const r = await uploadParallel(this.pool, {
      saveBigPart: (a) => new Api.upload.SaveBigFilePart(a),
      savePart: (a) => new Api.upload.SaveFilePart(a),
    }, file, {
      connections: max,
      perConnection: 2,
      onProgress: onFrac,
      isCanceled: () => !!(ctl.isCanceled && ctl.isCanceled()),
      floodSeconds,
      isDisconnect: (e) => /Not connected|disconnect|Connection closed|ECONNRESET|TIMEOUT/i.test((e && (e.errorMessage || e.message)) || ''),
    });
    return r.big
      ? new Api.InputFileBig({ id: r.id, parts: r.parts, name: r.name })
      : new Api.InputFile({ id: r.id, parts: r.parts, name: r.name, md5Checksum: '' });
  }

  /** Length, size and thumbnail of a video: ffmpeg first (it reads every format), the window's player second. */
  async videoInfo(f) {
    const key = `${f.path}|${f.size}|${f.mtime}`;
    if (this.videoMeta.has(key)) return this.videoMeta.get(key);
    let meta = await media.probe(f.path).catch(() => null);
    if (!meta || !meta.width) {
      const r = await this.probeVideo(f.path).catch(() => null);
      if (r && r.width) meta = { ...(meta || {}), ...r, thumb: r.thumb || (meta && meta.thumb) || null };
    }
    meta = meta && meta.width ? meta : null;
    if (this.videoMeta.size > 500) this.videoMeta.clear();
    this.videoMeta.set(key, meta);
    return meta;
  }

  async buildMedia(f, handle, kind, meta = null) {
    const fileName = new Api.DocumentAttributeFilename({ fileName: f.name });
    if (kind === KIND.PHOTO) return new Api.InputMediaUploadedPhoto({ file: handle });
    if (kind === KIND.VIDEO) {
      meta = meta || await this.videoInfo(f);
      const attrs = [fileName];
      let thumb;
      if (meta && meta.width) {
        attrs.unshift(new Api.DocumentAttributeVideo({ duration: meta.duration || 0, w: meta.width, h: meta.height, supportsStreaming: true }));
        if (meta.thumb) {
          thumb = await this.client.uploadFile({ file: new CustomFile('thumb.jpg', meta.thumb.length, '', meta.thumb), workers: 1 });
        }
      }
      return new Api.InputMediaUploadedDocument({ file: handle, mimeType: mimeOf(f.ext), attributes: attrs, thumb });
    }
    if (kind === KIND.AUDIO) {
      return new Api.InputMediaUploadedDocument({ file: handle, mimeType: mimeOf(f.ext),
        attributes: [new Api.DocumentAttributeAudio({ duration: 0, title: path.parse(f.name).name }), fileName] });
    }
    if (kind === KIND.ANIMATION) {
      return new Api.InputMediaUploadedDocument({ file: handle, mimeType: 'image/gif', attributes: [fileName, new Api.DocumentAttributeAnimated()] });
    }
    return new Api.InputMediaUploadedDocument({ file: handle, mimeType: mimeOf(f.ext), attributes: [fileName], forceFile: true });
  }

  /**
   * Work out how each file is sent. Photos over Telegram's 10 MB photo limit (or with sizes it refuses) are
   * resized to 2560 px, the largest size Telegram keeps for photos anyway, so they stay in the album instead
   * of arriving as files. If resizing isn't possible the photo is sent as a file.
   */
  async prepare(files, forceDocument, shrinkAll, { photosAsFiles = false, cleanups = [] } = {}) {
    const items = [];
    // Read all videos' details up front, a few at a time, instead of one after another.
    if (!forceDocument) await mapLimit(files.filter((f) => fileKind(f, !!f.asDocument) === KIND.VIDEO), 4, (f) => this.videoInfo(f));
    for (const f of files) {
      let kind = fileKind(f, forceDocument || !!f.asDocument);
      let file = f;
      let meta = null;
      if (kind === KIND.PHOTO && photosAsFiles) kind = KIND.DOC;
      if (kind === KIND.VIDEO) {
        // A video Telegram can't show as a video (no readable picture) goes with the files instead of turning
        // the whole album into files. Formats like .ts and .mkv are rewrapped into MP4 so they play inline.
        meta = await this.videoInfo(f);
        if (!meta) {
          kind = KIND.DOC;
        } else if (media.needsRemux(f.ext, meta)) {
          const r = await media.remuxToMp4(f, meta).catch(() => null);
          if (r) { cleanups.push(r.cleanup); file = r.file; } else kind = KIND.DOC;
        } else if (!media.PLAYABLE.has(f.ext) && f.ext !== '.webm') {
          kind = KIND.DOC;
        }
      }
      if (kind === KIND.PHOTO && (shrinkAll || f.size > PHOTO_MAX_BYTES)) {
        const small = await this.shrinkPhoto(f.path).catch(() => null);
        if (small && small.buffer.length <= PHOTO_MAX_BYTES) {
          file = { ...f, name: f.name.replace(/\.[^.]+$/, '.jpg'), buffer: small.buffer };
        } else {
          kind = KIND.DOC;
        }
      }
      items.push({ file, kind, meta });
    }
    return items;
  }

  /**
   * Upload files and send them as one album (or one message). The caption goes on the last item.
   * ctl (from the uploader, optional): randomIds(step, count, variant) gives stable message ids so a retry can't
   * post twice; isDone/stepDone track which messages of the album are already posted; isCanceled stops uploads;
   * concurrency() and workersFor(size) set parallelism; mediaCache keeps uploaded files for retries.
   * Returns the ids of the posted messages when Telegram reports them.
   */
  async sendAlbum(chat, files, caption, topicId, opts, onProgress, ctl = {}) {
    const peer = this.entity(chat);
    const cache = ctl.mediaCache || new Map();
    const posted = [];
    caption = sanitize(caption || '', CAPTION_MAX);

    const uploadAll = async (items) => {
      const sizes = items.map((it) => (it.file.buffer ? it.file.buffer.length : it.file.size));
      const total = sizes.reduce((a, b) => a + b, 0) || 1;
      const done = sizes.map(() => 0);
      const media = new Array(items.length);
      let next = 0;
      const report = () => onProgress(Math.min(1, done.reduce((a, b) => a + b, 0) / total));
      const worker = async () => {
        while (next < items.length) {
          const i = next++;
          const it = items[i];
          const key = `${it.file.path}|${it.file.size}|${it.file.mtime}|${it.kind}|${it.file.buffer ? 'shrunk' : 'orig'}`;
          if (cache.has(key)) {
            media[i] = cache.get(key);
          } else {
            const handle = await this.upload(it.file, (p) => {
              done[i] = p * sizes[i];
              onProgress(Math.min(1, done.reduce((a, b) => a + b, 0) / total), it.file.name);
            }, ctl);
            const built = await this.buildMedia(it.file, handle, it.kind, it.meta);
            // Turn the upload into a stored photo/document now, so a retry only resends the message.
            const r = await this.client.invoke(new Api.messages.UploadMedia({ peer, media: built }));
            media[i] = getInputMedia(r.photo || r.document);
            cache.set(key, media[i]);
          }
          done[i] = sizes[i];
          report();
        }
      };
      const n = Math.min(ctl.concurrency ? ctl.concurrency() : 3, items.length);
      await Promise.all(Array.from({ length: Math.max(1, n) }, worker));
      return media;
    };

    // Telegram can't mix files with photos/videos in one album. If a photo had to become a file,
    // send the files as their own album; the caption stays on the last one.
    const send = async (items, variant) => {
      const visual = items.filter((it) => it.kind === KIND.PHOTO || it.kind === KIND.VIDEO);
      const rest = items.filter((it) => !visual.includes(it));
      if (visual.length && rest.length) {
        await sendOne(visual, '', 0, variant);
        return sendOne(rest, caption, 1, variant);
      }
      return sendOne(items, caption, 0, variant);
    };

    const sendOne = async (items, text, step, variant) => {
      if (ctl.isDone && ctl.isDone(step)) return; // posted before an interruption
      const media = await uploadAll(items);
      const ids = ctl.randomIds ? ctl.randomIds(step, media.length, variant) : null;
      const silent = !!opts.silent;
      let res;
      try {
        if (media.length === 1) {
          res = await this.client.invoke(new Api.messages.SendMedia({ peer, media: media[0], message: text || '', replyTo: this.replyTo(topicId), silent,
            ...(ids ? { randomId: ids[0] } : {}) }));
        } else {
          const multiMedia = media.map((m, i) => new Api.InputSingleMedia({ media: m, message: i === media.length - 1 ? text || '' : '', ...(ids ? { randomId: ids[i] } : {}) }));
          res = await this.client.invoke(new Api.messages.SendMultiMedia({ peer, multiMedia, replyTo: this.replyTo(topicId), silent }));
        }
      } catch (e) {
        // Telegram already has messages with these ids: an earlier attempt got through.
        if (!/RANDOM_ID_DUPLICATE/.test(e.errorMessage || '')) throw e;
      }
      const got = messageIds(res);
      posted.push(...got);
      if (ctl.stepDone) ctl.stepDone(step, got);
    };

    const force = !!opts.forceDocument;
    const cleanups = [];
    try {
      // Telegram refused a photo or video (odd size or format): resize every photo and try again, then send the
      // photos as files (videos stay videos), and only then everything as files.
      const attempts = force ? [[true, false, {}]] : [[false, false, {}], [false, true, {}], [false, false, { photosAsFiles: true }], [true, false, {}]];
      for (let v = 0; v < attempts.length; v++) {
        const [asFiles, shrink, extra] = attempts[v];
        try {
          await send(await this.prepare(files, asFiles, shrink, { ...extra, cleanups }), force ? 0 : v);
          break;
        } catch (e) {
          if (force || !isPhotoError(e) || v === attempts.length - 1) throw e;
        }
      }
    } finally {
      for (const c of cleanups) await c();
    }
    return { messageIds: posted };
  }
}

/** Message ids from a send result (UpdateMessageID entries, or new-message updates). */
function messageIds(res) {
  const out = [];
  for (const u of (res && res.updates) || []) {
    if (u instanceof Api.UpdateMessageID) out.push(u.id);
  }
  if (!out.length) {
    for (const u of (res && res.updates) || []) if (u.message && u.message.id && !(u.message instanceof Api.MessageService)) out.push(u.message.id);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

module.exports = { Telegram, mimeOf };
