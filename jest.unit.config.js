// npm run test:unit — every suite that does NOT talk to production (fast, no Caspio quota).
const base = require('./jest.config.js');
const { liveSuites } = require('./jest.live-suites');
module.exports = {
  ...base,
  testPathIgnorePatterns: [...(base.testPathIgnorePatterns || []), ...liveSuites().map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))],
};
