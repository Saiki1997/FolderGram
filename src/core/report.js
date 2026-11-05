// Upload reports as CSV: one row per file, with its album, topic, result and error.
'use strict';

const cell = (v) => {
  const s = v == null ? '' : String(v);
  // Quote everything; neutralise leading characters that spreadsheets treat as formulas.
  return `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
};

function toCsv(r) {
  const rows = [['job', 'group', 'status', 'file', 'path', 'topic', 'album', 'detail', 'started', 'finished']];
  const base = [r.jobName || '', (r.chat && r.chat.title) || ''];
  const times = [r.startedAt || '', r.finishedAt || ''];
  for (const f of r.uploaded || []) rows.push([...base, 'uploaded', f.name, f.path, f.topic, f.album, '', ...times]);
  for (const f of r.failed || []) rows.push([...base, 'failed', f.name, f.path, f.topic || '', '', f.error || '', ...times]);
  for (const f of r.duplicates || []) rows.push([...base, 'duplicate', f.name, f.path, '', '', `${f.certain ? 'same as' : 'probably same as'} ${f.of || 'an earlier upload'}`, ...times]);
  for (const f of r.skipped || []) rows.push([...base, 'skipped', f.name, f.path, '', '', f.reason || '', ...times]);
  for (const a of r.review || []) for (const name of a.files || []) rows.push([...base, 'check', name, '', a.topic || '', a.set || '', 'may already be in Telegram', ...times]);
  return `﻿${rows.map((row) => row.map(cell).join(',')).join('\r\n')}\r\n`;
}

module.exports = { toCsv };
