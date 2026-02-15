/** @type {import('jest').Config} */
module.exports = {
  testMatch: ['**/tests/jest/**/*.test.js'],
  testTimeout: 30000,
  maxWorkers: 1,       // Sequential — avoid rate limits on Caspio
  verbose: true,
  // No transforms needed — plain Node.js
};
