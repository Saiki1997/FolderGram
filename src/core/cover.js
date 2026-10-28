// Cover suggestions: Telegram shows an album's first item biggest, so a sharp, well-exposed, high-resolution photo
// that fits the album's orientation makes the best first item. This only suggests; moving a photo to the front
// happens when the user accepts, and files on disk are never changed.
'use strict';

const { dhash, hamming } = require('./perceptual');

const SIDE = 64;
const CANDIDATES = 30; // photos looked at per album

/** Sharpness, brightness and contrast of a SIDE × SIDE grayscale picture. */
function measure(gray) {
  let sum = 0;
  for (let i = 0; i < gray.length; i++) sum += gray[i];
  const mean = sum / gray.length;
  let v = 0;
  for (let i = 0; i < gray.length; i++) v += (gray[i] - mean) ** 2;
  // Variance of the Laplacian: high when edges are crisp, low when blurred.
  let lsum = 0, lsq = 0, n = 0;
  for (let y = 1; y < SIDE - 1; y++) {
    for (let x = 1; x < SIDE - 1; x++) {
      const i = y * SIDE + x;
      const l = gray[i - 1] + gray[i + 1] + gray[i - SIDE] + gray[i + SIDE] - 4 * gray[i];
      lsum += l; lsq += l * l; n++;
    }
  }
  const lap = lsq / n - (lsum / n) ** 2;
  return { mean, contrast: Math.sqrt(v / gray.length), sharpness: Math.sqrt(Math.max(0, lap)) };
}

/** Score 0..1 with the reasons, for one photo. m: measure(); dim: { width, height }; orientation: album majority. */
function score(m, dim, orientation) {
  const reasons = [];
  const sharp = Math.min(1, m.sharpness / 45);
  const exposure = m.mean < 35 ? m.mean / 35 : m.mean > 225 ? (255 - m.mean) / 30 : 1;
  const contrast = Math.min(1, m.contrast / 50);
  const px = dim && dim.width && dim.height ? dim.width * dim.height : 0;
  const res = px ? Math.min(1, px / 2e6) : 0.5;
  const orient = dim && dim.width && dim.height ? (dim.height >= dim.width ? 'portrait' : 'landscape') : null;
  const fits = !orientation || !orient || orient === orientation ? 1 : 0;
  if (sharp >= 0.8) reasons.push('sharp');
  else if (sharp < 0.35) reasons.push('blurry');
  if (exposure < 0.7) reasons.push(m.mean < 35 ? 'very dark' : 'very bright');
  if (contrast < 0.4) reasons.push('flat');
  if (px >= 2e6) reasons.push(`${Math.round(px / 1e6)} MP`);
  else if (px && px < 5e5) reasons.push('low resolution');
  if (orient && orientation && !fits) reasons.push(`${orient}, album is ${orientation}`);
  const s = 0.4 * sharp + 0.2 * exposure + 0.15 * contrast + 0.15 * res + 0.1 * fits;
  return { score: Math.round(s * 1000) / 1000, reasons, orientation: orient };
}

/**
 * Suggests a cover for each album. albums: [{ id, files: [{ id, path, ext, size, mtimeMs, kind }] }] in their
 * current order. decoder: imaging.makeDecoder(). cache: optional HashCache-like store for the measurements.
 * Returns [{ albumId, fileId, score, reasons, currentId, currentScore, better, unreadable: [fileId] }] where better
 * means the suggestion is clearly better than the current first photo.
 */
async function suggestCovers(albums, decoder, cache = null, { isCancelled = () => false, onProgress = null } = {}) {
  const out = [];
  const usedCovers = []; // hashes of covers already suggested: avoid the same picture on two albums
  let done = 0;
  const total = albums.reduce((a, al) => a + Math.min(CANDIDATES, al.files.filter((f) => f.kind === 'photo').length), 0);
  for (const al of albums) {
    if (isCancelled()) break;
    const photos = al.files.filter((f) => f.kind === 'photo').slice(0, CANDIDATES);
    if (photos.length < 2) continue;
    const looked = [];
    const unreadable = [];
    for (const f of photos) {
      const hit = cache && cache.entry(f);
      let c = hit && hit.cv;
      if (!c) {
        const gray = await decoder.gray(f.path, SIDE, SIDE, { ext: f.ext });
        const small = gray ? await decoder.gray(f.path, 9, 9, { ext: f.ext }) : null;
        const dim = gray ? await decoder.imageSize(f.path) : null;
        c = gray ? { m: measure(gray), dim, hash: (dhash(small) || {}).hash || null } : { bad: true };
        if (cache) cache.put(f, { cv: c });
      }
      done++;
      if (onProgress) onProgress({ done, total });
      if (c.bad) unreadable.push(f.id);
      else looked.push({ f, c });
    }
    if (!looked.length) { out.push({ albumId: al.id, fileId: null, unreadable }); continue; }
    const portrait = looked.filter((x) => x.c.dim && x.c.dim.height >= x.c.dim.width).length;
    const orientation = portrait * 2 > looked.length ? 'portrait' : portrait * 2 < looked.length ? 'landscape' : null;
    const scored = looked.map((x) => ({ ...x, s: score(x.c.m, x.c.dim, orientation) })).sort((a, b) => b.s.score - a.s.score);
    let pick = scored.find((x) => !x.c.hash || !usedCovers.some((h) => hamming(h, x.c.hash) <= 6)) || scored[0];
    const reasons = [...pick.s.reasons];
    if (pick !== scored[0]) reasons.push('the best one is already another album’s cover');
    if (pick.c.hash) usedCovers.push(pick.c.hash);
    const current = scored.find((x) => x.f.id === al.files[0].id) || null;
    // Only worth moving when clearly better than the photo that is first now.
    const better = !current ? true : pick.f.id !== current.f.id && pick.s.score - current.s.score >= 0.08;
    out.push({ albumId: al.id, fileId: better ? pick.f.id : (current ? current.f.id : pick.f.id), score: pick.s.score, reasons: better ? reasons : current.s.reasons,
      currentId: al.files[0].id, currentScore: current ? current.s.score : null, better, unreadable });
  }
  return out;
}

module.exports = { measure, score, suggestCovers, SIDE };
