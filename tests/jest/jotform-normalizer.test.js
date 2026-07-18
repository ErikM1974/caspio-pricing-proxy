// jotform-normalizer.test.js — pure-function coverage for the JotForm lead
// ingest (src/utils/jotform.js): both upstream payload shapes normalize the
// same way, assignment picking, record building, webhook secret compare, and
// timezone conversion. No Caspio/network — the module lazy-requires all
// caspio-touching deps (same jest-safety pattern as form-submission-helpers).
'use strict';

const {
  DEFAULT_LEAD_REP,
  normalizeFromRawRequest,
  normalizeFromApiAnswers,
  pickBestContact,
  buildLeadRecord,
  timingSafeSecretCompare,
  toIsoFromZone,
  insertLead,
} = require('../../src/utils/jotform');

const LEAD_FORM = '21764724640151'; // Leads NWCA #1

describe('normalizeFromRawRequest (webhook rawRequest shape)', () => {
  const raw = {
    event_id: '12345_67890', // non-question metadata — must be ignored
    q3_email: 'Alex@CITCWA.com',
    q4_companyGroupOr: 'Construction Industry Training Council of Washington',
    q5_firstName: 'Alex',
    q6_lastName: 'Popescu',
    q7_phoneNumber: { full: '(253) 433-5405' },
    q8_address1: '405 Valley Ave NW',
    q9_address2: 'Suite D',
    q10_city: 'Puyallup',
    q11_projectDescription: 'Three window decals, about 18" diameter',
    q12_uploadArtwork: ['https://www.jotform.com/uploads/nwca/123/CITC - Council.jpg'],
    q13_pleaseVerifyThatYouAreHuman: 'passed', // captcha — must be skipped
  };
  const n = normalizeFromRawRequest(LEAD_FORM, raw, '6601205825228149933');

  test('promotes email (lowercased), name, company, phone', () => {
    expect(n.email).toBe('alex@citcwa.com');
    expect(n.contactName).toBe('Alex Popescu');
    expect(n.company).toBe('Construction Industry Training Council of Washington');
    expect(n.phone).toBe('(253) 433-5405');
  });

  test('summary comes from the project description', () => {
    expect(n.summary).toContain('window decals');
  });

  test('artwork upload URLs are collected', () => {
    expect(n.payload.artworkUrls).toEqual(['https://www.jotform.com/uploads/nwca/123/CITC - Council.jpg']);
  });

  test('captcha skipped; address survives losslessly in payload fields', () => {
    const labels = n.payload.fields.map(([l]) => l).join('|');
    expect(labels).not.toMatch(/verify/i);
    expect(n.payload.fields.some(([, v]) => v === '405 Valley Ave NW')).toBe(true);
  });

  test('_source stamps the form + JotForm deep link', () => {
    expect(n.payload._source).toMatchObject({
      system: 'jotform',
      formId: LEAD_FORM,
      formTitle: 'Leads NWCA #1',
      submissionId: '6601205825228149933',
    });
    expect(n.payload._source.url).toBe('https://www.jotform.com/submission/6601205825228149933');
  });
});

describe('normalizeFromApiAnswers (REST answers shape — reconcile/backfill)', () => {
  const answers = {
    3: { name: 'name', text: 'Name', type: 'control_fullname', answer: { first: 'Jane', last: 'Doe' } },
    4: { name: 'email', text: 'E-mail:', type: 'control_email', answer: 'jane@example.com' },
    5: { name: 'quoteRequest', text: 'Quote Request', type: 'control_textarea', answer: '50 embroidered polos' },
    6: { name: 'companygroup', text: 'Company/Group', type: 'control_textbox', answer: 'Doe Roofing' },
    7: { name: 'submit2', text: 'Submit Form', type: 'control_button', answer: '' },
    8: {
      name: 'uploadArtwork', text: 'Upload Artwork', type: 'control_fileupload',
      answer: ['https://www.jotform.com/uploads/a.png', 'https://www.jotform.com/uploads/b.pdf'],
    },
  };
  const n = normalizeFromApiAnswers('220514824751149', answers, '111');

  test('fullname object flattens; label colon stripped; textarea → summary', () => {
    expect(n.contactName).toBe('Jane Doe');
    expect(n.company).toBe('Doe Roofing');
    expect(n.email).toBe('jane@example.com');
    expect(n.summary).toBe('50 embroidered polos');
  });

  test('multiple uploads all collected', () => {
    expect(n.payload.artworkUrls).toHaveLength(2);
  });
});

describe('company fallback (list UIs key on Company)', () => {
  test('no company → "Individual — {name}"', () => {
    const n = normalizeFromRawRequest(LEAD_FORM, { q5_firstName: 'Solo', q6_lastName: 'Buyer' }, '1');
    expect(n.company).toBe('Individual — Solo Buyer');
  });
  test('no company and no name → "(no company)"', () => {
    const n = normalizeFromRawRequest(LEAD_FORM, { q3_email: 'x@y.com' }, '1');
    expect(n.company).toBe('(no company)');
  });
});

