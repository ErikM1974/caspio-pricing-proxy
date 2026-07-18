// lead-activity-validate.test.js — pure validators for the Lead_Activity
// timeline (src/utils/lead-activity-helpers.js). No network.
'use strict';

const {
  validateActivity,
  isAllowedAttachmentUrl,
  longText,
  TEXT_MAX,
} = require('../../src/utils/lead-activity-helpers');

const BASE = 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';

describe('isAllowedAttachmentUrl', () => {
  test('accepts proxy /api/files/ keys and JotForm uploads only', () => {
    expect(isAllowedAttachmentUrl(BASE + '/api/files/b2b2556b-8c75-4d92-b90c-0db55afe1a42', BASE)).toBe(true);
    expect(isAllowedAttachmentUrl('https://www.jotform.com/uploads/acct/1/2/a.jpg', BASE)).toBe(true);
    expect(isAllowedAttachmentUrl('https://files.jotform.com/x/y.png', BASE)).toBe(true);
  });
  test('rejects other hosts, path escapes, and empties', () => {
    expect(isAllowedAttachmentUrl('https://evil.com/api/files/abcdefgh', BASE)).toBe(false);
    expect(isAllowedAttachmentUrl(BASE + '/api/orders', BASE)).toBe(false);
    expect(isAllowedAttachmentUrl(BASE + '/api/files/../secrets', BASE)).toBe(false);
    expect(isAllowedAttachmentUrl('', BASE)).toBe(false);
  });
});

describe('validateActivity', () => {
  const good = {
    submissionId: 'JFL0718-9574',
    activityType: 'note',
    activityText: 'Called Jordan — wants 3 window decals, sending quote Friday.',
    createdBy: 'taneisha@nwcustomapparel.com',
  };

  test('accepts a valid note and shapes the record', () => {
    const { errors, record } = validateActivity(good, BASE);
    expect(errors).toEqual([]);
    expect(record).toMatchObject({
      Submission_ID: 'JFL0718-9574',
      Activity_Type: 'note',
      Created_By: 'taneisha@nwcustomapparel.com',
      Attachment_URL: '',
      Parent_PK: null,
    });
  });

  test('rejects bad type, missing id/author, and text-and-attachment both empty', () => {
    expect(validateActivity({ ...good, activityType: 'gossip' }, BASE).errors.join()).toMatch(/activityType/);
    expect(validateActivity({ ...good, submissionId: 'bad id!' }, BASE).errors.join()).toMatch(/submissionId/);
    expect(validateActivity({ ...good, createdBy: '' }, BASE).errors.join()).toMatch(/createdBy/);
    expect(validateActivity({ ...good, activityText: '', attachmentUrl: '' }, BASE).errors.join()).toMatch(/activityText or attachmentUrl/);
  });

  test('attachment-only activity is valid; disallowed URL is not', () => {
    const ok = validateActivity({ ...good, activityText: '', attachmentUrl: BASE + '/api/files/abcdef123456' }, BASE);
    expect(ok.errors).toEqual([]);
    const bad = validateActivity({ ...good, activityText: '', attachmentUrl: 'https://evil.com/x.png' }, BASE);
    expect(bad.errors.join()).toMatch(/attachmentUrl/);
  });

  test('long notes survive far past 255 chars (TEXT column, long-cap only)', () => {
    const note = 'x'.repeat(5000);
    const { errors, record } = validateActivity({ ...good, activityText: note }, BASE);
    expect(errors).toEqual([]);
    expect(record.Activity_Text).toHaveLength(5000);
    expect(longText('y'.repeat(TEXT_MAX + 50))).toHaveLength(TEXT_MAX);
  });
});
