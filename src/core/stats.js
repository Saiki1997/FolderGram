// Upload statistics for the dashboard. Each finished job adds one short line to stats.jsonl (counts, bytes, time
// and speed; no file names), so the numbers survive "Remove finished" and stay cheap to read.
'use strict';

const fs = require('fs');
const path = require('path');

const MAX_LINES = 20000;

/** One record from a finished job (queue job + its report). */
function recordOf(job, report) {
  const s = job.stats || {};
  const started = Number(s.startedAt || job.startedAt || 0);
  const finished = Number(job.finishedAt || Date.now());
  const seconds = Math.max(0, (finished - started - (s.offlineMs || 0)) / 1000);
  const r = report || {};
  const sizeOf = (list) => (Array.isArray(list) ? list.reduce((a, x) => a + (Number(x && x.size) || 0), 0) : 0);
  const topics = new Set((r.albums || []).filter((a) => a.status === 'sent').map((a) => a.topic || ''));
  return {
    at: finished, chat: job.chat ? String(job.chat.id) : '', status: job.status,
    sent: s.sent || 0, skipped: s.skipped || 0, duplicates: s.duplicates || 0, failed: s.failed || 0,
    albums: s.albumsDone || 0, topics: topics.size, bytes: s.bytesDone || 0, seconds: Math.round(seconds),
    skippedBytes: sizeOf(r.skipped) + sizeOf(r.duplicates),
  };
}

class StatsLog {
  constructor(file) { this.file = file; }

  append(rec) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // After a crash the last line may be torn: start on a fresh line so this record is not lost with it.
    let lead = '';
    try {
      const fd = fs.openSync(this.file, 'r');
      const size = fs.fstatSync(fd).size;
      const b = Buffer.alloc(1);
      if (size) fs.readSync(fd, b, 0, 1, size - 1);
      fs.closeSync(fd);
      if (size && b[0] !== 10) lead = '\n';
    } catch { /* new file */ }
    fs.appendFileSync(this.file, `${lead}${JSON.stringify(rec)}\n`);
  }

  read() {
    let text = '';
    try { text = fs.readFileSync(this.file, 'utf8'); } catch { return []; }
    const out = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch { /* a torn last line */ }
    }
    if (out.length > MAX_LINES) {
      const keep = out.slice(-MAX_LINES);
      try { fs.writeFileSync(this.file, keep.map((r) => JSON.stringify(r)).join('\n') + '\n'); } catch { /* next time */ }
      return keep;
    }
    return out;
  }
}

const dayKey = (t) => new Date(t).toISOString().slice(0, 10);

/**
 * Totals and the last `days` days of activity. Average speed is bytes over time actually spent uploading.
 * "Time saved" is an estimate: bytes FolderGram skipped as already uploaded or duplicate, at the average speed.
 */
function summarize(records, { now = Date.now(), days = 30 } = {}) {
  const t = { jobs: records.length, sent: 0, skipped: 0, duplicates: 0, failed: 0, albums: 0, topics: 0, bytes: 0, seconds: 0, skippedBytes: 0 };
  const chats = new Set();
  for (const r of records) {
    for (const k of ['sent', 'skipped', 'duplicates', 'failed', 'albums', 'topics', 'bytes', 'seconds', 'skippedBytes']) t[k] += Number(r[k]) || 0;
    if (r.chat) chats.add(r.chat);
  }
  t.groups = chats.size;
  t.averageSpeed = t.seconds > 0 ? t.bytes / t.seconds : 0;
  t.savedSeconds = t.averageSpeed > 0 ? t.skippedBytes / t.averageSpeed : 0;
  const series = [];
  const byDay = new Map();
  for (const r of records) {
    const k = dayKey(r.at);
    const d = byDay.get(k) || { files: 0, bytes: 0, seconds: 0, failed: 0 };
    d.files += r.sent || 0; d.bytes += r.bytes || 0; d.seconds += r.seconds || 0; d.failed += r.failed || 0;
    byDay.set(k, d);
  }
  const today = new Date(dayKey(now));
  for (let i = days - 1; i >= 0; i--) {
    const k = dayKey(today.getTime() - i * 86400000);
    series.push({ day: k, ...(byDay.get(k) || { files: 0, bytes: 0, seconds: 0, failed: 0 }) });
  }
  const recent = records.slice(-20).reverse().map((r) => ({ at: r.at, status: r.status, sent: r.sent, bytes: r.bytes, speed: r.seconds ? r.bytes / r.seconds : 0 }));
  return { totals: t, days: series, recent };
}

module.exports = { StatsLog, recordOf, summarize };
