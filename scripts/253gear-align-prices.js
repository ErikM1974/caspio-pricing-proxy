#!/usr/bin/env node
/**
 * Align live variant prices to the configured ladder.
 *
 *   node scripts/253gear-align-prices.js                       # dry run, WHOLE catalogue
 *   node scripts/253gear-align-prices.js --product 6137787383964
 *   node scripts/253gear-align-prices.js --product 6137787383964 --live
 *
 * Prices are computed with the SAME priceFor() the publisher uses, reading the same
 * Erik-editable Caspio config. Nothing is hand-typed here — if a number is wrong, it is
 * wrong in one place, and fixing it there fixes both new products and this alignment.
 *
 * 🔴 THIS CHANGES WHAT A CUSTOMER PAYS on live, published products. Dry run is the
 * default and prints the direction of every change. `--live` alone is refused: a target
 * product must be named, so a catalogue-wide reprice can never happen by momentum.
 *
 * Only the price field is touched. SKUs, weights, images, options and status are left
 * exactly as they are.
 */

require('dotenv').config();
const shopify = require('./../src/utils/shopify-client');
const { loadConfig } = require('./../src/utils/shopify-config');
const { priceFor, baseStyleOption } = require('./../src/utils/shopify-product-builder');

const Q_PRODUCTS = `
query {
  products(first: 100, query: "status:active") {
    nodes {
      id legacyResourceId title status
      variants(first: 100) { nodes { id sku price selectedOptions { name value } } }
    }
  }
}`;

const M_BULK_UPDATE = `
mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants { id price }
    userErrors { field message code }
  }
}`;

const opt = (v, name) => {
    const o = (v.selectedOptions || []).find((x) => x.name === name);
    return o ? o.value : '';
};

function argValue(flag) {
    const i = process.argv.indexOf(flag);
    return i > -1 ? process.argv[i + 1] : null;
}

async function main() {
    const live = process.argv.includes('--live');
    const only = argValue('--product');

    if (live && !only) {
        console.error('\n✖ --live requires --product <legacyId>.');
        console.error('  Repricing the whole catalogue in one command is not something that should');
        console.error('  be possible by accident. Run the dry run, pick a product, then apply.');
        process.exit(1);
    }
    if (!shopify.isConfigured()) {
        console.error('Shopify not configured. Missing:', shopify.missingConfig().join(', '));
        process.exit(1);
    }

    const cfg = await loadConfig({ refresh: true });
    const data = await shopify.gql(Q_PRODUCTS, {}, { isMutation: false });
    let products = (data.products && data.products.nodes) || [];
    if (only) products = products.filter((p) => String(p.legacyResourceId) === String(only));

    const plan = [];
    let unknownStyles = new Set();
    const aliased = new Set();

    for (const p of products) {
        const fixes = [];
        for (const v of p.variants.nodes) {
            const style = opt(v, 'Style');
            const size = opt(v, 'Size');
            if (!style || !size) continue;
            let expected;
            try {
                expected = priceFor(style, size, cfg);
            } catch (e) {
                unknownStyles.add(style);      // a garment this config does not price
                continue;
            }
            // A Style like "T-Shirt - Royal" resolves through baseStyleOption() to the plain
            // T-Shirt price. That is right for a colour suffix and WRONG for anything implying
            // a different garment or grade ("T-Shirt - Premium" would silently price as a plain
            // tee). priceFor cannot tell the two apart, so surface it here: this script is the
            // only path that would actually rewrite a customer-facing price, and a human reads
            // this dry run before --live.
            if (style !== baseStyleOption(style) && !(cfg.prices || {})[style]) {
                aliased.add(`${style}  ->  priced as "${baseStyleOption(style)}"`);
            }
            if (String(v.price) !== expected) {
                fixes.push({ id: v.id, style, size, from: v.price, to: expected });
            }
        }
        if (fixes.length) plan.push({ product: p, fixes });
    }

    if (unknownStyles.size) {
        console.log(`\nnote: no configured price for ${[...unknownStyles].join(', ')} — those variants were skipped, not guessed.`);
    }

    if (aliased.size) {
        console.log('\n⚠️  Style(s) priced through the colour-suffix fallback. Confirm each suffix is a');
        console.log('    COLOUR and not a different garment or grade — "T-Shirt - Premium" would be');
        console.log('    priced as a plain tee, and this script is the one path that rewrites what a');
        console.log('    customer pays:');
        [...aliased].forEach((a) => console.log(`      ${a}`));
    }

    if (!plan.length) {
        console.log('\n✔ Every priced variant already matches the configured ladder.');
        return;
    }

    let up = 0, down = 0;
    for (const { product, fixes } of plan) {
        console.log(`\n${product.title}  (${product.legacyResourceId})`);
        const byStyle = {};
        for (const f of fixes) (byStyle[f.style] = byStyle[f.style] || []).push(f);
        for (const [style, list] of Object.entries(byStyle)) {
            const dir = Number(list[0].to) > Number(list[0].from) ? 'UP' : 'DOWN';
            const delta = (Number(list[0].to) - Number(list[0].from)).toFixed(2);
            console.log(`   ${style} — ${list.length} variant(s), ${dir} ${delta > 0 ? '+' : ''}${delta}`);
            for (const f of list) {
                console.log(`      ${f.size.padEnd(4)} $${f.from}  ->  $${f.to}`);
                if (Number(f.to) > Number(f.from)) up++; else down++;
            }
        }
    }
    console.log(`\n${up + down} variant(s) across ${plan.length} product(s): ${up} increase, ${down} decrease.`);

    if (!live) {
        console.log('\nDry run. Re-run with --product <legacyId> --live to apply to ONE product.');
        return;
    }

    for (const { product, fixes } of plan) {
        await shopify.gql(M_BULK_UPDATE, {
            productId: product.id,
            variants: fixes.map((f) => ({ id: f.id, price: f.to }))
        });
        console.log(`✔ repriced ${fixes.length} variant(s) on ${product.title}`);
    }

    // Re-read and assert, rather than trusting the mutation's response.
    const after = await shopify.gql(Q_PRODUCTS, {}, { isMutation: false });
    const target = (after.products.nodes || []).filter((p) => String(p.legacyResourceId) === String(only));
    let remaining = 0, bound = 0, totalVariants = 0;
    for (const p of target) {
        for (const v of p.variants.nodes) {
            const style = opt(v, 'Style'), size = opt(v, 'Size');
            totalVariants++;
            try { if (String(v.price) !== priceFor(style, size, cfg)) remaining++; } catch (e) { /* unpriced style */ }
        }
    }
    if (remaining) {
        console.error(`\n✖ ${remaining} variant(s) still off the ladder.`);
        process.exit(1);
    }
    console.log('\n✔ Verified by re-reading: every priced variant matches the ladder.');
}

main().catch((e) => {
    console.error('\nFAILED:', shopify.redactShopify(e));
    process.exit(1);
});
