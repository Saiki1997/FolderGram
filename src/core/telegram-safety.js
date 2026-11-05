// Telegram Safety Engine: every message FolderGram posts goes through here first.
//
// What it does:
//  - paces messages per group and per account with a sliding one-minute window plus a minimum spacing, counting an
//    album of N items as N messages (one messages.sendMultiMedia request is still N messages);
//  - reserves an album's whole budget before it is sent, so several workers can never oversubscribe a group;
//  - honours FLOOD_WAIT_X / SLOWMODE_WAIT_X / HTTP 429 retry_after exactly (plus a small margin), persists the
//    cooldowns so a restart can't skip them, and lowers the effective rate after each flood;
//  - stops all sends for the account on PEER_FLOOD (a possible anti-abuse restriction) until the user resumes;
//  - after repeated flood warnings, falls back to the Safe Archive profile and pauses for the user.
//
// What it does not do: bypass anything. The rates below are FolderGram's own conservative recommendations based on
// Telegram's published Bot API guidance (about 1 message per second per chat, 20 messages per minute in a group for
// bots). They are not official limits for MTProto methods, and Telegram can enforce stricter limits at any time;
// its actual answers always win over these numbers. No speed guarantees that anti-spam systems won't act.
'use strict';

const fs = require('fs');
const path = require('path');
const { writeAtomic } = require('./store');

const MINUTE = 60000;

/** Built-in profiles. perMinute: media messages per minute per group; minIntervalMs: spacing per message. */
const PROFILES = {
  safe_archive: {
    label: 'Safe Archive', perMinute: 8, minIntervalMs: 7500, burst: 1, albumSpacingMs: 7500, topicCreateIntervalMs: 60000,
    maxWorkers: 2, maxOutstanding: 1, globalPerMinute: 8, cooldownMs: 30000,
  },
  balanced: {
    label: 'Balanced', perMinute: 12, minIntervalMs: 5000, burst: 1, albumSpacingMs: 5000, topicCreateIntervalMs: 30000,
    maxWorkers: 3, maxOutstanding: 1, globalPerMinute: 12, cooldownMs: 15000,
  },
  fast_conservative: {
    label: 'Fast Conservative', perMinute: 15, minIntervalMs: 4000, burst: 1, albumSpacingMs: 4000, topicCreateIntervalMs: 20000,
    maxWorkers: 4, maxOutstanding: 1, globalPerMinute: 15, cooldownMs: 10000,
  },
};
const DEFAULT_PROFILE = 'balanced';

// Published Bot API guidance (https://core.telegram.org/bots/faq): ~1 msg/s per chat, 20 msg/min per group,
// ~30 msg/s overall. FolderGram's custom settings are kept within these for every session type.
const LIMITS = {
  bot: { perMinute: 20, minIntervalMs: 3000, globalPerMinute: 20 * 60 /* informational */, burst: 3 },
  user: { perMinute: 20, minIntervalMs: 3000, globalPerMinute: 30, burst: 3 },
};
const CUSTOM_BOUNDS = {
  perMinute: [1, 20], burst: [1, 3], minIntervalMs: [3000, 600000], albumSpacingMs: [0, 600000], topicCreateIntervalMs: [10000, 3600000],
  maxWorkers: [1, 6], maxOutstanding: [1, 2], globalPerMinute: [1, 30], cooldownMs: [0, 3600000],
};

const FLOOD_MARGIN_MS = 2000; // added to every server-requested wait
const REPEATED_FLOODS = 3; // this many flood warnings within REPEAT_WINDOW pauses for the user
const REPEAT_WINDOW = 30 * MINUTE;
const RECOVER_AFTER_SENDS = 60; // successful messages since the last flood before the rate may rise by one step
const RECOVER_QUIET_MS = 30 * MINUTE;

// ---------------------------------------------------------------- errors

const text = (e) => String((e && (e.errorMessage || e.message || e.description || e.code)) || e || '');

/**
 * Sorts a Telegram/GramJS/Bot API error into a category the uploader acts on:
 * flood, slowmode, peer_flood, auth, permission, topic_deleted, topic_closed, write_forbidden, invalid_media,
 * file_size, network, uncertain, cancelled, delivered, permanent, unknown.
 * Returns { category, seconds, transient, message }.
 */
