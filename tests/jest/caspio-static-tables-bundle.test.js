/**
 * Method-keyed caching for the /api/pricing-bundle lookup tables
 * (2026-09-05 Caspio quota reduction).
 *
 * WHY THIS FILE EXISTS: the bundle caches its response on {method, styleNumber},
 * but tiers / rules / location / cost-table vary by METHOD ALONE. Browsing a
 * second style in the same method re-fetched ~9 identical calls to get 1 new one;
 * Embroidery_Costs alone is ~6 pages and was the largest table on the account.
 *
 * 🔴 THE RISK THIS LOCKS DOWN: a cache key coarser than its query serves ANOTHER
 * METHOD'S PRICES. That is a silent wrong price — the worst failure mode in this
 * repo — so the key-isolation tests below matter more than the saving tests.
 */

jest.mock('../../src/utils/caspio', () => ({ fetchAllCaspioPages: jest.fn() }));

const { fetchAllCaspioPages } = require('../../src/utils/caspio');
const st = require('../../src/utils/caspio-static-tables');

/** Return rows tagged with the query that produced them, so a key collision is visible. */
function echoRows() {
  fetchAllCaspioPages.mockImplementation(async (resource, params) => [
    { _resource: resource, _where: (params && params['q.where']) || null }
  ]);
}
const whereOf = rows => rows[0]._where;
const resourceOf = rows => rows[0]._resource;

beforeEach(() => {
  jest.clearAllMocks();
  st.clearStaticTableCaches();
  echoRows();
});

describe('key isolation — the silent-wrong-price guard', () => {
  test('two decoration methods never share a tier cache entry', async () => {
    const emb = await st.getPricingTierRows('EmbroideryShirts');
    const dtg = await st.getPricingTierRows('DTG');
    expect(whereOf(emb)).toBe("DecorationMethod='EmbroideryShirts'");
    expect(whereOf(dtg)).toBe("DecorationMethod='DTG'");
    expect(fetchAllCaspioPages).toHaveBeenCalledTimes(2); // no false hit
  });

  test('EMB and CAP get DIFFERENT embroidery cost rows, not one shared set', async () => {
    const emb = await st.getCostTableRows('EMB');
    const cap = await st.getCostTableRows('CAP');
    // Same table, different ItemType filter — the exact collision that would
    // price a cap off garment costs.
    expect(resourceOf(emb)).toBe('/tables/Embroidery_Costs/records');
    expect(resourceOf(cap)).toBe('/tables/Embroidery_Costs/records');
    expect(whereOf(emb)).toBe("ItemType='Shirt' OR ItemType='AS-Garm' OR ItemType='AS-Cap'");
    expect(whereOf(cap)).toBe("ItemType='Cap'");
  });

  test('all six Embroidery_Costs variants stay distinct', async () => {
    const seen = {};
    for (const m of ['EMB', 'CAP', 'EMB-AL', 'CAP-AL', 'PATCH', 'CAP-PUFF']) {
      seen[m] = whereOf(await st.getCostTableRows(m));
    }
    expect(new Set(Object.values(seen)).size).toBe(6);
  });

  test('location types do not collide', async () => {
    expect(whereOf(await st.getLocationRows('Embroidery'))).toBe("Type='Embroidery'");
    expect(whereOf(await st.getLocationRows('DTG'))).toBe("Type='DTG'");
  });
});

describe('the mapping is verbatim from the old switch', () => {
  const EXPECTED = {
    'DTG':         ['/tables/DTG_Costs/records', null],
    'EMB':         ['/tables/Embroidery_Costs/records', "ItemType='Shirt' OR ItemType='AS-Garm' OR ItemType='AS-Cap'"],
    'CAP':         ['/tables/Embroidery_Costs/records', "ItemType='Cap'"],
    'EMB-AL':      ['/tables/Embroidery_Costs/records', "ItemType='AL'"],
    'CAP-AL':      ['/tables/Embroidery_Costs/records', "ItemType='AL-CAP'"],
    'ScreenPrint': ['/tables/Screenprint_Costs/records', null],
    'DTF':         ['/tables/DTF_Pricing/records', null],
    'PATCH':       ['/tables/Embroidery_Costs/records', "ItemType='Patch'"],
    'CAP-PUFF':    ['/tables/Embroidery_Costs/records', "ItemType='Cap' OR ItemType='3D-Puff'"]
  };
  test.each(Object.entries(EXPECTED))('%s hits the same table and filter as before', async (m, [res, where]) => {
    const rows = await st.getCostTableRows(m);
    expect(resourceOf(rows)).toBe(res);
    expect(whereOf(rows)).toBe(where);
  });

  test('BLANK resolves [] without touching Caspio', async () => {
    await expect(st.getCostTableRows('BLANK')).resolves.toEqual([]);
    expect(fetchAllCaspioPages).not.toHaveBeenCalled();
  });

  // The route's switch had NO default. Returning [] instead would price a bundle
  // off an empty cost table — a silent wrong price rather than a loud failure.
  test('an unknown method yields undefined, NOT an empty array', async () => {
    await expect(st.getCostTableRows('NOPE')).resolves.toBeUndefined();
    expect(fetchAllCaspioPages).not.toHaveBeenCalled();
  });
});

describe('the saving', () => {
  test('a second style in the same method costs ZERO extra calls', async () => {
    // What the bundle does per style, minus the style-specific Sanmar read.
    const perStyle = () => Promise.all([
      st.getPricingTierRows('EmbroideryShirts'),
      st.getPricingRuleRows('EMB'),
      st.getLocationRows('Embroidery'),
      st.getCostTableRows('EMB')
    ]);
    await perStyle();
    expect(fetchAllCaspioPages).toHaveBeenCalledTimes(4);
    await perStyle();
    await perStyle();
    expect(fetchAllCaspioPages).toHaveBeenCalledTimes(4); // 8 avoided
  });

  test('force:true bypasses the cache so ?refresh=true still works', async () => {
    await st.getPricingTierRows('DTG');
    await st.getPricingTierRows('DTG');
    expect(fetchAllCaspioPages).toHaveBeenCalledTimes(1);
    await st.getPricingTierRows('DTG', { force: true });
    expect(fetchAllCaspioPages).toHaveBeenCalledTimes(2);
  });

  test('an EMPTY read is never pinned — a blank price table must not stick', async () => {
    fetchAllCaspioPages.mockResolvedValue([]);
    await st.getCostTableRows('EMB');
    await st.getCostTableRows('EMB');
    expect(fetchAllCaspioPages).toHaveBeenCalledTimes(2);
  });

  test('a cold-cache failure propagates so the route keeps its own catch', async () => {
    fetchAllCaspioPages.mockRejectedValue(new Error('Caspio 500'));
    await expect(st.getPricingTierRows('EMB')).rejects.toThrow('Caspio 500');
  });

  test('clearStaticTableCaches empties the bundle cache and reports its size', async () => {
    await st.getPricingTierRows('DTG');
    expect(st.clearStaticTableCaches()['pricing-bundle-tables']).toBe(1);
    await st.getPricingTierRows('DTG');
    expect(fetchAllCaspioPages).toHaveBeenCalledTimes(2);
  });
});
