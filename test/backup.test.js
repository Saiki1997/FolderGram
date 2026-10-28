'use strict';

// FolderGram 4.0 Phase 5: backup and restore.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const B = require('../src/core/backup');

const SECRETS = ['apiHash', 'botToken'];
const seal = (s) => `enc:${Buffer.from(s).toString('hex')}`;
const unseal = (s) => (s.startsWith('enc:') ? Buffer.from(s.slice(4), 'hex').toString() : s);

function account() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fgb-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ apiId: '123', apiHash: seal('HASH'), botToken: seal('TOKEN'), ui: { speed: 'fast' } }));
  fs.writeFileSync(path.join(dir, 'naming.json'), JSON.stringify({ learned: { a: 'B' } }));
  fs.writeFileSync(path.join(dir, 'uploaded.json'), JSON.stringify({ entries: { x: 1 } }));
  fs.writeFileSync(path.join(dir, 'session-user.dat'), seal('SESSION-STRING'));
  fs.writeFileSync(path.join(dir, 'hash-cache.json'), '{}');
  fs.mkdirSync(path.join(dir, 'jobs'));
  fs.writeFileSync(path.join(dir, 'jobs', 'queue.json'), '[{"id":"j1"}]');
  fs.writeFileSync(path.join(dir, 'jobs', 'j1.state.jsonl'), '{"a":1}\n');
  fs.writeFileSync(path.join(dir, 'jobs', 'queue.json.bak'), 'old');
  fs.mkdirSync(path.join(dir, 'sync'));
  fs.writeFileSync(path.join(dir, 'sync', 'profiles.json'), '[]');
  return dir;
}

test('a plain backup holds data but never the login or secrets', () => {
  const dir = account();
  const { buffer, summary } = B.create(dir, { appVersion: '4.0.0', secretKeys: SECRETS, unseal });
  const text = buffer.toString();
  assert.ok(!text.includes('SESSION') && !text.includes(Buffer.from('SESSION-STRING').toString('base64')));
  const r = B.read(buffer);
  assert.deepEqual(Object.keys(r.files).sort(), ['jobs/j1.state.jsonl', 'jobs/queue.json', 'naming.json', 'settings.json', 'sync/profiles.json', 'uploaded.json']);
  const s = JSON.parse(Buffer.from(r.files['settings.json'].data, 'base64'));
  assert.equal(s.apiHash, undefined);
  assert.equal(s.botToken, undefined);
  assert.equal(s.apiId, '123');
  assert.equal(summary.login, false);
});

test('the login can only go into an encrypted backup, and needs the right password back', () => {
  const dir = account();
  assert.throws(() => B.create(dir, { includeLogin: true, secretKeys: SECRETS, unseal }), /encrypted/);
  const { buffer } = B.create(dir, { includeLogin: true, password: 'correct horse', secretKeys: SECRETS, unseal });
  assert.ok(!buffer.toString().includes('HASH'));
  assert.throws(() => B.read(buffer), (e) => e.code === 'NEED_PASSWORD');
  assert.throws(() => B.read(buffer, { password: 'wrong' }), (e) => e.code === 'BAD_PASSWORD');
  const r = B.read(buffer, { password: 'correct horse' });
  assert.equal(Buffer.from(r.files['session-user.dat'].data, 'base64').toString(), 'SESSION-STRING');
});

test('damaged, foreign or newer backups are refused before anything is touched', () => {
  const dir = account();
  const { buffer } = B.create(dir, { secretKeys: SECRETS });
  const body = JSON.parse(buffer);
  const bad = JSON.parse(JSON.stringify(body));
  bad.files['naming.json'].data = Buffer.from('{"learned":{}}').toString('base64');
  assert.throws(() => B.read(Buffer.from(JSON.stringify(bad))), /damaged/);
  assert.throws(() => B.read(Buffer.from('{"hello":1}')), /not a FolderGram backup/);
  assert.throws(() => B.read(Buffer.from(JSON.stringify({ ...body, version: 99, appVersion: '9.0.0' }))), /newer FolderGram \(9\.0\.0\)/);
  const evil = JSON.parse(JSON.stringify(body));
  evil.files['../evil.json'] = evil.files['naming.json'];
  evil.sha256 = require('crypto').createHash('sha256').update(JSON.stringify({ files: evil.files })).digest('hex');
  assert.throws(() => B.read(Buffer.from(JSON.stringify(evil))), /unexpected file/);
});

test('restore: current data is saved first, old jobs are moved aside, secrets of this PC are kept', () => {
  const dir = account();
  const { buffer } = B.create(dir, { secretKeys: SECRETS, unseal });
  // Things change after the backup.
  fs.writeFileSync(path.join(dir, 'naming.json'), JSON.stringify({ learned: { a: 'CHANGED' } }));
  fs.writeFileSync(path.join(dir, 'jobs', 'j2.state.jsonl'), 'new job\n');
  const r = B.restore(dir, B.read(buffer), { secretKeys: SECRETS, seal });
  assert.equal(r.restored, 6);
  assert.ok(fs.existsSync(r.safetyCopy));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'naming.json'))).learned.a, 'B');
  assert.ok(!fs.existsSync(path.join(dir, 'jobs', 'j2.state.jsonl')));
  const aside = fs.readdirSync(path.join(dir, 'backups')).find((n) => n.startsWith('replaced-'));
  assert.ok(fs.existsSync(path.join(dir, 'backups', aside, 'jobs', 'j2.state.jsonl')));
  const s = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json')));
  assert.equal(unseal(s.apiHash), 'HASH'); // kept from this PC: the plain backup had none
  assert.equal(fs.readFileSync(path.join(dir, 'session-user.dat'), 'utf8'), seal('SESSION-STRING')); // untouched
  // The safety copy restores the changed state.
  const back = B.read(fs.readFileSync(r.safetyCopy));
  assert.equal(JSON.parse(Buffer.from(back.files['naming.json'].data, 'base64')).learned.a, 'CHANGED');
});

test('an encrypted backup with the login restores it sealed for this PC', () => {
  const dir = account();
  const { buffer } = B.create(dir, { includeLogin: true, password: 'pw', secretKeys: SECRETS, unseal });
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'fgb2-'));
  B.restore(other, B.read(buffer, { password: 'pw' }), { secretKeys: SECRETS, seal });
  assert.equal(unseal(fs.readFileSync(path.join(other, 'session-user.dat'), 'utf8')), 'SESSION-STRING');
  assert.equal(unseal(JSON.parse(fs.readFileSync(path.join(other, 'settings.json'))).botToken), 'TOKEN');
});

test('automatic backups keep the newest seven', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fgb3-'));
  for (let i = 10; i < 20; i++) fs.writeFileSync(path.join(dir, `auto-2026-01-${i}.fgbackup`), '');
  fs.writeFileSync(path.join(dir, 'mine.fgbackup'), '');
  B.prune(dir, 7);
  const left = fs.readdirSync(dir).sort();
  assert.equal(left.length, 8);
  assert.ok(left.includes('mine.fgbackup') && left.includes('auto-2026-01-19.fgbackup') && !left.includes('auto-2026-01-12.fgbackup'));
});
