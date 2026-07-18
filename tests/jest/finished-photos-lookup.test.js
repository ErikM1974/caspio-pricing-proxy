// parseScanCode — the capture page feeds it raw barcode reads (Code 39 keeps its * sentinels
// on some readers) and hand-typed numbers. Pure function, no network.
const { parseScanCode } = require('../../src/routes/finished-photos');

describe('finished-photos parseScanCode', () => {
  test('plain order number', () => {
    expect(parseScanCode('142476')).toEqual({ num: '142476', isDesign: false });
  });

  test('design-sheet code with Loc suffix', () => {
    expect(parseScanCode('40121Loc1')).toEqual({ num: '40121', isDesign: true });
  });

  test('case-insensitive Loc + Code 39 sentinels + stray whitespace', () => {
    expect(parseScanCode('*40121LOC1*')).toEqual({ num: '40121', isDesign: true });
    expect(parseScanCode(' 142476 ')).toEqual({ num: '142476', isDesign: false });
    expect(parseScanCode('*142476*')).toEqual({ num: '142476', isDesign: false });
  });

  test('ShopWorks alpha prefixes — the footer barcode encodes "Ord<order#>"', () => {
    expect(parseScanCode('Ord142476')).toEqual({ num: '142476', isDesign: false });
    expect(parseScanCode('ORD142476')).toEqual({ num: '142476', isDesign: false });
    expect(parseScanCode('*Ord142476*')).toEqual({ num: '142476', isDesign: false });
    expect(parseScanCode('Order142476')).toEqual({ num: '142476', isDesign: false });
    expect(parseScanCode('WO142476')).toEqual({ num: '142476', isDesign: false });
    expect(parseScanCode('Des40121')).toEqual({ num: '40121', isDesign: true });
    expect(parseScanCode('Ord40121Loc1')).toEqual({ num: '40121', isDesign: true });
  });

  test('rejects non-numeric / empty / junk', () => {
    expect(parseScanCode('')).toBeNull();
    expect(parseScanCode(null)).toBeNull();
    expect(parseScanCode('PC54')).toBeNull();
    expect(parseScanCode('142476; DROP TABLE')).toBeNull();
    expect(parseScanCode('12345678901')).toBeNull(); // > 10 digits
  });

  test('Loc suffix without digits after it still resolves the design number', () => {
    expect(parseScanCode('40121Loc')).toEqual({ num: '40121', isDesign: true });
  });
});
