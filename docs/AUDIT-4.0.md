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
