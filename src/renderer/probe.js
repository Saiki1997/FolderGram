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
