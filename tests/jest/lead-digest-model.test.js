// lead-digest-model.test.js — pure-function coverage for the Leads CRM
// follow-up digest (src/utils/lead-followup-digest.js). No Caspio/EmailJS.
'use strict';

const {
  buildDigestModel,
  groupModelByAE,
  TERMINAL_STATUSES,
  __test__,
} = require('../../src/utils/lead-followup-digest');

const TODAY = '2026-07-18';
const NOW = Date.parse('2026-07-18T15:00:00Z');

function lead(overrides) {
  return {
    Submission_ID: 'JFL0718-0001',
    Form_ID: 'jotform-lead',
    Company: 'Acme Co',
    Contact_Name: 'Road Runner',
    Sales_Rep: 'Taneisha Clark',
    Status: 'Contacted',
    Due_Date: '',
    Lead_Value: '',
    Submitted_At: '2026-07-10T12:00:00.000Z',
    ...overrides,
  };
}

describe('buildDigestModel — bucketing', () => {
  test('overdue / due today / future split on Due_Date', () => {
    const m = buildDigestModel([
      lead({ Submission_ID: 'A', Due_Date: '2026-07-15' }),
      lead({ Submission_ID: 'B', Due_Date: '2026-07-18' }),
      lead({ Submission_ID: 'C', Due_Date: '2026-07-25' }),
    ], TODAY, NOW);
    expect(m.overdue.map((r) => r.Submission_ID)).toEqual(['A']);
    expect(m.overdue[0].daysOverdue).toBe(3);
    expect(m.dueToday.map((r) => r.Submission_ID)).toEqual(['B']);
    expect(m.newUntouched).toHaveLength(0); // C has a future date — not "untouched"
  });

  test('overdue sorts oldest-first', () => {
    const m = buildDigestModel([
      lead({ Submission_ID: 'newer', Due_Date: '2026-07-17' }),
      lead({ Submission_ID: 'older', Due_Date: '2026-07-01' }),
    ], TODAY, NOW);
    expect(m.overdue.map((r) => r.Submission_ID)).toEqual(['older', 'newer']);
  });

  test('terminal statuses are excluded even when overdue', () => {
    TERMINAL_STATUSES.forEach((status) => {
      const m = buildDigestModel([lead({ Status: status, Due_Date: '2026-07-01' })], TODAY, NOW);
      expect(m.overdue).toHaveLength(0);
    });
  });

  test('new & untouched: New, no Due_Date, older than 48h, within 60 days', () => {
    const m = buildDigestModel([
      lead({ Submission_ID: 'fresh', Status: 'New', Submitted_At: '2026-07-18T10:00:00.000Z' }), // ~5h — too fresh
      lead({ Submission_ID: 'ripe', Status: 'New', Submitted_At: '2026-07-14T12:00:00.000Z' }),  // 4d — in
      lead({ Submission_ID: 'ancient', Status: 'New', Submitted_At: '2023-03-01T12:00:00.000Z' }), // backfill — out
      lead({ Submission_ID: 'worked', Status: 'Contacted', Submitted_At: '2026-07-14T12:00:00.000Z' }), // not New
    ], TODAY, NOW);
    expect(m.newUntouched.map((r) => r.Submission_ID)).toEqual(['ripe']);
  });

  test('non-lead Form_IDs and garbage dates are ignored', () => {
    const m = buildDigestModel([
      lead({ Form_ID: 'pto-request', Due_Date: '2026-07-01' }),
      lead({ Due_Date: 'not-a-date', Status: 'New', Submitted_At: 'garbage' }),
    ], TODAY, NOW);
    expect(m.overdue).toHaveLength(0);
    expect(m.newUntouched).toHaveLength(0);
  });
});

describe('groupModelByAE', () => {
  test('groups by loose-resolved rep (full display names) and buckets unresolvable', () => {
    const model = buildDigestModel([
      lead({ Submission_ID: 'T1', Due_Date: '2026-07-15', Sales_Rep: 'Taneisha Clark' }),
      lead({ Submission_ID: 'J1', Due_Date: '2026-07-18', Sales_Rep: 'Jim Mickelson' }),
      lead({ Submission_ID: 'X1', Due_Date: '2026-07-15', Sales_Rep: 'Somebody Unknown' }),
    ], TODAY, NOW);
    const { groups, unassigned } = groupModelByAE(model);
    const byEmail = Object.fromEntries(groups.map((g) => [g.aeEmail, g]));
    expect(byEmail['taneisha@nwcustomapparel.com'].overdue.map((r) => r.Submission_ID)).toEqual(['T1']);
    expect(byEmail['jim@nwcustomapparel.com'].dueToday.map((r) => r.Submission_ID)).toEqual(['J1']);
    expect(unassigned.map((u) => u.row.Submission_ID)).toEqual(['X1']);
  });
});

describe('section html', () => {
  test('empty section renders empty string; links are #hash (no "=")', () => {
    expect(__test__.buildSectionHtml('Overdue', '🔴', 'overdue', [])).toBe('');
    const html = __test__.buildSectionHtml('Overdue', '🔴', 'overdue',
      [lead({ Submission_ID: 'JFL0715-1', Due_Date: '2026-07-15', daysOverdue: 3 })]);
    expect(html).toContain('/dashboards/lead.html#JFL0715-1');
    const hrefs = html.match(/href="([^"]+)"/g) || [];
    expect(hrefs.length).toBeGreaterThan(0);
    hrefs.forEach((h) => {
      const url = h.slice(6, -1); // strip href=" and trailing quote
      expect(url).not.toContain('='); // quoted-printable mangles '=' in emails
    });
  });

  test('caps at 15 with an "and N more" line; escapes lead data', () => {
    const rows = Array.from({ length: 18 }, (_, i) =>
      lead({ Submission_ID: 'L' + i, Due_Date: '2026-07-15', daysOverdue: 3, Company: '<b>Evil</b>' }));
    const html = __test__.buildRowsHtml('overdue', rows);
    expect(html).toContain('and 3 more');
    expect(html).not.toContain('<b>Evil</b>');
    expect(html).toContain('&lt;b&gt;Evil&lt;/b&gt;');
  });
});
