// Video facts and fixes with the bundled ffmpeg, so every video arrives as a playable video with its length,
// size and a thumbnail: Chromium's own decoder can't open HEVC, MPEG-TS and other common formats.
'use strict';

const crypto = require('crypto');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { ffmpegPath } = require('./splitter');

// Containers Telegram plays inline. Others are rewrapped into MP4 (streams copied, no re-encoding).
const PLAYABLE = new Set(['.mp4', '.m4v', '.mov']);
// Codecs an MP4 can carry and Telegram's apps play.
const VIDEO_CODECS = new Set(['h264', 'hevc', 'h265', 'av1', 'vp9', 'mpeg4']);
const AUDIO_CODECS = new Set(['aac', 'mp3', 'ac3', 'eac3', 'opus', 'alac', 'flac']);

/** Runs ffmpeg and collects stdout (as a Buffer) and the end of stderr. */
function run(args, { timeoutMs = 120000 } = {}) {
  const bin = ffmpegPath();
  if (!bin) return Promise.reject(new Error('ffmpeg is missing'));
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true });
    const out = [];
    let err = '';
    const timer = setTimeout(() => p.kill(), timeoutMs);
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => { err = (err + d).slice(-60000); });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, out: Buffer.concat(out), err }); });
  });
}

/** Parses ffmpeg's report on an input: length, first video stream, first audio codec, rotation. */
function parseInfo(text) {
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  const duration = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0;
  // "Stream #0:0[0x100]: Video: h264 (High) ([27][0][0][0] / 0x001B), yuv420p(tv, bt709, progressive), 1920x1080 [SAR 1:1 DAR 16:9], ..."
  const v = /Stream #\d+:\d+[^:\n]*: Video: ([a-z0-9_]+)[^\n]*?,\s*(\d{2,5})x(\d{2,5})/i.exec(text);
  if (!v) return null;
  const a = /Stream #\d+:\d+[^:\n]*: Audio: ([a-z0-9_]+)/i.exec(text);
  const rot = /rotation of (-?\d+(?:\.\d+)?) degrees/.exec(text) || /rotate\s*:\s*(-?\d+)/.exec(text);
  let width = Number(v[2]), height = Number(v[3]);
  if (rot && Math.abs(Math.round(Number(rot[1]))) % 180 === 90) [width, height] = [height, width];
  return { duration, width, height, videoCodec: v[1].toLowerCase(), audioCodec: a ? a[1].toLowerCase() : null };
}

/** { duration, width, height, videoCodec, audioCodec } or null when the file has no readable video. */
async function info(file) {
  const { err } = await run(['-hide_banner', '-i', file], { timeoutMs: 60000 });
  return parseInfo(err);
}

/** A JPEG thumbnail at most 320 px on the longest side (Telegram's limit), or null. */
async function thumbnail(file, duration) {
  const grab = async (at) => {
    const seek = at > 0 ? ['-ss', at.toFixed(2)] : [];
    const { code, out } = await run(['-hide_banner', '-loglevel', 'error', ...seek, '-i', file, '-frames:v', '1',
      '-vf', "scale='if(gt(iw,ih),320,-2)':'if(gt(iw,ih),-2,320)'", '-c:v', 'mjpeg', '-q:v', '5', '-f', 'image2', 'pipe:1'], { timeoutMs: 60000 });
    return code === 0 && out.length > 100 && out.length < 200 * 1024 ? out : null;
  };
  // A frame a little way in shows more than the usual black first frame; streams that can't seek there use the start.
  return (duration > 2 && await grab(Math.min(duration / 3, 10))) || grab(0);
}

/** Everything Telegram needs to show a video: { duration, width, height, thumb, videoCodec, audioCodec } or null. */
async function probe(file) {
  const meta = await info(file).catch(() => null);
  if (!meta) return null;
  meta.thumb = await thumbnail(file, meta.duration).catch(() => null);
  return meta;
}

/** Whether a video in this container should be rewrapped into MP4, and whether its streams allow it. */
function needsRemux(ext, meta) {
  if (PLAYABLE.has(ext)) return false;
  return !!meta && VIDEO_CODECS.has(meta.videoCodec) && (!meta.audioCodec || AUDIO_CODECS.has(meta.audioCodec));
}

/**
 * Rewraps a video (`meta` from info()) into MP4 without re-encoding (seconds even for big files). Returns a scanner-style file entry in
 * a temp folder plus cleanup(), or null when ffmpeg can't do it (the caller then sends the original as a file).
 */
async function remuxToMp4(f, meta, { tmpRoot = os.tmpdir() } = {}) {
  const dir = path.join(tmpRoot, 'FolderGram-mp4', crypto.createHash('sha1').update(`${f.path}|${f.size}|${f.mtime}`).digest('hex').slice(0, 12));
  await fsp.mkdir(dir, { recursive: true });
  const name = `${f.name.replace(/\.[^.]+$/, '')}.mp4`;
  const out = path.join(dir, name);
  const cleanup = () => fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', f.path, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart'];
  if (meta && /^(hevc|h265)$/.test(meta.videoCodec)) args.push('-tag:v', 'hvc1'); // Apple devices need this tag to play HEVC
  args.push(out);
  const { code } = await run(args, { timeoutMs: 30 * 60000 });
  const st = code === 0 ? await fsp.stat(out).catch(() => null) : null;
  if (!st || !st.size) { await cleanup(); return null; }
  return { file: { ...f, path: out, name, ext: '.mp4', size: st.size, remuxedFrom: f.path }, cleanup };
}

module.exports = { probe, info, thumbnail, parseInfo, needsRemux, remuxToMp4, PLAYABLE };
