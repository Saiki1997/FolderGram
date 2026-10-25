// Reads a video's duration, size and a thumbnail using Chromium's own decoder.
// Called from the main process before a video is sent, so Telegram shows it with a preview and length.
'use strict';

window.fgProbe = (url) => new Promise((resolve) => {
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'metadata';
  let settled = false;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    v.removeAttribute('src');
    v.load();
    resolve(value);
  };
  const timer = setTimeout(() => finish(v.videoWidth ? meta(null) : null), 10000);
  const meta = (thumb) => ({
    duration: Number.isFinite(v.duration) ? v.duration : 0,
    width: v.videoWidth,
    height: v.videoHeight,
    thumb,
  });
  v.onerror = () => finish(null);
  v.onloadedmetadata = () => {
    if (!v.videoWidth) return finish(null);
    v.currentTime = Math.min(1, (v.duration || 0) / 3);
  };
  v.onseeked = () => {
    try {
      // Telegram thumbnails: JPEG, longest side at most 320 px.
      const scale = Math.min(1, 320 / Math.max(v.videoWidth, v.videoHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(v.videoWidth * scale);
      c.height = Math.round(v.videoHeight * scale);
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      finish(meta(c.toDataURL('image/jpeg', 0.8).split(',')[1]));
    } catch {
      finish(meta(null));
    }
  };
  v.src = url;
});

// Resizes a photo to at most `maxSide` px as JPEG, for photos over Telegram's 10 MB photo limit.
// Returns { data: base64, width, height }, or null when the image can't be decoded or is too thin for a photo.
window.fgShrink = async (url, maxSide = 2560, quality = 0.92) => {
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  try {
    await img.decode();
  } catch {
    return null;
  }
  const w = img.naturalWidth, h = img.naturalHeight;
  if (!w || !h || Math.max(w, h) / Math.min(w, h) > 20) return null; // Telegram refuses photos thinner than 1:20
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const width = Math.max(1, Math.round(w * scale)), height = Math.max(1, Math.round(h * scale));
  const bmp = await createImageBitmap(img, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' });
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // transparent PNGs get a white background instead of black
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  let blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  if (blob.size > 10 * 1024 * 1024) blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
  const data = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
  img.src = '';
  return { data, width, height };
};
