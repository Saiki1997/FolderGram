// A stand-in Telegram for upload tests (not a test file itself). It behaves like the real one where it matters:
// messages with a random id it already has are refused with RANDOM_ID_DUPLICATE, posted albums are stored with ids,
// dates, captions and grouped ids, and the delivery check reads them the way telegram.js reads the real chat.
'use strict';

const { matchAlbum } = require('../src/core/reconcile');

const err = (m, extra = {}) => Object.assign(new Error(m), { errorMessage: m, ...extra });

class FakeTelegram {
  /**
   * topics: [[id, title, closed]]
   * failures: script for sends, one entry per send: { when: "before" | "after", error } ("after": posted, reply lost),
   *   { hang: true } (never answers), { hangAfter: true } (posts, then never answers), or null (works).
   */
  constructor({ topics = [], failures = [] } = {}) {
    this.topics = topics.map(([id, title, closed]) => ({ id, title, closed: !!closed }));
    this.failures = failures;
    this.posts = [];
    this.ids = new Set();
    this.nextMsg = 1000;
    this.nextTopic = 100;
    this.offline = false;
    this.sendCalls = 0;
    this.checks = 0;
    this.checkResult = null; // force a delivery-check answer, e.g. { ids: null, complete: false }
    this.clock = 1_700_000_000; // Telegram's clock (unix s); serverNow() follows real time from here
    this.t0 = Date.now();
    this.deletedTopics = new Set();
    this.progressScript = null; // fractions reported while "uploading"
  }

  serverNow() { return this.clock + Math.floor((Date.now() - this.t0) / 1000); }
  online() { if (this.offline) throw err('Not connected'); }
  async checkConnection() { return !this.offline; }
  async ensureConnected() {}

  async listTopics() { this.online(); return this.topics.filter((t) => !this.deletedTopics.has(t.id)).map((t) => ({ ...t })); }
  async createTopic(_c, title) {
    this.online();
    this.topics.push({ id: ++this.nextTopic, title });
    return this.nextTopic;
  }
  async sendText(_c, text, topicId) { this.online(); this.posts.push({ text, topicId, ids: [++this.nextMsg] }); }

  async sendAlbum(_c, files, caption, topicId, _o, onProgress, ctl) {
    this.sendCalls++;
    if (ctl.isDone(0)) return {};
    for (const p of this.progressScript || [0.5]) onProgress(p, files[0].name);
    if (ctl.isCanceled()) throw err('USER_CANCELED');
    this.online();
    if (topicId && this.deletedTopics.has(topicId)) throw err('TOPIC_DELETED');
    const ids = ctl.randomIds(0, files.length);
    const f = this.failures.shift();
    if (f && f.hang) return new Promise(() => {});
    if (f && f.when === 'before') throw err(f.error, f.extra);
    if (ids.some((id) => this.ids.has(String(id)))) throw err('RANDOM_ID_DUPLICATE');
    if (ctl.sending) ctl.sending(0);
    ids.forEach((id) => this.ids.add(String(id)));
    const msgIds = files.map(() => ++this.nextMsg);
    const groupedId = files.length > 1 ? `g${msgIds[0]}` : null;
    this.posts.push({ files: files.map((x) => x.name), caption, topicId, ids: msgIds, groupedId, date: this.serverNow() });
    if (f && f.hangAfter) return new Promise(() => {});
    if (f && f.when === 'after') throw err(f.error);
    ctl.stepDone(0, msgIds);
    onProgress(1);
    return { messageIds: msgIds };
  }

  /** The chat as telegram.js sees it: one message per item, the caption on the last one. */
  messages(topicId) {
    const out = [];
    for (const p of this.posts) {
      if (!p.files || (p.topicId || null) !== (topicId || null)) continue;
      p.ids.forEach((id, i) => out.push({ id, date: p.date, out: true, groupedId: p.groupedId, media: true, text: i === p.ids.length - 1 ? p.caption || '' : '', names: [] }));
    }
    return out;
  }

  async findRecentAlbum(_c, topicId, want) {
    this.checks++;
    this.online();
    if (this.checkResult) return typeof this.checkResult === 'function' ? this.checkResult(want) : this.checkResult;
    const hit = matchAlbum(this.messages(topicId), { ...want, names: null });
    return { ids: hit ? hit.ids : null, complete: true };
  }
}

module.exports = { FakeTelegram, err };
