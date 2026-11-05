// Test helpers for the safety engine (not a test file itself): a virtual clock, so pacing and flood waits are
// checked exactly without the tests actually waiting minutes.
'use strict';

const { SafetyEngine } = require('../src/core/telegram-safety');

/** A safety engine on a virtual clock: sleep(ms) moves the clock instead of waiting. Returns the engine; .clock has the time. */
function instantSafety(opts = {}) {
  const clock = { t: 1_700_000_000_000, slept: 0 };
  const e = new SafetyEngine({ now: () => clock.t, sleep: async (ms) => { clock.t += ms; clock.slept += ms; await Promise.resolve(); }, ...opts });
  e.clock = clock;
  return e;
}

module.exports = { instantSafety };
