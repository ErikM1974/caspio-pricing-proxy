// Unit tests for the shared route-level TTL cache (src/utils/ttl-cache.js).
// Hermetic — no Caspio, no network.

const { createTtlCache, shouldBypass, makeKey, clearAll } = require('../../src/utils/ttl-cache');

describe('ttl-cache', () => {
  beforeEach(() => {
    clearAll();
    jest.useRealTimers();
  });

  test('fresh entry is returned on get', () => {
    const cache = createTtlCache({ name: 'test-fresh', ttlMs: 60000, maxEntries: 10 });
    cache.set('k1', { a: 1 });
    expect(cache.get('k1')).toEqual({ a: 1 });
  });

  test('expired entry is NEVER returned (Rule 4)', () => {
    jest.useFakeTimers();
    const cache = createTtlCache({ name: 'test-expiry', ttlMs: 1000, maxEntries: 10 });
    cache.set('k1', 'value');
    jest.advanceTimersByTime(1001);
    expect(cache.get('k1')).toBeUndefined();
    // Expired entry is also evicted on read
    expect(cache.size).toBe(0);
  });

  test('FIFO eviction past maxEntries drops the oldest entry', () => {
    const cache = createTtlCache({ name: 'test-fifo', ttlMs: 60000, maxEntries: 2 });
    cache.set('first', 1);
    cache.set('second', 2);
    cache.set('third', 3);
    expect(cache.size).toBe(2);
    expect(cache.get('first')).toBeUndefined();
    expect(cache.get('second')).toBe(2);
    expect(cache.get('third')).toBe(3);
  });

  test('clear() empties the cache and reports the dropped count', () => {
    const cache = createTtlCache({ name: 'test-clear', ttlMs: 60000, maxEntries: 10 });
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.clear()).toBe(2);
    expect(cache.size).toBe(0);
    expect(cache.get('a')).toBeUndefined();
  });

  test('clearAll() clears every registered cache and reports counts by name', () => {
    const c1 = createTtlCache({ name: 'test-all-1', ttlMs: 60000, maxEntries: 10 });
    const c2 = createTtlCache({ name: 'test-all-2', ttlMs: 60000, maxEntries: 10 });
    c1.set('x', 1);
    c2.set('y', 2);
    c2.set('z', 3);
    const cleared = clearAll();
    expect(cleared['test-all-1']).toBe(1);
    expect(cleared['test-all-2']).toBe(2);
    expect(c1.size).toBe(0);
    expect(c2.size).toBe(0);
  });

  test('createTtlCache is idempotent per name (registry returns the same instance)', () => {
    const a = createTtlCache({ name: 'test-idem', ttlMs: 60000, maxEntries: 10 });
    const b = createTtlCache({ name: 'test-idem', ttlMs: 1, maxEntries: 1 });
    expect(a).toBe(b);
  });

  test('shouldBypass only fires on refresh=true', () => {
    expect(shouldBypass({ query: { refresh: 'true' } })).toBe(true);
    expect(shouldBypass({ query: { refresh: 'false' } })).toBe(false);
    expect(shouldBypass({ query: {} })).toBe(false);
    expect(shouldBypass(undefined)).toBe(false);
  });

  test('makeKey is stable for identical field order', () => {
    expect(makeKey({ style: 'PC61', color: null })).toBe(makeKey({ style: 'PC61', color: null }));
    expect(makeKey({ style: 'PC61', color: 'jet black' }))
      .not.toBe(makeKey({ style: 'PC61', color: null }));
  });
});
