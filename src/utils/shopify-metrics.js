// Store metrics for 253gear.com — what Steve's dashboard shows about the live shop.
//
// 🔴 THE RULE THIS MODULE EXISTS TO ENFORCE: "we are not allowed to read this" must never
// reach the page as a number. Not as 0, not as "—", not as an empty chart. Every block
// below is either {available:true, ...data} or {available:false, code, missing, howToFix}
// and the page renders those two shapes differently. A dashboard that shows "0 visitors"
// when it means "no access" is worse than one that shows nothing: it reads as a measurement,
// and somebody will make a decision on it.
//
// This is the same failure that produced "0 stitches / 0.0 in" for the contract-embroidery
// model — Number(null) === 0 and 0 is finite, so a naive guard turns "no data" into the FACT
// "zero". Here the absent case never gets near a numeric field at all.
//
// WHAT IS ACTUALLY AVAILABLE TODAY (probed live 2026-08-09, app "253Gear Publisher"):
//
//   granted : read_content, read_online_store_navigation, read_products, read_publications,
//             read_themes, write_content, write_online_store_navigation, write_products,
//             write_themes
//   missing : read_orders   -> every sales figure
//             read_reports  -> every session / traffic figure
//
// ⚠️ read_reports is NOT just a checkbox. Shopify's own error is explicit:
//   "Required access: `read_reports` access scope. Also: Level 2 access to Customer data
//    including name, address, phone, and email fields."
// Protected customer data is an approval, not a toggle. Budget for that, not five minutes.
//
// ⚠️ THE ShopifyQL QUERIES BELOW ARE UNVERIFIED. They could not be executed even once,
// because the scope is missing — the request is rejected before the query is parsed. The
// syntax follows Shopify's documented grammar and the response SHAPE was introspected from
// the live schema (ShopifyqlQueryResponse { parseErrors: String, tableData { columns, rows,
// rowMetadata } } — note parseErrors is a SCALAR here, not a list of objects as older docs
// show). But nobody has seen one return a row. First run after the grant is a test, and
// `parseErrors` is where a wrong query will say so.

'use strict';

const shopify = require('./shopify-client');

const WINDOW_DAYS = 30;

// Scope -> what breaks without it, and what Erik has to do about it.
const SCOPE_HELP = {
    read_reports: {
        unlocks: 'sessions, traffic sources, and where visitors come from',
        howToFix: 'Shopify admin -> Settings -> Apps and sales channels -> Develop apps -> '
            + '253Gear Publisher -> Configuration -> Admin API scopes -> tick read_reports. '
            + 'This ALSO needs Level 2 protected customer data access, requested on the same '
            + 'app under Protected customer data access — that part is an approval, not a toggle.'
    },
    read_orders: {
        unlocks: 'units sold per design — which subjects actually convert',
        howToFix: 'Same screen: tick read_orders. Orders are protected customer data too, so '
            + 'the same Level 1 request applies. We only ever read line-item titles and '
            + 'quantities — never a name, address, phone or email.'
    }
};

function unavailable(missingScopes, extra) {
    const missing = missingScopes.slice();
    return Object.assign({
        available: false,
        code: 'SCOPE_MISSING',
        missing,
        unlocks: missing.map((s) => (SCOPE_HELP[s] || {}).unlocks).filter(Boolean),
        howToFix: missing.map((s) => (SCOPE_HELP[s] || {}).howToFix).filter(Boolean)
    }, extra || {});
}

/** What is this token actually allowed to do? One cheap query, and the ceiling on everything. */
async function grantedScopes() {
    const d = await shopify.gql(
        'query { currentAppInstallation { accessScopes { handle } } }', {}, { isMutation: false }
    );
    const inst = d && d.currentAppInstallation;
    return new Set(((inst && inst.accessScopes) || []).map((s) => s.handle));
}

