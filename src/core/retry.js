// Error classification and back-off for Telegram calls.
'use strict';

const text = (e) => String((e && (e.errorMessage || e.message || e.code)) || e || '');

/** Seconds Telegram asked us to wait (FLOOD_WAIT_X, SLOWMODE_WAIT_X, FLOOD_PREMIUM_WAIT_X), or null. */
function floodSeconds(e) {
  const m = text(e);
  if (e && typeof e.seconds === 'number' && /FLOOD|SLOWMODE/i.test(m)) return e.seconds;
  const r = /(?:FLOOD_WAIT|SLOWMODE_WAIT|FLOOD_PREMIUM_WAIT|FLOOD_TEST_PHONE_WAIT)_(\d+)/.exec(m) || /A wait of (\d+) seconds is required/i.exec(m);
  return r ? Number(r[1]) : null;
}

// Errors that will fail again however often they are retried.
const PERMANENT = /CHAT_WRITE_FORBIDDEN|CHAT_ADMIN_REQUIRED|CHAT_SEND_\w+_FORBIDDEN|USER_BANNED_IN_CHANNEL|CHANNEL_PRIVATE|CHANNEL_INVALID|PEER_ID_INVALID|TOPIC_CLOSED|TOPIC_DELETED|TOPIC_ID_INVALID|MSG_ID_INVALID|MEDIA_CAPTION_TOO_LONG|MESSAGE_TOO_LONG|MEDIA_EMPTY|MEDIA_INVALID|FILE_PART_\d+_MISSING|FILE_PARTS_INVALID|FILE_REFERENCE_\w+|DOCUMENT_INVALID|PHOTO_INVALID\w*|PHOTO_EXT_INVALID|IMAGE_PROCESS_FAILED|VIDEO_CONTENT_TYPE_INVALID|WEBPAGE_CURL_FAILED|USER_IS_BLOCKED|AUTH_KEY_UNREGISTERED|SESSION_REVOKED|USER_DEACTIVATED|CHAT_FORWARDS_RESTRICTED|ENOENT|EISDIR|ENOTDIR|EACCES|too big|Pick the group again/i;
// Errors after which we can't tell whether Telegram posted the message.
const UNCERTAIN = /STALLED|TIMEOUT|timed? ?out|Not connected|Connection closed|disconnect|ECONNRESET|EPIPE|socket hang up|RPC_CALL_FAIL|RPC_MCGET_FAIL|-503|MSG_WAIT_FAILED/i;
// Errors worth retrying after a pause.
const TEMPORARY = /INTERNAL|WORKER_BUSY|PERSISTENT_TIMESTAMP|NETWORK|ENETUNREACH|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|EBUSY|EMFILE|ENFILE|EPERM|EAGAIN|-500|5\d\d/i;

/**
 * "delivered" (RANDOM_ID_DUPLICATE: Telegram already has this message), "flood", "uncertain", "temporary",
 * "permanent", "cancelled" or "unknown" (retried like temporary).
 */
function classify(e) {
  const m = text(e);
  if (/USER_CANCELED|CANCELLED/i.test(m) || (e && e.cancelled)) return 'cancelled';
  if (/RANDOM_ID_DUPLICATE/.test(m)) return 'delivered';
  if (floodSeconds(e) != null) return 'flood';
  if (PERMANENT.test(m)) return 'permanent';
  if (UNCERTAIN.test(m)) return 'uncertain';
  if (TEMPORARY.test(m)) return 'temporary';
  return 'unknown';
}

/** Exponential back-off with full jitter: random between base and min(cap, base * 2^attempt). */
function backoff(attempt, { baseMs = 2000, capMs = 60000, random = Math.random } = {}) {
  const max = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(baseMs + random() * Math.max(0, max - baseMs));
}

const errorText = (e) => text(e).slice(0, 300);

// Errors that mean the connection itself is gone (no internet, DNS down, socket closed, nothing answering), as
// opposed to Telegram answering with an error. While these last, retrying is pointless: wait for the connection.
const NETWORK = /STALLED|TIMEOUT|timed? ?out|Not connected|Connection closed|disconnect|ECONNRESET|ECONNABORTED|EPIPE|socket hang up|ENETUNREACH|ENETDOWN|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|EHOSTDOWN|NETWORK|Maximum reconnection retries/i;

/** True when an error says the network or the connection to Telegram is down. */
function isNetworkError(e) {
  if (!e || classify(e) === 'cancelled' || floodSeconds(e) != null) return false;
  return NETWORK.test(text(e));
}

module.exports = { floodSeconds, classify, backoff, errorText, isNetworkError };
