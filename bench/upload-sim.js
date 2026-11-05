// Upload engine on a SIMULATED network (no Telegram account, nothing is sent anywhere).
// It runs a version's real planner, uploader and Telegram code, with only the network replaced by a stand-in:
// one shared line of LINE_MBPS, a fixed delay per request and a fixed time for Telegram to post an album.
// The numbers show how the engine uses a line like that; they are not measurements of real Telegram.
//
// Usage: node bench/upload-sim.js [repo root ...]   (default: this repo; pass an older checkout to compare)
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const MB = 1024 * 1024;
const LINE_MBPS = Number(process.env.LINE_MBPS || 11.9); // 100 Mbit/s
const RTT_MS = Number(process.env.RTT_MS || 120);
const POST_MS = Number(process.env.POST_MS || 700); // Telegram's time to post an album (assumed)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-sim-'));
  const blob = Buffer.alloc(MB, 1);
  blob.writeUInt32BE(0xffd8ffe0, 0);
  for (let d = 0; d < 8; d++) {
    const dir = path.join(root, `Set ${String(d + 1).padStart(2, '0')}`);
    fs.mkdirSync(dir);
    for (let i = 0; i < 20; i++) { blob.writeUInt32BE(d * 100 + i, 8); fs.writeFileSync(path.join(dir, `IMG_${String(i).padStart(3, '0')}.jpg`), blob); }
  }
  return root;
}

/** The repo's own Telegram class with its network replaced. */
function simTelegram(repo, { offlineAtMs = 0, offlineForMs = 0 } = {}) {
  const { Api } = require(path.join(repo, 'node_modules', 'telegram'));
  const { Telegram } = require(path.join(repo, 'src/core/telegram'));
  const rate = LINE_MBPS * MB;
  const t0 = Date.now();
  const offline = () => offlineForMs && Date.now() - t0 >= offlineAtMs && Date.now() - t0 < offlineAtMs + offlineForMs;
  const down = () => Object.assign(new Error('Not connected'), { errorMessage: 'Not connected' });
  const t = new Telegram({ store: { load: () => 'sim', save() {}, remove() {} }, shrinkPhoto: async () => null });
  const counts = { parts: 0, bytes: 0, uploads: new Map(), posts: 0 };
  let busyUntil = Date.now();
  const transfer = async (bytes) => {
    const start = Math.max(Date.now(), busyUntil);
    busyUntil = start + (bytes / rate) * 1000;
    await sleep(busyUntil - Date.now() + RTT_MS / 2);
  };
  let id = 1n;
  let msg = 1000;
  t.uploadFast = async (file, size, onFrac, ctl = {}) => {
    counts.uploads.set(file.path || file.name, (counts.uploads.get(file.path || file.name) || 0) + 1);
    const parts = Math.max(1, Math.ceil(size / (512 * 1024)));
    for (let i = 0; i < parts; i++) {
      if (ctl.isCanceled && ctl.isCanceled()) throw Object.assign(new Error('USER_CANCELED'), { errorMessage: 'USER_CANCELED' });
      if (offline()) { await sleep(300); throw down(); }
      const n = Math.min(512 * 1024, size - i * 512 * 1024);
      await transfer(n);
      counts.parts++;
      counts.bytes += n;
      onFrac((i + 1) / parts);
    }
    return new Api.InputFile({ id: id++, parts, name: file.name, md5Checksum: '' });
  };
  t.client = {
    connected: true,
    connect: async () => {},
    invoke: async (req) => {
      await sleep(RTT_MS);
      if (offline()) throw down();
      if (req instanceof Api.messages.UploadMedia) {
        return new Api.MessageMediaPhoto({ photo: new Api.Photo({ id: id++, accessHash: 1n, fileReference: Buffer.alloc(0), date: 0, sizes: [], dcId: 1 }) });
      }
      if (req instanceof Api.messages.SendMultiMedia || req instanceof Api.messages.SendMedia) {
        await sleep(POST_MS);
        counts.posts++;
        const n = req.multiMedia ? req.multiMedia.length : 1;
        return new Api.Updates({ updates: Array.from({ length: n }, () => new Api.UpdateMessageID({ id: ++msg, randomId: 1n })), users: [], chats: [], date: 0, seq: 0 });
      }
      if (req instanceof Api.messages.GetReplies || req instanceof Api.messages.GetHistory) return new Api.messages.Messages({ messages: [], chats: [], users: [] });
      return true;
    },
  };
  t.sendText = async () => { await sleep(RTT_MS); };
  t.videoInfo = async () => null;
  // A plain group, registered the way picking it in the window does.
  const chat = t.info(new Api.Chat({ id: 4242n, title: 'Sim', photo: new Api.ChatPhotoEmpty(), participantsCount: 1, date: 0, version: 0 }));
  return { t, counts, chat };
}

