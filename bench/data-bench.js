// Measures duplicate fingerprints, full SHA-256 hashing and the upload history on this machine.
// Usage: node bench/data-bench.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { HashCache, mapLimit } = require('../src/core/hashing');
const { UploadHistory } = require('../src/core/history');

const ms = (t0) => Math.round(Number(process.hrtime.bigint() - t0) / 1e6);

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-data-'));
  // 2,000 files of 200 KB (quick fingerprints) and 8 files of 64 MB (full hashes).
  const small = [];
  const blob = Buffer.alloc(200 * 1024, 7);
  for (let i = 0; i < 2000; i++) {
    const p = path.join(dir, `s${i}.jpg`);
    blob.writeUInt32LE(i, 0);
    fs.writeFileSync(p, blob);
    const st = fs.statSync(p);
    small.push({ path: p, size: st.size, mtimeMs: st.mtimeMs });
  }
  const big = [];
  const chunk = Buffer.alloc(64 * 1024 * 1024, 3);
  for (let i = 0; i < 8; i++) {
    const p = path.join(dir, `b${i}.mp4`);
    chunk.writeUInt32LE(i, 0);
    fs.writeFileSync(p, chunk);
    const st = fs.statSync(p);
    big.push({ path: p, size: st.size, mtimeMs: st.mtimeMs });
  }
  const cache = new HashCache(path.join(dir, 'hashes.json'));
  let t0 = process.hrtime.bigint();
  await mapLimit(small, 16, (f) => cache.quick(f));
  const quickCold = ms(t0);
  t0 = process.hrtime.bigint();
  await mapLimit(small, 16, (f) => cache.quick(f));
  const quickCached = ms(t0);
  t0 = process.hrtime.bigint();
  await Promise.all(big.map((f) => cache.sha256(f)));
  const shaMs = ms(t0);
  const mbps = Math.round((8 * 64) / (shaMs / 1000));
  cache.pool.close && cache.pool.close();

  const hist = new UploadHistory(path.join(dir, 'uploaded.json'));
  const pairs = Array.from({ length: 50000 }, (_, i) => [`chat|${i.toString(16).padStart(40, '0')}`, Date.now()]);
  t0 = process.hrtime.bigint();
  for (let i = 0; i < pairs.length; i += 10) hist.addMany(pairs.slice(i, i + 10)); // one album at a time, journalled
  const journalMs = ms(t0);
  t0 = process.hrtime.bigint();
  hist.save();
  const compactMs = ms(t0);
  t0 = process.hrtime.bigint();
  const again = new UploadHistory(path.join(dir, 'uploaded.json'));
  const loadMs = ms(t0);
  console.log(JSON.stringify({ quickFingerprints2000ColdMs: quickCold, quickFingerprints2000CachedMs: quickCached,
    sha256_8x64MB_Ms: shaMs, sha256MBps: mbps, historyJournal5000AlbumsMs: journalMs, perAlbumMs: +(journalMs / 5000).toFixed(3),
    historyCompact50kMs: compactMs, historyLoad50kMs: loadMs, entries: again.size ?? undefined }));
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}
main();