/**
 * Catalogue health — the one block that works today, because it only needs read_products.
 *
 * Deliberately NOT a vanity count. Every field here is something Steve can act on this
 * afternoon: thin copy is the cheapest ranking win in the catalogue (the words are what
 * rank, and they can be added without drawing anything), and a product with no SEO title
 * is one Google renders from the raw product title, design number and all.
 */
async function catalogueHealth() {
    const Q = `
      query($cursor: String) {
        products(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id title status descriptionHtml
            handle
            seo { title description }
            publishedAt
            featuredMedia { id }
          }
        }
      }`;

    const all = [];
    let cursor = null;
    // Bounded: the catalogue is ~50 products. The cap stops a runaway loop from
    // becoming a quota event if the store ever grows unexpectedly.
    for (let page = 0; page < 12; page++) {
        const d = await shopify.gql(Q, { cursor }, { isMutation: false });
        const conn = d.products;
        all.push(...conn.nodes);
        if (!conn.pageInfo.hasNextPage) break;
        cursor = conn.pageInfo.endCursor;
    }

    const words = (html) => String(html || '').replace(/<[^>]+>/g, ' ').trim().split(/\s+/).filter(Boolean).length;
    const active = all.filter((p) => p.status === 'ACTIVE');
    const wordCounts = active.map((p) => words(p.descriptionHtml));

    const thin = active.filter((p) => words(p.descriptionHtml) < 300);
    const noSeoTitle = active.filter((p) => !(p.seo && p.seo.title));
    const noSeoDesc = active.filter((p) => !(p.seo && p.seo.description));
    const unpublished = active.filter((p) => !p.publishedAt);
    const noImage = active.filter((p) => !p.featuredMedia);

    const sorted = wordCounts.slice().sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;

    return {
        // Handed to findLeaks so the catalogue is paged once rather than twice, then
        // deleted before the payload leaves storeMetrics — it is a join input, not data
        // the page has any use for.
        _products: all.map((p) => ({ handle: p.handle, title: p.title, status: p.status })),
        available: true,
        totalProducts: all.length,
        activeProducts: active.length,
        draftProducts: all.filter((p) => p.status === 'DRAFT').length,
        archivedProducts: all.filter((p) => p.status === 'ARCHIVED').length,
        medianWords: median,
        thinCopy: { count: thin.length, titles: thin.slice(0, 8).map((p) => p.title) },
        missingSeoTitle: noSeoTitle.length,
        missingSeoDescription: noSeoDesc.length,
        // 🔴 ACTIVE but never published still 404s on the storefront — status ACTIVE alone
        // does not publish, and that trap has bitten this store before.
        activeButUnpublished: { count: unpublished.length, titles: unpublished.slice(0, 8).map((p) => p.title) },
        noFeaturedImage: noImage.length
    };
}

/**
 * Sessions and traffic sources. Needs read_reports.
 *
 * 🔴 TWO TRAPS, both found the first time these ever executed (2026-08-09). They are
 * recorded here because both are invisible in a passing-looking response.
 *
 * 1. `parseErrors` is `[String!]!` — an ARRAY, `[]` on success. **An empty array is
 *    truthy in JavaScript**, so the obvious guard `if (r.parseErrors) throw` fires on
 *    EVERY SUCCESSFUL QUERY. It would have reported traffic as permanently broken with
 *    a fabricated error message the moment the scope landed. Same shape as the
 *    `Number(null) === 0` trap, mirrored: here "no errors" reads as "error".
 *    (Introspection calls it a LIST; a `{ code message }` selection is rejected with
 *    "returns String" — so it is `[String!]!` and neither signal alone tells you.)
 *
 * 2. `rows` are OBJECTS keyed by column name — `{"sessions":"1332"}` — not positional
 *    arrays. Rendering them as arrays yields empty cells, not an error.
 *
 * GRAMMAR, established by probing rather than from docs: there is no `sum()`
 * ("Could not find valid function sum()") and no bare `BY` (the parser wants
 * `GROUP BY`). The measure is the bare column name: `SHOW sessions`.
 */