async function run(repo, scenario) {
  const { scanFolder } = require(path.join(repo, 'src/core/scanner'));
  const { buildPlan } = require(path.join(repo, 'src/core/planner'));
  const { UploadJob } = require(path.join(repo, 'src/core/uploader'));
  const { UploadHistory } = require(path.join(repo, 'src/core/history'));
  const root = tree();
  const plan = buildPlan(await scanFolder(root), {});
  const { t, counts, chat } = simTelegram(repo, scenario);
  const history = new UploadHistory(path.join(root, 'uploaded.json'));
  let last = 0;
  let backwards = 0;
  const events = { progress(p) { if (p.done < last) backwards++; last = Math.max(last, p.done); }, log(m, level) { if (process.env.SIM_DEBUG && level !== 'info') console.log('  ', level, m); }, wait() {}, album() {}, topic() {} };
  const job = new UploadJob(t, chat, plan, { mode: 'none', concurrency: { preset: scenario.preset || 'balanced' } }, events, history);
  const started = Date.now();
  await job.run();
  const s = (Date.now() - started) / 1000;
  const total = plan.albums ? plan.albums.reduce((a, al) => a + al.files.length, 0) : 160;
  const twice = [...counts.uploads.values()].reduce((a, n) => a + n, 0) - 160;
  fs.rmSync(root, { recursive: true, force: true });
  return { seconds: s, mbps: 160 / s, sent: job.stats.sent, failed: job.stats.failed, total, posts: counts.posts, reuploaded: twice,
    networkMb: counts.bytes / MB, progressBackwards: backwards };
}

async function main() {
  const repos = (process.argv.slice(2).length ? process.argv.slice(2) : [path.join(__dirname, '..')]).map((r) => path.resolve(r));
  const scenarios = {
    'balanced': {}, 'balanced, 10 s outage': { offlineAtMs: 5000, offlineForMs: 10000 }, 'fast': { preset: 'fast' }, 'maximum': { preset: 'max' },
  };
  console.log(`SIMULATED network: ${LINE_MBPS} MB/s shared line, ${RTT_MS} ms per request, ${POST_MS} ms to post an album. 160 photos of 1 MB in 8 folders.`);
  for (const repo of repos) {
    const version = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
    const { PRESETS } = require(path.join(repo, 'src/core/concurrency'));
    for (const [name, sc] of Object.entries(scenarios)) {
      if (sc.preset && !PRESETS[sc.preset]) continue; // the version doesn't have this preset
      const r = await run(repo, sc);
      console.log(`${version.padEnd(8)} ${name.padEnd(22)} ${r.seconds.toFixed(1).padStart(6)} s  ${r.mbps.toFixed(1).padStart(5)} MB/s  sent ${r.sent}/160  failed ${r.failed}  posts ${r.posts}  ` +
        `files uploaded again ${r.reuploaded}  over the line ${r.networkMb.toFixed(0)} MB  progress went back ${r.progressBackwards}x`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
