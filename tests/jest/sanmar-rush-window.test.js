/**
 * Rush rule (Erik, 2026-08-04)
 *
 * "If we receive an order from SanMar today we need at least three production days,
 *  otherwise flag it. Saturdays, Sundays and holidays do not count."
 *
 * Settled convention: count the clear WORKING days strictly AFTER the blanks land, up to
 * and including the due date. The arrival day itself does not count — the cartons are being
 * counted in and put away. THREE OR FEWER is a rush (inclusive: an order due exactly three
 * days after receipt is the one that quietly slips, so it gets flagged).
 *
 * The calendar is deliberately the SAME one the arrival estimate uses (holidaysForYear),
 * so "when will it land" and "is it a rush" can never disagree about what a working day is.
 */
const {
  workingDaysBetween,
  isBusinessDay,
  RUSH_MAX_PRODUCTION_DAYS,
} = require('../../src/routes/sanmar-orders');

const isRush = (arrival, due) => {
  const d = workingDaysBetween(arrival, due);
  return d !== null && d <= RUSH_MAX_PRODUCTION_DAYS;
};

describe('rush window: the agreed threshold', () => {
  test('threshold is 3 and it is inclusive', () => {
    expect(RUSH_MAX_PRODUCTION_DAYS).toBe(3);
  });

  test('the real case that settled it: Tue 8/4 arrival, Sat 8/8 due = 3 days = RUSH', () => {
    // Wed 5, Thu 6, Fri 7 are workable. Sat 8 is not, so it contributes nothing.
    expect(workingDaysBetween('2026-08-04', '2026-08-08')).toBe(3);
    expect(isRush('2026-08-04', '2026-08-08')).toBe(true);
  });

  test('four clear days is NOT a rush', () => {
    // Tue 8/4 -> Mon 8/10: Wed, Thu, Fri, Mon.
    expect(workingDaysBetween('2026-08-04', '2026-08-10')).toBe(4);
    expect(isRush('2026-08-04', '2026-08-10')).toBe(false);
  });

  test('one and two days are rushes', () => {
    expect(workingDaysBetween('2026-08-04', '2026-08-05')).toBe(1);
    expect(workingDaysBetween('2026-08-04', '2026-08-06')).toBe(2);
    expect(isRush('2026-08-04', '2026-08-05')).toBe(true);
    expect(isRush('2026-08-04', '2026-08-06')).toBe(true);
  });
});

describe('rush window: weekends do not count', () => {
  test('a weekend between arrival and due buys no production time', () => {
    // Fri 7/31 -> Wed 8/5 spans a full weekend: Mon 3, Tue 4, Wed 5 = 3 workable days.
    expect(workingDaysBetween('2026-07-31', '2026-08-05')).toBe(3);
    expect(isRush('2026-07-31', '2026-08-05')).toBe(true);
  });

  test('Friday arrival, Monday due = a single working day', () => {
    expect(workingDaysBetween('2026-07-31', '2026-08-03')).toBe(1);
    expect(isRush('2026-07-31', '2026-08-03')).toBe(true);
  });

  test('a due date landing on a Sunday contributes nothing', () => {
    expect(isBusinessDay('2026-08-09')).toBe(false);           // Sunday
    expect(workingDaysBetween('2026-08-04', '2026-08-09'))
      .toBe(workingDaysBetween('2026-08-04', '2026-08-08'));   // same as the Saturday
  });
});

describe('rush window: company holidays do not count', () => {
  test('Christmas (Fri 25 Dec 2026) is not a production day', () => {
    expect(isBusinessDay('2026-12-25')).toBe(false);
    // Wed 12/23 -> Mon 12/28: Thu 24 and Mon 28 are workable; Fri 25 is Christmas,
    // Sat/Sun are the weekend. Two days, not four.
    expect(workingDaysBetween('2026-12-23', '2026-12-28')).toBe(2);
    expect(isRush('2026-12-23', '2026-12-28')).toBe(true);
  });

  test('Thanksgiving 2026 removes a day from the window', () => {
    expect(isBusinessDay('2026-11-26')).toBe(false);           // 4th Thursday
    // Mon 11/23 -> Fri 11/27: Tue, Wed, Fri workable; Thu is Thanksgiving.
    expect(workingDaysBetween('2026-11-23', '2026-11-27')).toBe(3);
    expect(isRush('2026-11-23', '2026-11-27')).toBe(true);
  });

  test('the same holiday calendar drives arrival estimates — one definition, not two', () => {
    for (const h of ['2026-01-01', '2026-05-25', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25']) {
      expect(isBusinessDay(h)).toBe(false);
    }
  });
});

describe('rush window: past due and unknown', () => {
  test('due ON the arrival day is past due, not a 0-day rush', () => {
    expect(workingDaysBetween('2026-08-04', '2026-08-04')).toBe(0);
    expect(isRush('2026-08-04', '2026-08-04')).toBe(true);
  });

  test('due BEFORE arrival counts backwards so lateness is visible', () => {
    expect(workingDaysBetween('2026-08-04', '2026-08-03')).toBe(-1);
    expect(workingDaysBetween('2026-08-04', '2026-07-31')).toBe(-2);
    expect(isRush('2026-08-04', '2026-07-31')).toBe(true);
  });

  test('a missing or malformed due date is UNKNOWN, never a rush', () => {
    // Never invent urgency from absent data — a blank due date must not page production.
    expect(workingDaysBetween('2026-08-04', '')).toBeNull();
    expect(workingDaysBetween('2026-08-04', null)).toBeNull();
    expect(workingDaysBetween('', '2026-08-08')).toBeNull();
    expect(workingDaysBetween('2026-08-04', 'not-a-date')).toBeNull();
    expect(isRush('2026-08-04', '')).toBe(false);
  });
});
