// Name analysis for albums: random-name detection, file name cleaning, sequence vs. content numbers, and
// folder-name classification. Pure functions, no file system access, so everything here is easy to test.
'use strict';

// ---------------------------------------------------------------- random-looking names

const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]{8,}$/i;
// Letter casing that real words use: "rem", "REM", "Rem", "ReZero", "iPhone", "iPhoneX", "USBDrive", "PlayStationVR".
const VALID_CASE = [/^[a-z]+$/, /^[A-Z]+$/, /^[a-z]?(?:[A-Z][a-z]+)+[A-Z]{0,3}$/, /^[A-Z]{2,}(?:[A-Z][a-z]+)+$/, /^[a-z]+(?:[A-Z][a-z]+)+$/];

const letterRuns = (s) => s.match(/[A-Za-z]+/g) || [];
const classOf = (c) => (/\d/.test(c) ? 'd' : /[A-Za-z]/.test(c) ? 'l' : 'o');

/**
 * How random one word looks, 0 (a real word) to 1 (certainly random), with the reasons. Short words (under 4
 * characters), plain numbers, real casing and pronounceable letters count as real; mixed-up digits and letters,
 * odd case changes, missing vowels, hex hashes and UUIDs count as random.
 */
function tokenRandomness(token) {
  const t = String(token || '').trim();
  const reasons = [];
  if (t.length < 4 || /[^A-Za-z0-9-]/.test(t)) return { score: 0, reasons };
  if (UUID.test(t)) return { score: 1, reasons: ['uuid'] };
  if (t.includes('-')) return { score: 0, reasons }; // hyphenated words are judged part by part by the caller
  if (/^\d+$/.test(t)) {
    if (t.length >= 9 && !looksLikeDate(t)) return { score: 0.6, reasons: ['long number'] };
    return { score: 0, reasons };
  }
  let transitions = 0;
  for (let i = 1; i < t.length; i++) if (classOf(t[i]) !== classOf(t[i - 1])) transitions++;
  if (HEX.test(t) && /\d/.test(t) && /[a-f]/i.test(t) && transitions >= 2) return { score: 0.95, reasons: ['hex hash'] };

  const letters = t.replace(/\d/g, '');
  // All-capital short words without digits are acronyms: NASA, PSVR, HBO.
  if (/^[A-Z]{4,6}$/.test(t)) return { score: 0.1, reasons };
  let score = 0;
  if (transitions >= 2) { score += 0.45; reasons.push('digits mixed into letters'); }
  if (transitions >= 4) score += 0.15;
  if (/[A-Za-z]\d+[A-Za-z]/.test(t)) { score += 0.15; reasons.push('digits inside a word'); }
  const runs = letterRuns(t.replace(/\d{1,3}$/, ''));
  const badCase = runs.filter((r) => r.length > 1 && !VALID_CASE.some((re) => re.test(r)));
  if (badCase.length) {
    score += 0.4;
    reasons.push('odd capital letters');
    let switches = 0;
    for (const r of badCase) for (let i = 1; i < r.length; i++) if ((r[i] === r[i].toUpperCase()) !== (r[i - 1] === r[i - 1].toUpperCase())) switches++;
    if (switches >= 2) score += 0.2;
  }
  if (letters.length >= 4) {
    const vowels = (letters.match(/[aeiouy]/gi) || []).length;
    if (vowels / letters.length < 0.2) { score += 0.35; reasons.push('no vowels'); }
    if (/[bcdfghjklmnpqrstvwxz]{5,}/i.test(letters)) { score += 0.3; reasons.push('unpronounceable'); }
  }
  if (t.length >= 12 && transitions >= 2) score += 0.2;
  return { score: Math.min(1, score), reasons };
}

/**
 * How random a whole name looks, 0..1. A trailing "(GoFile)" or "[tag]" is ignored. A name with at least one
 * real word ("Loose Files", "Model X100") is not random; a single mixed-up token ("kb03wM", "a8D3fG92") is.
 */
function randomness(name) {
  const core = stripTags(String(name || ''));
  if (UUID.test(core)) return { score: 1, reasons: ['uuid'] };
  const tokens = core.split(/[\s_.]+|(?<=\S)-(?=\S)/).filter(Boolean);
  // Words under 4 letters prove nothing either way ("Rem", "fgn"); judge the longer ones.
  const judged = tokens.filter((x) => x.length >= 4 && !/^\d{1,4}$/.test(x));
  if (!judged.length) return { score: 0, reasons: [] };
  let best = null;
  for (const tok of judged) {
    const r = tokenRandomness(tok);
    if (!best || r.score < best.score) best = r;
  }
  return best;
}

