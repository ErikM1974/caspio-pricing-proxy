#!/usr/bin/env node
/**
 * 253gear.com — read-only live-store inspection (Step 0 of the 253Gear Publisher build).
 *
 *   node scripts/253gear-inspect.js            # human-readable report
 *   node scripts/253gear-inspect.js --json     # machine-readable, for the config seed
 *   node scripts/253gear-inspect.js --design 34293   # also look up one design
 *
 * READ-ONLY BY CONSTRUCTION. Every operation here is a GraphQL *query*; this file
 * contains no mutation and must never grow one. It is safe to run against the live
 * store at any time.
 *
 * It answers the four things that are not recorded in any local file, and that the
 * publisher cannot be correct without:
 *
 *   1. The real field names on ProductSetInput / ProductVariantSetInput for this API
 *      version. The build assumes them; assumptions about a schema are how you get a
 *      userErrors response at 2am instead of a product.
 *   2. What the 8 automatic city collections actually key on. "Files it into the right
 *      category" is the whole feature request, and it is TAG-driven only if the ruleSet
 *      says so. Nothing local records this.
 *   3. How a real live product is shaped — options, variant count, media count, and
 *      crucially the variant->media binding pattern (159 images / 47 products is ~3.4
 *      each, so it is emphatically not one image per variant).
 *   4. The Online Store publication GID, so publishing uses publishablePublish rather
 *      than the REST workaround.
 *
 * Requires SHOPIFY_SHOP_DOMAIN / SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET.
 */

require('dotenv').config();
const shopify = require('../src/utils/shopify-client');

const asJson = process.argv.includes('--json');
const designArgIndex = process.argv.indexOf('--design');
const designNumber = designArgIndex > -1 ? process.argv[designArgIndex + 1] : null;

const out = (...args) => { if (!asJson) console.log(...args); };
const rule = (title) => out(`\n${'─'.repeat(72)}\n${title}\n${'─'.repeat(72)}`);

// ── 1. Schema introspection ──────────────────────────────────────────────────

const Q_INTROSPECT = `
query {
  productSet: __type(name: "ProductSetInput") { inputFields { name type { name kind ofType { name kind ofType { name } } } } }
  variantSet: __type(name: "ProductVariantSetInput") { inputFields { name type { name kind ofType { name } } } }
  variantBulk: __type(name: "ProductVariantsBulkInput") { inputFields { name type { name kind ofType { name } } } }
  inventoryItem: __type(name: "InventoryItemInput") { inputFields { name type { name kind ofType { name } } } }
  fileInput: __type(name: "FileSetInput") { inputFields { name type { name kind ofType { name } } } }
}`;

function typeName(t) {
    if (!t) return '?';
    if (t.name) return t.name + (t.kind === 'NON_NULL' ? '!' : '');
    if (t.ofType) return typeName(t.ofType) + (t.kind === 'LIST' ? '[]' : t.kind === 'NON_NULL' ? '!' : '');
    return t.kind || '?';
}

async function introspect() {
    const data = await shopify.gql(Q_INTROSPECT);
    const result = {};
    for (const [label, node] of Object.entries(data)) {
        result[label] = node ? node.inputFields.map((f) => ({ name: f.name, type: typeName(f.type) })) : null;
    }

    rule('1. Schema — what this API version actually accepts');
    for (const [label, fields] of Object.entries(result)) {
        if (!fields) { out(`\n  ${label}: TYPE NOT FOUND — the build's assumption is wrong for this version.`); continue; }
        out(`\n  ${label} (${fields.length} fields)`);
        out('    ' + fields.map((f) => f.name).join(', '));
    }

    // The specific assumptions the builder makes. Each one is load-bearing.
    const productSetNames = (result.productSet || []).map((f) => f.name);
    const assumptions = ['title', 'handle', 'descriptionHtml', 'status', 'tags', 'seo', 'metafields', 'productOptions', 'variants', 'files', 'redirectNewHandle'];
    rule('1b. Assumption check — ProductSetInput');
    for (const a of assumptions) {
        out(`  ${productSetNames.includes(a) ? 'ok  ' : 'MISSING'}  ${a}`);
    }
    if (productSetNames.includes('handle')) {
        out('\n  NOTE: `handle` is present. Test whether productSet UPSERTS on it —');
        out('        if it does, idempotency is free and the ledger becomes belt-and-braces.');
    }
    return result;
}

// ── 2. Collections and their rules ───────────────────────────────────────────

const Q_COLLECTIONS = `
query { collections(first: 50) { nodes {
  id handle title productsCount { count } sortOrder
  ruleSet { appliedDisjunctively rules { column relation condition } }
} } }`;

