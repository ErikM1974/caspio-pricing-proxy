/**
 * Regression test for buildDesigns() — the ShopWorks design-link logic (audit 2026-06-06).
 *   P2-10: the same design # on both garments and caps must link ONCE (was double-linked).
 *   P1-9 : a design # and uploaded artwork on the SAME surface must not push BOTH an {id_Design}
 *          and a duplicate {DesignName}; per-surface, a garment # covers garment artwork and a
 *          cap # covers cap artwork (the legitimate "garment # + new cap design" still works).
 */
const T = require('../../lib/embroidery-push-transformer');

const base = { QuoteID: 'EMB-T', CustomerName: 'T', id_Customer: 3739, TaxRate: 0 };
const ids = (d) => d.filter((x) => x && x.id_Design).map((x) => x.id_Design).sort((a, b) => a - b);
const names = (d) => d.filter((x) => x && x.DesignName).map((x) => x.DesignName);
const notes = (newDesignName, art) => JSON.stringify({ newDesignName, referenceArtwork: art });

describe('buildDesigns — dedup (P2-10) + branch mutual-exclusion (P1-9)', () => {
  test('P2-10: same design # on garment AND cap links exactly once', () => {
    expect(ids(T.buildDesigns({ ...base, GarmentDesignNumber: '12345', CapDesignNumber: '12345' }, []))).toEqual([12345]);
  });

  test('two different design #s link twice', () => {
    expect(ids(T.buildDesigns({ ...base, GarmentDesignNumber: '111', CapDesignNumber: '222' }, []))).toEqual([111, 222]);
  });

  test('non-numeric design # is ignored (no id_Design emitted)', () => {
    expect(ids(T.buildDesigns({ ...base, GarmentDesignNumber: 'ABC' }, []))).toEqual([]);
  });

  test('P1-9: garment design # + CAP artwork → garment id_Design + cap NEW design (no duplicate)', () => {
    const s = { ...base, GarmentDesignNumber: '500', ImportNotes: notes('Cap Logo', [{ hostedUrl: 'http://x/c.png', placement: 'Cap Front', fileName: 'c.png' }]) };
    const d = T.buildDesigns(s, []);
    expect(ids(d)).toEqual([500]);
    expect(names(d)).toEqual(['Cap Logo']);
  });

  test('P1-9: garment design # + GARMENT artwork → artwork dropped (the # covers it), no duplicate design', () => {
    const s = { ...base, GarmentDesignNumber: '500', ImportNotes: notes('Garment Logo', [{ hostedUrl: 'http://x/g.png', placement: 'Left Chest', fileName: 'g.png' }]) };
    const d = T.buildDesigns(s, []);
    expect(ids(d)).toEqual([500]);
    expect(names(d)).toEqual([]);
  });

  test('no design # + artwork → a NEW design, artwork preserved', () => {
    const s = { ...base, ImportNotes: notes('Fresh Logo', [{ hostedUrl: 'http://x/f.png', placement: 'Left Chest', fileName: 'f.png' }]) };
    const d = T.buildDesigns(s, []);
    expect(ids(d)).toEqual([]);
    expect(names(d)).toEqual(['Fresh Logo']);
  });
});
