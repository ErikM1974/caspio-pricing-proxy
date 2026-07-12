// blog-post-helpers.test.js — slug + validation contract for the blog API.
// Pure helpers module (no utils/caspio import) so jest exits cleanly.
'use strict';
const { slugify, validSlug, validatePost, toRecord, toApi, MAX_BODY } = require('../../src/utils/blog-post-helpers');

describe('slugify — titles become URL-safe permanent slugs', () => {
  test.each([
    ['How to Choose: Embroidery vs. Screen Printing?', 'how-to-choose-embroidery-vs-screen-printing'],
    ["  Erik's 2026 Cap Guide!  ", 'eriks-2026-cap-guide'],
    ['DTF — what it is & when to use it', 'dtf-what-it-is-when-to-use-it'],
  ])('%s → %s', (title, expected) => {
    expect(slugify(title)).toBe(expected);
    expect(validSlug(slugify(title))).toBe(true);
  });

  test('validSlug rejects path tricks and junk', () => {
    ['', 'ab', '../etc', 'UPPER', 'has space', 'trailing-', '-leading', 'a'.repeat(81)].forEach((bad) => {
      expect(validSlug(bad)).toBe(false);
    });
  });
});

describe('validatePost — API contract', () => {
  test('create requires slug + title; status enum enforced; body capped', () => {
    expect(validatePost({ slug: 'hello-world', title: 'Hello' })).toEqual([]);
    expect(validatePost({ slug: 'x', title: '' }).length).toBe(2);
    expect(validatePost({ slug: 'ok-slug', title: 'T', status: 'Live' }).length).toBe(1);
    expect(validatePost({ slug: 'ok-slug', title: 'T', bodyMarkdown: 'x'.repeat(MAX_BODY + 1) }).length).toBe(1);
  });

  test('update (requireAll:false) validates only provided fields', () => {
    expect(validatePost({ status: 'Published' }, { requireAll: false })).toEqual([]);
    expect(validatePost({ status: 'Nope' }, { requireAll: false }).length).toBe(1);
  });
});

describe('record mapping', () => {
  test('round-trips the API shape and normalizes Featured', () => {
    const rec = toRecord({ slug: 's-l-u-g', title: 'T', featured: true, status: 'Draft' });
    expect(rec).toMatchObject({ Post_ID: 's-l-u-g', Title: 'T', Featured: 'Yes', Status: 'Draft' });
    const api = toApi({ Post_ID: 's', Title: 'T', Status: 'Published', Featured: 'No', Body_Markdown: '# hi' });
    expect(api.slug).toBe('s');
    expect(api.bodyMarkdown).toBe('# hi');
    expect(toApi({ Post_ID: 's' }, { includeBody: false }).bodyMarkdown).toBeUndefined();
  });
});
