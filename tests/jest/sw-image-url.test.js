/**
 * sw-image-url — P2 lock (2026-07-10).
 *
 * OnSite silently drops >2MB images and can't type extension-less URLs
 * (MANAGEORDERS_COMPLETE_REFERENCE §13; reproduced on order 142409). Every
 * push transformer now routes OUR /api/files/<key> URLs through the /sw.jpg
 * variant; external URLs pass through untouched.
 */
const { swImageUrl, artworkAttachments } = require('../../lib/sw-image-url');

describe('swImageUrl', () => {
  test('rewrites our own /api/files/<key> URLs to the /sw.jpg variant', () => {
    expect(swImageUrl('https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/files/8b0239d0-0cd1-4f8a-a024-22bdf17bc7e8'))
      .toBe('https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/files/8b0239d0-0cd1-4f8a-a024-22bdf17bc7e8/sw.jpg');
    expect(swImageUrl('http://localhost:3002/api/files/abc12345'))
      .toBe('http://localhost:3002/api/files/abc12345/sw.jpg');
  });

  test('passes external / already-suffixed / empty URLs through untouched', () => {
    expect(swImageUrl('https://example.com/logo.png')).toBe('https://example.com/logo.png');
    expect(swImageUrl('https://x.test/api/files/abc12345/sw.jpg')).toBe('https://x.test/api/files/abc12345/sw.jpg');
    expect(swImageUrl('')).toBe('');
    expect(swImageUrl(null)).toBe('');
  });
});

describe('artworkAttachments', () => {
  test('maps hosted files to SW Attachments entries (sw.jpg URLs, Link=0)', () => {
    const atts = artworkAttachments([
      { hostedUrl: 'https://h.test/api/files/deadbeef-1234', fileName: 'Patriot Metal Caps.jpg', placement: 'Left Chest' },
      { hostedUrl: '', fileName: 'skipped.png' },
      null,
    ]);
    expect(atts).toEqual([{
      MediaURL: 'https://h.test/api/files/deadbeef-1234/sw.jpg',
      MediaName: 'Patriot Metal Caps.jpg',
      LinkURL: '',
      LinkNote: 'Placement: Left Chest',
      Link: 0,
    }]);
  });

  test('tolerates missing/non-array input', () => {
    expect(artworkAttachments(undefined)).toEqual([]);
  });
});