async function traffic() {
    const Q = `
      query($q: String!) {
        shopifyqlQuery(query: $q) {
          parseErrors
          tableData { columns { name dataType displayName } rows }
        }
      }`;

    const run = async (ql) => {
        const d = await shopify.gql(Q, { q: ql }, { isMutation: false });
        const r = d.shopifyqlQuery;

        // Normalise before testing. Trap 1 lives on this line.
        const pe = Array.isArray(r && r.parseErrors)
            ? r.parseErrors
            : ((r && r.parseErrors) ? [r.parseErrors] : []);
        if (pe.length) {
            const e = new Error('ShopifyQL rejected the query: ' + pe.map(String).join('; ').slice(0, 300));
            e.code = 'SHOPIFYQL_PARSE_ERROR';
            e.query = ql;
            throw e;
        }

        const t = (r && r.tableData) || { columns: [], rows: [] };
        const cols = t.columns || [];
        // Trap 2: project the keyed objects into positional rows the page can render,
        // using the column order the server declared.
        const rows = (t.rows || []).map((row) => cols.map((c) => {
            const v = row && Object.prototype.hasOwnProperty.call(row, c.name) ? row[c.name] : null;
            return v === null || v === undefined ? '—' : v;
        }));
        return { columns: cols.map((c) => c.displayName || c.name), rows };
    };

    const win = `SINCE -${WINDOW_DAYS}d UNTIL today`;

    const totals = await run(`FROM sessions SHOW sessions ${win}`);
    const bySource = await run(
        `FROM sessions SHOW sessions GROUP BY referrer_source ${win} ORDER BY sessions DESC LIMIT 8`);
    const byReferrer = await run(
        `FROM sessions SHOW sessions GROUP BY referrer_name ${win} ORDER BY sessions DESC LIMIT 8`);
    // The one Steve can act on: which PAGES people actually land on. A design whose
    // page nobody lands on is a drawing, not a product.
    const byLanding = await run(
        `FROM sessions SHOW sessions GROUP BY landing_page_path ${win} ORDER BY sessions DESC LIMIT 10`);
    const daily = await run(
        `FROM sessions SHOW sessions GROUP BY day ${win} ORDER BY day ASC`);

    // A single day carrying a large share of the window is almost always a bot sweep or
    // a scrape, not an audience. Flag it rather than let it inflate the headline —
    // an unflagged spike is how "traffic tripled" gets repeated in a meeting.
    let spike = null;
    const total = Number(String((totals.rows[0] || [])[0] || '0').replace(/,/g, '')) || 0;
    if (total > 0) {
        for (const [day, n] of daily.rows) {
            const v = Number(String(n).replace(/,/g, '')) || 0;
            if (v / total >= 0.25) spike = { day, sessions: v, shareOfWindow: Math.round((v / total) * 100) };
        }
    }

    return { available: true, windowDays: WINDOW_DAYS, totals, bySource, byReferrer, byLanding, daily, spike };
}

/**
 * Units sold per design over the window. Needs read_orders.
 *
 * This — not sessions — is the number that should inform what Steve draws. A session is a
 * proxy for interest; a sale is the thing itself. And it is the only figure that can settle
 * an argument like "do drive-in subjects work here", which is currently answered by pointing
 * at Star-Lite and reasoning by analogy.
 */
