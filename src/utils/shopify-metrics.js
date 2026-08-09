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

/** Sessions and traffic sources. Needs read_reports + Level 2 protected customer data. */
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
        // parseErrors is a SCALAR String on this API version — a non-empty value means the
        // query is wrong, and since these have never been executed that is a live possibility.
        // Surface it verbatim rather than returning an empty table that looks like "no traffic".
        if (r && r.parseErrors) {
            const e = new Error('ShopifyQL rejected the query: ' + String(r.parseErrors).slice(0, 300));
            e.code = 'SHOPIFYQL_PARSE_ERROR';
            e.query = ql;
            throw e;
        }
        const t = (r && r.tableData) || { columns: [], rows: [] };
        return {
            columns: (t.columns || []).map((c) => c.displayName || c.name),
            rows: t.rows || []
        };
    };

    const totals = await run(
        `FROM sessions SHOW sum(sessions) SINCE -${WINDOW_DAYS}d UNTIL today`
    );
    const bySource = await run(
        `FROM sessions SHOW sum(sessions) BY referrer_source `
        + `SINCE -${WINDOW_DAYS}d UNTIL today ORDER BY sum(sessions) DESC LIMIT 8`
    );
    const daily = await run(
        `FROM sessions SHOW sum(sessions) BY day SINCE -${WINDOW_DAYS}d UNTIL today ORDER BY day ASC`
    );

    return { available: true, windowDays: WINDOW_DAYS, totals, bySource, daily };
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

    return out;
}

module.exports = { storeMetrics, grantedScopes, catalogueHealth, traffic, sales, unavailable, SCOPE_HELP, WINDOW_DAYS };
