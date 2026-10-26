# FolderGram

Upload whole folders of photos and videos to a Telegram group, sorted into topics and albums.

![FolderGram](assets/screenshot.png)

## What it does

### New in 3.0

- **Smart album names.** FolderGram reads the folder, its parents and the file names and picks the best name,
  with a confidence badge (High, Medium, Check). Random folders such as `kb03wM (GoFile)` take the name in their
  files (`Marin Kitagawa (1).jpg` → **Marin Kitagawa**), generic folders get their parent (`Rem Collection/Set 01`
  → **Rem Collection - Set 01**), and file names are cleaned of numbering, copy marks, `[release tags]`, `(1080p)`
  and site names. Sets in one folder are kept apart (`Elaina_Set_01_001.png`, `Elaina_Set_02_001.png` →
  **Elaina - Set 01**, **Elaina - Set 02**). Other modes: folder name, parent + folder, file name (2.x) or your own
  template like `{parent} - {folder}`.
- **Captions** in five styles (simple, detailed `Marin Kitagawa — 10 Photos`, series `Part 1 of 3`, folder path,
  custom template), shown after the first, last or every album.
- **Editable preview.** Click a name to rename it, drag albums to reorder or move them between folders, merge
  and split albums, leave files out, map a folder to an existing topic, bulk rename with `{name} {n}` or
  `find => replace`, undo and redo, and save the plan to finish later. Names you correct are remembered for next
  time; the **Naming rules** tab lists them and lets you add find/replace rules.
- **Upload queue.** Jobs are saved and run one after another, can be paused, reordered, scheduled for a set time,
  and retried (only what failed is sent again). If FolderGram closes or crashes mid-upload it offers to resume,
  and an album that already reached Telegram is never posted twice.
- **Reliability.** Upload speed presets (Careful, Balanced, Fast, Custom) that slow down automatically when
  Telegram asks; flood waits are honoured with a countdown; retries back off with jitter; files are checked just
  before sending (missing, changed, empty or not really a photo).
- **Duplicates.** Quick fingerprints first, then a full SHA-256 check before anything is skipped; choose whether
  duplicates count per topic, per group or across all groups, and review them before uploading.
- **Filters**: include and leave-out patterns (`*.jpg`, `raw/**`), size limits, subfolder depth, hidden files.
- **History and reports**: every job's albums, topics, failures and skipped duplicates, exportable as JSON or CSV.
- **Fast with big folders**: 50,000 files scan in about 2.4 s and the preview only draws what is on screen.

### Everything from 2.x

- **Topic per folder.** Each folder goes into a forum topic with its name. With nested folders, the
  **top parent folder** is the topic (`Rem/Set 1` and `Rem/Set 2` both go to topic `Rem`), or "Every folder"
  gives each subfolder its own topic, or a template. Existing topics are reused (same name, any case, closed
  topics are flagged); missing ones are created.
- **One topic** (pick or create a topic) or **No topics** (normal groups), with an optional
  `📁 folder` message before each folder.
- **Albums of up to 10** photos and videos.
- **Random folder names** like `2Zy6lA (GoFile)` can be renamed to `Album 1`, `Album 2`, … (optional; choose the
  word instead of "Album"). The same folder keeps the same number in later scans.
- **Add folders or single files** (button or drag and drop).
- **Big photos stay in the album**: photos over 10 MB are resized to 2560 px instead of arriving as files.
- **Update check**, **pause / resume / cancel**, speed and time left, taskbar progress and a notification.
- **Send silently**, **pause between albums**, **file type filter**, **order** by name or date,
  **send as files** (original quality).
- Videos are sent with their length, size and a thumbnail, read with the bundled ffmpeg, so they play inline,
  including HEVC. `.ts`, `.mkv`, `.avi` and similar are rewrapped into MP4 first (no re-encoding, nothing lost).
  A video that can't be read is sent next to the album as a file instead of turning the whole album into files.
- Up to 2 GB per file (4 GB with Premium). **Longer videos are split** into playable parts
  (`Movie (part 1 of 3).mp4`, …) without re-encoding; each part is checked before it is sent.
- Log in with your own account or a bot.

## Install

Download the latest `FolderGram-x.y.z-portable.exe` (or the Setup installer) from [Releases](https://github.com/Saiki1997/FolderGram/releases). No install needed. Windows SmartScreen may warn because the app
isn't code-signed: click **More info → Run anyway**.

To build it yourself, install Node.js 20+ from nodejs.org and double-click `build-windows.bat`.
The installer and the portable exe end up in `dist\`. Or push to GitHub and run the
"Build Windows app" workflow. To run from source, use `run-dev.bat`.

## First use

1. Get an **API ID** and **API hash** at <https://my.telegram.org/apps> (log in, create an app).
2. In FolderGram, enter them plus your phone number (with country code) and press **Log in**.
   Type the code Telegram sends you, and your 2-step password if you have one.
3. Pick the group. Groups with topics show a **TOPICS** tag. To use topics, turn on Topics in the
   group's settings; you must be an admin who can manage topics.
4. Choose or drop the folder, check the preview, press **Start upload**.

Using a bot instead: create one with @BotFather, make it an admin with **Manage topics**, choose "Bot"
and paste its token. Bots can't list chats, so type the group's @username or id (like `-1001234567890`).

Your login session, settings, upload history, saved jobs and naming corrections are stored in
`%APPDATA%\FolderGram` (the session encrypted with Windows' own data protection), with a daily backup in
`backups\`. **Log out** deletes the session. Nothing is sent anywhere except Telegram and the GitHub update check.

## Development

```
npm install
npm test                      # naming, captions, planner, scanner, queue, recovery, duplicates, splitting
node bench/scan-bench.js      # scan + plan timing for 100 to 50,000 files
node bench/data-bench.js      # fingerprints, SHA-256 and history timing
npm start
```

- `src/core/naming.js`, `planner.js`, `captions.js`: name detection, album grouping, captions (captions.js is
  shared with the window so the preview shows exactly what is sent).
- `src/core/scanner.js`: parallel folder scan with filters.
- `src/core/queue.js`, `uploader.js`, `retry.js`, `concurrency.js`: the saved queue, the upload of one job,
  error handling and adaptive speed.
- `src/core/hashing.js`, `history.js`, `store.js`, `naming-memory.js`: duplicates, history journal, safe file
  writes and backups, remembered names.
- `src/core/telegram.js`: Telegram via GramJS (MTProto).
- `src/main.js`, `src/preload.js`, `src/renderer/`: the Electron app.

See `docs/AUDIT-3.0.md` for the audit behind 3.0 and `docs/RELEASE-3.0.md` for the full change report.
