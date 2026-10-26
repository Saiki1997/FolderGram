// Measures folder scanning and album planning on synthetic folders of 1,000 to 50,000 files.
// Usage: node bench/scan-bench.js [count ...]   (files are tiny; the test is about file count, not bytes)
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanSources, buildPlan } = require('../src/core/scanner');

const NAMES = ['IMG_2026{n}.jpg', 'Marin Kitagawa {n}.jpg', 'Elaina_Set_01_{n}.png', 'a8D3fG{n}.jpg', 'Episode {n}.mp4', 'Rem (({n})).jpg'];

function makeTree(count) {
  const root = path.join(os.tmpdir(), `fg-bench-${count}`);
  if (fs.existsSync(path.join(root, '.done'))) return root;
  fs.rmSync(root, { recursive: true, force: true });
  const perFolder = 50;
  for (let i = 0; i < count; i++) {
    const folder = path.join(root, `Collection ${Math.floor(i / 2000)}`, `Set ${String(Math.floor(i / perFolder)).padStart(3, '0')}`);
    if (i % perFolder === 0) fs.mkdirSync(folder, { recursive: true });
    const name = NAMES[i % NAMES.length].replace('{n}', String(i).padStart(4, '0'));
    fs.writeFileSync(path.join(folder, name), 'x');
  }
  fs.writeFileSync(path.join(root, '.done'), '');
  return root;
}

async function measure(count) {
  const root = makeTree(count);
  const opts = { captionBy: 'smart', topicBy: 'top' };
  const t0 = process.hrtime.bigint();
  const groups = await scanSources([root], opts);
  const t1 = process.hrtime.bigint();
  const plan = buildPlan(groups, opts);
  const t2 = process.hrtime.bigint();
  const files = groups.reduce((a, g) => a + g.files.length, 0);
  const albums = plan.reduce((a, e) => a + e.albums.length, 0);
  const ms = (a, b) => Number(b - a) / 1e6;
  return { files, folders: groups.length, albums, scanMs: Math.round(ms(t0, t1)), planMs: Math.round(ms(t1, t2)),
    heapMb: Math.round(process.memoryUsage().heapUsed / 1048576) };
}

(async () => {
  const counts = process.argv.slice(2).map(Number).filter(Boolean);
  for (const n of counts.length ? counts : [100, 1000, 10000, 50000]) {
    await measure(n); // warm the OS file cache so runs compare fairly
    const r = await measure(n);
    console.log(JSON.stringify({ target: n, ...r }));
  }
})();
