# FolderGram 3.0: change report

Base: v2.3.0 (`4970068`). Work branch: `claude/project-thread-h62ayy`, two local commits, **not pushed**.
Build: `FolderGram-3.0.0-portable.exe` (Windows x64, unsigned). Nothing was published or released.

## 1. Audit

The full audit is in [`AUDIT-3.0.md`](AUDIT-3.0.md): 25 findings (3 critical, 6 high, 12 medium, 4 low), each fixed
in 3.0. The critical ones: a corrupt history file was silently wiped, a lost reply made the retry post the album
twice, and "Album N" numbers shifted when folders were added, which re-sent albums under new names.

## 2. What changed

**Naming (Critical in your table)**
- New naming engine with priority sources: meaningful folder name, then file names, then parent folders, then a
  stand-in. Detects random names (GoFile ids, hashes, UUIDs), camera names (`IMG_`, `DSC`, `GOPR`, `DJI_`) and
  generic folders (`Set 01`, `Photos`, `New folder`, `Videos`).
- File name cleaning: numbering, copy marks (`copy`, `(2)`), quality tags (`1080p`, `4K`), site names, leading
  `[release group]`, underscores and dotted names. Identifiers survive (`Episode 01`, `Set 02`, `Part 3`,
  `Resident Evil 4`).
- Hierarchical names (`Rem Collection - Set 01`), series detection, sets kept apart inside a folder, singleton files
  clustered by shared prefix.
- Templates for album and topic names (`{parent} - {folder}`, `{album}`, `{count}` ...), five caption styles,
  caption after first, last or every album.
- Confidence score with reasons on every album; corrections are remembered per folder and, for confident names,
  for the same detected name elsewhere. Find/replace rules (plain or regex).
- "Album N" stand-ins are now stable: the same random folder keeps its number in every scan.

**Preview editor**
- Rename albums and topics inline, see "was ..." (original) and the detected source, drag to reorder or move to
  another folder, merge, split selected files off, leave files out and restore them, map a folder to an existing
  topic (closed and duplicate-named topics are flagged), bulk rename (`{name} {n}` or `find => replace`), reset
  names, undo/redo (60 steps), caption preview per album, counts and sizes, "Needs review" filter, search,
  "Same name" conflict badge, save/open a plan file.
- The upload sends exactly the previewed plan (2.x rescanned at upload time).

**Upload engine (Critical/High)**
- Saved queue: jobs survive restarts, run one at a time, can be paused, reordered, scheduled, cancelled, retried.
  A crash or quit mid-job marks it interrupted and the app offers to resume.
- Each album gets stable Telegram message ids, so a retry after a lost reply is refused by Telegram as a repeat
  instead of posting twice; uncertain sends are checked against the chat before retrying.
- Errors are classified (delivered, flood wait, uncertain, temporary, permanent, cancelled). Permanent errors are
  not retried; temporary ones back off with full jitter; flood waits are always honoured with a countdown.
- Speed presets (Careful 1, Balanced 3, Fast 4 files at once, or Custom) with adaptive slow-down on flood waits.
- Uploaded files are cached for the session, so a retry re-sends the message without re-uploading. Cancel stops
  the running file upload at once.
- Files are checked right before sending: missing, changed since the scan, unreadable, empty, or a "photo" that
  is not an image (sent as a file instead).
- Split video parts are checked to be playable and to cover the whole video before sending.

**Duplicates (High)**
- Quick fingerprint (size + start, middle, end) to find candidates, then full SHA-256 in worker threads before
  anything is skipped. Results are cached by path, size and modification time.
- Scope: this topic, this group, or any group. Matches that can't be fully checked (original file gone) are
  skipped or uploaded, your choice. "Check duplicates" lists them before upload and lets you force some.
- History recorded by 2.x is still recognised.

**Performance**
- Parallel folder scan (8 folders at once, bounded file stats), progress and cancel, scan cache so caption and
  naming changes don't rescan the disk.
- Virtual list in the preview (only visible rows are drawn), lazy thumbnails from Windows' own thumbnailer with a
  600-entry cache; thumbnails switch off automatically above 500 files.
- History is an append-only journal (one small write per album) instead of rewriting the whole file.