async function collections() {
    const data = await shopify.gql(Q_COLLECTIONS);
    const nodes = data.collections.nodes;

    rule('2. Collections — THE question: what do the automatic ones key on?');
    const automatic = nodes.filter((c) => c.ruleSet);
    const manual = nodes.filter((c) => !c.ruleSet);

    for (const c of automatic) {
        const join = c.ruleSet.appliedDisjunctively ? 'ANY of' : 'ALL of';
        out(`\n  ${c.handle}  (${(c.productsCount || {}).count} products) — automatic, ${join}:`);
        for (const r of c.ruleSet.rules) out(`      ${r.column} ${r.relation} "${r.condition}"`);
    }
    if (manual.length) {
        out(`\n  Manual collections (a new product will NOT file itself into these):`);
        for (const c of manual) out(`      ${c.handle} (${(c.productsCount || {}).count} products)`);
    }

    // Derive the tag vocabulary the classifier is allowed to emit.
    const tagVocabulary = Array.from(new Set(
        automatic
            .flatMap((c) => c.ruleSet.rules)
            .filter((r) => r.column === 'TAG' && (r.relation === 'EQUALS' || r.relation === 'CONTAINS'))
            .map((r) => String(r.condition).toLowerCase())
    ));

    rule('2b. Derived tag vocabulary (seed Shopify_Config_2026.tag_vocabulary with this)');
    if (tagVocabulary.length) {
        out('  ' + JSON.stringify(tagVocabulary));
    } else {
        out('  NONE — no automatic collection keys on TAG.');
        out('  ⚠️  Tagging will NOT file a product. Re-read the rules above and');
        out('      change the publisher to set whatever column they DO key on.');
    }
    return { collections: nodes, tagVocabulary };
}

// ── 3. A real product, and how its variants bind to media ────────────────────

const Q_MODEL_PRODUCT = `
query($q: String!) { products(first: 1, query: $q) { nodes {
  id title handle status publishedAt vendor productType tags
  options { name optionValues { name } }
  seo { title description }
  media(first: 50) { nodes { ... on MediaImage { id alt status image { url width height } } } }
  variants(first: 100) { nodes {
    id title sku price barcode
    image { id }
    selectedOptions { name value }
    inventoryPolicy
    inventoryItem { tracked requiresShipping measurement { weight { value unit } } }
  } }
} } }`;

async function modelProduct() {
    const data = await shopify.gql(Q_MODEL_PRODUCT, { q: 'status:active' });
    const p = data.products.nodes[0];
    if (!p) { out('\n  No active product found.'); return null; }

    const variants = p.variants.nodes;
    const media = p.media.nodes;

    rule('3. A live product — copy this shape');
    out(`  ${p.title}`);
    out(`  handle: ${p.handle}   status: ${p.status}   publishedAt: ${p.publishedAt}`);
    out(`  vendor: ${p.vendor}   productType: ${p.productType}`);
    out(`  tags: ${JSON.stringify(p.tags)}`);
    out(`  seo.title: ${(p.seo || {}).title || '(none)'}`);
    out(`  seo.description: ${((p.seo || {}).description || '(none)').slice(0, 90)}`);
    out(`  options: ${p.options.map((o) => `${o.name}(${o.optionValues.length})`).join(', ')}`);
    out(`  ${variants.length} variants, ${media.length} media`);

    const v = variants[0];
    if (v) {
        out(`\n  First variant:`);
        out(`    sku: ${v.sku}   price: ${v.price}`);
        out(`    inventoryPolicy: ${v.inventoryPolicy}   tracked: ${v.inventoryItem && v.inventoryItem.tracked}`);
        const w = v.inventoryItem && v.inventoryItem.measurement && v.inventoryItem.measurement.weight;
        out(`    weight: ${w ? `${w.value} ${w.unit}` : '(none)'}`);
    }

    // THE binding pattern. Which options actually decide a photo?
    const byMedia = new Map();
    let unbound = 0;
    for (const variant of variants) {
        if (!variant.image) { unbound++; continue; }
        const list = byMedia.get(variant.image.id) || [];
        list.push(variant);
        byMedia.set(variant.image.id, list);
    }

    rule('3b. Variant -> media binding — which options a photo DECIDES');
    out(`  ${variants.length - unbound}/${variants.length} variants bound, across ${byMedia.size} distinct images`);
    if (unbound) out(`  ⚠️  ${unbound} variants have NO bound image on a LIVE product.`);

    const optionNames = p.options.map((o) => o.name);
    const decides = [];
    for (const name of optionNames) {
        // An option is "decided" by a photo when every variant sharing that photo agrees on it.
        const agreesEverywhere = Array.from(byMedia.values()).every((group) => {
            const values = new Set(group.map((g) => (g.selectedOptions.find((o) => o.name === name) || {}).value));
            return values.size === 1;
        });
        if (agreesEverywhere) decides.push(name);
    }
    out(`  A photo decides: ${decides.length ? decides.join(' + ') : '(nothing)'}`);
    out(`  A photo leaves free: ${optionNames.filter((n) => !decides.includes(n)).join(', ') || '(nothing)'}`);
    out(`\n  Expected for 253gear: decides "Style + Color", leaves "Size" free —`);
    out(`  that is what lets a shopper click a thumbnail without losing their size.`);

    return { product: p, decides, distinctImages: byMedia.size, unbound };
}

// ── 4. Publications ──────────────────────────────────────────────────────────

