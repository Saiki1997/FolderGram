'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SenderPool, uploadParallel, PART } = require('../src/core/fastupload');
const { floodSeconds } = require('../src/core/retry');
const { AdaptiveConcurrency } = require('../src/core/concurrency');

const api = { saveBigPart: (a) => ({ big: true, ...a }), savePart: (a) => ({ big: false, ...a }) };

/** Fake Telegram data center: stores parts per file id, counts connections and parts in flight. */
function fakeDc({ latencyMs = 5, script = [] } = {}) {
  const dc = { files: new Map(), connections: 0, inFlight: 0, maxInFlight: 0, perSender: new Map() };
  const connect = async () => {
    const n = ++dc.connections;
    let connected = true;
    return {
      n,
      isConnected: () => connected,
      disconnect: async () => { connected = false; },
      send: async (req) => {
        if (!connected) throw new Error('Not connected');
        dc.inFlight++;
        dc.maxInFlight = Math.max(dc.maxInFlight, dc.inFlight);
        dc.perSender.set(n, (dc.perSender.get(n) || 0) + 1);
        try {
          await new Promise((r) => setTimeout(r, latencyMs));
          const step = script.shift();
          if (step === 'flood') throw Object.assign(new Error('A wait of 1 seconds is required'), { errorMessage: 'FLOOD_WAIT_1', seconds: 1 });
          if (step === 'drop') { connected = false; throw new Error('Not connected'); }
          const key = String(req.fileId);
          if (!dc.files.has(key)) dc.files.set(key, new Map());
          dc.files.get(key).set(req.filePart, Buffer.from(req.bytes));
          return true;
        } finally {
          dc.inFlight--;
        }
      },
    };
  };
  return { dc, connect };
}

function tmpFile(bytes) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fgu-')), 'v.mp4');
  const buf = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i += 4096) buf.writeUInt32LE(i >>> 0, i);
  fs.writeFileSync(p, buf);
  return { path: p, name: 'v.mp4', size: bytes, buf };
}

test('a big file goes out in 512 KB parts over several connections and arrives whole', async () => {
  const f = tmpFile(25 * 1024 * 1024 + 123);
  const { dc, connect } = fakeDc();
  const pool = new SenderPool(connect);
  const progress = [];
  const r = await uploadParallel(pool, api, f, { connections: 4, perConnection: 2, onProgress: (p) => progress.push(p) });
  assert.equal(r.big, true);
  assert.equal(r.parts, Math.ceil(f.size / PART));
  const parts = dc.files.get(String(r.id));
  assert.equal(parts.size, r.parts);
  const joined = Buffer.concat([...parts.keys()].sort((a, b) => a - b).map((k) => parts.get(k)));
  assert.ok(joined.equals(f.buf), 'every byte arrives in order');
  assert.equal(dc.connections, 4);
  assert.equal(dc.maxInFlight, 8);
  assert.ok([...dc.perSender.values()].every((n) => n > 5), 'parts are spread over all connections');
  assert.equal(progress[progress.length - 1], 1);
  await pool.close();
});

test('small files use the small-file call and one connection is reused for the next file', async () => {
  const f = tmpFile(300 * 1024);
  const { dc, connect } = fakeDc();
  const pool = new SenderPool(connect);
  const r1 = await uploadParallel(pool, api, f, { connections: 1 });
  const r2 = await uploadParallel(pool, api, { name: 'b.jpg', buffer: Buffer.alloc(1000, 1) }, { connections: 1 });
  assert.equal(r1.big, false);
  assert.equal(r1.parts, 1);
  assert.equal(r2.parts, 1);
  assert.notEqual(String(r1.id), String(r2.id));
  assert.equal(dc.connections, 1);
  await pool.close();
});

test('flood waits are waited out, dropped connections reconnect, and the file still arrives whole', async () => {
  const f = tmpFile(3 * PART + 10);
  const { dc, connect } = fakeDc({ script: ['flood', 'drop'] });
  const pool = new SenderPool(connect);
  const r = await uploadParallel(pool, api, f, { connections: 2, perConnection: 1, floodSeconds });
  assert.equal(dc.files.get(String(r.id)).size, 4);
  assert.ok(dc.connections >= 3, 'the dropped connection was replaced');
  await pool.close();
});

test('a long flood wait and a cancel stop the upload', async () => {
  const f = tmpFile(2 * PART);
  const long = fakeDc();
  const pool = new SenderPool(async () => ({ isConnected: () => true, disconnect: async () => {},
    send: async () => { throw Object.assign(new Error('FLOOD_WAIT_300'), { errorMessage: 'FLOOD_WAIT_300' }); } }));
  await assert.rejects(uploadParallel(pool, api, f, { floodSeconds }), /FLOOD_WAIT_300/);
  let cancel = false;
  const p2 = new SenderPool(long.connect);
  await assert.rejects(uploadParallel(p2, api, tmpFile(40 * PART), { connections: 2, onProgress: () => { cancel = true; }, isCanceled: () => cancel }), /USER_CANCELED/);
  await p2.close();
});

test('connections follow the speed setting, by file size, and halve on a flood wait', () => {
  const c = new AdaptiveConcurrency({ preset: 'fast' });
  assert.equal(c.connectionsFor(1024 * 1024), 1);
  assert.equal(c.connectionsFor(10 * 1024 * 1024), 2);
  assert.equal(c.connectionsFor(500 * 1024 * 1024), 8);
  c.flood(20);
  assert.equal(c.connectionsFor(500 * 1024 * 1024), 4);
  assert.equal(new AdaptiveConcurrency({ preset: 'custom', custom: { connections: 12 } }).connectionsFor(1e9), 12);
});
