// Telegram side, using GramJS (MTProto). MTProto allows 2 GB uploads (4 GB with Premium) for accounts and
// bots alike, unlike the HTTP Bot API's 50 MB limit.
'use strict';

const path = require('path');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { CustomFile } = require('telegram/client/uploads');
const { getInputMedia, getPeerId } = require('telegram/Utils');
const { fileKind, KIND } = require('./scanner');

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
   */
  constructor({ store, probeVideo }) {
    this.store = store;
    this.probeVideo = probeVideo || (async () => null);
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
      connectionRetries: 5, deviceModel: 'FolderGram', appVersion: '2.0', floodSleepThreshold: 120,
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
    if (this.client) {
      const c = this.client;
      this.client = null;
      await c.destroy().catch(() => {});
    }
  }

  hasSession(asBot) { return !!this.store.load(asBot ? 'bot' : 'user'); }

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
    return topics.map((t) => ({ id: t.id, title: t.title }));
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

  async upload(file, onFrac) {
    return this.client.uploadFile({ file: new CustomFile(file.name, file.size, file.path), workers: 4, onProgress: onFrac });
  }

  async buildMedia(f, handle, forceDocument) {
    const kind = fileKind(f, forceDocument);
    const fileName = new Api.DocumentAttributeFilename({ fileName: f.name });
    if (kind === KIND.PHOTO) return new Api.InputMediaUploadedPhoto({ file: handle });
    if (kind === KIND.VIDEO) {
      const meta = await this.probeVideo(f.path).catch(() => null);
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

  /** Upload files and send them as one album (or one message). The caption goes on the last item. */
  async sendAlbum(chat, files, caption, topicId, opts, onProgress) {
    const peer = this.entity(chat);
    const total = files.reduce((a, f) => a + f.size, 0) || 1;
    const handles = [];
    let before = 0;
    for (const f of files) {
      handles.push(await this.upload(f, (p) => onProgress(Math.min(1, (before + p * f.size) / total), f.name)));
      before += f.size;
    }
    const send = async (forceDocument) => {
      const media = [];
      for (let i = 0; i < files.length; i++) media.push(await this.buildMedia(files[i], handles[i], forceDocument));
      if (media.length === 1) {
        await this.client.invoke(new Api.messages.SendMedia({ peer, media: media[0], message: caption || '', replyTo: this.replyTo(topicId), silent: !!opts.silent }));
        return;
      }
      const multiMedia = [];
      for (let i = 0; i < media.length; i++) {
        const r = await this.client.invoke(new Api.messages.UploadMedia({ peer, media: media[i] }));
        const input = getInputMedia(r.photo || r.document);
        multiMedia.push(new Api.InputSingleMedia({ media: input, message: i === media.length - 1 ? caption || '' : '' }));
      }
      await this.client.invoke(new Api.messages.SendMultiMedia({ peer, multiMedia, replyTo: this.replyTo(topicId), silent: !!opts.silent }));
    };
    try {
      await send(!!opts.forceDocument);
    } catch (e) {
      if (opts.forceDocument || !isPhotoError(e)) throw e;
      await send(true); // Telegram refused a photo (odd size or format): send the same files as documents
    }
  }
}

module.exports = { Telegram, mimeOf };