/** True for names that look randomly generated ("2Zy6lA (GoFile)", "kb03wM", "8d1e4fa3b9c2", UUIDs). */
function isGibberish(name) {
  return randomness(name).score >= 0.5;
}

// ---------------------------------------------------------------- generic names (camera, timestamps, downloads)

const CAMERA_WORDS = new Set(['img', 'image', 'images', 'dsc', 'dscn', 'dscf', 'dcim', 'pxl', 'vid', 'video', 'mvimg', 'photo', 'pic', 'picture',
  'screenshot', 'screen', 'shot', 'scan', 'wa', 'gopr', 'gp', 'dji', 'mov', 'clip', 'file', 'download', 'untitled', 'temp', 'tmp', 'new', 'p',
  'snapchat', 'signal', 'telegram', 'whatsapp', 'received', 'fb', 'insta', 'instagram', 'capture', 'recording', 'record', 'camera', 'cam',
  'at', 'pano', 'burst', 'cover', 'portrait', 'sam', 'mvi', 'mah', 'imag', 'wp', 'trim', 'edit', 'edited', 'export', 'frame', 'thumb', 'output',
  'media', 'unknown', 'document', 'doc', 'audio', 'voice', 'ptt', 'gif', 'aud', 'rpreplay', 'jpeg', 'jpg', 'png', 'mp4']);
// Prefixes that are dropped from the front of an otherwise real name ("IMG_Marin_01" -> "Marin").
const LEAD_WORDS = new Set(['img', 'image', 'dsc', 'dscn', 'dscf', 'pxl', 'vid', 'mvimg', 'photo', 'pic', 'wa', 'gopr', 'dji', 'mvi', 'sam', 'imag', 'wp',
  'screenshot', 'video', 'snapchat', 'fb', 'insta']);
const DATE = /^(?:19|20)\d{2}[-_.]?(?:0[1-9]|1[0-2])[-_.]?(?:0[1-9]|[12]\d|3[01])$/;
function looksLikeDate(s) {
  return DATE.test(s) || /^(?:19|20)\d{6}\d{0,9}$/.test(s);
}

/** True when the file name carries no real name: camera, phone, screenshot, timestamp, hash or numbers only. */
function isGenericName(stem) {
  const s = String(stem || '').replace(/\.[a-z0-9]{2,4}$/i, '').trim();
  if (!s) return true;
  if (UUID.test(s)) return true;
  const tokens = s.split(/[\s._\-#()[\]{}~+,]+/).filter(Boolean);
  if (!tokens.length) return true;
  const generic = tokens.every((t) => /^\d+$/.test(t) || CAMERA_WORDS.has(t.toLowerCase()) || /^(?:wa|img|vid|dsc[nf]?|pxl|p|mvimg|gopr|gp|dji|mvi|imag|sam|cimg|mah|wp)\d+$/i.test(t)
    || /^\d{1,2}h\d{2}/i.test(t) || /^\d+(?:am|pm)$/i.test(t) || tokenRandomness(t).score >= 0.5);
  return generic;
}

// ---------------------------------------------------------------- file name parsing

// Words that make the number after them part of the content's name: "Episode 01" is not "Episode" #1.
const ID_WORDS = new Set(['episode', 'ep', 'eps', 'season', 'series', 'part', 'pt', 'vol', 'volume', 'chapter', 'ch', 'chap', 'set', 'disc', 'disk',
  'cd', 'dvd', 'day', 'week', 'book', 'issue', 'round', 'stage', 'level', 'act', 'scene', 'lesson', 'session', 'batch', 'album', 'collection', 'no']);
const ID_TOKEN = /^(?:s\d{1,2}e\d{1,4}|(?:ep|e|vol|v|part|pt|ch|cd|disc|no)\.?\d{1,4}|\d{1,2}x\d{2,3})$/i;
const QUALITY = /^(?:\d{3,4}p|[48]k|uhd|fhd|hd|sd|hq|lq|hdr|x26[45]|h26[45]|hevc|avc|\d{3,4}x\d{3,4}|web(?:rip|dl)?|bluray|remux)$/i;
const COPY_WORDS = /^(?:copy|kopie|copia|copie|kopya|duplicate|dup)$/i;
const SITE_TAG = /^(?:gofile|mega|pixeldrain|mediafire|telegram|tg|twitter|instagram|reddit|imgur|discord|bunkr|cyberdrop|google ?drive|dropbox|onedrive)$/i;
const DOMAIN = /\b[\w-]+\.(?:com|net|org|io|me|cc|to|xyz|ru|jp|co|tv|info|biz|site|online|club|link|su|ws|la|cr)\b/gi;
const STOP = new Set(['the', 'a', 'an', 'and', 'of', 'in', 'on', 'at', 'to', 'by', 'for', 'with', 'from', 'de', 'la', 'le', 'el', 'y', 'und', 'di']);

/** Removes trailing "(GoFile)", "[1080p]", "(2)" style tags from a folder or file name. */
function stripTags(name) {
  let s = String(name || '').trim();
  let prev;
  do {
    prev = s;
    s = s.replace(/\s*[([{][^)\]}]*[)\]}]\s*$/, '').trim();
  } while (s !== prev && s);
  return s || String(name || '').trim();
}

