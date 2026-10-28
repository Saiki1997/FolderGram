// Similar-picture detection: finds photos and videos that show the same thing although their bytes differ
// (resized, recompressed, converted). Each picture gets a 128-bit difference hash from a 9 × 9 grayscale copy;
// pictures whose hashes differ in few bits are the same picture. Videos are compared on three frames. Only finds
// and ranks: what to do with a group is the user's choice, and local files are never touched.
'use strict';

const BITS = 128;
const SIMILAR = 10; // bits out of 128: resized and recompressed copies are usually within 0–6
const NEAR = 4;

// ---------------------------------------------------------------- hashes

/** 128-bit difference hash of a 9 × 9 grayscale picture: 64 left/right and 64 up/down comparisons. */
function dhash(gray) {
  if (!gray || gray.length < 81) return null;
  const bits = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits.push(gray[y * 9 + x] > gray[y * 9 + x + 1] ? 1 : 0);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits.push(gray[y * 9 + x] > gray[(y + 1) * 9 + x] ? 1 : 0);
  let hex = '';
  for (let i = 0; i < BITS; i += 4) hex += ((bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3]).toString(16);
  // A nearly plain picture (one color, a black frame) has no structure to compare: flag it instead of matching it.
  let mean = 0;
  for (let i = 0; i < 81; i++) mean += gray[i];
  mean /= 81;
  let v = 0;
  for (let i = 0; i < 81; i++) v += (gray[i] - mean) ** 2;
  return { hash: hex, plain: Math.sqrt(v / 81) < 4 };
}

const POP = Array.from({ length: 16 }, (_, i) => (i & 1) + ((i >> 1) & 1) + ((i >> 2) & 1) + ((i >> 3) & 1));
/** Number of differing bits between two hex hashes of the same length. */
function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += POP[parseInt(a[i], 16) ^ parseInt(b[i], 16)];
  return d;
}

// ---------------------------------------------------------------- quality

const FORMAT_RANK = { png: 3, bmp: 3, tif: 3, tiff: 3, webp: 2, jpeg: 1, jpg: 1 };
/** Higher is better: more pixels, then more bytes (less compression), then a lossless format. */
function qualityCompare(a, b) {
  const px = (q) => (q.width || 0) * (q.height || 0);
  return px(a) - px(b) || (a.size || 0) - (b.size || 0) || (FORMAT_RANK[a.format] || 0) - (FORMAT_RANK[b.format] || 0) || (a.duration || 0) - (b.duration || 0);
}

// ---------------------------------------------------------------- grouping

/**
 * Groups similar items. items: [{ id, kind: 'photo'|'video', hash, plain, frames: [hash×3] (videos), duration,
 * quality: { width, height, size, format } }]. Returns [{ best, members: [{ id, distance }], near }] where best is
 * the id with the highest quality, distance is in bits from best, and near means all are practically identical.
 */