describe('franchise/webstore variants map through generic slugs', () => {
  test('businessName → company; whyDoYou… → summary; fullName object → name', () => {
    const n = normalizeFromRawRequest('233535928059162', {
      q3_fullName: { first: 'Frank', last: 'Chise' },
      q4_businessName: 'Stitch City',
      q5_whyDoYouWantToFranchise: 'Established shop, want the NWCA brand',
    }, '2');
    expect(n.company).toBe('Stitch City');
    expect(n.contactName).toBe('Frank Chise');
    expect(n.summary).toContain('NWCA brand');
  });
});

describe('pickBestContact (assignment picking)', () => {
  const rows = [
    { id_Customer: 1, Sales_Rep: '', Is_Active: 0, Last_Order_Date: '2020-01-01' },
    { id_Customer: 2, Sales_Rep: 'Nika Lao', Is_Active: 1, Last_Order_Date: '2026-05-01' },
    { id_Customer: 3, Sales_Rep: 'Taneisha Clark', Is_Active: 0, Last_Order_Date: '2026-06-01' },
  ];
  test('prefers active rows carrying a rep', () => {
    expect(pickBestContact(rows).id_Customer).toBe(2);
  });
  test('empty/undefined → null', () => {
    expect(pickBestContact([])).toBeNull();
    expect(pickBestContact(undefined)).toBeNull();
  });
});

describe('buildLeadRecord', () => {
  const normalized = normalizeFromRawRequest(LEAD_FORM, { q3_email: 'a@b.com', q4_company: 'B Co' }, '42');

  test('JFL id shape + lead columns + assignment applied', () => {
    const r = buildLeadRecord({
      formID: LEAD_FORM,
      submissionId: '42',
      normalized,
      assign: { salesRep: 'Nika Lao', matchedIdCustomer: '777' },
    });
    expect(r.Submission_ID).toMatch(/^JFL\d{4}-\d{4}$/);
    expect(r.Form_ID).toBe('jotform-lead');
    expect(r.Status).toBe('New');
    expect(r.External_Source).toBe(`jotform:${LEAD_FORM}`);
    expect(r.External_ID).toBe('42');
    expect(r.Sales_Rep).toBe('Nika Lao');
    expect(r.Matched_ID_Customer).toBe('777');
    expect(JSON.parse(r.Payload_JSON)._source.system).toBe('jotform');
  });

  test('blank assignment → Taneisha default; opts override status/timestamp/author', () => {
    const r = buildLeadRecord({
      formID: LEAD_FORM,
      submissionId: '43',
      normalized,
      assign: { salesRep: '' },
      opts: { status: 'Archived', submittedAtIso: '2020-02-02T00:00:00.000Z', updatedBy: 'jotform-backfill' },
    });
    expect(r.Sales_Rep).toBe(DEFAULT_LEAD_REP);
    expect(r.Status).toBe('Archived');
    expect(r.Submitted_At).toBe('2020-02-02T00:00:00.000Z');
    expect(r.Updated_By).toBe('jotform-backfill');
  });
});

describe('insertLead pre-Caspio guards (no network touched)', () => {
  test('knownExternalIds duplicate skips before any lookup', async () => {
    const result = await insertLead({
      formID: LEAD_FORM, submissionId: '99', normalized: {}, knownExternalIds: new Set(['99']),
    });
    expect(result).toMatchObject({ skipped: 'duplicate' });
  });
  test('unknown form / missing submission id skip', async () => {
    expect(await insertLead({ formID: '000', submissionId: '1', normalized: {} }))
      .toMatchObject({ skipped: 'unknown-form' });
    expect(await insertLead({ formID: LEAD_FORM, submissionId: '', normalized: {} }))
      .toMatchObject({ skipped: 'no-submission-id' });
  });
});

describe('timingSafeSecretCompare (webhook gate)', () => {
  test('accepts equal; rejects different, empty, and length-mismatched', () => {
    expect(timingSafeSecretCompare('abc123', 'abc123')).toBe(true);
    expect(timingSafeSecretCompare('abc123', 'abc124')).toBe(false);
    expect(timingSafeSecretCompare('', 'abc')).toBe(false);
    expect(timingSafeSecretCompare('short', 'a-much-longer-secret')).toBe(false);
  });
});

describe('toIsoFromZone (JotForm account-local → UTC ISO)', () => {
  test('summer (PDT) and winter (PST) offsets both convert', () => {
    expect(toIsoFromZone('2026-07-18 10:00:00', 'America/Los_Angeles')).toBe('2026-07-18T17:00:00.000Z');
    expect(toIsoFromZone('2026-01-15 10:00:00', 'America/Los_Angeles')).toBe('2026-01-15T18:00:00.000Z');
  });
  test('garbage input never throws', () => {
    expect(typeof toIsoFromZone('not-a-date')).toBe('string');
  });
});
