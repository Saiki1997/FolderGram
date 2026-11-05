// Main-process side of the Library, Downloads and Sync screens. Everything that changes Telegram (renaming a topic,
// editing a caption, deleting messages) runs only when the window asks after the user confirmed it there.
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const L = require('./core/library');
const { DownloadJob, DownloadManifest, MANIFEST, POLICIES } = require('./core/downloader');
const S = require('./core/sync');
const { RateLimiter } = require('./core/fastupload');
const { readJson, writeJson } = require('./core/store');
const { normalizeKey } = require('./core/naming');

const THUMB_CACHE_MAX = 300 * 1024 * 1024;

/**
 * ctx: { handle, send, tg, V, dialog, shell, getWin, dataDir, getQueue, getDlog, scanSources, plan(groups, options),
 *   jobOptions, chatPeer, scanOptions, GENERAL_TOPIC_ID }
 */
function setup(ctx) {
  const { handle, send, tg, V } = ctx;
  const cleanChat = (c) => {
    c = V.obj(c);
    if (!c.id) throw new Error('Choose a group first.');
    return { id: String(c.id), title: V.str(c.title, 256), isForum: !!c.isForum, username: c.username ? V.str(c.username, 64) : null, peer: ctx.chatPeer(c.peer) };
  };
  const topicArg = (t) => (t == null || t === '' ? null : V.int(t, 1, 2 ** 31));

  // ---------------------------------------------------------------- browsing

  const pagers = new Map(); // "<chat>|<topic>" -> { pager, offsetId, done }
  handle('library:topics', async (chat) => {
    chat = cleanChat(chat);
    const topics = chat.isForum ? await tg.listTopics(chat) : [{ id: null, title: chat.title || 'Chat', closed: false }];
    return { topics, duplicates: chat.isForum ? L.duplicateTopics(topics).map((g) => g.map((t) => t.id)) : [] };
  });

  /** The next page of albums of a topic (or the chat). reset starts from the newest again. */
  handle('library:page', async (chat, topicId, reset) => {
    chat = cleanChat(chat);
    topicId = topicArg(topicId);
    const key = `${chat.id}|${topicId}`;
    let p = pagers.get(key);
    if (!p || reset) { p = { pager: new L.AlbumPager(), offsetId: 0, done: false }; pagers.set(key, p); }
    if (p.done) return { albums: [], done: true };
    const albums = [];
    // Keep reading until a few albums are complete or the topic ends (a page can hold one big album part).
    for (let i = 0; i < 5 && albums.length < 12 && !p.done; i++) {
      const r = await tg.listMedia(chat, { topicId, offsetId: p.offsetId, limit: 100 });
      p.done = r.nextOffsetId == null;
      p.offsetId = r.nextOffsetId || p.offsetId;
      albums.push(...p.pager.add(r.items, p.done));
    }
    return { albums: albums.map(slimAlbum), done: p.done };
  });

  const slimAlbum = (a) => ({ key: a.key, ids: a.ids, date: a.date, caption: a.caption, captionId: (a.items.find((m) => m.caption) || {}).id || null, title: L.captionTitle(a.caption), count: a.count, size: a.size, kinds: a.kinds,
    items: a.items.map((m) => ({ id: m.id, kind: m.kind, fileName: m.fileName, size: m.size, width: m.width || 0, height: m.height || 0, duration: m.duration || 0, date: m.date })) });

  // Thumbnails: small JPEGs cached on disk by message, never the full files.
  const thumbDir = () => path.join(ctx.dataDir(), 'thumbs');
  let thumbBytes = null;
  handle('library:thumbs', async (chat, ids) => {
    chat = cleanChat(chat);
    const out = {};
    await fsp.mkdir(thumbDir(), { recursive: true });
    for (const id of V.arr(ids, 60).map((x) => V.int(x, 1, 2 ** 31))) {
      const file = path.join(thumbDir(), `${crypto.createHash('sha1').update(`${chat.id}:${id}`).digest('hex')}.jpg`);
      let buf = await fsp.readFile(file).catch(() => null);
      if (!buf) {
        buf = await tg.thumbnail(chat, id).catch(() => null);
        if (buf) { await fsp.writeFile(file, buf).catch(() => {}); trimThumbs(buf.length); }
      }
      if (buf) out[id] = `data:image/jpeg;base64,${buf.toString('base64')}`;
    }
    return out;
  });
  async function trimThumbs(added) {
    if (thumbBytes == null) {
      thumbBytes = 0;
      for (const f of await fsp.readdir(thumbDir()).catch(() => [])) thumbBytes += (await fsp.stat(path.join(thumbDir(), f)).catch(() => ({ size: 0 }))).size;
    }
    thumbBytes += added;
    if (thumbBytes <= THUMB_CACHE_MAX) return;
    // Oldest first until it is under 80% of the limit.
    const files = [];
    for (const f of await fsp.readdir(thumbDir()).catch(() => [])) {
      const st = await fsp.stat(path.join(thumbDir(), f)).catch(() => null);
      if (st) files.push({ f, st });
    }
    files.sort((a, b) => a.st.mtimeMs - b.st.mtimeMs);
    for (const { f, st } of files) {
      if (thumbBytes <= THUMB_CACHE_MAX * 0.8) break;
      await fsp.rm(path.join(thumbDir(), f), { force: true });
      thumbBytes -= st.size;
    }
  }

  handle('library:open', (chat, id, topicId) => {
    chat = cleanChat(chat);
    const link = tg.messageLink(chat, V.int(id, 1, 2 ** 31), topicArg(topicId));
    if (!link) throw new Error('Small groups have no message links. Open the group in Telegram instead.');
    return ctx.shell.openExternal(link);
  });

  /** All albums of a topic (up to `max` messages), for comparisons and downloads. */
  async function allAlbums(chat, topicId, max = 20000) {
    const pager = new L.AlbumPager();
    const albums = [];
    let offsetId = 0;
    let seen = 0;
    for (;;) {
      const r = await tg.listMedia(chat, { topicId, offsetId, limit: 100 });
      seen += r.items.length;
      const last = r.nextOffsetId == null || seen >= max;
      albums.push(...pager.add(r.items, last));
      if (last) return albums;
      offsetId = r.nextOffsetId;
    }
  }

  handle('library:compare', async (chat, topicId, localSets) => {
    chat = cleanChat(chat);
    const albums = await allAlbums(chat, topicArg(topicId));
    const sets = V.arr(localSets, 100000).map(V.obj).map((s) => ({ name: V.str(s.name, 1024), count: V.int(s.count, 0, 1e7) }));
    return L.compareCollections(sets, albums);
  });

  /** Checks across the group: duplicate topics, albums in another topic's name, and FolderGram albums that lost messages. */
  handle('library:checks', async (chat) => {
    chat = cleanChat(chat);
    const topics = chat.isForum ? await tg.listTopics(chat) : [];
    const byTopic = new Map();
    for (const t of topics.slice(0, 200)) byTopic.set(t.id, await allAlbums(chat, t.id, 300));
    const reports = [];
    const q = ctx.getQueue();
    for (const j of q.list()) {
      if (String(j.chat.id) !== chat.id) continue;
      const rep = q.report(j.id);
      for (const a of (rep && rep.albums) || []) if (a.status === 'sent') reports.push({ ...a, jobId: j.id });
    }
    const ids = [...new Set(reports.flatMap((a) => a.messageIds || []))];
    const existing = ids.length ? await tg.existingMessageIds(chat, ids) : new Set();
    // Messages deleted here on purpose (a sync's confirmed delete) are not "lost".
    for (const id of deletedOnPurpose()[chat.id] || []) existing.add(id);
    return {
      duplicates: L.duplicateTopics(topics),
      misplaced: L.misplacedAlbums(topics, byTopic).slice(0, 500),
      incomplete: L.incompleteAlbums(reports, existing).slice(0, 500),
      checkedAlbums: reports.length,
    };
  });

  // ---------------------------------------------------------------- changes (confirmed in the window)

  handle('library:renameTopic', async (chat, topicId, title) => {
    chat = cleanChat(chat);
    title = V.str(title, 128).trim();
    if (!title) throw new Error('The topic needs a name.');
    await tg.renameTopic(chat, V.int(topicId, 2, 2 ** 31), title);
    ctx.getDlog().write('library', `renamed topic ${topicId} in ${chat.title}`);
    return true;
  });

  handle('library:editCaption', async (chat, id, text) => {
    chat = cleanChat(chat);
    await tg.editCaption(chat, V.int(id, 1, 2 ** 31), V.str(text, 4096));
    ctx.getDlog().write('library', `edited the caption of message ${id} in ${chat.title}`);
    return true;
  });

  /**
   * Sends the files of an album again whose messages are gone (from a job report). Files that are no longer on
   * this PC are listed and left out. Nothing on Telegram is deleted.
   */
  handle('library:resendMissing', async (chat, album) => {
    chat = cleanChat(chat);
    album = V.obj(album);
    const paths = V.arr(album.paths, 1000).map((p) => V.path(p));
    const ids = V.arr(album.messageIds, 1000).map((x) => V.int(x, 1, 2 ** 31));
    const missing = new Set(V.arr(album.missing, 1000).map((x) => V.int(x, 1, 2 ** 31)));
    // One message per file when the counts agree; otherwise the whole album is sent again.
    const wanted = ids.length === paths.length ? paths.filter((_, i) => missing.has(ids[i])) : paths;
    const files = [];
    const gone = [];
    for (const p of wanted) {
      const st = await fsp.stat(p).catch(() => null);
      if (!st || !st.isFile()) { gone.push(path.basename(p)); continue; }
      files.push({ path: p, name: path.basename(p), ext: path.extname(p).toLowerCase(), size: st.size, mtime: Math.floor(st.mtimeMs / 1000), mtimeMs: st.mtimeMs });
    }
    if (!files.length) throw new Error(`None of the missing files are on this PC any more${gone.length ? ` (${gone.slice(0, 3).join(', ')}…)` : ''}.`);
    const topicId = album.topicId ? V.int(album.topicId, 1, 2 ** 31) : null;
    const plan = ctx.plan([{ leaf: V.str(album.topic, 128) || 'Repair', path: V.str(album.topic, 128) || 'Repair', top: V.str(album.topic, 128) || 'Repair',
      relPath: '.', dir: path.dirname(files[0].path), files }], { captionBy: 'folder' })
      .map((e) => ({ ...e, topicName: V.str(album.topic, 128) || e.topicName, topicId, albums: e.albums.map((a, i, all) => ({ ...a, caption: i === all.length - 1 ? V.str(album.caption, 1024) : '' })) }));
    const job = ctx.getQueue().add({
      name: `Repair: ${V.str(album.caption, 80) || V.str(album.topic, 80) || 'album'}`, chat, mode: chat.isForum && topicId ? 'single' : 'none', topicId: topicId || null,
      options: { ...ctx.jobOptions({}), skipUploaded: false, skipDuplicates: false }, plan, sources: [],
    });
    return { job, gone };
  });

  // ---------------------------------------------------------------- downloads

  let active = null;
  const downloads = []; // finished and running, newest last (this session)
  const limiterFor = (mbps) => (mbps > 0 ? new RateLimiter(mbps * 125000) : null);

  handle('downloads:pickFolder', async () => {
    const r = await ctx.dialog.showOpenDialog(ctx.getWin(), { properties: ['openDirectory', 'createDirectory'], title: 'Download to this folder' });
    return r.canceled ? null : r.filePaths[0];
  });

  /**
   * Starts a download. spec: { chat, dest, policy, layout, bandwidthMbps, albums: [{ title, topic, items }] } or
   * { chat, dest, topic: { id, title } } for a whole topic.
   */
  handle('downloads:start', async (spec) => {
    spec = V.obj(spec);
    if (active) throw new Error('A download is already running. Wait for it or cancel it first.');
    const chat = cleanChat(spec.chat);
    const dest = V.path(spec.dest);
    let items = [];
    if (spec.topic) {
      const topic = V.obj(spec.topic);
      const albums = await allAlbums(chat, topicArg(topic.id), 200000);
      items = albums.flatMap((a) => a.items.map((m) => ({ msgId: m.id, fileName: m.fileName, size: m.size, kind: m.kind, topic: V.str(topic.title, 128), album: L.captionTitle(a.caption), date: a.date })));
    } else {
      for (const a of V.arr(spec.albums, 10000).map(V.obj)) {
        for (const m of V.arr(a.items, 1000).map(V.obj)) {
          items.push({ msgId: V.int(m.id, 1, 2 ** 31), fileName: V.str(m.fileName, 300), size: V.int(m.size, 0, 2 ** 42), kind: V.str(m.kind, 20), topic: V.str(a.topic, 128),
            album: V.str(a.title, 300), date: V.int(a.date || 0, 0, 2 ** 31) });
        }
      }
    }
    if (!items.length) throw new Error('Nothing to download.');
    const progress = throttle((s) => send('download:progress', { id: rec.id, ...s }), 200);
    const job = new DownloadJob(tg, chat, items, {
      dest, policy: V.oneOf(spec.policy, POLICIES, 'skip'), layout: V.oneOf(spec.layout, ['topic/album', 'topic', 'flat'], 'topic/album'),
      limiter: limiterFor(V.num(spec.bandwidthMbps, 0, 10000, 0)),
    }, {
      progress,
      log: (text, kind) => send('log', { text, kind, at: Date.now() }),
    });
    const rec = { id: `d${Date.now().toString(36)}`, chat: chat.title, dest, files: items.length, status: 'running', startedAt: Date.now() };
    downloads.push(rec);
    active = job;
    ctx.getDlog().write('download', `downloading ${items.length} files from ${chat.title} to ${dest}`);
    job.run().then((s) => { rec.status = job.cancelled ? 'cancelled' : s.failed ? 'finished with errors' : 'done'; rec.stats = s; })
      .catch((e) => { rec.status = 'failed'; rec.error = e.message; })
      .finally(() => { active = null; progress.cancel(); send('download:progress', { id: rec.id, ...job.snapshot(), finished: true, status: rec.status }); if (spec.onDone) spec.onDone(rec); });
    return rec;
  });
  handle('downloads:cancel', () => { if (active) active.cancel(); return true; });
  handle('downloads:list', () => downloads.slice(-20));
  handle('downloads:openFolder', (dest) => ctx.shell.openPath(V.path(dest)));

  // ---------------------------------------------------------------- folder sync

  const syncDir = () => path.join(ctx.dataDir(), 'sync');
  const profilesFile = () => path.join(syncDir(), 'profiles.json');
  let profiles = [];
  const loadProfiles = () => { profiles = (readJson(profilesFile(), []) || []).map((p) => S.sanitizeProfile(p)); };
  const saveProfiles = () => { fs.mkdirSync(syncDir(), { recursive: true }); writeJson(profilesFile(), profiles, { backup: false }); };
  const results = new Map(); // profile id -> last run result (this session)
  const deletedFile = () => path.join(syncDir(), 'deleted.json');
  const deletedOnPurpose = () => readJson(deletedFile(), {}) || {};
  function rememberDeleted(chatId, ids) {
    const all = deletedOnPurpose();
    all[chatId] = [...new Set([...(all[chatId] || []), ...ids])].slice(-50000);
    fs.mkdirSync(syncDir(), { recursive: true });
    writeJson(deletedFile(), all, { backup: false });
  }

  const runner = new S.SyncRunner({
    scan: (folders, o) => ctx.scanSources(folders, ctx.scanOptions(o || {})),
    plan: (groups, o) => ctx.plan(groups, o || {}),
    enqueue: async ({ profile, plan, name }) => ctx.getQueue().add({
      name, chat: profile.chat, mode: profile.mode, topicId: profile.mode === 'single' ? profile.topicId || ctx.GENERAL_TOPIC_ID : null,
      // Sync uploads always skip what is already there: a renamed or copied file is found by its content.
      options: { ...ctx.jobOptions(profile.options), skipUploaded: true, skipDuplicates: true }, plan, sources: profile.folders, sync: profile.id,
    }),
    jobActive: (id) => { const j = ctx.getQueue().get(id); return !!j && ['queued', 'running', 'held', 'paused', 'interrupted'].includes(j.status); },
    stateFile: (id) => path.join(syncDir(), `${id.replace(/[^\w-]/g, '_')}.json`),
    downloadedPaths: (folders) => {
      const out = new Set();
      for (const f of folders) {
        const m = new DownloadManifest(f);
        for (const rel of m.paths()) out.add(path.join(f, rel));
      }
      return out;
    },
    telegramAlbums: async (profile) => {
      const chat = profile.chat;
      if (!chat.isForum || profile.mode !== 'per_folder') return allAlbums(chat, profile.mode === 'single' ? profile.topicId : null, 5000);
      // Topics this sync sends to: the ones named like its top folders.
      const topics = await tg.listTopics(chat);
      const names = new Set();
      for (const f of profile.folders) for (const d of await fsp.readdir(f, { withFileTypes: true }).catch(() => [])) if (d.isDirectory()) names.add(normalizeKey(d.name));
      const out = [];
      for (const t of topics.filter((x) => names.has(normalizeKey(x.title)))) out.push(...(await allAlbums(chat, t.id, 5000)).map((a) => ({ ...a, topic: t.title, topicId: t.id })));
      return out;
    },
  });

  const publicProfile = (p) => ({ ...p, result: results.get(p.id) || null, nextRunAt: S.nextRunAt(p), watching: watchers.has(p.id) });
  const changed = () => send('sync:changed', profiles.map(publicProfile));

  async function runProfile(p, why) {
    ctx.getDlog().write('sync', `run "${p.name}" (${why})`);
    let r;
    try {
      r = await runner.run(p);
    } catch (e) {
      r = { at: new Date().toISOString(), error: e.message };
    }
    if (r.newOnTelegram) r.newOnTelegram = r.newOnTelegram.slice(0, 500).map((a) => ({ ...slimAlbum(a), topic: a.topic || null, topicId: a.topicId || null }));
    results.set(p.id, r);
    p.lastRun = r.at || new Date().toISOString();
    p.lastResult = { at: p.lastRun, ...(r.changes || {}), jobId: r.jobId || null, error: r.error || null, note: r.note || null };
    saveProfiles();
    changed();
    return publicProfile(p);
  }

  // Scheduled and watched profiles.
  const watchers = new Map();
  let ticker = null;
  function arm() {
    clearInterval(ticker);
    ticker = setInterval(() => {
      for (const p of profiles) {
        const due = S.nextRunAt(p);
        if (due != null && due <= Date.now()) runProfile(p, 'schedule');
      }
    }, 60000);
    for (const [id, w] of watchers) if (!profiles.some((p) => p.id === id && p.enabled && p.schedule.type === 'watch')) { w.close(); watchers.delete(id); }
    for (const p of profiles) {
      if (!p.enabled || p.schedule.type !== 'watch' || watchers.has(p.id)) continue;
      watchers.set(p.id, watchFolders(p, () => runProfile(p, 'files changed')));
    }
  }
  /** Watches a profile's folders; runs 30 s after the last change, so a copy in progress is finished first. */
  function watchFolders(p, fn) {
    let timer = null;
    const ws = [];
    for (const f of p.folders) {
      try {
        ws.push(fs.watch(f, { recursive: true }, (_ev, name) => {
          if (name && (/\.part$/i.test(name) || path.basename(String(name)) === MANIFEST)) return; // our own downloads
          clearTimeout(timer);
          timer = setTimeout(fn, 30000);
        }));
      } catch (e) { ctx.getDlog().write('sync', `cannot watch ${f}: ${e.message}`); }
    }
    return { close: () => { clearTimeout(timer); ws.forEach((w) => w.close()); } };
  }

  handle('sync:list', () => profiles.map(publicProfile));
  handle('sync:save', (raw) => {
    const p = S.sanitizeProfile(V.obj(raw));
    if (!p.folders.length) throw new Error('Choose at least one folder to sync.');
    if (!p.chat || !p.chat.id) throw new Error('Choose the group to sync with.');
    p.chat.peer = ctx.chatPeer(p.chat.peer);
    const i = profiles.findIndex((x) => x.id === p.id);
    if (i >= 0) profiles[i] = { ...p, lastRun: profiles[i].lastRun, lastResult: profiles[i].lastResult }; else profiles.push(p);
    saveProfiles();
    arm();
    changed();
    return publicProfile(profiles.find((x) => x.id === p.id));
  });
  handle('sync:remove', (id) => {
    profiles = profiles.filter((p) => p.id !== V.str(id, 40));
    saveProfiles();
    arm();
    changed();
    return true;
  });
  handle('sync:run', (id) => {
    const p = profiles.find((x) => x.id === V.str(id, 40));
    if (!p) throw new Error('That sync no longer exists.');
    return runProfile(p, 'manual');
  });
  /** Two-way: deletes the Telegram messages of files removed here. The window asks first; this never runs on its own. */
  handle('sync:deleteRemoved', async (id, paths) => {
    const p = profiles.find((x) => x.id === V.str(id, 40));
    const r = p && results.get(p.id);
    if (!p || !r || !r.removedOnTelegram) throw new Error('Run the sync again first.');
    const want = new Set(V.arr(paths, 100000).map((x) => V.str(x, 4000)));
    const pick = r.removedOnTelegram.filter((x) => want.has(x.path));
    const ids = [...new Set(pick.flatMap((x) => x.messageIds))];
    if (ids.length) await tg.deleteMessages(p.chat, ids);
    rememberDeleted(p.chat.id, ids);
    runner.forgetRemoved(p.id, pick.map((x) => x.path));
    r.removedOnTelegram = r.removedOnTelegram.filter((x) => !want.has(x.path));
    ctx.getDlog().write('sync', `deleted ${ids.length} messages from ${p.chat.title} for files removed from "${p.name}" (confirmed)`);
    changed();
    return { deleted: ids.length };
  });
  /** Two-way: downloads albums that appeared on Telegram into the sync's first folder. The window asks first. */
  handle('sync:downloadNew', async (id, keys) => {
    const p = profiles.find((x) => x.id === V.str(id, 40));
    const r = p && results.get(p.id);
    if (!p || !r || !r.newOnTelegram) throw new Error('Run the sync again first.');
    const want = new Set(V.arr(keys, 100000).map((x) => V.str(x, 80)));
    const albums = r.newOnTelegram.filter((a) => want.has(a.key));
    if (!albums.length) return null;
    if (active) throw new Error('A download is already running. Wait for it or cancel it first.');
    const items = albums.flatMap((a) => a.items.map((m) => ({ msgId: m.id, fileName: m.fileName, size: m.size, kind: m.kind, topic: a.topic || 'General', album: a.title, date: a.date })));
    // Into the synced folder itself, "<topic>/<album>/", so the files sit with the rest of the collection.
    const progress = throttle((s) => send('download:progress', { id: `sync-${p.id}`, ...s }), 200);
    const job = new DownloadJob(tg, p.chat, items, { dest: p.folders[0], layout: 'topic/album', policy: 'skip', groupFolder: false }, {
      progress,
      log: (text, kind) => send('log', { text, kind, at: Date.now() }),
    });
    active = job;
    let status = 'failed';
    try {
      const s = await job.run();
      status = job.cancelled ? 'cancelled' : s.failed ? 'finished with errors' : 'done';
    } finally {
      active = null;
      progress.cancel();
      send('download:progress', { id: `sync-${p.id}`, ...job.snapshot(), finished: true, status });
    }
    runner.markDownloaded(p.id, albums.flatMap((a) => a.ids));
    r.newOnTelegram = r.newOnTelegram.filter((a) => !want.has(a.key));
    changed();
    return job.snapshot();
  });

  // Sync uploads finish in the queue: their reports update the sync's snapshot.
  function attachQueue() {
    ctx.getQueue().on('finished', ({ job, report }) => {
      if (!job.sync) return;
      try { runner.jobFinished(job.sync, job.id, report || ctx.getQueue().report(job.id)); } catch (e) { ctx.getDlog().write('sync', 'recording the job failed:', e); }
    });
  }

  return {
    start() { loadProfiles(); attachQueue(); arm(); },
    stop() { clearInterval(ticker); for (const w of watchers.values()) w.close(); watchers.clear(); if (active) active.cancel(); },
  };
}

function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  let pending = null;
  const out = (v) => {
    pending = v;
    const now = Date.now();
    if (now - last >= ms) { last = now; fn(v); pending = null; return; }
    if (!timer) timer = setTimeout(() => { timer = null; last = Date.now(); if (pending) fn(pending); pending = null; }, ms - (now - last));
  };
  /** Drops a waiting call, so nothing arrives after a final message. */
  out.cancel = () => { clearTimeout(timer); timer = null; pending = null; };
  return out;
}

module.exports = { setup };
