// form-submissions-cardstrip.test.js — locks the server-side guarantee that
// sample-checkout submissions NEVER store card data (Erik 2026-07-11: save the
// sample checkout form but strip the card section), plus the POST validation
// contract the fillable twins rely on.
'use strict';
// import the pure-helpers module, NOT the route — the route pulls in utils/caspio
// whose api-tracker timer would keep jest's event loop alive (open handle).
const { stripCardFields, validateSubmission, buildSubmissionId } = require('../../src/utils/form-submission-helpers');

describe('stripCardFields — card data never reaches Caspio', () => {
  test('drops every card-ish key, keeps everything else', () => {
    const payload = {
      company: 'Drain Pro Inc.',
      checkoutDate: '7/11/2026',
      cardOnFile: true,
      cardAddedToday: false,
      cardVisa: true,
      cardMc: false,
      cardAmex: false,
      cardDiscover: false,
      cardholder: 'Mike Rowe',
      last4: '1234',
      fldLast4: '1234',
      exp: '01/28',
      fldExp: '01/28',
      expiry: '01/28',
      cvv: '999',
      notes: 'exp is fine inside a value: card on file',
    };
    const clean = stripCardFields(payload);
    expect(clean).toEqual({
      company: 'Drain Pro Inc.',
      checkoutDate: '7/11/2026',
      notes: 'exp is fine inside a value: card on file',
    });
  });

  test('strips nested objects too', () => {
    const clean = stripCardFields({
      header: { company: 'X', cardType: 'Visa', last4: '4242' },
      items: [{ style: 'K87', qty: '2' }],
    });
    expect(clean.header).toEqual({ company: 'X' });
    expect(clean.items).toEqual([{ style: 'K87', qty: '2' }]);
  });

  test('strips [label, value] pair entries in the self-describing payload format', () => {
    const clean = stripCardFields({
      fields: [
        ['Company', 'Drain Pro Inc.'],
        ['Cardholder', 'Mike Rowe'],
        ['Last 4', '4242'],
        ['Exp', '01/28'],
        ['Return Due Date', '7/25/2026'],
      ],
      tables: [{ title: 'Items', rows: [['K87', 'Black', '2']] }],
    });
    expect(clean.fields).toEqual([
      ['Company', 'Drain Pro Inc.'],
      ['Return Due Date', '7/25/2026'],
    ]);
    expect(clean.tables[0].rows).toEqual([['K87', 'Black', '2']]);
  });

  test('does NOT eat innocent keys (expected/expedite/discard-free)', () => {
    const clean = stripCardFields({ expected: 'yes', expedite: 'no', description: 'postcard art' });
    // 'postcard' in a VALUE is fine; 'description' key survives; 'expected'/'expedite' survive
    expect(clean).toEqual({ expected: 'yes', expedite: 'no', description: 'postcard art' });
  });
});

describe('validateSubmission — POST contract', () => {
  const good = { formId: 'sample-checkout', company: 'Drain Pro', payload: { a: 1 }, items: [] };

  test('accepts a valid body', () => {
    expect(validateSubmission(good)).toEqual([]);
  });

  test('rejects unknown formId, missing company, non-object payload, oversized items', () => {
    expect(validateSubmission({ ...good, formId: 'nope' }).length).toBe(1);
    expect(validateSubmission({ ...good, company: '  ' }).length).toBe(1);
    expect(validateSubmission({ ...good, payload: 'str' }).length).toBe(1);
    expect(validateSubmission({ ...good, items: new Array(41).fill({}) }).length).toBe(1);
  });
});

describe('buildSubmissionId — per-form prefixes', () => {
  test.each([
    ['garment-drop-off', 'DRP'],
    ['artwork-request', 'ART'],
    ['name-personalization', 'NAM'],
    ['sample-checkout', 'SMP'],
    ['customer-onboarding', 'ONB'],
    ['team-roster', 'RST'],
    ['webstore-request', 'WSR'],
    ['credit-application', 'CRD'],
    ['tax-exempt-cert', 'TAX'],
    ['pto-request', 'PTO'],
    ['injury-report', 'INJ'],
  ])('%s → %s prefix + MMDD-rand4', (formId, prefix) => {
    expect(buildSubmissionId(formId)).toMatch(new RegExp(`^${prefix}\\d{4}-\\d{4}$`));
  });

  test('batch-2 formIds validate and carry their default status', () => {
    const { DEFAULT_STATUS } = require('../../src/utils/form-submission-helpers');
    ['customer-onboarding', 'team-roster', 'webstore-request', 'credit-application',
     'tax-exempt-cert', 'pto-request', 'injury-report'].forEach((formId) => {
      expect(validateSubmission({ formId, company: 'X', payload: {} })).toEqual([]);
      expect(DEFAULT_STATUS[formId]).toBeTruthy();
    });
    expect(DEFAULT_STATUS['pto-request']).toBe('Pending');
    expect(DEFAULT_STATUS['injury-report']).toBe('Open');
  });
});