async function publications() {
    rule('4. Publications — the Online Store GID for publishablePublish');
    try {
        const data = await shopify.gql('query { publications(first: 20) { nodes { id name } } }');
        for (const pub of data.publications.nodes) out(`  ${pub.name}: ${pub.id}`);
        const online = data.publications.nodes.find((n) => /online store/i.test(n.name));
        if (online) out(`\n  Seed Shopify_Config_2026.publication_id = ${online.id}`);
        return data.publications.nodes;
    } catch (err) {
        out(`  UNAVAILABLE: ${err.message}`);
        out('  read_publications is probably not granted — publishing must use the REST fallback');
        out('  (PUT products/{id}.json {published:true}), per 253gear-ops/shopify/sh.py:65-79.');
        return null;
    }
}

// ── 5. Catalogue-wide sanity ─────────────────────────────────────────────────

const Q_ALL = `
query($c: String) { products(first: 100, after: $c, query: "status:active") {
  pageInfo { hasNextPage endCursor }
  nodes { id title handle publishedAt
    media(first: 30) { nodes { ... on MediaImage { id alt } } }
    variants(first: 100) { nodes { id image { id } } } } } }`;

async function catalogue() {
    let cursor = null;
    const all = [];
    do {
        const page = (await shopify.gql(Q_ALL, { c: cursor })).products;
        all.push(...page.nodes);
        cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (cursor);

    rule('5. Catalogue health (same four checks as 253gear-ops/shopify/audit.py)');
    const unbound = [], unpublished = [], noAlt = [], numbers = new Map();
    for (const p of all) {
        const variants = p.variants.nodes;
        const bound = variants.filter((v) => v.image).length;
        if (bound < variants.length) unbound.push(`${p.title}  ${bound}/${variants.length}`);
        if (!p.publishedAt) unpublished.push(p.title);
        for (const m of p.media.nodes) if (!String(m.alt || '').trim()) noAlt.push(`${p.title} ${m.id}`);
        const found = /#(\d{4,6})/.exec(p.title);
        if (found) numbers.set(found[1], (numbers.get(found[1]) || []).concat(p.title));
    }
    const dupes = Array.from(numbers.entries()).filter(([, v]) => v.length > 1);

    out(`  ${all.length} active products\n`);
    const report = [
        ['Variants with no image bound', unbound],
        ['Active but not published to Online Store', unpublished],
        ['Images with no alt text', noAlt],
        ['Duplicate design numbers', dupes.map(([k, v]) => `#${k}: ${v.join(', ')}`)]
    ];
    for (const [name, rows] of report) {
        if (rows.length) {
            out(`  FAIL  ${name} (${rows.length})`);
            for (const r of rows.slice(0, 10)) out(`          ${r}`);
        } else {
            out(`  ok    ${name}`);
        }
    }

    const takenHandles = all.map((p) => p.handle);
    const takenNumbers = Array.from(numbers.keys());
    return { count: all.length, unbound, unpublished, noAlt, dupes, takenHandles, takenNumbers };
}

// ── main ─────────────────────────────────────────────────────────────────────

(async () => {
    if (!shopify.isConfigured()) {
        console.error('Shopify is not configured. Missing: ' + shopify.missingConfig().join(', '));
        console.error('\nErik: create the "253Gear Publisher" custom app in the Shopify Dev Dashboard');
        console.error('(scopes write_products, read_products, read_publications), then set:');
        console.error('  SHOPIFY_SHOP_DOMAIN=nw-custom-apparel.myshopify.com');
        console.error('  SHOPIFY_CLIENT_ID=…');
        console.error('  SHOPIFY_CLIENT_SECRET=…');
        process.exit(1);
    }

    const results = {};
    try {
        out(`Inspecting ${shopify.shopDomain()} (Admin API ${shopify.apiVersion()}) — READ ONLY`);
        results.shop = (await shopify.gql('{ shop { name myshopifyDomain primaryDomain { url } } }')).shop;
        out(`Connected: ${results.shop.name} — ${results.shop.primaryDomain.url}`);

        results.schema = await introspect();
        const c = await collections();
        results.collections = c.collections;
        results.tagVocabulary = c.tagVocabulary;
        results.model = await modelProduct();
        results.publications = await publications();
        results.catalogue = await catalogue();

        if (designNumber) {
            rule(`6. Design #${designNumber}`);
            const hit = await shopify.gql(
                'query($q:String!){ products(first:5, query:$q){ nodes{ id title handle status publishedAt } } }',
                { q: `title:*#${designNumber}*` }
            );
            results.designLookup = hit.products.nodes;
            if (!hit.products.nodes.length) out('  Not found — this design number is free.');
            for (const p of hit.products.nodes) out(`  ${p.title}  (${p.status}, publishedAt ${p.publishedAt})  ${p.handle}`);
        }

        rule('NEXT');
        out('  Paste the derived tag vocabulary and publication id into Shopify_Config_2026,');
        out('  and correct the builder if any ProductSetInput assumption came back MISSING.');

        if (asJson) console.log(JSON.stringify(results, null, 2));
        process.exit(0);
    } catch (err) {
        console.error(`\nFAILED: ${shopify.redactShopify(err)}`);
        if (err.userErrors) console.error(JSON.stringify(err.userErrors, null, 2));
        process.exit(1);
    }
})();
