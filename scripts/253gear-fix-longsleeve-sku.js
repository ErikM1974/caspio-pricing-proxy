#!/usr/bin/env node
/**
 * Correct the SKU on Long Sleeve Tee variants that carry the SHORT-sleeve style.
 *
 *   node scripts/253gear-fix-longsleeve-sku.js          # dry run — shows the diff
 *   node scripts/253gear-fix-longsleeve-sku.js --live   # apply
 *
 * THE DEFECT. Long Sleeve Tee variants were created with PC54 / PC54_2XL — the
 * SHORT-sleeve SanMar style. The long sleeve is PC55LS. Downstream systems key on the
 * SKU, so a long-sleeve line reads as a short-sleeve garment.
 *
 * 🔴 WHY THIS IS NARROW ON PURPOSE. The affected product carries all four styles, and
 * its T-Shirt variants use PC54 **correctly**. A blanket find-and-replace of PC54 on
 * this product would corrupt the seven rows that are right in order to fix the seven
 * that are wrong. Selection is therefore by the Style option value, never by SKU.
 *
 * Touches SKU only. Prices, weights, images, options and status are left exactly as
 * they are — several of those differ from the current config on this product, and
 * reconciling them is a separate decision, not a side effect of a SKU fix.
 */

require('dotenv').config();
const shopify = require('./../src/utils/shopify-client');

const STYLE_OPTION = 'Long Sleeve Tee';
const WRONG_BASE = 'PC54';
const RIGHT_BASE = 'PC55LS';

const Q_PRODUCTS = `
query {
  products(first: 100, query: "status:active") {
    nodes {
      id legacyResourceId title
      variants(first: 100) {
        nodes { id sku selectedOptions { name value } }
      }
    }
  }
}`;

const M_BULK_UPDATE = `
mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants { id sku }
    userErrors { field message code }
  }
}`;

/** PC54 -> PC55LS, PC54_2XL -> PC55LS_2XL. Anything else is left alone. */
function correctSku(sku) {
    const s = String(sku || '');
    if (s === WRONG_BASE) return RIGHT_BASE;
    const m = s.match(new RegExp(`^${WRONG_BASE}_(.+)$`));
    return m ? `${RIGHT_BASE}_${m[1]}` : null;
}

function styleOf(variant) {
    const o = (variant.selectedOptions || []).find((x) => x.name === 'Style');
    return o ? o.value : '';
}

function sizeOf(variant) {
    const o = (variant.selectedOptions || []).find((x) => x.name === 'Size');
    return o ? o.value : '';
}

function argValue(flag) {
    const i = process.argv.indexOf(flag);
    return i > -1 ? process.argv[i + 1] : null;
}

async function main() {
    const live = process.argv.includes('--live');
    const only = argValue('--product');

    // Written before the sibling align scripts established this guard, and it was the only
    // one that would rewrite SKUs across the whole catalogue from a bare --live.
    if (live && !only) {
        console.error('\n✖ --live requires --product <legacyId>.');
        console.error('  Rewriting SKUs catalogue-wide should not be possible by momentum.');
        process.exit(1);
    }

    if (!shopify.isConfigured()) {
        console.error('Shopify not configured. Missing:', shopify.missingConfig().join(', '));
        process.exit(1);
    }

    const data = await shopify.gql(Q_PRODUCTS, {}, { isMutation: false });
    let products = (data.products && data.products.nodes) || [];
    if (only) products = products.filter((x) => String(x.legacyResourceId) === String(only));

    const plan = [];
    for (const p of products) {
        const fixes = [];
        for (const v of p.variants.nodes) {
            if (styleOf(v) !== STYLE_OPTION) continue;      // selection is by STYLE, never by SKU
            const next = correctSku(v.sku);
            if (next && next !== v.sku) fixes.push({ id: v.id, from: v.sku, to: next, size: sizeOf(v) });
        }
        if (fixes.length) plan.push({ product: p, fixes });
    }

    if (!plan.length) {
        console.log('\n✔ Nothing to fix — no Long Sleeve Tee variant carries a PC54 SKU.');
        return;
    }

    let total = 0;
    for (const { product, fixes } of plan) {
        console.log(`\n${product.title}`);
        // Show what is deliberately NOT touched, so the narrowness is visible.
        const untouched = product.variants.nodes
            .filter((v) => styleOf(v) !== STYLE_OPTION && String(v.sku).startsWith(WRONG_BASE));
        for (const f of fixes) {
            console.log(`   ${String(f.size).padEnd(4)} ${f.from.padEnd(10)} -> ${f.to}`);
            total++;
        }
        if (untouched.length) {
            console.log(`   (leaving ${untouched.length} ${untouched[0] && styleOf(untouched[0])} variant(s) on ${WRONG_BASE} — correct for that garment)`);
        }
    }
    console.log(`\n${total} variant(s) to correct across ${plan.length} product(s).`);

    if (!live) {
        console.log('\nDry run. Re-run with --live to apply.');
        return;
    }

    for (const { product, fixes } of plan) {
        await shopify.gql(M_BULK_UPDATE, {
            productId: product.id,
            variants: fixes.map((f) => ({ id: f.id, inventoryItem: { sku: f.to } }))
        });
        console.log(`✔ updated ${fixes.length} variant(s) on ${product.title}`);
    }

    // Re-read and assert, rather than trusting the mutation's own response.
    const after = await shopify.gql(Q_PRODUCTS, {}, { isMutation: false });
    let remaining = 0;
    for (const p of (after.products && after.products.nodes) || []) {
        for (const v of p.variants.nodes) {
            if (styleOf(v) === STYLE_OPTION && correctSku(v.sku)) remaining++;
        }
    }
    if (remaining) {
        console.error(`\n✖ ${remaining} Long Sleeve variant(s) STILL carry a ${WRONG_BASE} SKU.`);
        process.exit(1);
    }
    console.log('\n✔ Verified by re-reading: no Long Sleeve Tee variant carries a PC54 SKU.');
}

main().catch((e) => {
    console.error('\nFAILED:', shopify.redactShopify(e));
    process.exit(1);
});
