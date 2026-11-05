# FolderGram 4.0: Telegram safety, topic protection and performance

This document records what was found about the disappearing forum topics, what FolderGram now does about it, what it
can and cannot promise, and what is still open. Measurements are in `bench/RESULTS.md`.

## 1. Disappearing topics: root-cause audit

Your `%APPDATA%\FolderGram` folder (logs, job files, topic map) had already been deleted, so no local evidence of
the original incident survives. Everything below comes from reading every version from v2.0.0 to v4.0.0.

### Verified in the code

1. **No FolderGram version ever deleted a topic.** None of them call `channels.deleteTopicHistory`,
   `messages.deleteHistory` or the Bot API `deleteForumTopic`.
2. **The only delete was the folder sync's "delete from Telegram" dialog.** It deletes messages, and only after you
   confirm. It had a bug: when Telegram's message ids for an album didn't line up with its files, each file was
   credited with every message id of the album. Removing one local file could then offer to delete the whole
   album. Fixed: a file is only linked to its own message id.
3. **Saved topic ids were used without checking.** `topicFor()` returned a saved or mapped topic id as is. If that
   topic was gone, Telegram refused the album, and older versions fell back to matching by name.
4. **4.0 Phase 1 added a silent re-creation** (commit d6fa32e, AUDIT-4.0 item 7). After `TOPIC_DELETED`, it created a
   new topic with the same name and posted there. A deleted topic would look like it was "replaced", with the history
   gone. Removed.
5. **Topics were matched by name, and the first one won.** With two topics of the same name, the files could go to
   the "wrong" one. The other one then looked empty or missing.
6. **The topic list could stop early.** `listTopics` stopped at the first short page, so on a big group some topics
   were never seen. They were treated as missing and created again. Fixed: it pages until Telegram's total count.

### Hypotheses (possible, not proven)

- The topic list in Telegram sorts by last activity, so old topics can scroll far down and look gone.
- Duplicate topics with the same name (from items 4–6) made the originals look empty.
- An **auto-delete timer** on the group deletes every message after its period, uploads included.
- Telegram's **Aggressive Anti-Spam** or a moderator deleted messages or topics.
- An admin or bot with "Delete messages" or "Manage topics" deleted a topic.

### Unresolved

- Which of these happened to your group can only be checked in Telegram. Recent Actions keeps about 48 hours. The
  local logs that might have helped were deleted.

## 2. What FolderGram now does

- **Topic identity is (group id, topic id), never the name.** Every topic FolderGram uses goes into a permanent
  registry. Renamed topics keep receiving their folder. Old ids are never removed.
- **Every saved topic is checked with Telegram before an upload uses it.** If a known topic is deleted, missing or
  can't be read, the job stops ("On hold"). The album stays unsent, and an incident is recorded. FolderGram never
  creates a replacement and never sends that folder into another topic. A new topic is created only when you
  approve it in *Incidents & topics*.
- **A failed or odd answer is "not checkable", never "missing".** A network error, or an answer without a topic list,
  doesn't trigger a pause or an incident.
- **Uploads can't delete.** Every Telegram request passes a guard. Delete methods are refused unless they run inside
  the sync's confirmed "delete from Telegram" dialog, which also refuses to touch topic ids.
- **Watch every 30 minutes, read-only.** The watch covers each group you upload to. It checks every known topic (one
  request per 100 topics) and, where your account is an admin, reads the admin log for deletions. If a topic has
  disappeared, it does three things:
  - shows a Windows notification and an in-app warning;
  - records an incident with the evidence, including who deleted it when the admin log shows that;
  - pauses that group's queued uploads.
- **Group check.** This warns about an auto-delete timer (critical), Aggressive Anti-Spam, slow mode, a bot with the
  delete right, and missing "Manage topics".
- **Message pacing.** The profiles are Safe Archive (8 a minute), Balanced (12, the default), Fast Conservative (15)
  and Custom. A 10-photo album counts as 10 messages. Flood waits are honoured exactly, plus 2 s, and saved across
  restarts. After a flood, the rate drops and recovers slowly, never above the profile. Repeated floods or PEER_FLOOD
  stop all sending until you resume. These rates are FolderGram's conservative choice, not official Telegram limits.
- **Integrity ledger** (`foldergram-integrity.sqlite`). It records every uploaded file with its message id, every
  attempt, incident and rate-limit event. It survives crashes (WAL, full sync), is backed up daily (7 copies kept),
  and restores itself from the newest good backup if damaged. Its check and backup run off the main thread.

## 3. What can and cannot be guaranteed

FolderGram can guarantee:

- it never deletes a topic, and never deletes a message outside the dialog you confirm;
- it never silently re-creates or remaps a topic;
- it stops uploading to a group as soon as it sees a known topic missing.

It **cannot** stop Telegram, an admin, a bot, the auto-delete timer or anti-spam from deleting things. What it does
is make sure you hear about it within about 30 minutes while the app is running, and at the next check before any
upload. When the app is closed, nothing watches. A missing message or topic is recorded as missing; the reason is
claimed only when the admin log shows it.

## 4. Performance (resource use on your computer)

- **Computer resources** card: Low resource / Balanced / High performance. This sets the number of ffmpeg
  processes (one shared cap for the whole app), hashing threads, photo-analysis workers and window updates per second
  (4–10). When the computer stays busy (CPU, free memory, event-loop delay), local work steps down to Low resource and
  comes back after a calm period. **None of this changes Telegram pacing.**
- Big scans freeze the window less. At 50k files, the largest pause went from about 420 ms to about 300 ms; at 100k,
  from 1052 ms to 673 ms.
- The activity log arrives in batches and is drawn over several frames. A 50,000-line burst caught up in 4.7 s
  instead of 16.5 s.
- The per-job upload cache no longer grows with every file.
- The ledger handles a million rows. Walking every message id took 73 s and now takes 0.6 s, thanks to new indexes.

## 5. Remaining risks and open items

- **No live Telegram test was run.** Everything was tested with mocks and a stand-in network. Never run tests
  against the production group. A first real run belongs in a separate test group.
- **The Windows EXE was built on Linux and not run on Windows.** It is unsigned, so SmartScreen will warn. It bundles
  the Windows ffmpeg; the first build accidentally bundled the Linux one, which was caught and fixed. All
  performance numbers are from Linux under xvfb; Windows numbers will differ.
- **The window still pauses about 0.3 s at 50k files and 0.7 s at 100k** when a scan result arrives. The rest is the
  preview's own rendering, not the transfer.
- **Detection needs the app running.** For round-the-clock watching, leave FolderGram open, or check Recent Actions in
  Telegram within its 48-hour window.
- **The admin log is only readable by admins.** As a regular member, FolderGram can say that a topic is missing, but
  not who removed it.
- **Insert speed is about 17k rows a second.** This only matters for the one-time import of very large old job
  histories.
