// The Caspio account clock (src/utils/account-time.js).
//
// Caspio buckets usage on the ACCOUNT timezone — its Integrations log header
// reads literally "Log date (UTC-07:00)". Our meter, rollup and pacing all keyed
// on UTC, so our "day" started seven hours before Caspio's. Comparing our daily
// total to the number on their chart was apples-to-oranges, and the offset was
// big enough to be mistaken for thousands of untracked API calls.

const { accountDay, accountHour, accountParts } = require('../../src/utils/account-time');

describe('account clock vs UTC', () => {
  // THE BUG: 5 PM Pacific on the 27th is already the 28th in UTC. Keying on UTC
  // put those evening calls in the wrong day — and Caspio put them in the 27th.
  test('5 PM Pacific on the 27th is still the 27th, not the next UTC day', () => {
    const d = new Date('2026-07-28T00:30:00Z');       // 17:30 PDT on 27 Jul
    expect(d.toISOString().slice(0, 10)).toBe('2026-07-28'); // what we used to key on
    expect(accountDay(d)).toBe('2026-07-27');                // what Caspio counts
  });

  test('just after Pacific midnight rolls to the new day', () => {
    expect(accountDay(new Date('2026-07-28T06:59:00Z'))).toBe('2026-07-27'); // 23:59 PDT
    expect(accountDay(new Date('2026-07-28T07:01:00Z'))).toBe('2026-07-28'); // 00:01 PDT
  });

  test('handles the PST/PDT switch rather than assuming a fixed -07:00', () => {
    // January is PST (-08:00): 07:30Z is still the previous day.
    expect(accountDay(new Date('2026-01-15T07:30:00Z'))).toBe('2026-01-14');
    // July is PDT (-07:00): the same wall clock lands on the 15th.
    expect(accountDay(new Date('2026-07-15T07:30:00Z'))).toBe('2026-07-15');
  });

  test('hour keys are account-local and sort lexicographically', () => {
    const h = accountHour(new Date('2026-07-28T00:30:00Z')); // 17:30 PDT on the 27th
    expect(h).toBe('2026-07-27T17');
    const seq = [
      accountHour(new Date('2026-07-27T15:00:00Z')),
      accountHour(new Date('2026-07-28T00:30:00Z')),
      accountHour(new Date('2026-07-28T15:00:00Z'))
    ];
    expect([...seq].sort()).toEqual(seq);
  });

  test('midnight renders as 00, never 24', () => {
    expect(accountHour(new Date('2026-07-28T07:10:00Z'))).toBe('2026-07-28T00');
  });

  test('accountParts gives 0-indexed months for Date arithmetic', () => {
    expect(accountParts(new Date('2026-07-28T00:30:00Z')))
      .toEqual({ year: 2026, month: 6, day: 27 });
  });
});

describe('period boundary uses the account clock', () => {
  const { periodWindow } = require('../../src/utils/caspio-usage-pacing');

  // The billing period turns over on the 27th. On the account clock that happens
  // at Pacific midnight; on UTC it happened seven hours early, so late-evening
  // calls on the 26th were billed by Caspio to the OLD period while we counted
  // them into the new one.
  test('5 PM Pacific on the 26th is still the OLD period', () => {
    const p = periodWindow(new Date('2026-07-27T00:30:00Z')); // 17:30 PDT on 26 Jul
    expect(p.startYmd).toBe('2026-06-27');
    expect(p.endYmd).toBe('2026-07-26');
  });

  test('after Pacific midnight on the 27th the new period has started', () => {
    const p = periodWindow(new Date('2026-07-27T08:00:00Z')); // 01:00 PDT on 27 Jul
    expect(p.startYmd).toBe('2026-07-27');
    expect(p.daysElapsed).toBe(1);
    expect(p.daysInPeriod).toBe(31); // 27 Jul – 26 Aug
  });
});