**Data and safety**
- Every data file is written atomically (temp file, flush, rename) with a `.bak`; a corrupt file is set aside and
  the backup is used, never silently replaced. Daily backup of settings, history and naming to `backups\`
  (7 days).
- SQLite was evaluated and not used: `better-sqlite3` needs a native rebuild for Electron on Windows, which breaks
  the portable cross-build, and `node:sqlite` is still experimental. The JSON journal design gives the same crash
  safety for this data size (50,000 entries load in 42 ms).
- Security: sandboxed window, navigation blocked, all permission requests denied, IPC accepts calls only from the
  app's own page, every IPC argument validated, settings keys whitelisted, captions cleaned of control and bidi
  characters, CSV export neutralises spreadsheet formulas.

**Extras**: Queue, History and Naming rules tabs; per-job reports (albums, topics, failures, skipped duplicates)
exported as JSON or CSV with "Retry failed"; live stats (speed now and average, size left, albums sent, current
topic and album); include/leave-out patterns, size limits, depth, hidden files.

## 3. How the naming algorithm works

For each folder:

1. **Classify the folder name.** Random if a token of 4+ characters scores high on randomness (mixed case and
   digits in odd places, no vowels, hex/UUID shape); generic if it is a camera, numbering or stock word
   (`Set 01`, `Photos`, `New folder`); ignored for system folders (`Downloads`, `Desktop`); otherwise meaningful.
2. **Read the file names.** Each name is cleaned (tags, numbering, copy marks, quality, domains) into a base name,
   an identifier (`Set 02`, `Episode 3`) and a sequence number. Files with the same base and identifier form a
   group; numbered episodes form one series album when "Put numbered episodes in one album" is on.
3. **Pick the name by priority.** A file-name group shared by 2+ files (confidence 0.9) beats a meaningful folder
   name (0.85); a generic folder takes its nearest meaningful parent (`Parent - Set 01`, 0.65); a random folder
   takes its parent (0.45) or, with "Rename random folder names" on, a stable `Album N`.
4. **Apply memory and rules.** Your earlier correction for this folder wins, then a learned correction for the
   same detected name, then your find/replace rules.
5. **Score.** 0.8+ is High, 0.55+ Medium, below is "Check"; albums with the same name from different folders in one
   topic are flagged.

Topics: the top folder's name, unless it is random (then the name its files agree on) or generic (then the
nearest meaningful parent).

## 4. Before and after

Measured by running the 2.3 code and the 3.0 code on the same folders (`topicBy: top`, random-name renaming on).

| Folder | 2.3 folder mode | 2.3 file-name mode | 3.0 smart |
|---|---|---|---|
| `Cosplay/kb03wM (GoFile)/Marin Kitagawa (1..3).jpg` | Album 2 | Marin Kitagawa | **Marin Kitagawa** (High) |
| `Cosplay/2Zy6lA (GoFile)/IMG_2001.jpg ...` | Album 1 | Album 1 | **Album 1** (Check) |
| `Downloads2/a8D3fGq1/Elaina_Set_01_001.png, Elaina_Set_02_001.png ...` | Album 3 | Elaina_Set (one album) | **Elaina - Set 01**, **Elaina - Set 02** (High) |
| `Anime/Frieren/[SubsPlease] Frieren - 01 (1080p).mkv ...` | Frieren | `[SubsPlease] Frieren - 01 (1080p)` ×3 | **Frieren** (High) |
| `Rem Collection/Set 01/DSC0001.jpg` | Set 01 | Set 01 | **Rem Collection - Set 01** (Medium) |
| `Videos/Videos/Final Fantasy 7 Tifa 1.mp4, ... 2.mp4` | Videos | `Final Fantasy 7 Tifa 1`, `... 2` | **Final Fantasy 7 Tifa** (High) |
| `Misc/New folder/Genshin_Raiden-Shogun_04.jpg ...` | New folder | Genshin_Raiden-Shogun | **Genshin Raiden-Shogun** (High) |
| `Misc/Loose Files (GoFile)/x9Qw2Lp0.jpg ...` | Loose Files (GoFile) | Hk3mZ8rT / x9Qw2L | **Loose Files (GoFile)** (High) |

## 5. Tests

`npm test`: **74 passing, 0 failing** (16 original 2.x tests kept unchanged apart from turning off adaptive speed
in their helper, 32 naming/planner/scanner, 25 upload engine, 1 video splitting).

The upload tests use a stand-in Telegram that behaves like the real one where it matters (repeated message ids
are refused, scripted flood waits, timeouts after delivery, closed topics, topic creation that fails before or
after creating). They cover: no double post after a lost reply, reconciliation of uncertain sends, flood waits,
permanent errors not retried, retries reusing uploads, cancel during upload, pause, crash and resume from the job
journal, duplicate scopes and SHA-256 confirmation, probable duplicates, changed and missing files, topic reuse and
closed topics, queue order, scheduling and interruption, and corrupt-file recovery.

The real app was also run in an Electron window (Linux, virtual display) with the stand-in Telegram: scan,
thumbnails, rename/undo/redo, learned names, search and review filters, move, split, caption styles, a full upload
through the queue (with a flood wait and a lost reply in the middle: 28 files, 6 albums, nothing posted twice),
history report, and quitting mid-upload then resuming (only the 5 unsent albums were sent). No errors in the
window console.

**Not tested: a live Telegram account.** No real upload was made. Please do a small real upload first (see 9).

## 6. Benchmarks

This cloud machine (Linux, SSD), tiny files, so they measure file count, not disk speed.

| Files | 2.3 scan | 3.0 scan | 2.3 plan (folder names) | 3.0 plan (smart names) | 3.0 heap |
|---|---|---|---|---|---|
| 100 | – | 6 ms | – | 3 ms | 5 MB |
| 1,000 | 56 ms | 54 ms | – | 22 ms | 7 MB |
| 10,000 | 418 ms | 421 ms | 2 ms | 166 ms | 31 MB |
| 50,000 | 2,523 ms | 2,394 ms | 22 ms | 667 ms | 50 MB (2.3: 79 MB) |

Smart naming costs about 0.7 s at 50,000 files; caption and naming changes reuse the scan, so it is paid once.

| Data | Result |
|---|---|
| History write per album | 0.46 ms (2.3 rewrote the whole file: 135 ms at 50,000 entries) |
| History compact / load, 50,000 entries | 54 ms / 42 ms |
| Quick fingerprints, 2,000 × 200 KB, first time / cached | 1,564 ms / 5 ms |
| SHA-256, 8 × 64 MB in 2 worker threads | 304 MB/s, off the main thread |

Run them yourself with `node bench/scan-bench.js` and `node bench/data-bench.js`.

## 7. Changed files

New: `src/core/naming.js`, `planner.js`, `captions.js`, `naming-memory.js`, `queue.js`, `retry.js`,
`concurrency.js`, `hashing.js`, `history.js`, `integrity.js`, `store.js`, `validate.js`, `report.js`,
`src/renderer/vlist.js`, `bench/`, `docs/`, `test/naming.test.js`, `test/upload.test.js`, `test/splitter.test.js`.

Rewritten: `src/core/uploader.js`, `src/main.js`, `src/preload.js`, `src/renderer/app.js`.
Changed: `src/core/scanner.js`, `telegram.js`, `splitter.js`, `src/renderer/index.html`, `styles.css`,
`package.json` (3.0.0), `README.md`. 32 files, +5,329 / −616 lines.

## 8. Limitations

- Not tested against live Telegram (see 5). GramJS behaviour for repeated message ids and cancel was checked in its
  source, not on the wire.
- The exe is unsigned (as before): SmartScreen shows "More info → Run anyway". It was built on Linux, so the exe
  has Electron's default icon and file details (the same as 2.x builds with `signAndEditExecutable: false`).
- Saving and opening plans, the folder pickers and Windows notifications use native dialogs that weren't driven in
  the automated run.
- "No double post" relies on Telegram's message-id check, which Telegram keeps for a limited time; resuming a job
  days later falls back to the job journal (albums marked sent are skipped, an album cut off mid-send may repeat).
- Duplicates of files over 256 MB that were deleted after upload can only be matched by quick fingerprint (marked
  "probably same"); the default is to skip them.
- A job runs one album at a time; files inside an album upload in parallel.
- Thumbnails rely on Windows' thumbnailer (videos show an icon if Windows has no thumbnail).

## 9. Testing it on your PC

1. Copy `FolderGram-3.0.0-portable.exe` anywhere and run it. It uses the same `%APPDATA%\FolderGram` data as 2.x;
   on first start it backs up your files to `%APPDATA%\FolderGram\backups\<date>` and switches album names to
   Smart (a message says so). Your 2.x exe stays untouched; to go back, run it again.
2. Pick a small test group with topics, add a folder of 20–30 files, and check the preview: names, confidence,
   "was ..." lines. Rename one, undo, drag one.
3. Press **Check duplicates**, then **Start upload**. Watch the Queue tab and the live stats.
4. While a bigger job runs, close the app, reopen it, press **Resume**; confirm nothing was posted twice.
5. Open History, export CSV, and look at Naming rules.

## 10. Building it yourself (Windows x64)

From source on Windows (Node.js 20+):

```
git checkout claude/project-thread-h62ayy
npm install
npm test
npx electron-builder --win portable --x64 --publish never
```

The exe lands in `dist\FolderGram-3.0.0-portable.exe`. `build-windows.bat` still builds both the installer and the
portable exe. On Windows the exe also gets the FolderGram icon.

How this build was made on Linux: the Windows Electron 44.9.3 zip and the Windows `ffmpeg.exe` for ffmpeg-static
5.2.0 were downloaded, the ffmpeg binary in a copy of the project was replaced by `ffmpeg.exe`, then
`npx electron-builder --win portable --x64 --publish never -c.electronDist=<unzipped Windows Electron>`.
