/** @type {import('jest').Config} */
module.exports = {
  testMatch: ['**/tests/jest/**/*.test.js'],
  testTimeout: 30000,
  maxWorkers: 1,       // Sequential — avoid rate limits on Caspio
  verbose: true,
  // No transforms needed — plain Node.js

  // forceExit (2026-08-05): without it `npm test` exits 1 even when every
  // suite passes — 1100/1100 green, exit code 1. Jest runs a small file set
  // in-band (exit 0) but spawns a worker once the run is big enough, and on
  // this box (Windows · Node 22.11 · Jest 30.1) that worker's teardown leaks a
  // non-zero code to the parent. Verified: 2 files → 0, 11 files → 1, and the
  // same 11 with --forceExit → 0; --runInBand does NOT help; and
  // --detectOpenHandles reports nothing, so this is not a leaked handle we are
  // papering over. It mattered because deploy Step 0.6 gates on `npm test`,
  // so the gate was permanently red — which only teaches people to reach for
  // --skip-tests. If a suite ever DOES hang, drop this flag first and re-run
  // with --detectOpenHandles before assuming the harness is at fault.
  forceExit: true,
};