function groupSimilar(items, { threshold = SIMILAR } = {}) {
  const parent = items.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const join = (i, j) => { const a = find(i), b = find(j); if (a !== b) parent[b] = a; };

  // Photos: any two hashes within `threshold` bits agree completely on at least one of threshold + 1 pieces.
  const photos = items.map((it, i) => ({ it, i })).filter(({ it }) => it.kind !== 'video' && it.hash && !it.plain);
  const pieces = threshold + 1;
  const bounds = Array.from({ length: pieces + 1 }, (_, p) => Math.round((p * BITS) / pieces));
  const bitsOf = (hex) => [...hex].map((c) => parseInt(c, 16).toString(2).padStart(4, '0')).join('');
  const checked = new Set();
  for (let p = 0; p < pieces; p++) {
    const buckets = new Map();
    for (const { it, i } of photos) {
      const b = (it._bits || (it._bits = bitsOf(it.hash))).slice(bounds[p], bounds[p + 1]);
      if (!buckets.has(b)) buckets.set(b, []);
      buckets.get(b).push(i);
    }
    for (const list of buckets.values()) {
      if (list.length < 2 || list.length > 2000) continue; // a huge bucket is a piece every picture shares
      for (let x = 0; x < list.length; x++) for (let y = x + 1; y < list.length; y++) {
        const i = list[x], j = list[y];
        const key = i < j ? `${i},${j}` : `${j},${i}`;
        if (checked.has(key)) continue;
        checked.add(key);
        if (hamming(items[i].hash, items[j].hash) <= threshold) join(i, j);
      }
    }
  }
  for (const { it } of photos) delete it._bits;

  // Videos: same length (within 2 s or 3 %), and the three frames close on average.
  const videos = items.map((it, i) => ({ it, i })).filter(({ it }) => it.kind === 'video' && it.frames && it.frames.length && it.duration)
    .sort((a, b) => a.it.duration - b.it.duration);
  for (let x = 0; x < videos.length; x++) {
    for (let y = x + 1; y < videos.length; y++) {
      const a = videos[x].it, b = videos[y].it;
      if (b.duration - a.duration > Math.max(2, a.duration * 0.03)) break;
      if (videoDistance(a, b) <= threshold) join(videos[x].i, videos[y].i);
    }
  }

  const groups = new Map();
  items.forEach((it, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(it); });
  const out = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const best = members.reduce((a, b) => (qualityCompare(b.quality || {}, a.quality || {}) > 0 ? b : a));
    const dist = (m) => (m === best ? 0 : m.kind === 'video' ? videoDistance(m, best) : hamming(m.hash, best.hash));
    const list = members.map((m) => ({ id: m.id, distance: Math.round(dist(m)) })).sort((a, b) => (a.id === best.id ? -1 : b.id === best.id ? 1 : a.distance - b.distance));
    out.push({ best: best.id, members: list, near: list.every((m) => m.distance <= NEAR) });
  }
  return out;
}

function videoDistance(a, b) {
  const n = Math.min(a.frames.length, b.frames.length);
  let d = 0;
  for (let i = 0; i < n; i++) d += a.frames[i] && b.frames[i] ? hamming(a.frames[i], b.frames[i]) : BITS;
  return d / n;
}

// ---------------------------------------------------------------- fingerprints of files (cached)

const PHOTO_EXT = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.webp', '.gif', '.tif', '.tiff']);

/**
 * Perceptual fingerprint of one file: { kind, hash, plain, frames, duration, quality } or null when it can't be
 * read (the reason goes in `error`). cache: HashCache-like ({ entry(f), put(f, patch) }) keyed by path+size+mtime.
 */
async function fingerprint(f, decoder, cache = null, { video = true } = {}) {
  const ext = String(f.ext || '').toLowerCase();
  const isVideo = !PHOTO_EXT.has(ext);
  const hit = cache && cache.entry(f);
  if (hit && hit.ph) return hit.ph;
  let fp;
  if (!isVideo) {
    const dim = await decoder.imageSize(f.path);
    const gray = await decoder.gray(f.path, 9, 9, { ext });
    const h = dhash(gray);
    fp = h ? { kind: 'photo', hash: h.hash, plain: h.plain, quality: { width: dim ? dim.width : 0, height: dim ? dim.height : 0, size: f.size, format: dim ? dim.format : ext.slice(1) } }
      : { kind: 'photo', error: 'unreadable' };
  } else if (video) {
    const info = await decoder.videoInfo(f.path);
    if (!info || !info.duration) fp = { kind: 'video', error: 'unreadable' };
    else {
      const frames = [];
      for (const at of [0.15, 0.5, 0.85]) {
        const h = dhash(await decoder.gray(f.path, 9, 9, { seek: info.duration * at }));
        frames.push(h ? h.hash : null);
      }
      fp = frames.some(Boolean) ? { kind: 'video', frames, duration: info.duration, quality: { width: info.width, height: info.height, size: f.size, duration: info.duration } }
        : { kind: 'video', error: 'unreadable' };
    }
  } else {
    return null;
  }
  if (cache) cache.put(f, { ph: fp });
  return fp;
}

module.exports = { dhash, hamming, groupSimilar, qualityCompare, fingerprint, SIMILAR, NEAR, PHOTO_EXT };
