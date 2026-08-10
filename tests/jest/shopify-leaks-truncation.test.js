// The truncation bug, locked shut.
//
// findLeaks() reads a landing-page list and reports which products got no traffic. The
// first version was fed a list capped at 60 rows. Over 90 days that cap fell at 25
// sessions, so 38 of 47 products were simply not in the data — and their absence was
// reported to the business as "38 live designs got no traffic at all". Every one of them
// had traffic.
//
// The same truncation also inflated the headline: products missing from the list were not
// counted as reaching a live page, so "76% of product traffic is broken" was really 58%.
//
// Two properties keep it dead:
//   1. absence from a TRUNCATED list is never reported as zero
//   2. a cohort of products sharing one identical session count is reported as a crawler
//      floor, not as interest

const { findLeaks } = require('../../src/utils/shopify-metrics');

const products = [];
for (let i = 1; i <= 47; i++) {
    products.push({ handle: 'design-' + i, title: 'Design ' + i, status: 'ACTIVE' });
}

/** Realistic shape: a few popular pages, then a long flat crawler floor at 15. */
function landingRows({ upTo }) {
    const rows = [];
    const busy = [68, 59, 36, 36, 34, 33, 31, 30, 30, 23];
    busy.forEach((n, i) => rows.push(['/products/design-' + (i + 1), String(n)]));
    for (let i = busy.length; i < 47; i++) rows.push(['/products/design-' + (i + 1), '15']);
    rows.sort((a, b) => Number(b[1]) - Number(a[1]));
    return upTo ? rows.slice(0, upTo) : rows;
}

describe('a truncated landing-page list is never read as zero traffic', () => {
    test('THE BUG: capping the list must not invent products with no traffic', () => {
        const rows = landingRows({ upTo: 12 });          // stands in for LIMIT 60
        const leaks = findLeaks({
            landingRows: rows, products, redirects: [], salesByTitle: {},
            truncated: true, lowestSessions: Number(rows[rows.length - 1][1])
        });

        // The regression, stated exactly: 35 products are missing from this list and NOT ONE
        // of them may be reported as having no traffic.
        expect(leaks.noTraffic.count).toBe(0);
        expect(leaks.noTraffic.unknown).toBeGreaterThan(0);
        expect(leaks.noTraffic.sample).toEqual([]);
        expect(leaks.noTraffic.note).toMatch(/truncated/i);
    });

    test('coverage is reported so a caller can see the list was cut', () => {
        const rows = landingRows({ upTo: 12 });
        const leaks = findLeaks({
            landingRows: rows, products, redirects: [], salesByTitle: {},
            truncated: true, lowestSessions: 15
        });
        expect(leaks.coverage.truncated).toBe(true);
        expect(leaks.coverage.lowestSessions).toBe(15);
        expect(leaks.coverage.activeProducts).toBe(47);
        expect(leaks.coverage.productsSeen).toBeLessThan(47);
    });

    test('a COMPLETE list may report a real zero', () => {
        // One product genuinely absent, and the query reached the bottom of the tail.
        const rows = landingRows({}).filter((r) => r[0] !== '/products/design-47');
        const leaks = findLeaks({
            landingRows: rows, products, redirects: [], salesByTitle: {},
            truncated: false, lowestSessions: 15
        });
        expect(leaks.noTraffic.count).toBe(1);
        expect(leaks.noTraffic.unknown).toBe(0);
        expect(leaks.noTraffic.sample[0].handle).toBe('design-47');
        expect(leaks.coverage.truncated).toBe(false);
    });
});

describe('the crawler floor is separated from real interest', () => {
    test('a cohort sharing one session count is reported as a floor', () => {
        const leaks = findLeaks({
            landingRows: landingRows({}), products, redirects: [], salesByTitle: {},
            truncated: false, lowestSessions: 15
        });
        expect(leaks.crawlerFloor).not.toBeNull();
        expect(leaks.crawlerFloor.sessions).toBe(15);
        // 37 products sit on exactly 15 — that is a machine, not 37 audiences of fifteen.
        expect(leaks.crawlerFloor.count).toBeGreaterThanOrEqual(30);
    });

    test('genuinely spread-out traffic produces NO floor — the check must not cry wolf', () => {
        const spread = products.map((p, i) => ['/products/' + p.handle, String(100 - i)]);
        const leaks = findLeaks({
            landingRows: spread, products, redirects: [], salesByTitle: {},
            truncated: false, lowestSessions: 54
        });
        expect(leaks.crawlerFloor).toBeNull();
    });
});

describe('the headline percentage counts every product that was seen', () => {
    test('a complete list attributes far more traffic to live pages than a cut one', () => {
        const cut = findLeaks({
            landingRows: landingRows({ upTo: 12 }), products, redirects: [], salesByTitle: {},
            truncated: true, lowestSessions: 15
        });
        const full = findLeaks({
            landingRows: landingRows({}), products, redirects: [], salesByTitle: {},
            truncated: false, lowestSessions: 15
        });
        // This gap IS the bug: the same store looked far more broken through a cut window.
        expect(full.summary.reachingALivePage).toBeGreaterThan(cut.summary.reachingALivePage);
    });
});
