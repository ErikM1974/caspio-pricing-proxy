// send-lead-email.test.js — pure-helper coverage for the new-lead AE email
// (src/utils/send-lead-email.js). No EmailJS/network — buildParams and
// repEmailFor are pure; sendLeadEmail itself is exercised only for the
// missing-env skip path (never throws).
'use strict';

const { sendLeadEmail, repEmailFor, __test__ } = require('../../src/utils/send-lead-email');
const { buildParams } = __test__;

describe('repEmailFor — rep display name → inbox', () => {
    test('exact names route to their inbox', () => {
        expect(repEmailFor('Taneisha Clark')).toBe('taneisha@nwcustomapparel.com');
        expect(repEmailFor('Nika Lao')).toBe('nika@nwcustomapparel.com');
        expect(repEmailFor('Steve Deland')).toBe('art@nwcustomapparel.com');
    });
    test('first-name drift still routes (ShopWorks CSR strings vary)', () => {
        expect(repEmailFor('Taneisha')).toBe('taneisha@nwcustomapparel.com');
        expect(repEmailFor('nika')).toBe('nika@nwcustomapparel.com');
    });
    test('blank/unknown reps fall back to Taneisha (routing-rule default)', () => {
        expect(repEmailFor('')).toBe('taneisha@nwcustomapparel.com');
        expect(repEmailFor(null)).toBe('taneisha@nwcustomapparel.com');
        expect(repEmailFor('Somebody New')).toBe('taneisha@nwcustomapparel.com');
    });
});

describe('buildParams', () => {
    const record = {
        Submission_ID: 'JFL0718-4821',
        Company: 'CITC of Washington',
        Contact_Name: 'Alex Popescu',
        Phone: '(253) 433-5405',
        Email: 'alex@citcwa.com',
        Summary: 'Three window decals',
        Sales_Rep: 'Nika Lao',
        Matched_ID_Customer: '7740',
    };

    test('routes to the assigned rep with the lead details', () => {
        const p = buildParams({ record, sourceTitle: 'Leads NWCA #1', matchedCompany: 'CITC' });
        expect(p.to_email).toBe('nika@nwcustomapparel.com');
        expect(p.to_name).toBe('Nika Lao');
        expect(p.lead_id).toBe('JFL0718-4821');
        expect(p.source).toBe('Leads NWCA #1');
        expect(p.customer_note).toBe('Existing ShopWorks customer #7740 — CITC');
    });

    test('lead_link uses a #hash and carries NO "=" (quoted-printable mangling)', () => {
        const p = buildParams({ record });
        expect(p.lead_link).toBe('https://teamnwca.com/dashboards/lead.html#JFL0718-4821');
        expect(p.lead_link.indexOf('=')).toBe(-1);
    });

    test('unmatched lead → prospect note + Taneisha default recipient', () => {
        const p = buildParams({
            record: { ...record, Sales_Rep: '', Matched_ID_Customer: '' },
        });
        expect(p.to_email).toBe('taneisha@nwcustomapparel.com');
        expect(p.to_name).toBe('Taneisha Clark');
        expect(p.customer_note).toBe('New prospect (no ShopWorks match)');
    });
});

describe('sendLeadEmail — never throws', () => {
    test('missing EmailJS env → resolved skip (lead save must not care)', async () => {
        const saved = {};
        ['EMAILJS_SERVICE_ID', 'EMAILJS_PUBLIC_KEY', 'EMAILJS_PRIVATE_KEY'].forEach((k) => {
            saved[k] = process.env[k];
            delete process.env[k];
        });
        try {
            const result = await sendLeadEmail({ record: { Submission_ID: 'JFL0718-0001', Sales_Rep: 'Nika Lao' } });
            expect(result).toEqual({ sent: false, skipped: 'missing-env' });
        } finally {
            Object.keys(saved).forEach((k) => { if (saved[k] !== undefined) process.env[k] = saved[k]; });
        }
    });
});
