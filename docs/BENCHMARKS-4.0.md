# FolderGram 4.0 benchmarks

Two kinds of numbers are in this file, and they are kept apart on purpose:

- **Measured on this machine**: scanning, planning and hashing (see `docs/AUDIT-4.0.md`, section 5).
- **Simulated network**: the upload engine on a stand-in connection. These are **not** measurements of Telegram.

No live Telegram upload has been run for 4.0 yet. That needs an approved test group.

## Upload engine on a simulated network (Phase 2)

`node bench/upload-sim.js <3.1.2 checkout> .` runs each version's real planner, uploader and Telegram code. Only the
network is replaced:

- one shared 11.9 MB/s line (100 Mbit/s);
- 120 ms per request;
- 700 ms for Telegram to post an album. This figure is an assumption, not a measured one.

The workload is 160 photos of 1 MB each in 8 folders. With photos this small, the time between albums matters more
than the line speed, which is exactly where pipelining helps. Big videos are limited by the line in both versions, and
3.1.0 already reached about 11.6 MB/s on them on a real 100 Mbit/s line, so no gain is claimed for them.

| Version | Speed preset | Time | Effective speed | Sent | Failed | Files uploaded again | Progress went backwards |
|---|---|---|---|---|---|---|---|
| 3.1.2 | Balanced | 48.6 s | 3.3 MB/s | 160/160 | 0 | 0 | 0 times |
| 3.1.2 | Balanced, connection lost for 10 s | 71.4 s | 2.2 MB/s | 160/160 | 0 | 6 | 0 times |
| 3.1.2 | Fast | 36.7 s | 4.4 MB/s | 160/160 | 0 | 0 | 0 times |
| 4.0 | Balanced | 30.7 s | 5.2 MB/s | 160/160 | 0 | 0 | 0 times |
| 4.0 | Balanced, connection lost for 10 s | 46.8 s | 3.4 MB/s | 160/160 | 0 | 3 | 0 times |
| 4.0 | Fast | 20.8 s | 7.7 MB/s | 160/160 | 0 | 0 | 0 times |
| 4.0 | Maximum | 20.5 s | 7.8 MB/s | 160/160 | 0 | 0 | 0 times |

The runs were repeated twice and gave the same times to within 0.5 s. Three things explain the differences:

- **Pipelining.** 4.0 uploads the next album while Telegram posts the current one and during the pause between
  albums. 3.1.2 leaves the line idle during both.
- **Outage.** A 10 s outage cost 3.1.2 about 23 s and 4.0 about 16 s. 4.0 checks the connection and continues as
  soon as it is back, without spending retries.
- **Maximum.** Here it is no faster than Fast, because this simulation has no per-connection limit, so extra
  connections cannot help. The Maximum explorer is covered by unit tests, which check that it climbs while more
  connections are measurably faster and settles where they stop helping. Whether it helps on a real line can only be
  shown by a live test.

## Reliability tests (fake Telegram)

`test/reliability.test.js` has 20 scenarios: half-sent albums, hung requests, outages, deleted topics, clock skew
and look-alike albums. On 3.1.2, 18 of the 20 fail or hang. On 4.0 all 20 pass. See `docs/AUDIT-4.0.md`, section 3.

## Real app window with the stand-in network

The Electron app was driven with Playwright under xvfb. It used `test/ui-fake-transport.js`, which is development
only and is never in a build. The run was 42 photos (82 MB) at 6 MB/s, with the connection dropped for 10 s
partway through:

- Result: 42 of 42 delivered, no window errors.
- During the outage, the Uploads view said "No connection to Telegram, waiting for it", with a countdown. Speed and
  time left showed "—" instead of stale numbers.
- After the run, "Sent over the network" was 83.9 MB against 82.0 MB of files. The extra 1.9 MB is the part
  re-sent after the outage.
