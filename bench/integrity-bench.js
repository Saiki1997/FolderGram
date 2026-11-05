// Integrity ledger at scale: inserts N uploaded-file rows (default 1,000,000) into a temporary database and times
// the operations FolderGram does on it. Uses a temp folder only; never touches the real app data or Telegram.
//   node bench/integrity-bench.js [N]
//   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron bench/integrity-bench.js [N]   (the app's own runtime)
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Ledger } = require('../src/core/ledger');

const N = Number(process.argv[2] || 1000000);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-ledger-bench-'));
const chatId = '-1001234567890';
const out = { runtime: `node ${process.versions.node}${process.versions.electron ? ` / electron ${process.versions.electron}` : ''}`, rows: N };
const time = (label, fn) => { const t0 = process.hrtime.bigint(); const r = fn(); out[label] = Math.round(Number(process.hrtime.bigint() - t0) / 1e5) / 10; return r; };

const l = Ledger.open(dir);
if (!l.available) { console.log(JSON.stringify({ error: 'SQLite not available in this runtime', why: l.why })); process.exit(1); }

// Insert in chunks so the bench itself doesn't hold a million row objects at once.
time('insertMs', () => {
  const CH = 50000;
  for (let i = 0; i < N; i += CH) {
    const rows = [];
    for (let j = i; j < Math.min(N, i + CH); j++) rows.push({ path: `D:\\Archive\\Folder ${j % 5000}\\IMG_${j}.jpg`, name: `IMG_${j}.jpg`, size: 1000000 + j, mtime: 1700000000 + j,
      uploadedAt: Date.now(), chatId, topicId: 100 + (j % 5000), messageId: 10 + j, albumKey: `a${Math.floor(j / 10)}`, jobId: `job${Math.floor(j / 20000)}`, state: 'VERIFIED_SENT', verification: 'album_ids_only' });
    l.addFilesBatch(rows);
  }
});
out.insertRowsPerSec = Math.round(N / (out.insertMs / 1000));
time('countsMs', () => l.counts());
time('pageOneTopicAllMs', () => { let after = 0, n = 0; for (;;) { const p = l.pageFiles({ chatId, topicId: 1234, afterId: after, limit: 500 }); if (!p.length) break; n += p.length; after = p[p.length - 1].id; } out.pageOneTopicRows = n; });
time('page2000RowsMs', () => { let after = 0; for (let k = 0; k < 4; k++) { const p = l.pageFiles({ chatId, afterId: after, limit: 500 }); after = p[p.length - 1].id; } });
time('deepPage500AtEndMs', () => l.pageFiles({ chatId, afterId: N - 600, limit: 500 }));
time('findFile1000Ms', () => { for (let k = 0; k < 1000; k++) { const j = Math.floor(Math.random() * N); l.findFile(`D:\\Archive\\Folder ${j % 5000}\\IMG_${j}.jpg`, 1000000 + j, 1700000000 + j); } });
time('messageIdsScanAllMs', () => { let after = 0, n = 0; for (;;) { const p = l.messageIds(chatId, { afterId: after, limit: 1000 }); if (!p.length) break; n += p.length; after = p[p.length - 1].id; } out.messageIdsScanned = n; });
time('setVerification10kMs', () => l.tx(() => { for (let k = 0; k < 10000; k++) l.setVerification(chatId, 10 + k * 7, 'confirmed'); }));
time('integrityCheckMs', () => l.integrityCheck());
time('backupMs', () => l.backup(path.join(dir, 'backups', 'integrity')));
l.checkpoint();
out.dbFileMB = Math.round(fs.statSync(path.join(dir, 'foldergram-integrity.sqlite')).size / 1048576);
out.heapUsedMB = Math.round(process.memoryUsage().heapUsed / 1048576);
out.rssMB = Math.round(process.memoryUsage().rss / 1048576);
l.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(JSON.stringify(out, null, 1));
