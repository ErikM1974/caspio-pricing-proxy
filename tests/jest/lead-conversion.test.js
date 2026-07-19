// lead-conversion.test.js — pure coverage for the conversion classifier/guards.
'use strict';

const {
  isEmail, isGenericEmail, normCompany, isJunkCompany, companyNamesAlign,
  classifyOrders, isCollisionRisk, GRACE_DAYS,
} = require('../../src/utils/lead-conversion');

const day = (iso) => Date.parse(iso + 'T12:00:00');

describe('company + email helpers', () => {
  test('generic vs corporate email domains', () => {
    expect(isGenericEmail('jane@gmail.com')).toBe(true);
    expect(isGenericEmail('jane@buckleyadvisors.com')).toBe(false);
    expect(isEmail('a@b.com')).toBe(true);
    expect(isEmail('not-an-email')).toBe(false);
  });
  test('normalize strips suffixes/punct; junk detection', () => {
    expect(normCompany('Gray Lumber Company')).toBe('gray lumber');
    expect(normCompany('CHEEMA Freightlines LLC')).toBe('cheema freightlines');
    expect(isJunkCompany('None')).toBe(true);
    expect(isJunkCompany('Individual — Pat')).toBe(false); // has a real token
    expect(isJunkCompany('Puget Systems')).toBe(false);
  });
  test('company alignment: shared significant token', () => {
    expect(companyNamesAlign('Gray Lumber Company', 'Gray Lumber')).toBe(true);
    expect(companyNamesAlign('Construction Components LLC', 'Construction Components')).toBe(true);
    // concatenated vs spaced does NOT token-align — stays a conservative "review"
    // (personal-email + no shared token → collision risk → not auto-won).
    expect(companyNamesAlign('2purplebunnies', '2 Purple Bunnies')).toBe(false);
    expect(companyNamesAlign('Auburn Dance Academy', 'Xtreme')).toBe(false);
    expect(companyNamesAlign('H4O', 'Salvation Baptist Church')).toBe(false);
  });
});

describe('classifyOrders — first order after inquiry', () => {
  test('no orders → not converted', () => {
    expect(classifyOrders(day('2025-01-01'), []).converted).toBe(false);
  });
  test('order after inquiry → converted, conversion = that order', () => {
    const r = classifyOrders(day('2025-01-01'), [day('2025-01-20'), day('2025-06-01')]);
    expect(r.converted).toBe(true);
    expect(r.orderCount).toBe(2);
    expect(new Date(r.conversionMs).toISOString().slice(0, 10)).toBe('2025-01-20');
  });
  test('all orders before inquiry → still "converted" for THIS lead only within grace', () => {
    // an order 30 days before the inquiry does NOT count (outside 14d grace)
    const r = classifyOrders(day('2025-02-01'), [day('2025-01-01')]);
    expect(r.converted).toBe(false);
  });
  test('order within grace window before the lead counts', () => {
    const r = classifyOrders(day('2025-02-01'), [day('2025-01-25')]); // 7d before < 14d grace
    expect(r.converted).toBe(true);
    expect(GRACE_DAYS).toBe(14);
  });
});

describe('isCollisionRisk — only flags risky email matches', () => {
  test('personal email + mismatched company = risk', () => {
    expect(isCollisionRisk('email', 'yeli@gmail.com', 'H4O', 'Salvation Baptist Church')).toBe(true);
  });
  test('personal email but aligned company = safe', () => {
    expect(isCollisionRisk('email', 'jel@gmail.com', 'Art For All', 'Art For All')).toBe(false);
  });
  test('corporate email = safe regardless of name', () => {
    expect(isCollisionRisk('email', 'a@acme.com', 'Acme West', 'Acme Holdings')).toBe(false);
  });
  test('company/fuzzy matches are never collision risk', () => {
    expect(isCollisionRisk('company', 'x@gmail.com', 'Foo', 'Bar')).toBe(false);
    expect(isCollisionRisk('company-fuzzy', 'x@gmail.com', 'Foo', 'Bar')).toBe(false);
  });
});
