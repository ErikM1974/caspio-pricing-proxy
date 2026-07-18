// lead-outreach.test.js — pure coverage for the AE outreach template builder.
'use strict';

const { buildOutreach, TEMPLATE_KEYS } = require('../../src/utils/lead-outreach-templates');

describe('buildOutreach', () => {
  const ctx = { contactName: 'Jordan Hibbard', company: 'NW Equipment', aeName: 'Taneisha Clark' };

  test('all template keys build subject + body + label', () => {
    expect(TEMPLATE_KEYS).toEqual(['intro', 'quote-followup', 'checking-in', 'won-thanks']);
    TEMPLATE_KEYS.forEach((k) => {
      const b = buildOutreach(k, ctx);
      expect(b.label).toBeTruthy();
      expect(b.subject.length).toBeGreaterThan(10);
      expect(b.bodyHtml).toContain('Jordan');
      expect(b.bodyHtml).toContain('Taneisha Clark');
      expect(b.bodyHtml).toContain('Northwest Custom Apparel');
    });
  });

  test('unknown template → null; blank name → "there"', () => {
    expect(buildOutreach('spam-blast', ctx)).toBeNull();
    expect(buildOutreach('intro', { aeName: 'Nika' }).bodyHtml).toContain('Hi there,');
  });

  test('lead-supplied values are HTML-escaped', () => {
    const b = buildOutreach('intro', { contactName: '<img src=x>', company: '<b>Evil&Co</b>', aeName: 'Nika Lao' });
    expect(b.bodyHtml).not.toContain('<img');
    expect(b.bodyHtml).not.toContain('<b>Evil');
    expect(b.bodyHtml).toContain('&lt;img');
    expect(b.subject).not.toContain('<b>');
  });
});
