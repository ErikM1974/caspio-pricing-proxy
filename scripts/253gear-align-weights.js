#!/usr/bin/env node
/**
 * Align live variant shipping weights to the configured table.
 *
 *   node scripts/253gear-align-weights.js                        # dry run, WHOLE catalogue
 *   node scripts/253gear-align-weights.js --product 6137787383964 --live
 *
 * Weights come from `weightFor()` reading the same Caspio config the publisher uses,
 * which is itself SanMar's PIECE_WEIGHT (heaviest colourway per size, lb -> g). Nothing
 * is hand-typed; correcting a weight in Caspio corrects new products AND this alignment.
 *
 * WHY IT MATTERS. An under-stated weight under-quotes shipping on every order of that
 * variant, forever, and nothing surfaces it — the order just earns less. The long-sleeve
 * tee was carrying the SHORT-sleeve weights, 46-82 g light on every size.
 *
 * Same guards as the price script: dry run by default, `--live` refuses without a named
 * product, only the weight field is touched, and the result is re-read rather than
 * trusting the mutation's own response.
 */

require('dotenv').config();
const shopify = require('./../src/utils/shopify-client');
const { loadConfig } = require('./../src/utils/shopify-config');
const { weightFor } = require('./../src/utils/shopify-product-builder');

const Q = `
query {
  products(first: 100, query: "status:active") {
    nodes {
      id legacyResourceId title
      variants(first: 100) {
        nodes {
          id sku selectedOptions { name value }
          inventoryItem { id measurement { weight { value unit } } }
        }
      }
    }
  }
}`;

const M = `
mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants { id inventoryItem { measurement { weight { value unit } } } }
    userErrors { field message code }
  }
}`;

const opt = (v, n) => {
    const o = (v.selectedOptions || []).find((x) => x.name === n);
    return o ? o.value : '';
};
const argValue = (f) => {
    const i = process.argv.indexOf(f);
    return i > -1 ? process.argv[i + 1] : null;
};

async function main() {
    const live = process.argv.includes('--live');
    const only = argValue('--product');

    if (live && !only) {
        console.error('\n✖ --live requires --product <legacyId>. Re-weighing the whole catalogue');
        console.error('  in one command should not be possible by momentum.');
        process.exit(1);
    }
    if (!shopify.isConfigured()) {
        console.error('Shopify not configured:', shopify.missingConfig().join(', '));
        process.exit(1);
    }

    const cfg = await loadConfig({ refresh: true });
    const data = await shopify.gql(Q, {}, { isMutation: false });
    let products = (data.products && data.products.nodes) || [];
    if (only) products = products.filter((p) => String(p.legacyResourceId) === String(only));

    const plan = [];
    const skipped = new Set();

    for (const p of products) {
        const fixes = [];
        for (const v of p.variants.nodes) {
            const style = opt(v, 'Style');
            const size = opt(v, 'Size');
            if (!style || !size) continue;
            let want;
            try { want = weightFor(style, size, cfg); } catch (e) { skipped.add(style); continue; }
            const cur = v.inventoryItem && v.inventoryItem.measurement && v.inventoryItem.measurement.weight;
            const curVal = cur ? Number(cur.value) : null;
            const curUnit = cur ? cur.unit : null;
            if (curVal !== want || curUnit !== 'GRAMS') {
                fixes.push({ id: v.id, style, size, from: curVal, unit: curUnit, to: want });
            }
        }
        if (fixes.length) plan.push({ product: p, fixes });
    }

    if (skipped.size) console.log(`\nnote: no configured weight for ${[...skipped].join(', ')} — skipped, not guessed.`);

    if (!plan.length) {
        console.log('\n✔ Every variant already carries its configured weight.');
        return;
    }

    let n = 0;
    for (const { product, fixes } of plan) {
        console.log(`\n${product.title}  (${product.legacyResourceId})`);
        const byStyle = {};
        for (const f of fixes) (byStyle[f.style] = byStyle[f.style] || []).push(f);
        for (const [style, list] of Object.entries(byStyle)) {
            console.log(`   ${style} — ${list.length} variant(s)`);
            for (const f of list) {
                const d = f.from === null ? 'unset' : `${f.to - f.from > 0 ? '+' : ''}${f.to - f.from} g`;
                console.log(`      ${f.size.padEnd(4)} ${String(f.from).padStart(4)} ${f.unit || ''} -> ${String(f.to).padStart(4)} GRAMS   (${d})`);
                n++;
            }
        }
    }
    console.log(`\n${n} variant(s) across ${plan.length} product(s).`);

    if (!live) {
        console.log('\nDry run. Re-run with --product <legacyId> --live to apply to ONE product.');
        return;
    }

    for (const { product, fixes } of plan) {
        await shopify.gql(M, {
            productId: product.id,
            variants: fixes.map((f) => ({
                id: f.id,
                inventoryItem: { measurement: { weight: { value: f.to, unit: 'GRAMS' } } }
            }))
        });
        console.log(`✔ re-weighed ${fixes.length} variant(s) on ${product.title}`);
    }

    const after = await shopify.gql(Q, {}, { isMutation: false });
    let remaining = 0;
    for (const p of (after.products.nodes || []).filter((x) => String(x.legacyResourceId) === String(only))) {
        for (const v of p.variants.nodes) {
            const style = opt(v, 'Style'), size = opt(v, 'Size');
            try {
                const want = weightFor(style, size, cfg);
                const cur = v.inventoryItem?.measurement?.weight;
                if (!cur || Number(cur.value) !== want || cur.unit !== 'GRAMS') remaining++;
            } catch (e) { /* unpriced style */ }
        }
    }
    if (remaining) {
        console.error(`\n✖ ${remaining} variant(s) still off the configured weight.`);
        process.exit(1);
    }
    console.log('\n✔ Verified by re-reading: every variant carries its configured weight in grams.');
}

main().catch((e) => {
    console.error('\nFAILED:', shopify.redactShopify(e));
    process.exit(1);
});
