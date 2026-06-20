// Unit tests for the CORS origin allowlist.
const { isOriginAllowed } = require('../../src/utils/cors-allowlist');

describe('cors-allowlist: isOriginAllowed', () => {
  test('allows missing origin (server-to-server: crons, curl, health)', () => {
    expect(isOriginAllowed(undefined)).toBe(true);
    expect(isOriginAllowed('')).toBe(true);
    expect(isOriginAllowed(null)).toBe(true);
  });

  test('allows every known NWCA origin', () => {
    [
      'https://www.teamnwca.com',
      'https://teamnwca.com',
      'https://nwcustom.caspio.com',
      'https://c2aby672.caspio.com',
      'https://sanmar-inventory-app-4cd7b252508d.herokuapp.com',
      'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com',
      'https://inksoft-transform-8a3dc4e38097.herokuapp.com',
      'http://localhost:3000',
      'http://localhost',
      'http://127.0.0.1:5500'
    ].forEach(o => expect(isOriginAllowed(o)).toBe(true));
  });

  test('blocks unknown / look-alike origins', () => {
    [
      'https://evil.com',
      'https://teamnwca.com.evil.com',
      'https://notcaspio.com',
      'https://herokuapp.com.attacker.net',
      'http://localhost.evil.com'
    ].forEach(o => expect(isOriginAllowed(o)).toBe(false));
  });

  test('respects an EXTRA_CORS_ORIGINS list', () => {
    expect(isOriginAllowed('https://partner.example.com', ['https://partner.example.com'])).toBe(true);
    expect(isOriginAllowed('https://partner.example.com', [])).toBe(false);
    expect(isOriginAllowed('https://partner.example.com')).toBe(false);
  });
});
