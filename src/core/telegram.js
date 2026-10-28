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
const { SenderPool, uploadParallel, partSizeFor, PART } = require('./fastupload');
const { floodSeconds } = require('./retry');
const { mapLimit } = require('./hashing');
const { nullLog } = require('./debuglog');

const MB = 1024 * 1024;
// Answers to UploadMedia that mean the uploaded file is gone or not ready: upload it again under a new id.
const STORE_AGAIN = /WORKER_BUSY|^-503$|Timedout|MEDIA_EMPTY|FILE_PART_\d+_MISSING|FILE_PARTS_INVALID|FILE_ID_INVALID/;
// Answers to a file part that are worth uploading the file again for.
const PART_AGAIN = /WORKER_BUSY|INTERNAL|RPC_CALL_FAIL|RPC_MCGET_FAIL|^-50[03]$|Timedout|TIMEOUT/;
// Answers to a send that mean Telegram lost or refused a stored file; nothing was posted.
const REFUSED = /MEDIA_EMPTY|FILE_PART_\d+_MISSING|FILE_PARTS_INVALID|FILE_ID_INVALID|FILE_REFERENCE/;
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
    this.dlog = nullLog; // debug log on disk (debuglog.js), set by the app
    this.storePauseMs = 1500; // pause before uploading a file Telegram lost again (times the attempt)
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

  /** How files are uploaded right now, for the job log. */
  uploadMode() { return this.fastUpload ? 'fast upload (several connections)' : 'standard upload (one connection)'; }

  /** Uploads one file's bytes. standard: use GramJS' own uploader instead of the multi-connection one. */
  async upload(file, onFrac, ctl = {}, { standard = false } = {}) {
    const size = file.buffer ? file.buffer.length : file.size;
    const t0 = Date.now();
    const done = (how, r) => {
      const s = (Date.now() - t0) / 1000;
      this.dlog.write('upload', `${how} ${file.name} ${size} bytes in ${s.toFixed(1)}s (${(size / 1048576 / Math.max(s, 0.001)).toFixed(1)} MB/s)`,
        `id=${r.id} parts=${r.parts} ${r.className}`);
      return r;
    };
    if (this.fastUpload && !standard && !(ctl.standardUpload && ctl.standardUpload())) {
      try {
        return done(`fast x${ctl.connectionsFor ? ctl.connectionsFor(size) : '?'}`, await this.uploadFast(file, size, onFrac, ctl));
      } catch (e) {
        this.dlog.write('upload', `fast upload of ${file.name} failed:`, e);
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
    // GramJS gives up on a part at the first "worker busy" or internal error; upload the file again after a pause.
    for (let attempt = 1; ; attempt++) {
      try {
        return done(`standard w${workers}`, await this.client.uploadFile({ file: custom, workers, onProgress: progress }));
      } catch (e) {
        if (attempt >= 3 || (ctl.isCanceled && ctl.isCanceled()) || !PART_AGAIN.test((e && (e.errorMessage || e.message)) || '')) throw e;
        this.dlog.write('upload', `standard upload of ${file.name} failed, attempt ${attempt} of 3:`, e);
        await new Promise((r) => setTimeout(r, this.storePauseMs * attempt));
      }
    }
  }

  /**
   * Uploads a file and turns it into a stored photo/document (messages.UploadMedia), so a retry only resends the
   * message. Telegram sometimes answers "worker busy" or stores nothing (an empty photo/document, which later fails
   * the send with MEDIA_EMPTY); the file is then uploaded again under a new id, the second time with GramJS' own
   * uploader, instead of asking again about an upload Telegram has dropped.
   */
  async storeMedia(peer, it, onFrac, ctl, { standard = false } = {}) {
    let useStandard = standard;
    let fastFailed = false;
    for (let attempt = 1; ; attempt++) {
      const fast = this.fastUpload && !useStandard;
      const handle = await this.upload(it.file, onFrac, ctl, { standard: useStandard });
      const built = await this.buildMedia(it.file, handle, it.kind, it.meta);
      let problem;
      try {
        const r = await this.client.invoke(new Api.messages.UploadMedia({ peer, media: built }));
        const stored = r && (r.photo || r.document);
        if (stored && !/Empty$/.test(stored.className || '')) {
          if (fastFailed && !fast) this.fastUploadStrike();
          return getInputMedia(stored);
        }
        problem = `Telegram stored nothing for ${it.file.name} (${(r && r.className) || 'no answer'}${stored ? `/${stored.className}` : ''})`;
      } catch (e) {
        if (!STORE_AGAIN.test((e && (e.errorMessage || e.message)) || '')) {
          this.dlog.write('upload', `UploadMedia ${it.file.name} failed:`, e);
          throw e;
        }
        problem = `Telegram could not store ${it.file.name} (${e.errorMessage || e.message})`;
      }
      if (fast) fastFailed = true;
      this.dlog.write('upload', `${problem}; attempt ${attempt} of 3${attempt < 3 ? ', uploading it again with the standard uploader' : ''}`);
      if (attempt >= 3) throw Object.assign(new Error(`MEDIA_EMPTY: ${problem}`), { errorMessage: 'MEDIA_EMPTY' });
      useStandard = true;
      await new Promise((r) => setTimeout(r, this.storePauseMs * attempt));
    }
  }

  /**
   * A file sent over the extra connections was lost by Telegram but the same file went through with the standard
   * uploader. After two of those the rest of the session uses the standard uploader, which is slower but sure.
   */
  fastUploadStrike() {
    this.fastStrikes = (this.fastStrikes || 0) + 1;
    this.dlog.write('upload', `standard upload worked after a fast upload was lost (${this.fastStrikes} time${this.fastStrikes > 1 ? 's' : ''})`);
    if (this.fastStrikes >= 2 && this.fastUpload) {
      this.fastUpload = false;
      this.dlog.write('upload', 'fast upload turned off until FolderGram is restarted');
    }
  }

  /**
   * Telegram answers WORKER_BUSY_TOO_LONG_RETRY when its media workers are still busy (often right after a batch of
   * photos was uploaded); it means "ask again shortly". Retried here quietly, a few times with short pauses, so it
   * doesn't show up as a failed attempt. Safe for sends: their message ids make a repeat harmless.
   */
  async invokeBusy(request, pauses = [700, 1500, 3000, 5000]) {
    for (let i = 0; ; i++) {
      try {
        return await this.client.invoke(request);
      } catch (e) {
        if (i >= pauses.length || !/WORKER_BUSY_TOO_LONG_RETRY|^-503$|Timedout|WORKER_BUSY/.test((e && (e.errorMessage || e.message)) || '')) throw e;
        await new Promise((r) => setTimeout(r, pauses[i]));
      }
    }
  }

  /** Parts sent in parallel over several connections (fastupload.js). */
  async uploadFast(file, size, onFrac, ctl) {
    if (!this.pool) this.pool = new SenderPool(() => this.connectUploader());
    // Small files don't need many connections; big ones use the speed setting's number.
    const max = ctl.connectionsFor ? ctl.connectionsFor(size) : size > 20 * MB ? 4 : 2;
    const partSize = partSizeFor(size);
    const r = await uploadParallel(this.pool, {
      saveBigPart: (a) => new Api.upload.SaveBigFilePart(a),
      savePart: (a) => new Api.upload.SaveFilePart(a),
    }, file, {
      connections: max,
      partSize,
      perConnection: Math.min(8, Math.max(2, Math.round((2 * PART) / partSize))), // the same bytes in flight as two 512 KB parts
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

    const cacheKey = (it) => `${it.file.path}|${it.file.size}|${it.file.mtime}|${it.kind}|${it.file.buffer ? 'shrunk' : 'orig'}`;
    const uploadAll = async (items, { standard = false } = {}) => {
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
          const key = cacheKey(it);
          if (cache.has(key)) {
            media[i] = cache.get(key);
          } else {
            media[i] = await this.storeMedia(peer, it, (p) => {
              done[i] = p * sizes[i];
              onProgress(Math.min(1, done.reduce((a, b) => a + b, 0) / total), it.file.name);
            }, ctl, { standard });
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
      let media = await uploadAll(items);
      const idsFor = (v) => (ctl.randomIds ? ctl.randomIds(step, items.length, v) : null);
      const silent = !!opts.silent;
      let got;
      try {
        got = messageIds(await sendMessage(media, text, idsFor(variant), silent));
      } catch (e) {
        // Telegram has lost one of the stored files (MEDIA_EMPTY, missing parts): nothing was posted, so upload the
        // album's files again with the standard uploader and send it once more, with new message ids.
        if (!REFUSED.test(e.errorMessage || e.message || '')) throw e;
        this.dlog.write('send', `${items.length} files refused (${e.errorMessage || e.message}); uploading them again with the standard uploader`);
        if (ctl.log) ctl.log(`  ${items.length} files refused by Telegram (${e.errorMessage || e.message}), uploading them again…`, 'warn');
        for (const it of items) cache.delete(cacheKey(it));
        const wasFast = this.fastUpload;
        media = await uploadAll(items, { standard: true });
        try {
          got = messageIds(await sendMessage(media, text, idsFor(variant + 10), silent));
          if (wasFast) this.fastUploadStrike();
        } catch (e2) {
          if (!REFUSED.test(e2.errorMessage || e2.message || '')) throw e2;
          got = await sendSingly(items, media, text, step, variant, silent);
        }
      }
      posted.push(...got);
      this.dlog.write('send', `step ${step} variant ${variant}: ${items.length} files posted as ${got.join(',') || '(no ids reported)'}`);
      if (ctl.stepDone) ctl.stepDone(step, got);
    };

    // Telegram refused the album twice: send the files one at a time so all the others still arrive, and a file
    // Telegram refuses even alone goes as a plain file. Each message keeps its own stable id, so a resumed job
    // doesn't post any of them twice.
    const sendSingly = async (items, media, text, step, variant, silent) => {
      const ids = ctl.randomIds ? ctl.randomIds(step, items.length, variant + 20) : null;
      const fileIds = ctl.randomIds ? ctl.randomIds(step, items.length, variant + 30) : null;
      this.dlog.write('send', `album of ${items.length} refused again; sending the files one at a time`);
      if (ctl.log) ctl.log(`  Telegram refused the album again; sending its ${items.length} files one at a time`, 'warn');
      const got = [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const line = i === items.length - 1 ? text : '';
        try {
          got.push(...messageIds(await sendMessage([media[i]], line, ids && [ids[i]], silent)));
          continue;
        } catch (e) {
          if (!REFUSED.test(e.errorMessage || e.message || '')) throw e;
          this.dlog.write('send', `${it.file.name} refused alone (${e.errorMessage || e.message}); sending it as a file`);
        }
        const handle = await this.upload(it.file, () => {}, ctl, { standard: true });
        const doc = new Api.InputMediaUploadedDocument({ file: handle, mimeType: mimeOf(it.file.ext), forceFile: true,
          attributes: [new Api.DocumentAttributeFilename({ fileName: it.file.name })] });
        got.push(...messageIds(await sendMessage([doc], line, fileIds && [fileIds[i]], silent)));
        if (ctl.log) ctl.log(`  ⚠ ${it.file.name}: Telegram wouldn't take it as a ${it.kind}, sent as a file`, 'warn');
      }
      return got;
    };

    const sendMessage = async (media, text, ids, silent) => {
      let res;
      try {
        if (media.length === 1) {
          res = await this.invokeBusy(new Api.messages.SendMedia({ peer, media: media[0], message: text || '', replyTo: this.replyTo(topicId), silent,
            ...(ids ? { randomId: ids[0] } : {}) }));
        } else {
          const multiMedia = media.map((m, i) => new Api.InputSingleMedia({ media: m, message: i === media.length - 1 ? text || '' : '', ...(ids ? { randomId: ids[i] } : {}) }));
          res = await this.invokeBusy(new Api.messages.SendMultiMedia({ peer, multiMedia, replyTo: this.replyTo(topicId), silent }));
        }
      } catch (e) {
        // Telegram already has messages with these ids: an earlier attempt got through.
        if (!/RANDOM_ID_DUPLICATE/.test(e.errorMessage || '')) {
          this.dlog.write('send', `${media.length} items failed:`, e);
          throw e;
        }
      }
      return res;
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
