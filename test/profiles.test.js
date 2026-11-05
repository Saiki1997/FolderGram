'use strict';

// FolderGram 4.0 Phase 5: upload profiles.
const test = require('node:test');
const assert = require('node:assert');
const P = require('../src/core/profiles');

test('the built-in profiles are valid and only use known settings', () => {
  assert.equal(P.BUILTIN.length, 7);
  for (const b of P.BUILTIN) assert.deepEqual(P.sanitizeSettings(b.settings), b.settings, b.name);
});

test('saved profiles are cleaned: unknown keys and bad values dropped, numbers clamped', () => {
  const p = P.sanitizeProfile({ name: '  Mine  ', settings: {
    segs: { speed: 'warp', sortBy: 'date', evil: 'x' }, toggles: { pipeline: false, nope: true, silent: 'yes' },
    inputs: { maxRetries: 99, bandwidthMbps: -3, dupScope: 'topic', captionBy: 'hack', nameTemplate: '{album}' }, types: { photo: true, exe: true }, delaySec: 50 } });
  assert.equal(p.name, 'Mine');
  assert.match(p.id, /^p\w+$/);
  assert.deepEqual(p.settings, { segs: { sortBy: 'date' }, toggles: { pipeline: false }, inputs: { maxRetries: 20, bandwidthMbps: 0, dupScope: 'topic', nameTemplate: '{album}' }, types: { photo: true }, delaySec: 10 });
  assert.equal(P.sanitizeProfile({ name: '   ' }), null);
});

test('saved profiles come before the built-in ones', () => {
  const all = P.allProfiles([{ id: 'pabc', name: 'Weekly', settings: {} }, null, { name: '' }]);
  assert.equal(all[0].name, 'Weekly');
  assert.equal(all.length, 1 + P.BUILTIN.length);
  assert.ok(all.slice(1).every((p) => p.builtin));
});
