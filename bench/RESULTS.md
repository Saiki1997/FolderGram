# FolderGram 4.0 performance measurements

All numbers below were measured in this environment (Linux, xvfb, Electron 44.9.3, fake Telegram transport,
synthetic folder trees). They are not Windows measurements; expect different absolute values on the user's PC.
"base" = commit d11cb6c (before this work), "new" = this branch.

## Scan of a large folder, real app window (bench: scan-ui via Playwright)

maxFrameGap = the longest time the window could not paint while the scan result arrived (lower is better).

| files | base maxFrameGap | new maxFrameGap | base scan+render | new scan+render |
|---|---|---|---|---|
| 10,000 | 116–173 ms | 86 ms | 825–975 ms | 793 ms |
| 50,000 | 403–624 ms (4 runs) | 282–309 ms (3 runs) | 2394–2970 ms | 2224–2502 ms |
| 100,000 | 1052 ms | 673 ms | 4853 ms | 4282 ms |

Change: the scan reply sends file metadata as columns instead of one object per file (smaller structured clone).

## Activity-log flood, real app window (bench: log-flood via Playwright)

Lines are pushed from the main process for a few seconds. "base" sends one IPC message per line (as d11cb6c does);
"new" sends batches (as this branch's main process does) and the window draws at most 200 lines per frame.
wall = time until the last line is on screen (the base window falls behind and catches up long after the burst).

| burst | base maxFrameGap | base wall | new maxFrameGap | new wall |
|---|---|---|---|---|
| 20,000 lines over 4 s | 109 ms | 7.4 s | 39 ms | 5.7 s |
| 50,000 lines over 3 s (2 runs each) | 111–114 ms | 16.5–16.9 s | 56–69 ms | 4.7–4.8 s |

No long tasks (>50 ms) were recorded in either build for these runs. Real uploads log far fewer lines than this;
the burst is a stress test.

## Integrity ledger with 1,000,000 uploaded-file rows (bench/integrity-bench.js)

Run in the app's own runtime (`ELECTRON_RUN_AS_NODE=1 electron bench/integrity-bench.js 1000000`: Node 24.22.0,
Electron 44.9.3, SQLite WAL, synchronous=FULL). "before" is the same bench on the ledger without migration 2.

| operation | before (Node 22) | after (Electron 44) |
|---|---|---|
| insert 1M rows (batches of 5,000) | 57.9 s | 59.5 s (≈17k rows/s) |
| walk every message id of the chat (deep audit) | 73.5 s | 0.62 s |
| 4 keyset pages of 500 over the whole chat | 329 ms | 4 ms |
| one page of 500 at the end of the chat | 53 ms | 0.9 ms |
| status counts (cached 30 s in the app) | 290 ms | 123 ms |
| 1,000 lookups by path + size + mtime | 40 ms | 43 ms |
| 10,000 verification updates | 100 ms | 146 ms |
| full integrity_check | 5.1 s | 6.6 s (now on a worker thread) |
| backup (VACUUM INTO) | 1.9 s | 2.6 s (now on a worker thread) |
| open incl. quick_check | – | 0.42 s |
| database file | 277 MB | 331 MB |
| bench process memory (RSS) | 205 MB | 222 MB |

Uploads add rows at most a few per second (the safety engine's pace), so insert speed only matters for the one-time
migration from old job files.

## Upload in the real app, stand-in network (600 photos, 10 folders)

Paced by the real safety engine at Balanced (a 10-photo album uses 10 of the 12 messages a minute, so one album
went out per minute, as designed). Sampled for 200 s: peak memory (all processes) 602 MB, average CPU 2%, largest
window frame gap 36 ms, no long tasks, no console errors, 55 progress messages to the window. This run also found
the false "topic missing" pause fixed in edace00.
