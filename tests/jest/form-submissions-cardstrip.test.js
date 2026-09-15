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
    ['credit-card-auth', 'CCA'],
    ['quote-request', 'QRQ'],
  ])('%s → %s prefix + MMDD-rand4', (formId, prefix) => {
    expect(buildSubmissionId(formId)).toMatch(new RegExp(`^${prefix}\\d{4}-\\d{4}$`));
  });

  test('public lead forms are Slack-notified; staff-only forms are not', () => {
    const { LEAD_NOTIFY_FORMS } = require('../../src/utils/form-submission-helpers');
    expect(LEAD_NOTIFY_FORMS.has('quote-request')).toBe(true);
    expect(LEAD_NOTIFY_FORMS.has('webstore-request')).toBe(true);
    expect(LEAD_NOTIFY_FORMS.has('ae-order-intake')).toBe(false);
  });

  test('credit-card-auth is card-stripped: identity labels survive, PAN/CVV labels die', () => {
    const { CARD_STRIPPED_FORMS, stripCardFields } = require('../../src/utils/form-submission-helpers');
    expect(CARD_STRIPPED_FORMS.has('credit-card-auth')).toBe(true);
    expect(CARD_STRIPPED_FORMS.has('sample-checkout')).toBe(true);
    const payload = {
      fields: [
        ['Ending in', '1234'],            // last4 — PCI-storable, must survive
        ['Good through (MM/YY)', '12/27'], // expiry sans PAN — must survive
        ['Issuing bank', 'BoA'],
        ['Credit Card #', '4111111111111111'], // must die
        ['CVV Code', '123'],                    // must die
        ['Expiration', '12/27'],                // exact-set key — must die
      ],
    };
    const clean = stripCardFields(payload);
    const labels = clean.fields.map((f) => f[0]);
    expect(labels).toEqual(['Ending in', 'Good through (MM/YY)', 'Issuing bank']);
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

  test('garment-waiver (e-signed, 2026-09-15): GLW prefix, Signed default, server audit stamp, no lead ping', () => {
    const { DEFAULT_STATUS, LEAD_NOTIFY_FORMS, SIGNED_FORMS, withSignatureAudit } = require('../../src/utils/form-submission-helpers');
    expect(validateSubmission({ formId: 'garment-waiver', company: 'Drain Pro', payload: { signature: { typedName: 'Mike Rowe' }, checks: ['Agreed'] } })).toEqual([]);
    // no typed name / no consent → not a signature → rejected before it can be stored as 'Signed'
    expect(validateSubmission({ formId: 'garment-waiver', company: 'Drain Pro', payload: {} })).toHaveLength(2);
    expect(validateSubmission({ formId: 'garment-waiver', company: 'Drain Pro', payload: { signature: { typedName: '  ' }, checks: ['Agreed'] } })).toHaveLength(1);
    expect(validateSubmission({ formId: 'garment-drop-off', company: 'Drain Pro', payload: {} })).toEqual([]); // other forms unaffected
    expect(buildSubmissionId('garment-waiver')).toMatch(/^GLW\d{4}-\d{4}$/);
    expect(DEFAULT_STATUS['garment-waiver']).toBe('Signed');
    expect(LEAD_NOTIFY_FORMS.has('garment-waiver')).toBe(false);
    expect(SIGNED_FORMS.has('garment-waiver')).toBe(true);
    const stamped = withSignatureAudit({ signature: { typedName: 'Mike Rowe' }, notes: [] }, { ip: '203.0.113.9', userAgent: 'Mozilla/5.0 (test)', receivedAt: '2026-09-15T18:00:00.000Z' });
    expect(stamped.signature).toEqual({ typedName: 'Mike Rowe' });
    expect(stamped.audit).toEqual({ ip: '203.0.113.9', userAgent: 'Mozilla/5.0 (test)', receivedAt: '2026-09-15T18:00:00.000Z', textSha256: '', recordedBy: 'caspio-pricing-proxy' });
    const hashed = withSignatureAudit({ notes: [['Garments Supplied', 'x'], ['Waiver Text (as signed)', 'abc']] }, { ip: '203.0.113.9' });
    expect(hashed.audit.textSha256).toBe(require('crypto').createHash('sha256').update('abc').digest('hex'));
    // single-line fields flatten CR/LF so a company name cannot forge a log line
    const { S } = require('../../src/utils/form-submission-helpers');
    expect(S('Acme\n[form-submissions] saved GLW0915-0001\tfor "Victim"')).toBe('Acme [form-submissions] saved GLW0915-0001 for "Victim"');
    // a client cannot pre-seed its own audit block — the server's stamp replaces it
    expect(withSignatureAudit({ audit: { ip: 'forged' } }, { ip: '198.51.100.4' }).audit.ip).toBe('198.51.100.4');
    expect(withSignatureAudit(null, { ip: '198.51.100.4' }).audit.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
