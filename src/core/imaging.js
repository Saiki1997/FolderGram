// Small views of pictures for comparing and scoring them: image dimensions read from the file header, and tiny
// grayscale versions (e.g. 9 × 9 or 64 × 64 pixels) made by Electron's image decoder or by ffmpeg. Nothing here
// changes or writes the user's files.
'use strict';

const fsp = require('fs/promises');
const { spawn } = require('child_process');

// ---------------------------------------------------------------- dimensions from the header

/** { width, height, format } of a JPEG, PNG, GIF, WebP or BMP file, read from its first bytes; null if unknown. */
async function imageSize(file) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    let buf = Buffer.alloc(65536);
    let { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    let r = parseSize(buf.subarray(0, bytesRead));
    // A JPEG's size comes after its EXIF block, which can hold a large preview: read further when needed.
    if (r === undefined && bytesRead === buf.length) {
      buf = Buffer.alloc(2 * 1024 * 1024);
      ({ bytesRead } = await fh.read(buf, 0, buf.length, 0));
      r = parseSize(buf.subarray(0, bytesRead));
    }
    return r || null;
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

/** Parses dimensions from the start of a file. undefined: a JPEG whose size is further in; null: not recognised. */
function parseSize(b) {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), format: 'png' };
  if (b.length >= 10 && b.toString('latin1', 0, 3) === 'GIF') return { width: b.readUInt16LE(6), height: b.readUInt16LE(8), format: 'gif' };
  if (b.length >= 26 && b.toString('latin1', 0, 2) === 'BM') return { width: b.readInt32LE(18), height: Math.abs(b.readInt32LE(22)), format: 'bmp' };
  if (b.length >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const kind = b.toString('latin1', 12, 16);
    if (kind === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3), format: 'webp' };
    if (kind === 'VP8L') { const v = b.readUInt32LE(21); return { width: 1 + (v & 0x3fff), height: 1 + ((v >> 14) & 0x3fff), format: 'webp' }; }
    if (kind === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff, format: 'webp' };
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker === 0xff) { i++; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = b.readUInt16BE(i + 2);
      // Start-of-frame markers (not DHT 0xC4, JPG 0xC8, DAC 0xCC) hold the size.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5), format: 'jpeg' };
      }
      if (marker === 0xda) return null; // image data began without a frame header
      i += 2 + len;
    }
    return undefined;
  }
  return null;
}

// ---------------------------------------------------------------- tiny grayscale pictures

function run(cmd, args, { timeoutMs = 30000, maxBytes = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    let p;
    try { p = spawn(cmd, args, { windowsHide: true }); } catch (e) { resolve({ code: -1, out: Buffer.alloc(0), err: String(e) }); return; }
    const out = [];
    let size = 0;
    let err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d) => { size += d.length; if (size <= maxBytes) out.push(d); });
    p.stderr.on('data', (d) => { if (err.length < 20000) err += d; });
    p.on('error', (e) => { err += String(e); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, out: Buffer.concat(out), err }); });
  });
}

/** w × h grayscale bytes of a picture (or of a video frame at `seek` seconds) via ffmpeg; null on failure. */
async function ffmpegGray(ffmpeg, file, w, h, { seek = null } = {}) {
  const args = ['-v', 'error', '-nostdin'];
  if (seek != null) args.push('-ss', String(Math.max(0, seek)));
  args.push('-i', file, '-frames:v', '1', '-vf', `scale=${w}:${h}:flags=area,format=gray`, '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1');
  const r = await run(ffmpeg, args);
  return r.code === 0 && r.out.length >= w * h ? r.out.subarray(0, w * h) : null;
}

/** Duration in seconds and frame size of a video from ffmpeg's description of it; null when unreadable. */
async function videoInfo(ffmpeg, file) {
  const r = await run(ffmpeg, ['-hide_banner', '-nostdin', '-i', file], { timeoutMs: 20000 });
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(r.err);
  if (!d) return null;
  const size = /Video:.*?(\d{2,5})x(\d{2,5})/.exec(r.err);
  return { duration: Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]), width: size ? Number(size[1]) : 0, height: size ? Number(size[2]) : 0 };
}

/** BGRA or RGBA pixels → grayscale bytes. */
function toGray(bitmap, w, h) {
  const g = Buffer.alloc(w * h);
  for (let i = 0; i < w * h; i++) g[i] = Math.round(0.299 * bitmap[i * 4 + 2] + 0.587 * bitmap[i * 4 + 1] + 0.114 * bitmap[i * 4]);
  return g;
}

/**
 * A decoder for picture analysis. Uses Electron's nativeImage for JPEG and PNG when given (fast, in process) and
 * ffmpeg for the rest and for videos. gray(file, w, h, opts) → Buffer | null.
 */
function makeDecoder({ ffmpeg = null, nativeImage = null } = {}) {
  return {
    async gray(file, w, h, { seek = null, ext = '' } = {}) {
      if (nativeImage && seek == null && ['.jpg', '.jpeg', '.png'].includes(ext)) {
        try {
          const img = nativeImage.createFromPath(file);
          if (!img.isEmpty()) {
            const small = img.resize({ width: w, height: h, quality: 'better' });
            const s = small.getSize();
            if (s.width === w && s.height === h) return toGray(small.toBitmap(), w, h); // Windows and Linux bitmaps are BGRA
          }
        } catch { /* fall back to ffmpeg */ }
      }
      return ffmpeg ? ffmpegGray(ffmpeg, file, w, h, { seek }) : null;
    },
    videoInfo: (file) => (ffmpeg ? videoInfo(ffmpeg, file) : Promise.resolve(null)),
    imageSize,
  };
}

module.exports = { imageSize, parseSize, ffmpegGray, videoInfo, toGray, makeDecoder };
