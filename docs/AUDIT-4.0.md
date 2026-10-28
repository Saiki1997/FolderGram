# FolderGram 3.1.2 audit and 4.0 plan

Audited commit `6434240` (v3.1.2, branch `claude/project-thread-h62ayy`). Work branch: `claude/project-thread-9q8th7`,
local only, nothing pushed. On 3.1.2, all 89 tests pass (2 of them need ffmpeg, which is installed here) and
`npm audit` finds 0 vulnerabilities.

Severity: **Critical** can lose data, post duplicates or stop a job for good. **High** silently skips or mis-sends
media. **Medium** gives wrong numbers or needs the user to step in. **Low** is hardening.

## 1. Architecture as found

| Layer | Modules | Notes |
|---|---|---|
| Main process | `src/main.js` | Window, IPC (all handlers validated, only the app's own page may call), settings with `safeStorage`, queue wiring, taskbar progress, notifications, update check, debug log. |
| Preload | `src/preload.js` | `contextBridge` API `window.fg`; context isolation and sandbox on. |
| Renderer | `src/renderer/app.js`, `vlist.js`, `probe.js` | One page: setup cards on the left, tabs (Album preview, Upload queue, History, Naming rules), upload bar with activity log. Preview is a virtual list. |
| Planning | `scanner.js`, `naming.js`, `planner.js`, `captions.js`, `naming-memory.js` | Parallel scan with filters; smart naming with confidence; albums of 10; templates; remembered corrections and rules. Pure Node, tested. |
| Upload engine | `queue.js`, `uploader.js`, `retry.js`, `concurrency.js`, `integrity.js`, `hashing.js`, `history.js` | Saved queue (one job at a time), per-album journal, stable random ids, error classes, adaptive presets, file checks before send, SHA-256 in worker threads, history journal. |
| Telegram | `telegram.js`, `fastupload.js`, `media.js`, `splitter.js` | GramJS MTProto; files are uploaded over 2–8 extra connections to the account's DC (3.1), stored with `UploadMedia`, then posted with `SendMultiMedia`; ffmpeg for video facts, thumbnails, remux and splitting. |
| Storage | `store.js`, `debuglog.js` | Atomic writes with `.bak`, damaged files set aside, daily backups, 7-day debug log without secrets. |

Upload flow of one job: check every file (history, size, duplicates) → for each folder: find or create the topic →
for each album, one after another: check the files on disk → upload them (3 at a time, each over several
connections) → `UploadMedia` each → `SendMultiMedia` with stable random ids → journal → pause (0.4–2 s).

## 2. What already exists, compared with the 4.0 brief

| Brief section | Already in 3.1.2 | Missing |
|---|---|---|
| 2 Upload engine | Multi-connection part upload, 3 files at once, presets Careful/Balanced/Fast/Custom, slow-down on flood waits | Throughput-driven concurrency, "Maximum practical speed", overlap between albums, buffer reuse |
| 3 Progress | Job bytes, current file name, speed now/average, time left, taskbar, notification, timestamped activity log | Per-file and per-album progress, rolling-window speed, uploaded vs delivered, network bytes vs logical bytes |
| 4 Recovery | Saved queue, per-album journal, stable random ids, reconciliation after a lost reply, crash resume | Waiting out outages, watchdog, safe resume of half-sent albums, review state (fixed in Phase 1, below) |
| 5 Naming | Smart naming with confidence and reasons, sets kept apart, identifiers, random/generic folder detection, saved corrections, regex rules, both brief examples already give the expected names | Similar-title matching across folders, user dictionaries, batch preview |
| 6 Sync | — | All |
| 7 Library browser | — (topics list only) | All |
| 8 Duplicates | Quick fingerprint + SHA-256, scopes, review before upload | Perceptual (similar image/video) detection |
| 9 Topic management | Topic matching, closed/duplicate topic warnings, manual mapping | Rename topics, edit captions, repair albums |
| 10 Covers | — | All |
| 11 Organization rules | Name/topic templates, find/replace rules | Rule engine with conditions and presets |
| 12 Downloads | — | All |
| 13 Accounts | One user and one bot session | Several profiles |
| 14 Profiles | Speed presets only | Saved upload profiles |
| 15 Backup | Daily copies of settings, history, naming | Manual/encrypted export, restore |
| 16 Dashboard | Live stats in the upload bar, job reports | Totals and history graphs |
| 17 QoL | Taskbar progress, notifications, update check, logs, reports | Tray, background mode, prevent sleep (added in Phase 1), bandwidth limit, shortcuts, compact mode |

## 3. Findings fixed in Phase 1

Every fix has a regression test in `test/reliability.test.js`. "3.1.2" is the result of the same test run against the
3.1.2 code (the test file and the stand-in Telegram copied into a checkout of `6434240`).

| # | Severity | Problem and root cause | Fix | Test (3.1.2 → 4.0) |
|---|---|---|---|---|
| 1 | Critical | **A Wi-Fi drop fails every remaining album.** `withRetry` counts "Not connected", DNS and timeout errors as attempts: 5 tries with 2–32 s back-off is about a minute, then the album is marked failed and the next album starts the same way. A 5-minute outage fails the rest of the job. | Network errors trigger `waitForConnection()`: a small `help.getNearestDc` request with a 10 s limit (and Windows' own online flag) is retried at 2, 4, 8, 16, 30 s… until the connection is back, shown as "No connection to Telegram". Outages don't use up attempts (capped at 30 outages per album so a flapping link still ends). Every third failed check asks GramJS to rebuild a connection that is open but silent. | "a connection outage is waited out": 30 of 30 files failed → 30 sent, 0 failed |
| 2 | Critical | **A Telegram call that never answers stops the job forever.** `SendMultiMedia`, `UploadMedia` and GramJS' own uploader have no time limit; GramJS keeps pending requests across reconnects and leaves them queued when its 5 reconnect tries fail. Cancel didn't end such a call either. | Watchdog per attempt: no progress (bytes, a stored file, a sent message, ffmpeg heartbeat) for 150 s gives the attempt up as uncertain; it is retried with the same message ids, after a delivery check. Cancel ends a hung call at once. | "a send Telegram never answers…", "…arrived but never answered…", "cancel ends a send…": hung (test runner cancelled) → pass |
| 3 | High | **The delivery check could take the previous album for the lost one.** After a lost reply, `findRecentAlbum` accepted any of our albums with the same item count and caption sent up to 5 s before. With "caption after the last album", every album but the last has an empty caption, so a lost album 2 matched album 1 and was marked sent: its media were silently missing. It also looked at only the last 40 messages. | `reconcile.js`: our messages already known to be other albums of the job are excluded, times use Telegram's clock, documents must have the same file names, and the check pages back until it has seen every message since the send (`complete`). | "findRecentAlbum does not take the album sent just before": returned album 1's ids → null |
| 4 | High | **A resumed job re-sent half-sent albums without checking.** An album cut off mid-send (crash, quit, power loss) was sent again with the same random ids, which only protects for as long as Telegram remembers them; a job resumed the next day could post it twice. | The journal now records whether the send call had started. On resume such an album is checked first; if Telegram confirms it isn't there it is sent, if found it is marked sent. If the check can't be completed and the send started over 15 min ago, the album is held as **Check needed** with **Check again / Send again / Mark as sent** in the queue and the report. Albums stopped while still uploading are sent without a check. | 5 resume tests: re-sent/unchecked → pass |
| 5 | Medium | **"Sent" counted files that failed.** A file deleted after the scan was counted as failed and, because the rest of its album went, also as sent. | `sendAlbumChecked` returns the number of files actually sent. | counted 3 sent (only 2 existed) → 2 sent, 1 failed |
| 6 | Medium | **Progress jumped back.** The 3.1.2 MEDIA_EMPTY recovery uploads lost files again, restarting their progress at 0, and the "checking files" step was reported as bytes ("200 B / 1 KB", taskbar jumping). | Job progress only moves forward; the checking step is its own phase (file count, indeterminate taskbar). Full per-file progress comes in Phase 2. | went back 436 → 109 → monotonic |
| 7 | Medium | **A topic deleted in Telegram failed its albums for good.** The job journal keeps the topic id; every send then fails with `TOPIC_DELETED`, also after Retry. | The topic is forgotten, looked up and created again once, and the album is sent there with new message ids. | 2 failed → 0 failed |
| 8 | Medium | **Resumed bot jobs failed after a restart** with "Pick the group again": bots can't list chats, and the group's address was only kept in memory. | The group's id and access hash are saved with each new job, so it can be reached without listing chats. (Jobs saved by 3.x don't have it; pick the group once.) | error → pass |
| 9 | Medium | **Flood waits on file parts were silent and not cancellable.** The fast uploader slept up to 60 s per part without telling anyone; Cancel waited it out; the speed control never heard about it. | The wait is logged, slows the speed control (once per wait, not per part), and Cancel ends it within 250 ms. | waited the full 30 s → ends in 0.1 s |
| 10 | Medium | **Windows could sleep in the middle of an upload.** | `powerSaveBlocker` ("prevent app suspension") while a job runs; the screen may still turn off. | Not testable here (no Windows power management); code path loaded in the Electron run |
| 11 | Low | **Unhandled promise rejections and exceptions in the main process were not logged.** | Both go to the debug log. | Code review |

## 4. Other observations (planned, not changed yet)

1. **Idle link between albums.** Albums run strictly one after another: the next album's files start uploading only
   after the previous `SendMultiMedia` answered and the pause between albums (1 s on Balanced) passed. With photo
   albums the line sits idle for 1.5–2 s per album. Phase 2: upload the next album while the current one is posted.
2. **Concurrency never measures throughput.** It only reacts to errors; "Fast" uses fixed numbers. Phase 2.
3. **Speed and time left are computed in the window** with an exponential average of 1 s samples; no rolling window,
   no per-file or per-album numbers, no difference between bytes sent over the network (with retries) and progress.
   Phase 2.
4. **Video probing** runs ffmpeg twice per video before the album starts uploading. Phase 2 overlaps it with the
   previous album.
5. **Duplicate hashing reads small files twice** (once for the upload, once for SHA-256) when duplicate skipping is
   on. Cheap on SSDs; to be measured on a hard disk.
6. Dependencies are current within their majors: Electron 44.9.3 (45.0.0 exists), GramJS 2.26.22, ffmpeg-static
   5.2.0 (5.3.0 exists). No known vulnerabilities. A major Electron update is left for a separate, tested step.
7. Electron security is in good shape: context isolation, sandbox, CSP, navigation blocked, permissions denied, IPC
   sender check and argument validation.

## 5. Baseline benchmarks (this Linux machine, SSD, tiny files)

Same machine, same run, 3.1.2 vs the Phase 1 code. Phase 1 didn't touch scanning or planning; differences are noise.

| Files | 3.1.2 scan / plan / heap | Phase 1 scan / plan / heap |
|---|---|---|
| 1,000 | 26 / 12 ms / 7 MB | 46 / 18 ms / 9 MB |
| 10,000 | 232 / 67 ms / 33 MB | 245 / 64 ms / 31 MB |
| 50,000 | 1,278 / 293 ms / 94 MB | 1,220 / 254 ms / 65 MB |

| Data | 3.1.2 | Phase 1 |
|---|---|---|
| Quick fingerprints, 2,000 files, cold / cached | 803 / 6 ms | 772 / 6 ms |
| SHA-256, 8 × 64 MB in worker threads | 821 MB/s | 933 MB/s |
| History journal write per album | 0.23 ms | 0.26 ms |
| History compact / load, 50,000 entries | 34 / 21 ms | 27 / 19 ms |

Live Telegram throughput was not measured: no test account or test group has been approved for this work.

## 6. Plan for the remaining phases

- **Phase 2, upload engine**: progress tracker in the main process (per file, album and job; logical bytes vs
  network bytes; rolling 10 s speed; smoothed ETA that shows stalls), new Uploads view, pipelining of the next album,
  throughput-measuring concurrency with a "Maximum" preset, bandwidth limit, simulated-network benchmark of 3.1.2 vs
  4.0 (labelled as a simulation).
- **Phase 3, organization**: naming improvements (cross-folder titles, dictionaries, batch preview), cover
  suggestion and perceptual duplicates (decoded with Electron's own image decoder, no new dependency), rule engine.
- **Phase 4, library and sync**: topic/album browser with paging and thumbnail cache, folder watching and scheduled
  sync (upload-only by default; anything that changes Telegram asks first), downloads with resume.
- **Phase 5**: account profiles, upload profiles, dashboard, backup/restore with encrypted export, tray and other
  quality-of-life items.
- **Phase 6**: 100,000-file runs, memory checks, Windows build, migration check against a copy of 3.x data, release
  notes with a feature status table.

## 7. Phase 2 status

Done and tested with fakes and the stand-in network:

- the progress tracker (`src/core/progress.js`);
- the Uploads view;
- pipelining;
- the Maximum preset (`src/core/concurrency.js`);
- the bandwidth limit (`RateLimiter` in `src/core/fastupload.js`);
- the stall watchdog;
- outage waiting.

Speed is a rolling 5 s window. Time left blends the last 30 s with the whole run.

The simulated benchmark is in `docs/BENCHMARKS-4.0.md`. Not yet done: a live Telegram run, which waits for an
approved test group.

## 8. Phase 3 status

Done and tested with unit tests and in the real app window (Playwright under xvfb, stand-in Telegram).

**Naming**
- A dictionary of preferred spellings. It replaces whole words only.
- Suggestions to unify album and topic names that are the same title spelled differently: case, `_` or `.`
  instead of spaces, word order, or a typo. Names with different numbers are never grouped. Suggestions are
  only applied when you pick them in the preview, and Undo reverses them.
- `foldergram.txt` and `.foldergram.json` folder files that name the album and topic. They are never uploaded.
- A "Try a path" naming simulator that also tests rules.

**Organization rules** (`src/core/organize.js`)
- Conditions: path, folder, parent folder, file names, extensions, detected album name, depth, and date range.
- Actions: a topic or album name template, or leaving the albums out.
- Rules are checked in order and the first match wins. Your own corrections still win over rules.
- Five presets, including the brief's example: Anime/Marin/Set 01 becomes topic Marin, album Set 01.

**Similar photos and videos** (`src/core/perceptual.js`)
- Each picture gets a 128-bit difference hash. Videos are compared on three frames and their length.
- Resized, recompressed and converted copies were found in tests. Different pictures were not.
- Grouping 20,000 hashes takes well under 5 s in the test.
- Each group is ranked by quality, and the review screen offers "keep only the best", "keep all" or ticking
  files by hand. Ticked files are only left out of the upload. Nothing on disk is deleted.

**Covers** (`src/core/cover.js`)
- Photos are scored on sharpness, exposure, contrast, resolution and how well their orientation fits the album.
- Damaged photos are reported, and the same picture is avoided as the cover of two albums.
- Covers are only suggested. A photo is moved first only when you accept, and Undo reverses it.

**Limits**
- Similar-photo detection compares the files being planned with each other, not with uploads from earlier runs.
  Earlier runs are still covered by the exact duplicate check.
- No offline AI naming. Not implemented.

## 9. Phase 4 status

Tested with unit tests (148 in all) and in the real app window over the stand-in Telegram
(`test/ui-fake-transport.js`, which now holds a pretend group with albums). **Nothing in this phase has been run
against a real Telegram account yet.** The calls it uses are GetHistory, GetReplies, channels.GetMessages,
upload.GetFile, EditForumTopic, EditMessage and DeleteMessages.

**Library tab** (`src/core/library.js`, `src/ipc-library.js`)
- Topics on the left, albums of the chosen topic on the right, newest first. Albums load page by page as you scroll.
  Only small previews are loaded and cached on disk (300 MB cap), never the full files.
- Search by album title and filter by media type. "Open in Telegram" opens the message link.
- Rename a topic and edit an album's caption. Both ask for confirmation first, because they change the group for everyone.
- "Compare with preview" lists albums that are only on this PC, only on Telegram, or have a different file count.
- "Check the group" finds topics with the same name, albums whose title matches another topic's name, and albums
  FolderGram sent that have lost messages, with "Send the missing files again". Messages you deleted on purpose
  through a sync are not reported as lost.
- Fixed while testing: switching topics while a page was still loading left the album list empty.

**Downloads** (`src/core/downloader.js`)
- Download chosen albums or a whole topic into Group / Topic / Album, Group / Topic, or Group only.
- If a file already exists you choose: skip it (default), keep both, or replace it.
- Pieces are written to a `.part` file. An interrupted or cancelled download continues from there. This was
  tested in the window: cancelled at 1.5 MB of a 2.6 MB video, then continued, and every byte matched.
- A manifest in the destination remembers each downloaded message (with a SHA-256), so nothing is downloaded twice.
- Optional speed limit.
- Fixed while testing: a late progress message could overwrite "Download done".
- Limit: files Telegram serves through its CDN are reported as not downloadable yet.

**Folder sync** (`src/core/sync.js`)
- A sync is saved from the current folders, group and settings. It runs when you click, every N minutes, or when
  files change (the folder is watched, with a 30 s pause so a copy in progress is not uploaded half way).
- Each run compares the folders with the last run. New and changed files go through the normal upload queue with
  "skip uploaded" and "skip duplicates" always on. A renamed or moved file is recognised and is not sent again.
- Tested in the window: first run 4 new files uploaded. A run with no change did nothing. A renamed file was
  "1 renamed, nothing to upload". A new file was uploaded alone.
- Two-way is opt-in and never acts on its own:
  - Files removed on the PC are listed with their messages. They are deleted from Telegram only when you tick
    them and confirm.
  - Albums someone else posted to the synced topics are listed. They are downloaded only when you confirm.
  - Downloaded files are never uploaded back, and FolderGram's own posts are never offered for download. This was
    tested: after downloading the album, the next run found nothing to upload or download.
- Local files are never deleted by a sync.

**Not done in this phase**
- Moving an album to another topic. Telegram has no call for it. The check suggests sending it again and deleting
  the old one yourself.
- Merging two topics automatically.

## 10. Phase 5 status

Tested with unit tests (165 in all) and in the real app window over the stand-in Telegram. **Nothing here has
been tried on Windows itself or with a real Telegram account yet.** The notification-area icon was only checked on
Linux.

**Several accounts** (`src/core/accounts.js`)
- The account menu at the top of the sidebar lets you add, switch, rename and remove accounts.
- Each account has its own data folder: login, settings, upload queue, history, naming memory, syncs, logs and
  backups. The first account keeps the original folder, so 3.x data stays where it is.
- Only one account is active at a time. Switching restarts FolderGram on the other account, so logins, queues and
  flood waits never mix. A running upload stops safely and is offered for resuming when you switch back. Uploads
  of different accounts do not run at the same time.
- A new account can start with the current settings and naming rules. It never copies the login, API keys,
  folders, last group or learned names.
- Removing an account deletes its login files. Its other data stays in its folder.
- Tested in the window: added an account, switched (the app restarted logged out, on its own empty data), and
  switched back.

**Upload profiles** (`src/core/profiles.js`)
- Seven built-in profiles: Maximum quality, Fast upload, Photo archive, Video collection, Anime albums,
  Low bandwidth and Large file archive. Each one changes only the settings it is about.
- "Save as…" keeps the current speed, bandwidth limit, naming, captions, duplicate handling, order, media types,
  filters, pause and retries as your own profile.
- Saved profiles are checked when loaded, and unknown or out-of-range values are dropped.
- Not included: a schedule inside a profile. Scheduling stays on each upload ("Schedule…").

**Backup and restore** (`src/core/backup.js`)
- A backup is one `.fgbackup` file holding settings, naming rules, upload history, statistics, saved jobs and the
  queue, and folder syncs.
- One is made automatically every day in the data folder, and the newest 7 are kept. Manual backups go wherever
  you choose.
- A plain backup never holds the Telegram login, the API hash or the bot token. They can only go into an encrypted
  backup (scrypt and AES-256-GCM, password of 8+ characters), and only if you tick it.
- Before restoring, the backup is fully checked: the format, the version (a backup from a newer FolderGram is
  refused), the password, and every file's SHA-256. Nothing is touched if any check fails.
- Restoring first saves the current data as a backup. Job and sync folders it replaces are moved aside, not
  deleted. FolderGram then restarts.
- Tested in the window: encrypted backup with login, a wrong password refused, restore brought the earlier state
  back and kept the login.

**Dashboard**
- Shows files, data, albums and topics uploaded; files skipped as already sent; duplicates skipped; failed files;
  average speed; speed now; time spent uploading; and the queue.
- Two 30-day graphs (files per day and data per day) with hover values, and a table of recent jobs.
- Each finished job adds one short line to `stats.jsonl` (counts and bytes, no file names). The numbers stay even
  after "Remove finished", and only start from jobs run with 4.0.
- "Time saved" is an estimate and is labelled as one: the size of the files skipped as already uploaded or
  duplicates, divided by your average speed.

**Windows extras**
- Notification-area icon with Open, Pause/Resume and Quit. Closing the window during an upload offers to keep
  uploading in the background. Tested: the window hides and the upload finishes.
- Only one FolderGram runs at a time. A second start brings the open window forward. Tested.
- Keyboard shortcuts: Ctrl+1…7 for tabs, Ctrl+O, F5 / Ctrl+R, Ctrl+Enter, Ctrl+Shift+P, Ctrl+Shift+M, and ?
  for the list. Tested.
- Compact view (Ctrl+Shift+M, or the button under Data), remembered after a restart. Tested.
- Already there before Phase 5: keeping the PC awake during uploads, the bandwidth limit, the queue order, the
  naming simulator, resending missing files, upload reports as JSON/CSV, safe update checks, and plain-language
  errors.
- Not done: drag-and-drop topic mapping between the sidebar and the preview, custom album numbering, resource
  usage controls, and a check of Telegram permissions before upload. Some of these are planned for Phase 6.
