// Backups of an account's FolderGram data in one file: settings, naming rules, upload history, saved jobs and the
// queue, and folder syncs. A plain backup never holds the Telegram login or the API hash / bot token. Only an
// encrypted backup (password, scrypt + AES-256-GCM) can carry them, and only when asked. Every file is checked
// against its SHA-256 before anything is restored, and the current data is backed up first.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeAtomic } = require('./store');

const FORMAT = 'foldergram-backup';
const VERSION = 1;
const EXT = '.fgbackup';

// What a backup holds, relative to the account's data folder.
const SINGLE = ['settings.json', 'naming.json', 'uploaded.json', 'stats.jsonl', 'sync/profiles.json', 'sync/deleted.json'];
const FOLDERS = [{ dir: 'jobs', match: /\.(json|jsonl)$/ }, { dir: 'sync', match: /^[\w-]+\.json$/ }];
const SESSION = /^session-[\w-]+\.dat$/;

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** The files a backup of `dir` would hold (relative paths, forward slashes). */
function filesOf(dir, { sessions = false } = {}) {
  const out = new Set();
  for (const f of SINGLE) if (fs.existsSync(path.join(dir, f))) out.add(f);
  for (const { dir: sub, match } of FOLDERS) {
    let names = [];
    try { names = fs.readdirSync(path.join(dir, sub)); } catch { continue; }
    for (const n of names) if (match.test(n) && fs.statSync(path.join(dir, sub, n)).isFile()) out.add(`${sub}/${n}`);
  }
  if (sessions) for (const n of fs.readdirSync(dir)) if (SESSION.test(n)) out.add(n);
  return [...out].sort();
}

/**
 * Builds a backup of `dir`. opts: { appVersion, account: { id, name }, password (encrypts when set), includeLogin
 * (only with a password), secretKeys (settings keys stripped unless includeLogin), unseal(text) → plain text for
 * values sealed with Windows' secure storage (so a restore on another PC can read them) }.
 * Returns { buffer, summary }.
 */
