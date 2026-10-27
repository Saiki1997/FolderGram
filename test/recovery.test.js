'use strict';

// Albums that Telegram refuses with MEDIA_EMPTY (an upload it lost) are uploaded again and sent; and the debug log.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Api } = require('telegram');
const { Telegram } = require('../src/core/telegram');
const { DebugLog, describe } = require('../src/core/debuglog');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fg-rec-'));
const err = (m) => Object.assign(new Error(m), { errorMessage: m });

function photoFiles(n) {
  const dir = tmp();
  return Array.from({ length: n }, (_, i) => {
    const p = path.join(dir, `p${i}.jpg`);
    fs.writeFileSync(p, Buffer.alloc(100, i));
    return { path: p, name: `p${i}.jpg`, ext: '.jpg', size: 100, mtime: 1, kind: 'photo' };
  });
}

const photo = (id) => new Api.MessageMediaPhoto({ photo: new Api.Photo({ id: BigInt(id), accessHash: 1n, fileReference: Buffer.alloc(0), date: 0, sizes: [], dcId: 1 }) });

/** A Telegram with a scripted UploadMedia / send and a fast and a standard uploader that count their uses. */
function rig({ store = () => null, send = () => null } = {}) {
  const lines = [];
  const t = new Telegram({ store: { load: () => null, save() {}, remove() {} }, shrinkPhoto: async () => null });
  t.dlog = { write: (area, ...p) => lines.push(`[${area}] ${p.map((x) => (typeof x === 'string' ? x : describe(x))).join(' ')}`) };
  t.storePauseMs = 1;
  const used = { fast: 0, standard: 0, store: 0, send: 0 };
  let nextId = 1n;
  t.uploadFast = async (file) => { used.fast++; return new Api.InputFile({ id: nextId++, parts: 1, name: file.name, md5Checksum: '' }); };
  t.client = {
    uploadFile: async ({ file }) => { used.standard++; return new Api.InputFile({ id: nextId++, parts: 1, name: file.name, md5Checksum: '' }); },
    invoke: async (req) => {
      if (req instanceof Api.messages.UploadMedia) {
        const n = ++used.store;
        const r = store(n, req);
        if (r instanceof Error) throw r;
        return r || photo(n);
      }
      const n = ++used.send;
      const r = send(n, req);
      if (r instanceof Error) throw r;
      return new Api.Updates({ updates: [new Api.UpdateMessageID({ id: 100 + n, randomId: 1n })], users: [], chats: [], date: 0, seq: 0 });
    },
  };
  t.entities.set('-100', new Api.InputPeerChannel({ channelId: 1n, accessHash: 1n }));
  return { t, used, lines };
}

test('an empty stored photo is uploaded again with the standard uploader before sending', async () => {
  const empty = new Api.MessageMediaPhoto({ photo: new Api.PhotoEmpty({ id: 9n }) });
  const { t, used, lines } = rig({ store: (n) => (n === 1 ? empty : null) });
  await t.sendAlbum({ id: '-100' }, photoFiles(2), 'Cap', null, {}, () => {});
  assert.equal(used.fast, 2);
  assert.equal(used.standard, 1); // only the file Telegram lost
  assert.equal(used.send, 1);
  assert.ok(lines.some((l) => /stored nothing for p0\.jpg.*PhotoEmpty/.test(l)), lines.join('\n'));
});

test('"worker busy" or MEDIA_EMPTY while storing uploads the file again instead of asking about the same upload', async () => {
  const { t, used } = rig({ store: (n) => (n === 1 ? err('WORKER_BUSY_TOO_LONG_RETRY') : n === 2 ? err('MEDIA_EMPTY') : null) });
  await t.sendAlbum({ id: '-100' }, photoFiles(1), 'Cap', null, {}, () => {});
  assert.equal(used.store, 3);
  assert.equal(used.fast + used.standard, 3); // a fresh upload for every try
  assert.equal(used.standard, 2);
});

