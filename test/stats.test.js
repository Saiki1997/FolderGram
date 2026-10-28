'use strict';

// FolderGram 4.0 Phase 5: dashboard statistics.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StatsLog, recordOf, summarize } = require('../src/core/stats');

const DAY = 86400000;
const now = Date.parse('2026-10-28T12:00:00Z');

test('a finished job becomes one record without file names', () => {
  const job = { status: 'done', chat: { id: -100 }, startedAt: now - 70000, finishedAt: now,
    stats: { startedAt: now - 70000, offlineMs: 10000, sent: 10, skipped: 2, duplicates: 1, failed: 0, albumsDone: 3, bytesDone: 6e6 } };
  const report = { albums: [{ status: 'sent', topic: 'A' }, { status: 'sent', topic: 'B' }, { status: 'failed', topic: 'C' }],
    skipped: [{ name: 'x.jpg', size: 1000 }], duplicates: [{ name: 'y.jpg', size: 500 }] };
  const r = recordOf(job, report);
  assert.deepEqual(r, { at: now, chat: '-100', status: 'done', sent: 10, skipped: 2, duplicates: 1, failed: 0, albums: 3, topics: 2, bytes: 6e6, seconds: 60, skippedBytes: 1500 });
  assert.ok(!JSON.stringify(r).includes('.jpg'));
});

test('totals, speed, time saved and 30 days of activity', () => {
  const recs = [
    { at: now - 2 * DAY, chat: '1', sent: 5, skipped: 0, duplicates: 0, failed: 1, albums: 2, topics: 1, bytes: 1e6, seconds: 10, skippedBytes: 0 },
    { at: now, chat: '2', sent: 3, skipped: 4, duplicates: 2, failed: 0, albums: 1, topics: 1, bytes: 3e6, seconds: 30, skippedBytes: 5e6 },
    { at: now - 40 * DAY, chat: '1', sent: 1, bytes: 0, seconds: 0 },
  ];
  const s = summarize(recs, { now });
  assert.equal(s.totals.sent, 9);
  assert.equal(s.totals.groups, 2);
  assert.equal(s.totals.averageSpeed, 1e5);
  assert.equal(s.totals.savedSeconds, 50);
  assert.equal(s.days.length, 30);
  assert.equal(s.days[29].day, '2026-10-28');
  assert.equal(s.days[29].files, 3);
  assert.equal(s.days[27].files, 5);
  assert.equal(s.days.reduce((a, d) => a + d.files, 0), 8); // the 40-day-old job is outside the graph
});

test('the log survives a torn last line', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fgs-')), 'stats.jsonl');
  const log = new StatsLog(file);
  log.append({ at: 1, sent: 1 });
  fs.appendFileSync(file, '{"at":2,"se');
  assert.deepEqual(log.read(), [{ at: 1, sent: 1 }]);
  log.append({ at: 3, sent: 3 });
  assert.deepEqual(log.read(), [{ at: 1, sent: 1 }, { at: 3, sent: 3 }]);
});