async function sales() {
    const since = new Date(Date.now() - WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
    const Q = `
      query($cursor: String, $q: String!) {
        orders(first: 100, after: $cursor, query: $q, sortKey: CREATED_AT, reverse: true) {
          pageInfo { hasNextPage endCursor }
          nodes {
            createdAt
            lineItems(first: 25) { nodes { title quantity } }
          }
        }
      }`;

    const tally = {};
    let orderCount = 0;
    let unitCount = 0;
    let cursor = null;
    for (let page = 0; page < 10; page++) {
        const d = await shopify.gql(Q, { cursor, q: `created_at:>=${since}` }, { isMutation: false });
        const conn = d.orders;
        conn.nodes.forEach((o) => {
            orderCount++;
            o.lineItems.nodes.forEach((li) => {
                const t = String(li.title || '').trim();
                if (!t) return;
                tally[t] = (tally[t] || 0) + (li.quantity || 0);
                unitCount += li.quantity || 0;
            });
        });
        if (!conn.pageInfo.hasNextPage) break;
        cursor = conn.pageInfo.endCursor;
    }

    const top = Object.entries(tally)
        .map(([title, units]) => ({ title, units }))
        .sort((a, b) => b.units - a.units);

    return {
        available: true,
        windowDays: WINDOW_DAYS,
        since,
        orders: orderCount,
        units: unitCount,
        // Zero orders in the window is a REAL result and must read differently from
        // "no access" — hence this lives inside available:true.
        topDesigns: top.slice(0, 12),
        designsWithNoSales: null // filled by the route, which knows the full catalogue
    };
}

/**
 * Where traffic is being lost. The highest-value block on the whole dashboard, and the
 * one nothing else would have surfaced.
 *
 * Measured the first time it ran (90 days to 2026-08-09): of 2,126 sessions landing on
 * product pages, 1,000 hit URLs with no product and no redirect — every one of them a
 * BLANK GARMENT SKU (pc54 269, pc147 239, bc3001 197, pc54y 122, nkbq5230 116, lpc54 57).
 * A further 112 landed on a redirect pointing at the wrong product. That is 52% of
 * product-page traffic, on a store taking two orders a month.
 *
 * 🔴 A `copy-of-` HANDLE IN A REDIRECT IS THE SIGNATURE OF THIS BUG. Duplicating a product
 * in the Shopify admin creates `copy-of-<original>`; renaming the duplicate makes Shopify
 * auto-create a redirect from that handle to the NEW product. Technically right, and
 * semantically wrong the moment Google has indexed the URL under the original's name.
 * Pizza and Pipes traffic was being handed a motel for exactly this reason.
 */
function findLeaks({ landingRows, products, redirects, salesByTitle }) {
    const activeHandles = new Set(products.filter((p) => p.status === 'ACTIVE').map((p) => p.handle));
    const redirectByPath = new Map(redirects.map((r) => [r.path, r.target]));

    const words = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
    // Words that appear in half the handles on the store carry no signal about WHICH
    // product a URL meant, so they must not count as agreement between path and target.
    const NOISE = new Set(['products', 'copy', 'shirt', 'tshirt', 'hoodie', 'tee', 'black', 'white',
        'gray', 'grey', 'the', 'and', 'for', 'with', 'mens', 'womens', 'youth']);
    const signal = (s) => words(s).filter((w) => !NOISE.has(w) && !/^\d+$/.test(w));

    const dead = [];
    const misrouted = [];
    const productSessions = new Map();

    for (const row of landingRows) {
        const path = row[0];
        const sessions = Number(String(row[1]).replace(/,/g, '')) || 0;
        if (!/^\/products\//.test(String(path))) continue;
        const handle = String(path).replace(/^\/products\//, '').split('?')[0];

        if (activeHandles.has(handle)) {
            productSessions.set(handle, (productSessions.get(handle) || 0) + sessions);
            continue;
        }

        const target = redirectByPath.get(path) || redirectByPath.get('/products/' + handle);
        if (!target) {
            dead.push({ path, sessions });
            continue;
        }

        // A redirect exists. Is it pointing somewhere that has anything to do with the URL
        // the visitor clicked?
        //
        // 🔑 THE DESIGN NUMBER EXONERATES. Every product carries a 4-6 digit ShopWorks
        // design number, and it is the store's own identity key — it survives renames,
        // which is precisely when redirects get created. If the source path and the target
        // carry the SAME number, the redirect is a rename and is correct, however little
        // the words resemble each other. Without this rule
        // `253-area-code-t-shirt-32187 -> 253-repeat-32187` reads as a misroute when it is
        // the system working exactly as intended.
        //
        // A `copy-of-` prefix is NOT flagged on its own. It was, briefly, and it re-flagged
        // the Pizza and Pipes pair the moment they were fixed — a check that keeps
        // complaining after you fix the thing is a check people learn to ignore. The real
        // bug it was aimed at (a duplicate renamed to an unrelated product) is caught by
        // the number test anyway, which is both stricter and quieter.
        const num = (s) => { const m = String(s).match(/\b(\d{4,6})\b/g); return m ? m[m.length - 1] : null; };
        const srcNum = num(handle);
        const dstNum = num(target);
        if (srcNum && dstNum && srcNum === dstNum) continue;   // same design, renamed — fine

        const src = signal(handle);
        const dst = signal(target);
        const overlap = src.filter((w) => dst.includes(w));
        if (src.length && !overlap.length) {
            misrouted.push({
                path, sessions, target,
                why: srcNum && dstNum
                    ? `design #${srcNum} redirects to #${dstNum} — a different design, and no word matches either`
                    : 'the destination shares no word with the URL clicked'
            });
        }
    }

    dead.sort((a, b) => b.sessions - a.sessions);
    misrouted.sort((a, b) => b.sessions - a.sessions);

    // Traffic but no sale: the page is found and does not convert. Distinct from no
    // traffic at all, which is a findability problem, and the two need opposite fixes.
    const soldTitles = new Set(Object.keys(salesByTitle || {}));
    const titleOf = new Map(products.map((p) => [p.handle, p.title]));
    const trafficNoSales = [];
    for (const [handle, sessions] of productSessions) {
        const title = titleOf.get(handle) || handle;
        if (!soldTitles.has(title) && sessions >= 10) trafficNoSales.push({ handle, title, sessions });
    }
    trafficNoSales.sort((a, b) => b.sessions - a.sessions);

    const noTraffic = products
        .filter((p) => p.status === 'ACTIVE' && !productSessions.has(p.handle))
        .map((p) => ({ handle: p.handle, title: p.title }));

    const productTotal = [...productSessions.values()].reduce((a, n) => a + n, 0);
    const deadTotal = dead.reduce((a, d) => a + d.sessions, 0);
    const misTotal = misrouted.reduce((a, d) => a + d.sessions, 0);
    const grand = productTotal + deadTotal + misTotal;

    return {
        available: true,
        windowDays: 90,
        summary: {
            productPageSessions: grand,
            reachingALivePage: productTotal,
            lostTo404: deadTotal,
            misrouted: misTotal,
            brokenPercent: grand ? Math.round(((deadTotal + misTotal) / grand) * 100) : 0
        },
        dead: dead.slice(0, 15),
        misrouted: misrouted.slice(0, 15),
        trafficNoSales: trafficNoSales.slice(0, 12),
        noTraffic: { count: noTraffic.length, sample: noTraffic.slice(0, 10) }
    };
}

/**
 * The whole payload. Each block fails independently: a missing scope on one must not
 * blank the block that does work.
 */
async function storeMetrics() {
    const scopes = await grantedScopes();
    const has = (s) => scopes.has(s);

    const out = {
        shop: '253gear.com',
        windowDays: WINDOW_DAYS,
        grantedScopes: Array.from(scopes).sort()
    };

    // Catalogue — read_products, which we have.
    try {
        out.catalogue = has('read_products')
            ? await catalogueHealth()
            : unavailable(['read_products']);
    } catch (e) {
        out.catalogue = { available: false, code: e.code || 'UPSTREAM_FAILED', error: String(e.message || e).slice(0, 300) };
    }

    // Traffic — read_reports.
    if (!has('read_reports')) {
        out.traffic = unavailable(['read_reports'], {
            note: 'Shopify collects these numbers whether or not GA4 is installed. This is a '
                + 'permission on our app, not a tracking gap.'
        });
    } else {
        try { out.traffic = await traffic(); } catch (e) {
            out.traffic = {
                available: false,
                code: e.code || 'UPSTREAM_FAILED',
                error: String(e.message || e).slice(0, 400),
                note: 'The scope is granted, so this is the query itself failing. These ShopifyQL '
                    + 'statements had never been executable before the grant — read parseErrors.'
            };
        }
    }

    // Sales — read_orders.
    if (!has('read_orders')) {
        out.sales = unavailable(['read_orders']);
    } else {
        try {
            out.sales = await sales();
            if (out.catalogue && out.catalogue.available && out.sales.topDesigns) {
                const sold = new Set(out.sales.topDesigns.map((d) => d.title));
                out.sales.designsWithNoSales = Math.max(0, out.catalogue.activeProducts - sold.size);
            }
        } catch (e) {
            out.sales = { available: false, code: e.code || 'UPSTREAM_FAILED', error: String(e.message || e).slice(0, 300) };
        }
    }

    // Leaks — needs read_reports (for landing pages) and read_products. Sales are optional:
    // without them the traffic-no-sales list is simply omitted rather than the whole block
    // failing, because the 404 list is the valuable part and it does not need orders.
    if (!has('read_reports')) {
        out.leaks = unavailable(['read_reports'], {
            note: 'The 404 list needs landing-page data, which is the same permission as traffic.'
        });
    } else {
        try {
            const landing = await landingPages(90);
            const redirects = await allRedirects();
            const salesByTitle = {};
            if (out.sales && out.sales.available) {
                (out.sales.topDesigns || []).forEach((t) => { salesByTitle[t.title] = t.units; });
            }
            out.leaks = findLeaks({
                landingRows: landing.rows,
                products: (out.catalogue && out.catalogue._products) || [],
                redirects,
                salesByTitle
            });
        } catch (e) {
            out.leaks = { available: false, code: e.code || 'UPSTREAM_FAILED', error: String(e.message || e).slice(0, 300) };
        }
    }

    // The raw product list is an implementation detail of the leak join, not payload.
    if (out.catalogue) delete out.catalogue._products;

    return out;
}

/** Landing pages over an arbitrary window. Deeper list than the traffic block shows. */
async function landingPages(days) {
    const Q = `
      query($q: String!) {
        shopifyqlQuery(query: $q) {
          parseErrors
          tableData { columns { name displayName } rows }
        }
      }`;
    const d = await shopify.gql(Q, {
        q: `FROM sessions SHOW sessions GROUP BY landing_page_path SINCE -${days}d UNTIL today `
            + 'ORDER BY sessions DESC LIMIT 60'
    }, { isMutation: false });
    const r = d.shopifyqlQuery;
    const pe = Array.isArray(r && r.parseErrors) ? r.parseErrors : ((r && r.parseErrors) ? [r.parseErrors] : []);
    if (pe.length) {
        const e = new Error('ShopifyQL rejected the landing-page query: ' + pe.map(String).join('; '));
        e.code = 'SHOPIFYQL_PARSE_ERROR';
        throw e;
    }
    const t = (r && r.tableData) || { columns: [], rows: [] };
    const cols = t.columns || [];
    return { rows: (t.rows || []).map((row) => cols.map((c) => (row ? row[c.name] : null))) };
}

/** Every redirect on the store. 127 of them today, so one page is usually enough. */
async function allRedirects() {
    const Q = `
      query($cursor: String) {
        urlRedirects(first: 250, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { path target }
        }
      }`;
    const out = [];
    let cursor = null;
    for (let i = 0; i < 8; i++) {
        const d = await shopify.gql(Q, { cursor }, { isMutation: false });
        out.push(...d.urlRedirects.nodes);
        if (!d.urlRedirects.pageInfo.hasNextPage) break;
        cursor = d.urlRedirects.pageInfo.endCursor;
    }
    return out;
}

module.exports = { storeMetrics, grantedScopes, catalogueHealth, traffic, sales, unavailable, SCOPE_HELP, WINDOW_DAYS };