const capitalizeFirst = (s) => (s && s[0] === s[0].toLowerCase() && /[a-z]/.test(s[0]) && /[a-z]/.test(s.slice(1)) ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * Splits a file name into its content name and numbering.
 *   "Marin_Kitagawa_001.jpg"  -> base "Marin Kitagawa", seq 1 (padded)
 *   "Marin Kitagawa (2).jpg"  -> base "Marin Kitagawa", bracket 2
 *   "Elaina_Set_01_003.png"   -> base "Elaina", identifier "Set 01", seq 3
 *   "Episode 01.mp4"          -> identifier "Episode 01"
 *   "Resident Evil 4.jpg"     -> base "Resident Evil", seq 4 (not padded; the caller decides if it is a series)
 *   "IMG_20261025_001.jpg"    -> generic
 */
function parseFileName(fileName) {
  const stem = String(fileName).replace(/\.[^.\s]{1,5}$/, '');
  let s = stem.replace(DOMAIN, ' ');
  let bracket = null;
  // Bracketed tags: numbers are copy counters, the rest is kept only if it is a real word.
  s = s.replace(/[([{]([^)\]}]*)[)\]}]/g, (m, inner) => {
    const v = inner.trim();
    if (/^\d{1,4}$/.test(v)) { if (bracket == null) bracket = Number(v); return ' '; }
    if (!v || COPY_WORDS.test(v) || QUALITY.test(v) || SITE_TAG.test(v) || tokenRandomness(v).score >= 0.5 || /^@/.test(v)) return ' ';
    return ` ${v} `;
  });
  const hasSpace = /\s/.test(s.trim());
  const hasUnderscore = s.includes('_');
  const hyphens = (s.match(/(?<=\S)-(?=\S)/g) || []).length;
  s = s.replace(/_+/g, ' ').replace(/(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])/g, ' ');
  // Hyphens separate words in "Rem-Photos-01" or next to numbers ("Rem-01"), but not in "Spider-Man" inside a spaced name.
  s = s.replace(/\s+-\s+/g, ' ').replace(/(?<=\S)-(?=\S)/g, (m, off, all) => {
    const before = all.slice(0, off), after = all.slice(off + 1);
    if (/\d$/.test(before) || /^\d/.test(after)) return ' ';
    return !hasSpace && !hasUnderscore && hyphens >= 2 ? ' ' : '-';
  });
  let tokens = s.split(/\s+/).filter((x) => x && x !== '-' && x !== '#');

  const nums = [];
  let identifier = '';
  // Peel numbering and junk off the end.
  while (tokens.length) {
    const t = tokens[tokens.length - 1].replace(/^#/, '');
    const prev = tokens[tokens.length - 2];
    if (/^\d{1,9}$/.test(t)) {
      if (prev && ID_WORDS.has(prev.toLowerCase().replace(/\.$/, ''))) {
        identifier = `${capitalizeFirst(prev.replace(/\.$/, ''))} ${t}`;
        tokens = tokens.slice(0, -2);
        break;
      }
      nums.unshift(t);
      tokens.pop();
      continue;
    }
    if (ID_TOKEN.test(t)) {
      identifier = t;
      tokens.pop();
      break;
    }
    if (COPY_WORDS.test(t) || QUALITY.test(t) || SITE_TAG.test(t) || /^@/.test(t)) { tokens.pop(); continue; }
    if (tokens.length > 1 && (tokenRandomness(t).score >= 0.5 || (/^\d+[a-z]$/i.test(t)))) { tokens.pop(); continue; } // hash fragments
    break;
  }
  // Leading camera words, dates and track numbers ("IMG_Marin_01", "20240101 Marin", "01 - Song").
  const lead = [];
  while (tokens.length > 1 && (LEAD_WORDS.has(tokens[0].toLowerCase()) || /^\d+$/.test(tokens[0]))) lead.push(tokens.shift());
  // A content word left after the identifier, e.g. "Episode 01 Pilot": keep it in the base.
  const base = tokens.join(' ').replace(/\s+/g, ' ').trim();
  const seqRaw = nums.length ? nums[nums.length - 1] : (lead.length && /^\d+$/.test(lead[lead.length - 1]) ? lead[lead.length - 1] : null);
  const seq = seqRaw != null ? Number(seqRaw) : null;
  const generic = (!base && !identifier) || (base && isGenericName(base)) || (base && !identifier && randomness(base).score >= 0.5);
  const cleanBase = generic && !identifier ? '' : (isGenericName(base) ? '' : base);
  return {
    stem,
    base: cleanBase,
    identifier,
    seq,
    seqRaw,
    seqPadded: seqRaw != null && (/^0\d/.test(seqRaw)),
    bracket,
    numbers: nums,
    generic: !cleanBase && !identifier,
    title: joinName(cleanBase, identifier),
  };
}

