// Library rep-join + filter helpers — pure functions, no network.
// The /finished-photos/library endpoint tags each photo with the account's rep
// (Sales_Reps_2026) and filters by ?rep= / ?idCustomer=; this locks that logic.
const {
  attachRepNames,
  applyLibraryFilters,
  repSummary,
  chunkArray,
} = require('../../src/routes/finished-photos');

const photos = attachRepNames(
  [
    { pkId: 1, idCustomer: '100', companyName: 'Archterra Landscaping' },
    { pkId: 2, idCustomer: '100', companyName: 'Archterra Landscaping' },
    { pkId: 3, idCustomer: '200', companyName: 'Milton Coffee' },
    { pkId: 4, idCustomer: '300', companyName: 'No-Rep Co' },
  ],
  new Map([
    ['100', 'Taneisha Clark'],
    ['200', 'Nika Lao'],
  ])
);

describe('finished-photos library helpers', () => {
  test('attachRepNames maps id_Customer → rep, blank when unassigned', () => {
    expect(photos[0].repName).toBe('Taneisha Clark');
    expect(photos[2].repName).toBe('Nika Lao');
    expect(photos[3].repName).toBe(''); // house/unassigned
  });

  test('rep filter is exact full-name, case-insensitive', () => {
    expect(applyLibraryFilters(photos, { rep: 'Taneisha Clark' }).length).toBe(2);
    expect(applyLibraryFilters(photos, { rep: 'taneisha clark' }).length).toBe(2);
    // First-name-only must NOT match (rep-name shapes lesson 2026-07-19):
    // silent partial matching is how the "Taneisha Jones" class of bug hides.
    expect(applyLibraryFilters(photos, { rep: 'Taneisha' }).length).toBe(0);
  });

  test('rep=house returns only unassigned accounts', () => {
    const house = applyLibraryFilters(photos, { rep: 'house' });
    expect(house.map((p) => p.pkId)).toEqual([4]);
    expect(applyLibraryFilters(photos, { rep: 'unassigned' }).length).toBe(1);
  });

  test('idCustomer filter composes with rep filter', () => {
    expect(applyLibraryFilters(photos, { idCustomer: '100' }).length).toBe(2);
    expect(applyLibraryFilters(photos, { rep: 'Nika Lao', idCustomer: '100' }).length).toBe(0);
  });

  test('no filters → everything back untouched', () => {
    expect(applyLibraryFilters(photos, {})).toHaveLength(4);
    expect(applyLibraryFilters(photos)).toHaveLength(4);
  });

  test('repSummary counts per rep with house bucket, biggest first', () => {
    expect(repSummary(photos)).toEqual([
      { name: 'Taneisha Clark', count: 2 },
      { name: 'Nika Lao', count: 1 },
      { name: 'House / Unassigned', count: 1 },
    ]);
  });

  test('chunkArray splits for the IN-clause lookups', () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunkArray([], 50)).toEqual([]);
  });
});
