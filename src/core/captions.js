// Caption and name templates. Shared by the main process (require) and the preview window (<script>), so it
// has no dependencies.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.fgCaptions = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const CAPTION_MAX = 1024; // Telegram's caption limit for normal accounts
  const TOPIC_MAX = 128;

  const PHOTO = new Set(['photo']);
  const VIDEO = new Set(['video', 'animation']);

  /** "10 Photos", "3 Videos", "8 Photos, 2 Videos", "4 Files". kinds: array of file kinds. */
  function countLabel(kinds) {
    const photos = kinds.filter((k) => PHOTO.has(k)).length;
    const videos = kinds.filter((k) => VIDEO.has(k)).length;
    const n = kinds.length;
    const plural = (c, w) => `${c} ${w}${c === 1 ? '' : 's'}`;
    if (photos === n) return plural(n, 'Photo');
    if (videos === n) return plural(n, 'Video');
    if (photos + videos === n) return `${plural(photos, 'Photo')}, ${plural(videos, 'Video')}`;
    return plural(n, 'File');
  }

  /**
   * Fills {name} placeholders and tidies the result: placeholders with no value disappear together with the
   * separator next to them, so "{parent} - {folder}" for a top-level folder is just "Set 01".
   */
  function applyTemplate(template, values) {
    let s = String(template || '').replace(/\{(\w+)\}/g, (m, k) => {
      const v = values[k];
      return v == null || v === '' ? '\u0000' : String(v);
    });
    // Drop empty placeholders with the separator before or after them.
    s = s.replace(/\s*[-–—|/:·,]\s*\u0000/g, '\u0000').replace(/\u0000\s*[-–—|/:·,]\s*/g, '\u0000');
    s = s.replace(/\s*[([{][^)\]}]*\u0000[^)\]}]*[)\]}]/g, '').replace(/\u0000/g, '');
    s = s.replace(/[([{]\s*[)\]}]/g, '');
    s = s.replace(/\s{2,}/g, ' ').replace(/^[\s\-–—|/:·,]+|[\s\-–—|/:·,]+$/g, '');
    return s;
  }

  /** Removes control characters, folds whitespace and shortens to `max` characters on a word boundary. */
  function sanitize(text, max = CAPTION_MAX) {
    let s = String(text || '').replace(/[\u0000-\u0008\u000B-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, '').replace(/[ \t]+/g, ' ').trim();
    if ([...s].length > max) {
      const chars = [...s].slice(0, max - 1).join('');
      const cut = chars.lastIndexOf(' ');
      s = `${(cut > max * 0.6 ? chars.slice(0, cut) : chars).trimEnd()}…`;
    }
    return s;
  }

  const FORMATS = {
    simple: '{album}',
    detailed: '{album} — {countLabel}',
    series: '{album} — Part {part} of {totalParts}',
    folder: '{folderPath}',
  };

  /**
   * Caption for one album.
   * ctx: { album, kinds, part, totalParts, folder, parent, top, path, folderPath, size, date }
   * format: simple | detailed | series | folder | custom (uses template).
   */
  function formatCaption(format, template, ctx) {
    let t = format === 'custom' ? template || '{album}' : FORMATS[format] || FORMATS.simple;
    if (format === 'series' && !(ctx.totalParts > 1)) t = FORMATS.simple;
    const values = {
      ...ctx,
      count: ctx.kinds ? ctx.kinds.length : ctx.count,
      countLabel: ctx.kinds ? countLabel(ctx.kinds) : '',
      part: ctx.totalParts > 1 ? ctx.part : '',
      totalParts: ctx.totalParts > 1 ? ctx.totalParts : '',
    };
    return sanitize(applyTemplate(t, values));
  }

  /** Which albums of a set of `total` get a caption: every, last, first or none. */
  function captioned(where, index, total) {
    if (where === 'every') return true;
    if (where === 'first') return index === 0;
    if (where === 'last') return index === total - 1;
    return false;
  }

  return { CAPTION_MAX, TOPIC_MAX, countLabel, applyTemplate, sanitize, formatCaption, captioned, FORMATS };
}));
