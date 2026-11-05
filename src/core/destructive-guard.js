// Guard around Telegram methods that delete content. Every request FolderGram sends passes through check(); a
// destructive one is refused unless the caller is inside authorize(), which only the user-confirmed maintenance
// actions use (today: the folder sync's "delete from Telegram" dialog). Uploading, retrying, resuming, cancelling,
// checking and cleaning up never run inside authorize(), so they can't delete anything even by mistake.
'use strict';

const { AsyncLocalStorage } = require('async_hooks');

// MTProto classes that delete messages, history, topics or chats (GramJS className values).
const DESTRUCTIVE = new Set([
  'messages.DeleteMessages', 'channels.DeleteMessages', 'messages.DeleteHistory', 'channels.DeleteHistory',
  'channels.DeleteTopicHistory', 'messages.DeleteChat', 'channels.DeleteChannel', 'messages.DeleteScheduledMessages',
  'channels.DeleteParticipantHistory', 'messages.DeleteChatUser', 'messages.DeleteQuickReplyMessages', 'messages.DeleteSavedHistory',
  'messages.DeleteFactCheck', 'stories.DeleteStories',
]);
// Bot API method names, for any HTTP Bot API transport added later.
const DESTRUCTIVE_BOT_API = new Set(['deleteMessage', 'deleteMessages', 'deleteForumTopic', 'unpinAllForumTopicMessages', 'deleteChatPhoto', 'leaveChat']);

const scope = new AsyncLocalStorage();
const audit = []; // last destructive attempts, allowed or blocked (for the debug log and tests)

const nameOf = (request) => (typeof request === 'string' ? request : (request && (request.className || (request.constructor && request.constructor.className))) || '');

function isDestructive(request) {
  const n = nameOf(request);
  return DESTRUCTIVE.has(n) || DESTRUCTIVE_BOT_API.has(n);
}

/** Runs fn with permission to delete. reason: what the user confirmed, for the log. */
function authorize(reason, fn) {
  if (!reason) throw new Error('A destructive action needs a stated, user-confirmed reason.');
  return scope.run({ reason, at: Date.now() }, fn);
}

/** Throws DESTRUCTIVE_BLOCKED for a destructive request made outside authorize(). */
function check(request) {
  if (!isDestructive(request)) return;
  const ctx = scope.getStore();
  const entry = { method: nameOf(request), at: new Date().toISOString(), allowed: !!ctx, reason: ctx ? ctx.reason : null };
  audit.push(entry);
  if (audit.length > 200) audit.shift();
  if (!ctx) {
    throw Object.assign(new Error(`DESTRUCTIVE_BLOCKED: ${entry.method} is not allowed during uploads or checks`), { errorMessage: 'DESTRUCTIVE_BLOCKED', method: entry.method });
  }
}

/** Wraps an invoke-like function (GramJS client.invoke / invokeWithSender) with check(). */
function guardInvoke(invoke) {
  if (invoke && invoke.guarded) return invoke;
  const g = function guarded(request, ...rest) {
    try { check(request); } catch (e) { return Promise.reject(e); }
    return invoke.call(this, request, ...rest);
  };
  g.guarded = true;
  return g;
}

/** Puts the guard on a GramJS client (idempotent). */
function guardClient(client) {
  if (!client) return client;
  client.invoke = guardInvoke(client.invoke);
  if (typeof client.invokeWithSender === 'function') client.invokeWithSender = guardInvoke(client.invokeWithSender);
  return client;
}

module.exports = { authorize, check, guardInvoke, guardClient, isDestructive, DESTRUCTIVE, DESTRUCTIVE_BOT_API, audit };
