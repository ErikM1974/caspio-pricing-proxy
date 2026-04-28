/**
 * Unit tests for synthesizeFilesFromLegacy — pins the legacy-column-to-files[]
 * contract that frontend renderers depend on.
 *
 * Pure-function test: no Caspio, no Box, no Express. Calls the helper
 * directly via the property attached to the router export.
 *
 * Pass `proxyBase: null` (or omit opts) so resolveBoxThumbnail short-circuits
 * to null without hitting Box. The Box-resolution path is exercised in the
 * smoke verification step (live curl against /api/transfer-orders/:id).
 */
const router = require('../../src/routes/transfer-orders');
const { synthesizeFilesFromLegacy } = router;

describe('synthesizeFilesFromLegacy', () => {
  test('returns [] for null record', async () => {
    const out = await synthesizeFilesFromLegacy(null);
    expect(out).toEqual([]);
  });

  test('returns [] for record with no file columns', async () => {
    const out = await synthesizeFilesFromLegacy({ ID_Transfer: 'ST-X', Status: 'Requested' });
    expect(out).toEqual([]);
  });

  test('Working_File_URL only → 1 row, type=working, _synthesized:true', async () => {
    const out = await synthesizeFilesFromLegacy({
      Working_File_URL: 'https://box.com/s/abc',
      Working_File_Name: 'transfer.ai',
      Working_File_Type: 'application/postscript',
      Box_File_ID: '123'
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      File_Order: 1,
      File_Type: 'working',
      File_URL: 'https://box.com/s/abc',
      File_Name: 'transfer.ai',
      File_MIME: 'application/postscript',
      Box_File_ID: '123',
      _synthesized: true
    });
    expect(out[0].Thumbnail_URL).toBeNull();
  });

  test('Working + Additional_File_1 → working + mockup in that order', async () => {
    const out = await synthesizeFilesFromLegacy({
      Working_File_URL: 'https://box.com/s/working',
      Additional_File_1_URL: 'https://box.com/s/mockup',
      Additional_File_1_Name: 'mock.jpg'
    });
    expect(out).toHaveLength(2);
    expect(out[0].File_Type).toBe('working');
    expect(out[0].File_Order).toBe(1);
    expect(out[1].File_Type).toBe('mockup');
    expect(out[1].File_Order).toBe(2);
    expect(out[1].File_URL).toBe('https://box.com/s/mockup');
    expect(out[1].File_Name).toBe('mock.jpg');
    expect(out.every(f => f._synthesized === true)).toBe(true);
  });

  test('all 3 legacy slots → working, mockup, reference in order', async () => {
    const out = await synthesizeFilesFromLegacy({
      Working_File_URL: 'https://box.com/s/w',
      Working_File_Name: 'w.ai',
      Additional_File_1_URL: 'https://box.com/s/m',
      Additional_File_1_Name: 'm.jpg',
      Additional_File_2_URL: 'https://box.com/s/r',
      Additional_File_2_Name: 'r.png'
    });
    expect(out).toHaveLength(3);
    expect(out.map(f => f.File_Type)).toEqual(['working', 'mockup', 'reference']);
    expect(out.map(f => f.File_Order)).toEqual([1, 2, 3]);
    expect(out.map(f => f.File_Name)).toEqual(['w.ai', 'm.jpg', 'r.png']);
  });

  test('Additional_File_1 only (no working) → still emits mockup at File_Order 1', async () => {
    // Edge case: legacy row that somehow only has the mockup column.
    // Order should sequence from 1, not skip slots.
    const out = await synthesizeFilesFromLegacy({
      Additional_File_1_URL: 'https://box.com/s/m',
      Additional_File_1_Name: 'm.jpg'
    });
    expect(out).toHaveLength(1);
    expect(out[0].File_Order).toBe(1);
    expect(out[0].File_Type).toBe('mockup');
  });

  test('skips Thumbnail_URL resolution when proxyBase is null', async () => {
    // Sanity check: passing opts without proxyBase MUST NOT make Box calls.
    // (If it did, this test would hang on the network or throw without env vars.)
    const out = await synthesizeFilesFromLegacy(
      { Additional_File_1_URL: 'https://box.com/s/abc' },
      { proxyBase: null, cache: new Map() }
    );
    expect(out).toHaveLength(1);
    expect(out[0].Thumbnail_URL).toBeNull();
  });
});
