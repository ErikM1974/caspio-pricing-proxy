/**
 * DTG canonical engine — vendored-copy BYTE parity, proxy-side mirror (Batch 6,
 * 2026-07-09, Pricing Index repo). lib/dtg-canonical-pricing.js is THE one DTG
 * formula (UMD); the Pricing Index repo vendors it byte-identical and its
 * client service delegates all math to it. This mirror fails the PROXY's CI
 * when someone edits the canonical here without re-copying to the app repo.
 * Fix = copy lib/dtg-canonical-pricing.js over the app repo's
 * shared_components/js/dtg-canonical-pricing.js and re-run both suites.
 */
const fs = require('fs');
const path = require('path');

const CANONICAL = path.join(__dirname, '../../lib/dtg-canonical-pricing.js');
const VENDORED = path.join(
  __dirname,
  '../../../Pricing Index File 2025/shared_components/js/dtg-canonical-pricing.js'
);

describe('dtg-canonical-pricing vendored parity (proxy-side mirror)', () => {
  test('app repo vendored copy is BYTE-IDENTICAL (skip if sibling repo absent)', () => {
    if (!fs.existsSync(VENDORED)) {
      console.warn('[vendored-parity] sibling Pricing Index repo not checked out — skipping');
      return;
    }
    expect(fs.readFileSync(CANONICAL, 'utf8')).toBe(fs.readFileSync(VENDORED, 'utf8'));
  });

  test('UMD: CJS surface intact + browser branch exposes window.DTGCanonicalPricing', () => {
    const m = require(CANONICAL);
    expect(typeof m.priceForLocationCombo).toBe('function');
    expect(typeof m.priceLines).toBe('function');
    const win = {};
    new Function('window', fs.readFileSync(CANONICAL, 'utf8'))(win);
    expect(typeof win.DTGCanonicalPricing.priceForLocationCombo).toBe('function');
  });
});