function create(dir, opts = {}) {
  const { appVersion = '', account = null, password = '', includeLogin = false, secretKeys = [], unseal = (s) => s } = opts;
  if (includeLogin && !password) throw new Error('A backup with the login must be encrypted: choose a password.');
  const files = {};
  for (const rel of filesOf(dir, { sessions: includeLogin })) {
    let buf = fs.readFileSync(path.join(dir, rel));
    if (rel === 'settings.json') {
      const s = JSON.parse(buf.toString('utf8') || '{}');
      for (const k of secretKeys) { if (includeLogin && s[k]) s[k] = unseal(s[k]); else delete s[k]; }
      buf = Buffer.from(JSON.stringify(s));
    } else if (SESSION.test(rel)) {
      buf = Buffer.from(unseal(buf.toString('utf8')) || '');
    }
    files[rel] = { sha256: sha(buf), size: buf.length, data: buf.toString('base64') };
  }
  const payload = Buffer.from(JSON.stringify({ files }));
  const head = { format: FORMAT, version: VERSION, appVersion, createdAt: new Date().toISOString(), account: account ? { id: account.id, name: account.name } : null,
    login: !!includeLogin, count: Object.keys(files).length, sha256: sha(payload) };
  let body;
  if (password) {
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = crypto.scryptSync(String(password), salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([c.update(payload), c.final()]);
    body = { ...head, encrypted: { kdf: 'scrypt', N: 2 ** 15, r: 8, p: 1, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') } };
  } else {
    body = { ...head, files };
  }
  return { buffer: Buffer.from(JSON.stringify(body)), summary: summarize(head, files) };
}

const summarize = (head, files) => ({ ...head, files: Object.entries(files).map(([p, f]) => ({ path: p, size: f.size })) });

/**
 * Reads and checks a backup: the format and version, the password, and every file's SHA-256 (and that JSON files
 * parse). Throws a plain-language error when anything is wrong. Returns { head, files, summary }.
 */
function read(buffer, { password = '' } = {}) {
  let body;
  try { body = JSON.parse(buffer.toString('utf8')); } catch { throw new Error('This is not a FolderGram backup (or it is damaged).'); }
  if (!body || body.format !== FORMAT) throw new Error('This is not a FolderGram backup.');
  if (!Number.isInteger(body.version) || body.version > VERSION) throw new Error(`This backup was made by a newer FolderGram (${body.appVersion || 'unknown version'}). Update FolderGram to restore it.`);
  let files = body.files;
  if (body.encrypted) {
    if (!password) throw Object.assign(new Error('This backup is encrypted. Enter its password.'), { code: 'NEED_PASSWORD' });
    const e = body.encrypted;
    try {
      const key = crypto.scryptSync(String(password), Buffer.from(e.salt, 'base64'), 32, { N: e.N, r: e.r, p: e.p, maxmem: 64 * 1024 * 1024 });
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(e.iv, 'base64'));
      d.setAuthTag(Buffer.from(e.tag, 'base64'));
      const plain = Buffer.concat([d.update(Buffer.from(e.data, 'base64')), d.final()]);
      if (sha(plain) !== body.sha256) throw new Error('checksum');
      files = JSON.parse(plain.toString('utf8')).files;
    } catch {
      throw Object.assign(new Error('Wrong password, or the backup is damaged.'), { code: 'BAD_PASSWORD' });
    }
  } else if (sha(Buffer.from(JSON.stringify({ files }))) !== body.sha256) {
    throw new Error('The backup is damaged: its contents do not match its checksum.');
  }
  if (!files || typeof files !== 'object') throw new Error('The backup holds no files.');
  for (const [rel, f] of Object.entries(files)) {
    if (!isSafeRel(rel)) throw new Error(`The backup holds an unexpected file: ${rel}`);
    const buf = Buffer.from(f.data || '', 'base64');
    if (sha(buf) !== f.sha256) throw new Error(`The backup is damaged: ${rel} does not match its checksum.`);
    if (rel.endsWith('.json')) { try { JSON.parse(buf.toString('utf8')); } catch { throw new Error(`The backup is damaged: ${rel} is not readable.`); } }
  }
  const head = { ...body };
  delete head.files;
  delete head.encrypted;
  return { head, files, summary: summarize({ ...head, encrypted: !!body.encrypted }, files) };
}

/** Only the files a backup can hold, inside the data folder. */
function isSafeRel(rel) {
  if (typeof rel !== 'string' || rel.includes('..') || path.isAbsolute(rel) || rel.includes('\\')) return false;
  if (SINGLE.includes(rel) || SESSION.test(rel)) return true;
  const [sub, name, extra] = rel.split('/');
  if (extra !== undefined) return false;
  const f = FOLDERS.find((x) => x.dir === sub);
  return !!(f && name && f.match.test(name));
}

/**
 * Restores checked backup files into `dir`. The current data is saved first (as a plain backup in
 * backups/before-restore-<time>.fgbackup), then the backed-up jobs and sync folders replace the current ones and
 * each file is written atomically. seal(text) re-protects the login and secrets with this PC's secure storage.
 * Returns { restored, safetyCopy }.
 */
function restore(dir, checked, { appVersion = '', secretKeys = [], seal = (s) => s } = {}) {
  const safety = create(dir, { appVersion, secretKeys });
  const safetyCopy = path.join(dir, 'backups', `before-restore-${new Date().toISOString().replace(/[:.]/g, '-')}${EXT}`);
  writeAtomic(safetyCopy, safety.buffer, { backup: false });
  // Folders are replaced as a whole, so a restored queue does not mix with jobs that were not in the backup. The
  // old files are moved aside, never deleted.
  const aside = path.join(dir, 'backups', `replaced-${Date.now()}`);
  for (const { dir: sub } of FOLDERS) {
    if (!Object.keys(checked.files).some((r) => r.startsWith(`${sub}/`))) continue;
    const from = path.join(dir, sub);
    if (fs.existsSync(from)) { fs.mkdirSync(aside, { recursive: true }); fs.renameSync(from, path.join(aside, sub)); }
  }
  let restored = 0;
  for (const [rel, f] of Object.entries(checked.files)) {
    let buf = Buffer.from(f.data, 'base64');
    if (rel === 'settings.json') {
      const s = JSON.parse(buf.toString('utf8') || '{}');
      // A plain backup has no secrets: keep the ones this PC has now.
      const now = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')); } catch { return {}; } })();
      for (const k of secretKeys) { if (s[k]) s[k] = seal(s[k]); else if (now[k]) s[k] = now[k]; }
      buf = Buffer.from(JSON.stringify(s));
    } else if (SESSION.test(rel)) {
      buf = Buffer.from(seal(buf.toString('utf8')));
    }
    writeAtomic(path.join(dir, ...rel.split('/')), buf);
    restored++;
  }
  return { restored, safetyCopy };
}

/** Keeps the newest `keep` automatic backups in `folder` (files named auto-*.fgbackup). */
function prune(folder, keep = 7) {
  let names = [];
  try { names = fs.readdirSync(folder).filter((n) => /^auto-.*\.fgbackup$/.test(n)).sort(); } catch { return; }
  for (const n of names.slice(0, Math.max(0, names.length - keep))) fs.rmSync(path.join(folder, n), { force: true });
}

module.exports = { create, read, restore, filesOf, isSafeRel, prune, FORMAT, VERSION, EXT };
