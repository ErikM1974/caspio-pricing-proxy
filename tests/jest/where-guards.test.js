// Unit tests for the Caspio route input guards (WHERE-clause + file-key safety).
// Pure functions — no network, no Caspio creds needed.
const { reqInt, escWhere, isValidFileKey } = require('../../src/utils/where-guards');

describe('where-guards: reqInt (id validation)', () => {
  test('accepts positive integers', () => {
    expect(reqInt('123')).toBe(123);
    expect(reqInt(53001)).toBe(53001);
    expect(reqInt(' 42 ')).toBe(42);
  });
  test('rejects injection payloads and non-positive-integers', () => {
    expect(reqInt('1 OR 1=1')).toBeNull();
    expect(reqInt('1; DROP TABLE ArtRequests')).toBeNull();
    expect(reqInt('1.5')).toBeNull();
    expect(reqInt('-5')).toBeNull();
    expect(reqInt('0')).toBeNull();
    expect(reqInt('abc')).toBeNull();
    expect(reqInt('')).toBeNull();
    expect(reqInt(null)).toBeNull();
    expect(reqInt(undefined)).toBeNull();
  });
});

describe('where-guards: escWhere (string filter escaping)', () => {
  test('escapes single quotes (doubles them, Caspio-style)', () => {
    expect(escWhere("O'Brien")).toBe("O''Brien");
    expect(escWhere("x' OR '1'='1")).toBe("x'' OR ''1''=''1");
  });
  test('leaves clean strings unchanged', () => {
    expect(escWhere('Acme Co')).toBe('Acme Co');
  });
});

describe('where-guards: isValidFileKey', () => {
  test('accepts GUID / token-shaped keys', () => {
    expect(isValidFileKey('f746f21a-ad2d-4b1c-9e3f-0123456789ab')).toBe(true);
    expect(isValidFileKey('AbC_123-xyz')).toBe(true);
  });
  test('rejects path-traversal and malformed keys', () => {
    expect(isValidFileKey('../../etc/passwd')).toBe(false);
    expect(isValidFileKey('a/b/c')).toBe(false);
    expect(isValidFileKey('short')).toBe(false);   // < 8 chars
    expect(isValidFileKey('')).toBe(false);
    expect(isValidFileKey(null)).toBe(false);
    expect(isValidFileKey(123)).toBe(false);
  });
});