test('a file Telegram keeps losing fails as MEDIA_EMPTY after three uploads', async () => {
  const { t, used } = rig({ store: () => err('MEDIA_EMPTY') });
  await assert.rejects(t.sendAlbum({ id: '-100' }, photoFiles(1), 'Cap', null, {}, () => {}), (e) => e.errorMessage === 'MEDIA_EMPTY');
  assert.equal(used.store, 3);
  assert.equal(used.send, 0);
});

test('MEDIA_EMPTY when sending uploads the album again and resends with the same message ids', async () => {
  const sent = [];
  const { t, used, lines } = rig({ send: (n, req) => { sent.push(req); return n === 1 ? err('MEDIA_EMPTY') : null; } });
  const ids = [11n, 12n, 13n];
  const ctl = { randomIds: () => ids };
  await t.sendAlbum({ id: '-100' }, photoFiles(3), 'Cap', null, {}, () => {}, ctl);
  assert.equal(used.send, 2);
  assert.equal(used.fast, 3);
  assert.equal(used.standard, 3);
  assert.deepEqual(sent[1].multiMedia.map((m) => m.randomId), ids);
  assert.ok(lines.some((l) => /refused \(MEDIA_EMPTY\)/.test(l)));
  assert.ok(lines.some((l) => /posted as 102/.test(l)));
});

test('after two lost fast uploads the session uses the standard uploader', async () => {
  const empty = new Api.MessageMediaPhoto({ photo: new Api.PhotoEmpty({ id: 9n }) });
  // Every first store of a fast upload comes back empty; standard uploads work.
  let lastFast = false;
  const { t, used } = rig({ store: () => (lastFast ? empty : null) });
  const fast = t.uploadFast;
  t.uploadFast = async (...a) => { lastFast = true; return fast(...a); };
  const std = t.client.uploadFile;
  t.client.uploadFile = async (...a) => { lastFast = false; return std(...a); };
  await t.sendAlbum({ id: '-100' }, photoFiles(1), 'A', null, {}, () => {});
  assert.equal(t.fastUpload, true);
  await t.sendAlbum({ id: '-100' }, photoFiles(1), 'B', null, {}, () => {});
  assert.equal(t.fastUpload, false);
  const before = used.fast;
  await t.sendAlbum({ id: '-100' }, photoFiles(1), 'C', null, {}, () => {});
  assert.equal(used.fast, before);
});

test('other errors when sending are not retried here', async () => {
  const { t, used } = rig({ send: () => err('CHAT_WRITE_FORBIDDEN') });
  await assert.rejects(t.sendAlbum({ id: '-100' }, photoFiles(2), 'Cap', null, {}, () => {}), /CHAT_WRITE_FORBIDDEN/);
  assert.equal(used.send, 1);
  assert.equal(used.standard, 0);
});

test('debug log writes lines, hides secrets, rolls over big files and keeps 7 days', () => {
  const dir = tmp();
  for (let d = 1; d <= 9; d++) fs.writeFileSync(path.join(dir, `foldergram-2026-01-0${d}.log`), 'old\n');
  fs.writeFileSync(path.join(dir, 'other.txt'), 'keep');
  let now = new Date('2026-01-10T12:00:00Z');
  const log = new DebugLog(dir, { now: () => now });
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.log')).sort().slice(0, 1), ['foldergram-2026-01-03.log']);
  assert.ok(fs.existsSync(path.join(dir, 'other.txt')));
  log.write('upload', 'apiHash: abcdef0123 and', { sessionString: '1AbC', size: 5n }, err('FILE_PART_3_MISSING'));
  const text = fs.readFileSync(path.join(dir, 'foldergram-2026-01-10.log'), 'utf8');
  assert.match(text, /^2026-01-10T12:00:00\.000Z \[upload\] apiHash: \*\*\* and /);
  assert.doesNotMatch(text, /abcdef0123|1AbC/);
  assert.match(text, /"size":"5"/);
  assert.match(text, /FILE_PART_3_MISSING/);
  log.size = 21 * 1024 * 1024;
  log.write('x', 'roll');
  assert.ok(fs.existsSync(path.join(dir, 'foldergram-2026-01-10.log.1')));
  now = new Date('2026-01-11T00:00:01Z');
  log.write('x', 'next day');
  assert.equal(path.basename(log.list()[0]), 'foldergram-2026-01-11.log');
  log.close();
});
