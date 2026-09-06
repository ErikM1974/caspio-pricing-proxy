// npm run test:live — only the suites that call the production proxy (costs Caspio quota).
const base = require('./jest.config.js');
const { liveSuites } = require('./jest.live-suites');
module.exports = {
  ...base,
  testMatch: liveSuites().map(p => p.replace(/\\/g, '/')),
};