const joinName = (a, b) => (a && b ? `${a} - ${b}` : a || b || '');

// ---------------------------------------------------------------- folder names

// Folder names that say what kind of content, not which content: they need their parent to be meaningful.
const GENERIC_FOLDER = /^(?:(?:set|part|pt|vol|volume|disc|disk|cd|season|chapter|ch|day|batch|album|episode|ep|week|page|group|folder|session|shoot|take|round|no)[\s._-]*#?\d+[a-z]?|\d+|videos?|photos?|pics?|pictures?|images?|imgs?|gallery|media|clips?|movies?|audio|music|sounds?|gifs?|misc|other|others|extras?|bonus|raw|raws|hq|lq|full|preview|previews|thumbs?|thumbnails?|new folder(?:\s*\(\d+\))?|untitled(?: folder)?|folder|files|stuff|export|exports|dcim|camera|100apple|\d{3}[a-z]{5}|screenshots?|selected|edited|originals?|final|uploads?|sorted|unsorted|jpg|jpeg|png|mp4|webm)$/i;
// Folders above the content that never name it.
const IGNORED_ANCESTOR = /^(?:[a-z]:\\?|users?|home|desktop|downloads?|documents?|my documents|pictures|my pictures|videos|my videos|music|onedrive(?: - .*)?|dropbox|google drive|icloud drive|telegram desktop|new folder|mnt|media|volumes|tmp|temp|public|shared|share|data|storage|internal storage|sdcard|dcim|camera|whatsapp|whatsapp images|whatsapp video|received files|gofile|mega|downloads? \(\d+\))$/i;

/**
 * "meaningful" (Rem Collection, Marin), "generic" (Set 01, Videos, 2024), "random" (kb03wM) or, for folders
 * above the content (asAncestor), "ignored" (Downloads, Desktop, a drive). As the content folder itself a
 * name like "Downloads" counts as generic.
 */
function classifyFolder(name, { asAncestor = false } = {}) {
  const n = String(name || '').trim();
  if (!n) return asAncestor ? 'ignored' : 'generic';
  if (asAncestor && IGNORED_ANCESTOR.test(n)) return 'ignored';
  if (isGibberish(n)) return 'random';
  const core = stripTags(n);
  if (GENERIC_FOLDER.test(core) || looksLikeDate(core.replace(/[\s._-]/g, '')) || /^\d{4}[-_. ]\d{2}([-_. ]\d{2})?$/.test(core)) return 'generic';
  if (IGNORED_ANCESTOR.test(n)) return asAncestor ? 'ignored' : 'generic';
  return 'meaningful';
}

// ---------------------------------------------------------------- comparing names

const normalizeKey = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/[\s._\-–—]+/g, ' ').replace(/[^\p{L}\p{N} ]/gu, '').trim();
const words = (s) => normalizeKey(s).split(' ').filter((w) => w && !STOP.has(w));

/** True when every word of `inner` appears in `outer` ("Rem" in "Rem Collection - Set 01"). */
function containsWords(outer, inner) {
  const o = new Set(words(outer));
  const i = words(inner);
  return i.length > 0 && i.every((w) => o.has(w));
}

/** Longest run of leading words shared by all names, in the first name's spelling. */
function commonPrefix(names) {
  if (!names.length) return '';
  const split = names.map((n) => n.split(/\s+/));
  const out = [];
  for (let i = 0; i < split[0].length; i++) {
    const w = split[0][i];
    if (split.every((p) => p[i] && p[i].toLowerCase() === w.toLowerCase())) out.push(w);
    else break;
  }
  while (out.length && STOP.has(out[out.length - 1].toLowerCase())) out.pop();
  return out.join(' ');
}

function confidenceLevel(score) {
  return score >= 0.8 ? 'high' : score >= 0.5 ? 'medium' : 'low';
}

module.exports = {
  tokenRandomness, randomness, isGibberish, isGenericName, parseFileName, classifyFolder, stripTags, normalizeKey, containsWords,
  commonPrefix, confidenceLevel, joinName, looksLikeDate, ID_WORDS,
};