function classifyTelegramError(e) {
  const m = text(e);
  const out = (category, extra = {}) => ({ category, seconds: null, transient: false, message: m.slice(0, 300), ...extra });
  if (/USER_CANCELED|CANCELLED/i.test(m) || (e && e.cancelled)) return out('cancelled');
  if (/RANDOM_ID_DUPLICATE/.test(m)) return out('delivered');
  // HTTP Bot API: { error_code: 429, parameters: { retry_after } }
  const retryAfter = e && e.parameters && Number(e.parameters.retry_after);
  if ((e && (e.error_code === 429 || e.status === 429)) || /^429\b|Too Many Requests/i.test(m)) {
    return out('flood', { seconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : secondsIn(m) || 30, transient: true, http: true });
  }
  if (/PEER_FLOOD/.test(m)) return out('peer_flood');
  const slow = /SLOWMODE_WAIT_(\d+)/.exec(m);
  if (slow) return out('slowmode', { seconds: Number(slow[1]), transient: true });
  const flood = /(?:FLOOD_WAIT|FLOOD_PREMIUM_WAIT|FLOOD_TEST_PHONE_WAIT)_(\d+)/.exec(m) || /A wait of (\d+) seconds is required/i.exec(m);
  if (flood || (e && typeof e.seconds === 'number' && /FLOOD/i.test(m))) return out('flood', { seconds: flood ? Number(flood[1]) : e.seconds, transient: true });
  if (/AUTH_KEY_UNREGISTERED|AUTH_KEY_INVALID|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED|AUTH_KEY_DUPLICATED|BOT_TOKEN_INVALID/.test(m)) return out('auth');
  if (/TOPIC_DELETED|TOPIC_ID_INVALID/.test(m)) return out('topic_deleted');
  if (/TOPIC_CLOSED/.test(m)) return out('topic_closed');
  if (/CHAT_WRITE_FORBIDDEN|CHAT_SEND_\w+_FORBIDDEN|USER_BANNED_IN_CHANNEL|CHAT_RESTRICTED/.test(m)) return out('write_forbidden');
  if (/CHAT_ADMIN_REQUIRED|CHANNEL_PRIVATE|CHANNEL_INVALID|PEER_ID_INVALID|RIGHT_FORBIDDEN|CHAT_FORBIDDEN/.test(m)) return out('permission');
  if (/FILE_PARTS_INVALID|FILE_PART_TOO_BIG|FILE_TOO_LARGE|too big|ENTITY_TOO_LARGE/i.test(m)) return out('file_size');
  if (/MEDIA_EMPTY|MEDIA_INVALID|PHOTO_\w*INVALID|IMAGE_PROCESS_FAILED|DOCUMENT_INVALID|VIDEO_CONTENT_TYPE_INVALID|FILE_REFERENCE_\w+|MEDIA_CAPTION_TOO_LONG/.test(m)) return out('invalid_media');
  if (/STALLED|TIMEOUT|timed? ?out|Not connected|Connection closed|disconnect|ECONNRESET|EPIPE|socket hang up|RPC_CALL_FAIL|MSG_WAIT_FAILED|-503/i.test(m)) return out('uncertain', { transient: true });
  if (/ENETUNREACH|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|NETWORK/i.test(m)) return out('network', { transient: true });
  if (/INTERNAL|WORKER_BUSY|-500|\b5\d\d\b/i.test(m)) return out('unknown', { transient: true });
  if (/_INVALID$|_INVALID\b|_FORBIDDEN\b|_REQUIRED\b/.test(m)) return out('permanent');
  return out('unknown', { transient: true });
}
const secondsIn = (m) => { const r = /(\d+)\s*s/.exec(m); return r ? Number(r[1]) : null; };

// ---------------------------------------------------------------- settings

const clamp = (v, [lo, hi], d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d; };

/**
 * The settings a profile name (or a custom object) stands for, validated for the session type. Custom values are
 * clamped to the published guidance; warnings say what was changed. Returns { name, settings, warnings }.
 */
