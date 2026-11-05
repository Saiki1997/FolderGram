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
