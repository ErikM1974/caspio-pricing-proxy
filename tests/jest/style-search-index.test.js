/**
 * style-search-index.test.js — lock for the in-memory catalog search index
 * that replaced the five-column LIKE scan in /api/products/search?q=
 * (2026-08-25: uncached terms cost 10-22s; index answers in ~2ms).
 *
 * Locks the two things that must never drift:
 *   1. MATCH SEMANTICS — one case-insensitive phrase across the same five
 *      fields the LIKE clause searched (style, title, brand, keywords,
 *      description). A term that only appears in the description MUST match.
 *   2. RANKING + CAP — exact style beats prefix beats title beats brand
 *      beats keyword/description, capped at MAX_MATCHES (Caspio IN()/URL
 *      limits). The route turns [] into STYLE='__NO_MATCH__', never an
 *      unfiltered query.
 */

const { buildIndex, searchIndex, MAX_MATCHES, getStyleSearchIndex, _resetCacheForTests } =
  require('../../src/utils/style-search-index');

const rows = [
  { STYLE: 'PC54', PRODUCT_TITLE: 'Port & Company Core Cotton Tee', BRAND_NAME: 'Port & Company', KEYWORDS: 'tee tshirt', PRODUCT_DESCRIPTION: 'A classic cotton tee.' },
  { STYLE: 'PC54DTG', PRODUCT_TITLE: 'Core Cotton DTG Tee', BRAND_NAME: 'Port & Company', KEYWORDS: '', PRODUCT_DESCRIPTION: '' },
  { STYLE: 'F170', PRODUCT_TITLE: 'Heavyweight Full-Zip Hoodie', BRAND_NAME: 'Hanes', KEYWORDS: 'fleece', PRODUCT_DESCRIPTION: 'Warm hooded sweatshirt.' },
  { STYLE: 'K500', PRODUCT_TITLE: 'Silk Touch Polo', BRAND_NAME: 'Port Authority', KEYWORDS: 'golf shirt', PRODUCT_DESCRIPTION: 'Pique polo for crews.' },
  { STYLE: 'NKDC1963', PRODUCT_TITLE: 'Dri-FIT Micro Pique 2.0 Polo', BRAND_NAME: 'Nike', KEYWORDS: '', PRODUCT_DESCRIPTION: 'Moisture-wicking.' },
  // description-only match for "moisture" lives on NKDC1963 above
];

describe('buildIndex', () => {
  test('dedupes to one entry per STYLE, concatenating grouped variants', () => {
    const idx = buildIndex([
      { STYLE: 'X1', PRODUCT_TITLE: 'Alpha', BRAND_NAME: 'B', KEYWORDS: 'red', PRODUCT_DESCRIPTION: '' },
      { STYLE: 'X1', PRODUCT_TITLE: 'Alpha', BRAND_NAME: 'B', KEYWORDS: 'blue', PRODUCT_DESCRIPTION: '' },
    ]);
    expect(idx).toHaveLength(1);
    expect(idx[0].hay).toContain('red');
    expect(idx[0].hay).toContain('blue');
  });

  test('rows with a blank STYLE are dropped', () => {
    expect(buildIndex([{ STYLE: ' ', PRODUCT_TITLE: 'ghost' }])).toHaveLength(0);
  });
});

describe('searchIndex — LIKE-parity semantics', () => {
  const idx = buildIndex(rows);

  test('matches are case-insensitive phrase matches', () => {
    expect(searchIndex(idx, 'HOODIE')).toEqual(['F170']);
    expect(searchIndex(idx, 'full-zip hood')).toEqual(['F170']);
  });

  test('a description-only term still matches (LIKE searched description too)', () => {
    expect(searchIndex(idx, 'moisture')).toEqual(['NKDC1963']);
  });

  test('a keywords-only term still matches', () => {
    expect(searchIndex(idx, 'golf')).toEqual(['K500']);
  });

  test('exact style outranks style-prefix outranks title/brand hits', () => {
    const res = searchIndex(idx, 'pc54');
    expect(res[0]).toBe('PC54');       // exact
    expect(res[1]).toBe('PC54DTG');    // prefix
  });

  test('brand search finds every style of the brand', () => {
    expect(searchIndex(idx, 'port & company').sort()).toEqual(['PC54', 'PC54DTG']);
  });

  test('no match → empty array (route maps this to a NO_MATCH clause, never unfiltered)', () => {
    expect(searchIndex(idx, 'zzzznothing')).toEqual([]);
    expect(searchIndex(idx, '   ')).toEqual([]);
  });

  test('results are capped at MAX_MATCHES', () => {
    const many = buildIndex(Array.from({ length: MAX_MATCHES + 50 }, (_, i) =>
      ({ STYLE: 'S' + String(i).padStart(4, '0'), PRODUCT_TITLE: 'common tee', BRAND_NAME: '', KEYWORDS: '', PRODUCT_DESCRIPTION: '' })));
    expect(searchIndex(many, 'common').length).toBe(MAX_MATCHES);
  });
});

describe('getStyleSearchIndex — cache behavior', () => {
  beforeEach(() => _resetCacheForTests());

  test('builds once, serves from cache on the second call', async () => {
    let calls = 0;
    const fetcher = async () => { calls++; return rows; };
    const a = await getStyleSearchIndex(fetcher);
    const b = await getStyleSearchIndex(fetcher);
    expect(calls).toBe(1);
    expect(a).toBe(b);
    expect(a.length).toBe(5);
  });

  test('a failed build does not poison the cache — next call retries', async () => {
    let calls = 0;
    const failing = async () => { calls++; throw new Error('caspio down'); };
    await expect(getStyleSearchIndex(failing)).rejects.toThrow('caspio down');
    const ok = async () => rows;
    const idx = await getStyleSearchIndex(ok);
    expect(idx.length).toBe(5);
    expect(calls).toBe(1);
  });
});

describe('warmOnBoot', () => {
  beforeEach(() => _resetCacheForTests());
  const { warmOnBoot } = require('../../src/utils/style-search-index');

  test('no-ops under jest (JEST_WORKER_ID) so tests never fire live fetches', () => {
    expect(warmOnBoot(async () => { throw new Error('must not be called'); })).toBeNull();
  });

  test('schedules the build when enabled, and the timer is unref-ed (never holds the process open)', () => {
    const saved = process.env.JEST_WORKER_ID;
    delete process.env.JEST_WORKER_ID;
    jest.useFakeTimers();
    let calls = 0;
    const timer = warmOnBoot(async () => { calls++; return []; });
    expect(timer).not.toBeNull();
    expect(calls).toBe(0);           // jittered delay — nothing fires synchronously
    jest.advanceTimersByTime(61000); // past max jitter (20-60s)
    expect(calls).toBe(1);
    jest.useRealTimers();
    process.env.JEST_WORKER_ID = saved;
  });
});
