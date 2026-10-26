// Small validators for values that arrive over IPC from the window. Bad input becomes a safe default or an error,
// never an exception deep inside the app.
'use strict';

const path = require('path');

const str = (v, max = 1000) => (typeof v === 'string' ? v.slice(0, max) : v == null ? '' : String(v).slice(0, max));
const num = (v, min, max, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};
const int = (v, min, max) => {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n) || n < min || n > max) throw new Error('Invalid number.');
  return n;
};
const arr = (v, max = 1000) => (Array.isArray(v) ? v.slice(0, max) : []);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const oneOf = (v, list, dflt) => (list.includes(v) ? v : dflt);

/** An absolute local path without NUL bytes. */
function filePath(v) {
  const p = str(v, 4096);
  if (!p || p.includes('\0') || !path.isAbsolute(p)) throw new Error(`Not a valid path: ${p.slice(0, 80)}`);
  return path.normalize(p);
}

module.exports = { str, num, int, arr, obj, oneOf, path: filePath };
