'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { splitVideo, ffmpegPath, duration } = require('../src/core/splitter');

const bin = ffmpegPath();
const usable = bin && fs.existsSync(bin) && spawnSync(bin, ['-version']).status === 0;

test('a video over the limit is split into playable parts that cover all of it', { skip: !usable && 'ffmpeg not available here' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fgs-'));
  const file = path.join(dir, 'clip.mp4');
  const r = spawnSync(bin, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440',
    '-t', '12', '-c:v', 'libx264', '-g', '25', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file]);
  assert.equal(r.status, 0, String(r.stderr));
  const st = fs.statSync(file);
  const limit = Math.ceil(st.size / 3);
  const { parts, cleanup } = await splitVideo({ path: file, name: 'clip.mp4', ext: '.mp4', size: st.size, mtime: st.mtime.toISOString(), mtimeMs: st.mtimeMs }, limit, { tmpRoot: dir });
  try {
    assert.ok(parts.length >= 3, `${parts.length} parts`);
    assert.ok(parts.every((p) => p.size > 0 && p.size <= limit));
    assert.equal(parts[0].name, `clip (part 1 of ${parts.length}).mp4`);
    let total = 0;
    for (const p of parts) total += await duration(bin, p.path);
    assert.ok(Math.abs(total - 12) < 1, `parts cover ${total}s`);
  } finally {
    await cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