function resolveProfile(name, custom = null, { sessionType = 'user' } = {}) {
  const warnings = [];
  if (name !== 'custom') {
    const p = PROFILES[name] ? name : DEFAULT_PROFILE;
    return { name: p, settings: { ...PROFILES[p] }, warnings };
  }
  const base = PROFILES.balanced;
  const c = custom && typeof custom === 'object' ? custom : {};
  const s = { label: 'Custom' };
  for (const k of Object.keys(CUSTOM_BOUNDS)) {
    const want = c[k] != null ? Number(c[k]) : base[k];
    s[k] = clamp(want, CUSTOM_BOUNDS[k], base[k]);
    if (c[k] != null && s[k] !== Math.round(want)) warnings.push(`${k} ${c[k]} is outside the allowed range; using ${s[k]}.`);
  }
  const lim = LIMITS[sessionType] || LIMITS.user;
  if (s.perMinute > lim.perMinute) { warnings.push(`At most ${lim.perMinute} messages per minute per group.`); s.perMinute = lim.perMinute; }
  // The spacing must not allow more than perMinute: 60 s / perMinute at least.
  const spacing = Math.ceil(MINUTE / s.perMinute);
  if (s.minIntervalMs < spacing) s.minIntervalMs = spacing;
  if (s.globalPerMinute < s.perMinute) s.globalPerMinute = s.perMinute;
  return { name: 'custom', settings: s, warnings };
}

// ---------------------------------------------------------------- the engine

/**
 * opts: { file (persisted state, optional), profile, custom, adaptive, autoDowngrade, sessionType, account,
 *         now(), sleep(ms), onEvent(ev) }
 * onEvent receives { type: 'rate_limit'|'suspended'|'downgrade'|'resumed'|'cooldown', ... } for the ledger and the UI.
 */
class SafetyEngine {
  constructor(opts = {}) {
    this.now = opts.now || Date.now;
    this.sleepFn = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.onEvent = opts.onEvent || (() => {});
    this.file = opts.file || null;
    this.account = String(opts.account || 'default');
    this.sessionType = opts.sessionType === 'bot' ? 'bot' : 'user';
    this.adaptive = opts.adaptive !== false;
    this.autoDowngrade = opts.autoDowngrade !== false;
    this.windows = new Map(); // scope -> [{ t, n, id }] reservations in the last minute (and future ones)
    this.lastSend = new Map(); // scope -> { t, n } last reserved send, for spacing
    this.lastTopicCreate = 0;
    this.outstanding = 0;
    this.waiters = [];
    this.nextId = 1;
    this.stats = { messagesReserved: 0, messagesConfirmed: 0, releases: 0, floods: 0, waitsMs: 0, latencyMs: 0, latencyN: 0 };
    this.state = { cooldowns: {}, suspended: {}, effective: {}, floods: [], sendsSinceFlood: 0, lastFloodAt: 0, downgradedFrom: null };
    this.load();
    this.setProfile(opts.profile || DEFAULT_PROFILE, opts.custom || null);
  }

  // ---- persistence

