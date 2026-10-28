'use strict';

// FolderGram 4.0 Phase 5: several accounts, each with its own data folder.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Accounts, MAIN } = require('../src/core/accounts');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fga-'));

test('the first account keeps the original folder, so earlier data needs no moving', () => {
  const root = tmp();
  const a = new Accounts(root);
  assert.equal(a.active.id, MAIN);
  assert.equal(a.activeDir(), root);
});

test('a new account gets its own folder; switching is remembered', () => {
  const root = tmp();
  const a = new Accounts(root);
  const b = a.add('Work');
  assert.ok(fs.existsSync(a.dirOf(b.id)));
  assert.notEqual(a.dirOf(b.id), root);
  a.setActive(b.id);
  const again = new Accounts(root);
  assert.equal(again.active.id, b.id);
  assert.equal(again.list().length, 2);
});

test('copying settings never copies secrets, login, folders or learned mappings', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ apiId: '1', apiHash: 'enc:x', botToken: 'enc:y', phone: '+1', sources: ['C:/x'], lastChat: { id: '1' }, ui: { speed: 'fast' } }));
  fs.writeFileSync(path.join(root, 'naming.json'), JSON.stringify({ learned: { a: 'b' }, topics: { c: 'd' }, rules: [{ id: 1 }], dictionary: [{ name: 'Rem', aliases: [] }], organize: [] }));
  fs.writeFileSync(path.join(root, 'session-user.dat'), 'secret');
  const a = new Accounts(root);
  const b = a.add('Second');
  a.copySettings(MAIN, b.id, ['apiHash', 'botToken']);
  const dir = a.dirOf(b.id);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'))), { ui: { speed: 'fast' } });
  const n = JSON.parse(fs.readFileSync(path.join(dir, 'naming.json')));
  assert.equal(n.learned, undefined);
  assert.equal(n.topics, undefined);
  assert.equal(n.dictionary.length, 1);
  assert.ok(!fs.existsSync(path.join(dir, 'session-user.dat')));
});

test('removing an account deletes its login only; the active and first accounts stay', () => {
  const root = tmp();
  const a = new Accounts(root);
  const b = a.add('Old');
  const dir = a.dirOf(b.id);
  fs.writeFileSync(path.join(dir, 'session-user.dat'), 'x');
  fs.writeFileSync(path.join(dir, 'session-user.dat.bak'), 'x');
  fs.writeFileSync(path.join(dir, 'uploaded.json'), '{}');
  assert.throws(() => a.remove(MAIN));
  a.setActive(b.id);
  assert.throws(() => a.remove(b.id));
  a.setActive(MAIN);
  assert.equal(a.remove(b.id), dir);
  assert.deepEqual(fs.readdirSync(dir), ['uploaded.json']);
  assert.equal(a.list().length, 1);
});

test('a damaged or missing list falls back to the first account', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'accounts.json'), JSON.stringify({ active: 'gone', list: [] }));
  const a = new Accounts(root);
  assert.equal(a.active.id, MAIN);
});
