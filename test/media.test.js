'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// The Linux build of ffmpeg-static 6.0 crashes on MPEG-TS on some machines (the Windows build doesn't), so on
// Linux the system ffmpeg is used when there is one. FFMPEG_BIN is ffmpeg-static's own override.
if (process.platform === 'linux' && !process.env.FFMPEG_BIN && fs.existsSync('/usr/bin/ffmpeg')) process.env.FFMPEG_BIN = '/usr/bin/ffmpeg';

const media = require('../src/core/media');
const { ffmpegPath } = require('../src/core/splitter');
const { Telegram } = require('../src/core/telegram');
const { KIND } = require('../src/core/scanner');

const bin = ffmpegPath();
const usable = bin && fs.existsSync(bin) && spawnSync(bin, ['-version']).status === 0;
const skip = !usable && 'ffmpeg not available here';

test('ffmpeg reports are read for size, length, codecs and rotation', () => {
  const hevcRotated = `Duration: 00:01:05.50, start: 0.000000, bitrate: 9000 kb/s
  Stream #0:0[0x1](und): Video: hevc (Main) (hvc1 / 0x31637668), yuv420p(tv, bt709), 1920x1080, 8000 kb/s, 30 fps
      Side data:
        displaymatrix: rotation of -90.00 degrees
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo`;
  assert.deepEqual(media.parseInfo(hevcRotated), { duration: 65.5, width: 1080, height: 1920, videoCodec: 'hevc', audioCodec: 'aac' });
  const ts = `Duration: 00:00:12.04, start: 1.400000, bitrate: 1200 kb/s
  Program 1
  Stream #0:0[0x100]: Video: h264 (High) ([27][0][0][0] / 0x001B), yuv420p(progressive), 1280x720 [SAR 1:1 DAR 16:9], 25 fps
  Stream #0:1[0x101](und): Audio: aac (LC) ([15][0][0][0] / 0x000F), 44100 Hz, stereo, fltp, 130 kb/s`;
  const info = media.parseInfo(ts);
  assert.equal(info.width, 1280);
  assert.equal(info.videoCodec, 'h264');
  assert.ok(media.needsRemux('.ts', info));
  assert.ok(!media.needsRemux('.mp4', info));
  assert.ok(!media.needsRemux('.avi', { ...info, videoCodec: 'msmpeg4v3' }));
  assert.equal(media.parseInfo('Duration: 00:00:03.00\n  Stream #0:0: Audio: mp3, 44100 Hz'), null);
});

function makeVideo(dir, name, extra = []) {
  const file = path.join(dir, name);
  const r = spawnSync(bin, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440',
    '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', ...extra, file]);
  assert.equal(r.status, 0, String(r.stderr));
  const st = fs.statSync(file);
  return { path: file, name, ext: path.extname(name), size: st.size, mtime: Math.floor(st.mtimeMs / 1000), mtimeMs: st.mtimeMs };
}

test('videos are sent as videos: MP4 as is, .ts and .mkv rewrapped into MP4, unreadable ones as files', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fgv-'));
  const mp4 = makeVideo(dir, 'clip.mp4');
  const ts = makeVideo(dir, 'stream.ts');
  const mkv = makeVideo(dir, 'show.mkv');
  const bad = path.join(dir, 'broken.mp4');
  fs.writeFileSync(bad, 'not a video at all');
  const broken = { path: bad, name: 'broken.mp4', ext: '.mp4', size: 18, mtime: 1 };

  const t = new Telegram({ store: { load: () => null, save() {}, remove() {} } });
  const cleanups = [];
  const items = await t.prepare([mp4, ts, mkv, broken], false, false, { cleanups });
  try {
    assert.deepEqual(items.map((it) => it.kind), [KIND.VIDEO, KIND.VIDEO, KIND.VIDEO, KIND.DOC]);
    assert.equal(items[0].file.path, mp4.path);
    assert.equal(items[1].file.name, 'stream.mp4');
    assert.equal(items[2].file.name, 'show.mp4');
    for (const it of items.slice(0, 3)) {
      assert.equal(it.meta.width, 640);
      assert.ok(it.meta.duration > 3.5 && it.meta.duration < 4.5);
      assert.ok(it.meta.thumb && it.meta.thumb[0] === 0xff && it.meta.thumb[1] === 0xd8, 'JPEG thumbnail');
      const again = await media.info(it.file.path);
      assert.equal(again.videoCodec, 'h264'); // still the original stream: nothing re-encoded
    }
    const head = fs.readFileSync(items[1].file.path).subarray(4, 8).toString('latin1');
    assert.equal(head, 'ftyp');
  } finally {
    for (const c of cleanups) await c();
  }
  assert.ok(!fs.existsSync(items[1].file.path), 'temporary MP4 removed after sending');
  fs.rmSync(dir, { recursive: true, force: true });
});
