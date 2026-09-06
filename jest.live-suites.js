// Suites that require('./setup') call the PRODUCTION proxy (and so cost Caspio quota);
// everything else runs on mocks. Detected from the files themselves so nothing needs
// maintaining when a suite is added.
const fs = require('fs');
const path = require('path');
function liveSuites() {
  const dir = path.join(__dirname, 'tests', 'jest');
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.test.js'))
    .filter(f => /require\('\.\/setup'\)/.test(fs.readFileSync(path.join(dir, f), 'utf8')))
    .map(f => path.join(dir, f).replace(/\\/g, '/'));
}
module.exports = { liveSuites };
