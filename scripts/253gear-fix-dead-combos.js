#!/usr/bin/env node
/**
 * Remove option combinations the dropdowns offer but no variant backs.
 *
 *   node scripts/253gear-fix-dead-combos.js --product 5762255585436
 *   node scripts/253gear-fix-dead-combos.js --product 5762255585436 --live
 *
 * THE DEFECT. Shopify options are PRODUCT-level: every value of Colour is offered for
 * every value of Style. A design sold as "tee in Royal, hoodie in Navy" therefore also
 * advertises a Navy tee and a Royal hoodie — and the theme does no availability filtering
 * (product-template.CURRENT.liquid:201-226), so the shopper picks one and gets
 * "Unavailable" with a dead Add to Cart. Confirmed live on four products, each selling 14
 * variants where the dropdowns offered 28. Half of every one of them was unbuyable.
 *
 * TWO SHAPES OF FIX, declared per product in 253gear-dead-combo-plan.json:
 *
 *   "recolour" — every garment becomes ONE colour. Moves the variants onto that colour and
 *                drops the others, so Colour survives as a single-value option (the theme
 *                renders it as static text, not a dropdown).
 *
 *   "foldIntoStyle" — each garment keeps its OWN colour, which a shared dropdown cannot
 *                express. The colour moves into the Style value ("T-Shirt - Royal") and the
 *                Colour option is deleted. Config lookups still resolve via
 *                baseStyleOption() in shopify-product-builder.js, so price, weight, SKU and
 *                filter tags keep working — otherwise the product would silently stop being
 *                covered by every align script.
 *
 * 🔴 The Colour option is deleted with NON_DESTRUCTIVE, which REFUSES rather than deleting
 * variants. If the rename left two variants colliding on (Style, Size), this aborts instead
 * of destroying inventory rows.
 *
 * Dry run by default; --live requires --product. Re-reads and asserts afterwards.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const shopify = require('./../src/utils/shopify-client');

const PLAN_PATH = path.join(__dirname, '253gear-dead-combo-plan.json');

const Q = `
query($id: ID!) {
  product(id: $id) {
    id legacyResourceId title handle
    options { id name position optionValues { id name } }
    media(first: 50) { nodes { id alt ... on MediaImage { image { url } } } }
    variants(first: 250) { nodes { id sku image { id url } selectedOptions { name value } } }
  }
}`;

const M_VARIANTS = `
mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants { id title }
    userErrors { field message code }
  }
}`;

const M_OPTION_UPDATE = `
mutation($productId: ID!, $option: OptionUpdateInput!, $toUpdate: [OptionValueUpdateInput!],
         $toDelete: [ID!], $strategy: ProductOptionUpdateVariantStrategy!) {
  productOptionUpdate(productId: $productId, option: $option, optionValuesToUpdate: $toUpdate,
                      optionValuesToDelete: $toDelete, variantStrategy: $strategy) {
    product { id options { name optionValues { name } } }
    userErrors { field message code }
  }
}`;

const M_OPTIONS_DELETE = `
mutation($productId: ID!, $options: [ID!]!, $strategy: ProductOptionDeleteStrategy!) {
  productOptionsDelete(productId: $productId, options: $options, strategy: $strategy) {
    product { id options { name optionValues { name } } }
    userErrors { field message code }
  }
}`;

const M_DELETE_MEDIA = `
mutation($productId: ID!, $mediaIds: [ID!]!) {
  productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
    deletedMediaIds
    mediaUserErrors { field message code }
    product { id }
  }
}`;

const opt = (v, n) => ((v.selectedOptions || []).find((o) => o.name === n) || {}).value || '';
const fileOf = (u) => String(u || '').split('?')[0].split('/').pop();
const argValue = (f) => {
    const i = process.argv.indexOf(f);
    return i > -1 ? process.argv[i + 1] : null;
};

async function main() {
    const live = process.argv.includes('--live');
    const only = argValue('--product');

    if (!only) {
        console.error('\n✖ --product <legacyId> is required. Plans live in 253gear-dead-combo-plan.json.');
        process.exit(1);
    }
    if (!shopify.isConfigured()) {
        console.error('Shopify not configured:', shopify.missingConfig().join(', '));
        process.exit(1);
    }

    const plans = JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8'));
    const plan = plans[String(only)];
    if (!plan) {
        console.error(`\n✖ No plan for ${only}. Every change here is declared, never inferred.`);
        process.exit(1);
    }

    const gid = `gid://shopify/Product/${only}`;
    const p = (await shopify.gql(Q, { id: gid }, { isMutation: false })).product;
    if (!p) { console.error(`\n✖ Product ${only} not found.`); process.exit(1); }

    console.log(`\n${p.title}  (${p.legacyResourceId})   /products/${p.handle}`);
    console.log(`plan: ${plan.mode} — ${plan.why}`);

    const colourOpt = p.options.find((o) => o.name === 'Color');
    const styleOpt = p.options.find((o) => o.name === 'Style');
    const before = {};
    for (const v of p.variants.nodes) {
        const k = `${opt(v, 'Style')} | ${opt(v, 'Color')}`;
        before[k] = (before[k] || 0) + 1;
    }
    console.log('\nNOW:');
    Object.entries(before).forEach(([k, n]) => console.log(`   ${k.padEnd(34)} ${n} size(s)`));
    const offered = (styleOpt ? styleOpt.optionValues.length : 1) * (colourOpt ? colourOpt.optionValues.length : 1);
    console.log(`   dropdowns offer ${offered} combination(s); ${Object.keys(before).length} exist`);

    const steps = [];
    let variantUpdates = [];
    let mediaToDelete = [];

    if (plan.mode === 'recolour') {
        if (!colourOpt) { console.error('\n✖ No Colour option to recolour.'); process.exit(1); }
        const keep = plan.colour;
        if (!colourOpt.optionValues.some((v) => v.name === keep)) {
            console.error(`\n✖ "${keep}" is not a current Colour value.`); process.exit(1);
        }
        variantUpdates = p.variants.nodes
            .filter((v) => opt(v, 'Color') !== keep)
            .map((v) => ({ id: v.id, optionValues: [{ optionName: 'Color', name: keep }] }));
        const drop = colourOpt.optionValues.filter((v) => v.name !== keep);
        steps.push(`move ${variantUpdates.length} variant(s) to Colour "${keep}"`);
        if (drop.length) steps.push(`delete Colour value(s): ${drop.map((d) => d.name).join(', ')}`);
        plan._drop = drop;
    } else if (plan.mode === 'foldIntoStyle') {
        if (!styleOpt) { console.error('\n✖ No Style option to fold into.'); process.exit(1); }
        const renames = [];
        for (const sv of styleOpt.optionValues) {
            const to = plan.styleRenames[sv.name];
            if (!to) { console.error(`\n✖ No rename declared for Style "${sv.name}".`); process.exit(1); }
            if (to !== sv.name) renames.push({ id: sv.id, name: to });
        }
        plan._renames = renames;
        steps.push(...renames.map((r) => `rename Style value -> "${r.name}"`));
        if (colourOpt) steps.push(`delete the Colour option (${colourOpt.optionValues.map((v) => v.name).join(', ')}) — NON_DESTRUCTIVE`);
    } else {
        console.error(`\n✖ Unknown mode "${plan.mode}".`); process.exit(1);
    }

    if (Array.isArray(plan.deleteMediaMatching) && plan.deleteMediaMatching.length) {
        mediaToDelete = p.media.nodes.filter((m) =>
            m.image && plan.deleteMediaMatching.some((frag) => fileOf(m.image.url).includes(frag)));
        const bound = new Set(p.variants.nodes.filter((v) => v.image).map((v) => fileOf(v.image.url)));
        for (const m of mediaToDelete) {
            const stillBound = bound.has(fileOf(m.image.url));
            steps.push(`DELETE photo ${fileOf(m.image.url).slice(0, 48)}${stillBound ? '   ⚠️ currently bound to variants' : ''}`);
        }
        const remaining = p.media.nodes.length - mediaToDelete.length;
        if (remaining === 0) { console.error('\n✖ That would leave the product with no photos at all.'); process.exit(1); }
    }

    console.log('\nWILL DO:');
    steps.forEach((s) => console.log(`   - ${s}`));

    // Predict the end state so the dry run shows the actual consequence.
    const after = {};
    for (const v of p.variants.nodes) {
        let st = opt(v, 'Style'), co = opt(v, 'Color');
        if (plan.mode === 'recolour') co = plan.colour;
        if (plan.mode === 'foldIntoStyle') { st = plan.styleRenames[st] || st; co = null; }
        const k = co ? `${st} | ${co}` : st;
        after[k] = (after[k] || 0) + 1;
    }
    console.log('\nAFTER:');
    Object.entries(after).forEach(([k, n]) => console.log(`   ${k.padEnd(34)} ${n} size(s)`));
    const afterOffered = plan.mode === 'foldIntoStyle'
        ? Object.keys(after).length
        : Object.keys(after).length;
    console.log(`   dropdowns will offer ${afterOffered}; ${Object.keys(after).length} exist  ->  ${afterOffered === Object.keys(after).length ? 'NO dead ends' : 'STILL has dead ends'}`);

    if (!live) {
        console.log(`\nDry run. Re-run with --product ${only} --live to apply.`);
        return;
    }

    if (variantUpdates.length) {
        for (let i = 0; i < variantUpdates.length; i += 100) {
            await shopify.gql(M_VARIANTS, { productId: gid, variants: variantUpdates.slice(i, i + 100) });
        }
        console.log(`✔ moved ${variantUpdates.length} variant(s)`);
    }
    if (plan.mode === 'recolour' && plan._drop.length) {
        await shopify.gql(M_OPTION_UPDATE, {
            productId: gid, option: { id: colourOpt.id },
            toUpdate: null, toDelete: plan._drop.map((d) => d.id), strategy: 'LEAVE_AS_IS'
        });
        console.log(`✔ dropped ${plan._drop.length} unused Colour value(s)`);
    }
    if (plan.mode === 'foldIntoStyle') {
        if (plan._renames.length) {
            await shopify.gql(M_OPTION_UPDATE, {
                productId: gid, option: { id: styleOpt.id },
                toUpdate: plan._renames.map((r) => ({ id: r.id, name: r.name })),
                toDelete: null, strategy: 'LEAVE_AS_IS'
            });
            console.log(`✔ renamed ${plan._renames.length} Style value(s)`);
        }
        if (colourOpt) {
            // NON_DESTRUCTIVE: succeeds only if no variant would be deleted.
            await shopify.gql(M_OPTIONS_DELETE, {
                productId: gid, options: [colourOpt.id], strategy: 'NON_DESTRUCTIVE'
            });
            console.log('✔ removed the Colour option');
        }
    }
    if (mediaToDelete.length) {
        await shopify.gql(M_DELETE_MEDIA, { productId: gid, mediaIds: mediaToDelete.map((m) => m.id) });
        console.log(`✔ deleted ${mediaToDelete.length} photo(s)`);
    }

    // ── Re-read and assert.
    const now = (await shopify.gql(Q, { id: gid }, { isMutation: false })).product;
    const combos = new Set();
    for (const v of now.variants.nodes) combos.add(now.options.map((o) => opt(v, o.name)).join(' | '));
    const offeredNow = now.options.reduce((n, o) => n * o.optionValues.length, 1);
    console.log('\nRESULT:');
    now.options.forEach((o) => console.log(`   ${o.name}: ${o.optionValues.map((v) => v.name).join(', ')}`));
    console.log(`   ${now.variants.nodes.length} variants, ${combos.size} distinct combination(s), dropdowns offer ${offeredNow}`);
    if (offeredNow !== combos.size) {
        console.error(`\n✖ STILL has ${offeredNow - combos.size} dead combination(s).`);
        process.exit(1);
    }
    const unbound = now.variants.nodes.filter((v) => !v.image);
    if (unbound.length) {
        console.log(`\n⚠️  ${unbound.length} variant(s) now have NO photo: ${[...new Set(unbound.map((v) => opt(v, now.options[0].name)))].join(', ')}`);
        console.log('   They will fall back to the product\'s first image until a real photo is bound.');
    }
    console.log('\n✔ Verified by re-reading: every offered combination has a variant behind it.');
}

main().catch((e) => {
    console.error('\nFAILED:', shopify.redactShopify(e));
    process.exit(1);
});