  load() {
    if (!this.file) return;
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (d && typeof d === 'object') this.state = { ...this.state, ...d, floods: Array.isArray(d.floods) ? d.floods : [] };
    } catch { /* first run, or damaged: start from defaults (cooldowns then come from Telegram again) */ }
    const now = this.now();
    for (const [k, until] of Object.entries(this.state.cooldowns)) if (!(until > now)) delete this.state.cooldowns[k];
  }

  save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      writeAtomic(this.file, JSON.stringify(this.state), { backup: true });
    } catch { /* in memory it still works for this session */ }
  }

  // ---- profile

  setProfile(name, custom = null) {
    const r = resolveProfile(name, custom, { sessionType: this.sessionType });
    this.profileName = r.name;
    this.profile = r.settings;
    this.warnings = r.warnings;
    // A lowered rate stays lowered when the profile changes, but never above the new cap.
    for (const k of Object.keys(this.state.effective)) this.state.effective[k] = Math.min(this.state.effective[k], this.profile.perMinute);
    return r;
  }

  /** Messages per minute allowed now for a group (adaptive, never above the profile). */
  effectiveRate(chatId) {
    const v = this.state.effective[`group:${chatId}`];
    return Math.max(1, Math.min(this.profile.perMinute, v || this.profile.perMinute));
  }

  // ---- scheduling

  scopes(chatId, topicId) {
    return [
      { key: `account:${this.account}`, perMinute: this.profile.globalPerMinute, minIntervalMs: 0 },
      { key: `group:${chatId}`, perMinute: this.effectiveRate(chatId), minIntervalMs: Math.max(this.profile.minIntervalMs, Math.ceil(MINUTE / this.effectiveRate(chatId))) },
      ...(topicId ? [{ key: `topic:${chatId}:${topicId}`, perMinute: Infinity, minIntervalMs: this.profile.albumSpacingMs }] : []),
    ];
  }

  prune(key, now) {
    const w = this.windows.get(key);
    if (!w) return [];
    while (w.length && w[0].t <= now - MINUTE) w.shift();
    return w;
  }

  /** The earliest time `n` messages may go to this chat/topic, given every reservation and cooldown. */
  earliest(chatId, topicId, n, now = this.now()) {
    let t = now;
    for (const k of [`account:${this.account}`, `group:${chatId}`, topicId ? `topic:${chatId}:${topicId}` : null]) {
      if (k && this.state.cooldowns[k] > t) t = this.state.cooldowns[k];
    }
    for (const s of this.scopes(chatId, topicId)) {
      const last = this.lastSend.get(s.key);
      // Spacing: after an album of k messages the scope rests k × interval, so long runs average perMinute.
      if (last && s.minIntervalMs) t = Math.max(t, last.t + last.n * s.minIntervalMs);
      if (!Number.isFinite(s.perMinute)) continue;
      const w = this.prune(s.key, now);
      // Sliding window: at most perMinute messages in any minute. An album bigger than the whole budget (a 10-item
      // album at 8/min) is sent alone into an empty window instead of being split; the spacing above then rests longer.
      // Reservations are never in the future, so moving t later only empties the window: one pass is enough.
      for (;;) {
        const inWin = w.filter((r) => r.t > t - MINUTE);
        const used = inWin.reduce((a, r) => a + r.n, 0);
        if (used === 0 || used + n <= s.perMinute) break;
        t = inWin[0].t + MINUTE + 1;
      }
    }
    return t;
  }

  /**
   * Waits for a slot and reserves `messages` messages for this chat/topic. Returns a reservation:
   * { id, at, n, confirm(count), release() }. ctx: { isCanceled(), onWait(seconds, reason), sleep(ms) }.
   * Throws a SAFETY_SUSPENDED error while the account is suspended (PEER_FLOOD, repeated floods).
   */
  async acquire({ chatId, topicId = null, messages = 1, ctx = {} } = {}) {
    const n = Math.max(1, Math.floor(messages));
    const sleep = ctx.sleep || this.sleepFn;
    // One send in flight per account at a time (maxOutstanding): albums never go out simultaneously.
    while (this.outstanding >= this.profile.maxOutstanding) {
      if (ctx.isCanceled && ctx.isCanceled()) throw canceled();
      await new Promise((r) => this.waiters.push(r));
    }
    this.outstanding++;
    try {
      for (;;) {
        if (ctx.isCanceled && ctx.isCanceled()) throw canceled();
        this.assertNotSuspended();
        const now = this.now();
        const at = this.earliest(chatId, topicId, n, now);
        if (at <= now) {
          const res = this.reserve(chatId, topicId, n, now);
          return res;
        }
        const ms = at - now;
        const cooling = this.cooldownFor(chatId, topicId);
        if (ctx.onWait) ctx.onWait(Math.ceil(ms / 1000), cooling ? cooling.reason : 'pacing');
        this.stats.waitsMs += ms;
        await sleep(Math.min(ms, 5000)); // re-check every few seconds: a cooldown or suspension may change meanwhile
      }
    } catch (e) {
      this.done();
      throw e;
    }
  }

  reserve(chatId, topicId, n, now) {
    const id = this.nextId++;
    for (const s of this.scopes(chatId, topicId)) {
      if (!this.windows.has(s.key)) this.windows.set(s.key, []);
      this.windows.get(s.key).push({ t: now, n, id });
      this.lastSend.set(s.key, { t: now, n });
    }
    this.stats.messagesReserved += n;
    let settled = false;
    const finish = () => { if (!settled) { settled = true; this.done(); } };
    return {
      id, at: now, n,
      /** Telegram confirmed `count` messages: they stay counted. */
      confirm: (count = n, latencyMs = null) => {
        this.stats.messagesConfirmed += count;
        if (latencyMs != null) { this.stats.latencyMs += latencyMs; this.stats.latencyN++; }
        this.success(chatId, count);
        finish();
      },
      /** The outcome is unknown (timeout): keep the budget counted, a retry needs its own reservation. */
      uncertain: () => finish(),
      /**
       * Telegram certainly did not post anything (the request failed before it was sent, or an error answer such as
       * a flood wait): the budget can be given back. Never call this after a timeout or a lost answer.
       */
      release: () => {
        for (const s of this.scopes(chatId, topicId)) {
          const w = this.windows.get(s.key);
          if (w) { const i = w.findIndex((r) => r.id === id); if (i >= 0) w.splice(i, 1); }
        }
        this.stats.releases++;
        finish();
      },
    };
  }

  done() {
    this.outstanding = Math.max(0, this.outstanding - 1);
    const w = this.waiters.shift();
    if (w) w();
  }

  /** Topic creation is paced on its own (it posts a service message too). */
  async acquireTopicCreate(chatId, ctx = {}) {
    const sleep = ctx.sleep || this.sleepFn;
    for (;;) {
      if (ctx.isCanceled && ctx.isCanceled()) throw canceled();
      this.assertNotSuspended();
      const now = this.now();
      const at = Math.max(this.lastTopicCreate + this.profile.topicCreateIntervalMs, this.earliest(chatId, null, 1, now));
      if (at <= now) { this.lastTopicCreate = now; return this.reserve(chatId, null, 1, now); }
      if (ctx.onWait) ctx.onWait(Math.ceil((at - now) / 1000), 'topic pacing');
      await sleep(Math.min(at - now, 5000));
    }
  }

  // ---- outcomes

  success(chatId, count) {
    this.state.sendsSinceFlood += count;
    if (!this.adaptive) return;
    // Recovery is slow and bounded: one step up after a long quiet period, never above the chosen profile.
    const k = `group:${chatId}`;
    const cur = this.state.effective[k];
    if (cur && cur < this.profile.perMinute && this.state.sendsSinceFlood >= RECOVER_AFTER_SENDS && this.now() - this.state.lastFloodAt >= RECOVER_QUIET_MS) {
      this.state.effective[k] = Math.min(this.profile.perMinute, cur + 1);
      this.state.sendsSinceFlood = 0;
      this.save();
    }
  }

  cooldownFor(chatId, topicId) {
    const now = this.now();
    let best = null;
    for (const [k, reason] of [[`account:${this.account}`, 'flood'], [`group:${chatId}`, 'flood'], [topicId ? `topic:${chatId}:${topicId}` : '', 'slowmode']]) {
      const until = this.state.cooldowns[k];
      if (until > now && (!best || until > best.until)) best = { key: k, until, reason: (this.state.cooldownReasons || {})[k] || reason };
    }
    return best;
  }

  setCooldown(key, ms, reason) {
    const until = this.now() + ms;
    if (!(this.state.cooldowns[key] > until)) this.state.cooldowns[key] = until;
    this.state.cooldownReasons = { ...(this.state.cooldownReasons || {}), [key]: reason };
  }

  /**
   * Tells the engine how a Telegram call ended badly. ctx: { chatId, topicId, method }.
   * Returns { action: 'wait'|'stop'|'retry'|'fail'|'delivered'|'cancelled'|'reconcile', seconds, category, reason }.
   */
  reportError(e, { chatId = null, topicId = null, method = 'send' } = {}) {
    const c = classifyTelegramError(e);
    const now = this.now();
    if (c.category === 'flood' || c.category === 'slowmode') {
      const seconds = Math.max(1, c.seconds || 1);
      const ms = seconds * 1000 + FLOOD_MARGIN_MS;
      if (c.category === 'slowmode') this.setCooldown(`group:${chatId}`, ms, 'slowmode');
      else {
        // A flood wait on sending holds every send of the account; on other calls, the group.
        this.setCooldown(/send|Media|Message/i.test(method) ? `account:${this.account}` : `group:${chatId}`, ms, 'flood');
        if (chatId) this.setCooldown(`group:${chatId}`, ms, 'flood');
      }
      let rate = chatId ? this.effectiveRate(chatId) : null;
      if (c.category === 'flood') {
        this.stats.floods++;
        this.state.floods = [...this.state.floods.filter((t) => now - t < REPEAT_WINDOW), now];
        this.state.lastFloodAt = now;
        this.state.sendsSinceFlood = 0;
        if (this.adaptive && chatId) {
          rate = Math.max(1, Math.floor(this.effectiveRate(chatId) * 0.6));
          this.state.effective[`group:${chatId}`] = rate;
        }
      }
      this.onEvent({ type: 'rate_limit', account: this.account, chatId, topicId, method, seconds, code: c.message, category: c.category, effectiveRate: rate, at: now });
      let action = 'wait';
      if (c.category === 'flood' && this.state.floods.length >= REPEATED_FLOODS) {
        if (this.autoDowngrade && this.profileName !== 'safe_archive') {
          this.state.downgradedFrom = this.profileName;
          this.onEvent({ type: 'downgrade', from: this.profileName, to: 'safe_archive', at: now });
          this.setProfile('safe_archive');
        }
        this.suspend(`Telegram asked FolderGram to slow down ${this.state.floods.length} times in 30 minutes. Uploads are paused; check the account, then resume.`, 'repeated_flood');
        action = 'stop';
      }
      this.save();
      return { action, seconds: seconds + FLOOD_MARGIN_MS / 1000, category: c.category, reason: c.message };
    }
    if (c.category === 'peer_flood') {
      this.suspend('Telegram answered PEER_FLOOD: the account may be restricted for sending. FolderGram stopped all sends. Check @SpamBot in Telegram before resuming.', 'peer_flood');
      this.onEvent({ type: 'rate_limit', account: this.account, chatId, topicId, method, seconds: null, code: 'PEER_FLOOD', category: 'peer_flood', effectiveRate: null, at: now });
      this.save();
      return { action: 'stop', category: c.category, reason: c.message };
    }
    if (c.category === 'delivered') return { action: 'delivered', category: c.category };
    if (c.category === 'cancelled') return { action: 'cancelled', category: c.category };
    if (c.category === 'uncertain') return { action: 'reconcile', category: c.category, reason: c.message };
    if (c.category === 'auth') return { action: 'stop', category: c.category, reason: c.message };
    if (c.transient) return { action: 'retry', category: c.category, reason: c.message };
    return { action: 'fail', category: c.category, reason: c.message };
  }

  suspend(reason, kind) {
    this.state.suspended[this.account] = { reason, kind, at: this.now() };
    this.onEvent({ type: 'suspended', account: this.account, reason, kind, at: this.now() });
    this.save();
  }

  suspension() { return this.state.suspended[this.account] || null; }

  /** The user looked and resumes: sends may start again (cooldowns from Telegram still apply). */
  clearSuspension() {
    if (!this.state.suspended[this.account]) return false;
    delete this.state.suspended[this.account];
    this.state.floods = [];
    this.onEvent({ type: 'resumed', account: this.account, at: this.now() });
    this.save();
    return true;
  }

  assertNotSuspended() {
    const s = this.suspension();
    if (s) throw Object.assign(new Error(`SAFETY_SUSPENDED: ${s.reason}`), { errorMessage: 'SAFETY_SUSPENDED', safetyStop: true, kind: s.kind });
  }

  /** For the window: profile, rates, cooldowns. */
  status(chatId = null) {
    const now = this.now();
    const cool = Object.entries(this.state.cooldowns).filter(([, u]) => u > now).map(([key, until]) => ({ key, seconds: Math.ceil((until - now) / 1000) }));
    return {
      profile: this.profileName, label: this.profile.label, perMinute: this.profile.perMinute, minIntervalMs: this.profile.minIntervalMs,
      effectiveRate: chatId ? this.effectiveRate(chatId) : this.profile.perMinute, adaptive: this.adaptive,
      cooldowns: cool, suspended: this.suspension(), downgradedFrom: this.state.downgradedFrom, warnings: this.warnings,
      recentFloods: this.state.floods.filter((t) => now - t < REPEAT_WINDOW).length,
      stats: { ...this.stats, avgLatencyMs: this.stats.latencyN ? Math.round(this.stats.latencyMs / this.stats.latencyN) : null },
    };
  }
}

const canceled = () => Object.assign(new Error('USER_CANCELED'), { errorMessage: 'USER_CANCELED' });

module.exports = { SafetyEngine, PROFILES, LIMITS, CUSTOM_BOUNDS, DEFAULT_PROFILE, resolveProfile, classifyTelegramError, FLOOD_MARGIN_MS, MINUTE };
