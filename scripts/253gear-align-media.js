#!/usr/bin/env node
/**
 * Bind every (Style x Colour) pair to its own photo, and fix media alt text.
 *
 *   node scripts/253gear-align-media.js                          # audit WHOLE catalogue
 *   node scripts/253gear-align-media.js --product 6123423367324  # dry run one product
 *   node scripts/253gear-align-media.js --product 6123423367324 --live
 *
 * THE DEFECT. Variants on the older products are bound to a photo by Style ALONE, so Colour does
 * not change the picture. A shopper picks Charcoal, is shown Athletic Heather, and buys on that
 * photo. Measured 2026-08-07: 6 of the 7 active multi-colour products had it, and in two of them
 * the correct photo was already uploaded and simply bound to nothing.
 *
 * 🔴 THE MAP IS EXPLICIT, NEVER INFERRED. Bindings come from scripts/253gear-media-maps.json,
 * keyed by product id. Filenames cannot be trusted: two of Spanaway's photos are named 34082 for
 * design 34084, and the lifestyle shots are stock files with no colour in the name at all.
 *
 * 🔴 MEDIA ORDER IS LOAD-BEARING. An unbound photo has no options of its own — the theme hands it
 * the options of the nearest preceding BOUND photo (product-template.CURRENT.liquid:393-402). Put
 * a heather-hoodie lifestyle shot after the charcoal hoodie and clicking it switches the shopper to
 * Charcoal. This script simulates that walk and refuses to apply if the map's `productLevel`
 * declaration disagrees with where the photo actually sits.
 *
 * Same guards as the sibling align scripts: dry run by default, `--live` refused without a named
 * product, and the result re-read and asserted rather than trusting the mutation's own response.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const shopify = require('./../src/utils/shopify-client');

const MAPS_PATH = path.join(__dirname, '253gear-media-maps.json');

const Q = `
query($id: ID!) {
  product(id: $id) {
    id legacyResourceId title
    options { name optionValues { name } }
    media(first: 50) { nodes { id alt ... on MediaImage { image { url width height } } } }
    variants(first: 100) { nodes { id image { url } selectedOptions { name value } } } }
}`;

const Q_ALL = `
query {
  products(first: 100, query: "status:active") {
    nodes {
      legacyResourceId title
      options { name optionValues { name } }
      variants(first: 100) { nodes { image { url } selectedOptions { name value } } }
    }
  }
}`;

const M_BIND = `
mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants { id }
    userErrors { field message code }
  }
}`;

const M_ALT = `
mutation($files: [FileUpdateInput!]!) {
  fileUpdate(files: $files) { files { id alt } userErrors { field message code } }
}`;

const M_REORDER = `
mutation($id: ID!, $moves: [MoveInput!]!) {
  productReorderMedia(id: $id, moves: $moves) {
    job { id done }
    userErrors { field message }   # UserError, NOT MediaUserError — it has no 'code'
  }
}`;

const Q_JOB = `query($id: ID!) { job(id: $id) { id done } }`;

const opt = (v, n) => {
    const o = (v.selectedOptions || []).find((x) => x.name === n);
    return o ? o.value : '';
};
const pairOf = (v) => `${opt(v, 'Style') || '(single)'}|${opt(v, 'Color') || '(single)'}`;
const fileOf = (u) => String(u || '').split('?')[0].split('/').pop();
const argValue = (f) => {
    const i = process.argv.indexOf(f);
    return i > -1 ? process.argv[i + 1] : null;
};

/**
 * Reproduce the theme's inheritance walk so an unbound photo's real behaviour is visible here
 * rather than only on the live page. Mirrors product-template.CURRENT.liquid:393-402.
 */
function inheritedOptions(mediaList, boundPairByPosition) {
    const out = {};
    let last = null, firstKnown = null;
    for (const m of mediaList) {
        const decided = boundPairByPosition[m.n];
        if (decided) { last = decided; if (!firstKnown) firstKnown = decided; }
        out[m.n] = decided || last;
    }
    for (const m of mediaList) if (!out[m.n]) out[m.n] = firstKnown;
    return out;
}

/** Which (Style x Colour) pairs share one photo — the defect, in one number. */
function colourBlindPairs(variants) {
    const byPair = {};
    for (const v of variants) if (v.image) byPair[pairOf(v)] = fileOf(v.image.url);
    const byStyle = {};
    for (const [pair, f] of Object.entries(byPair)) {
        const st = pair.split('|')[0];
        (byStyle[st] = byStyle[st] || new Set()).add(f);
    }
    const colours = new Set(Object.keys(byPair).map((p) => p.split('|')[1]));
    if (colours.size < 2) return [];
    return Object.entries(byStyle).filter(([, s]) => s.size === 1).map(([st]) => st);
}

async function auditCatalogue() {
    const d = await shopify.gql(Q_ALL, {}, { isMutation: false });
    const bad = [];
    for (const p of d.products.nodes) {
        const colours = (p.options.find((o) => o.name === 'Color') || { optionValues: [] }).optionValues.length;
        if (colours < 2) continue;
        const blind = colourBlindPairs(p.variants.nodes);
        if (blind.length) bad.push({ p, blind, colours });
    }
    console.log(`\nActive products with more than one colour where colour does NOT change the photo: ${bad.length}`);
    for (const { p, blind, colours } of bad) {
        console.log(`   ${p.legacyResourceId}  ${colours} colours, ${blind.join(' + ')} share one photo   ${p.title}`);
    }
    console.log('\nAdd a map for a product to scripts/253gear-media-maps.json, then run with --product <id>.');
    return bad.length;
}

async function main() {
    const live = process.argv.includes('--live');
    const only = argValue('--product');

    if (live && !only) {
        console.error('\n✖ --live requires --product <legacyId>. Re-binding the whole catalogue in one');
        console.error('  command should not be possible by momentum.');
        process.exit(1);
    }
    if (!shopify.isConfigured()) {
        console.error('Shopify not configured:', shopify.missingConfig().join(', '));
        process.exit(1);
    }

    if (!only) { await auditCatalogue(); return; }

    const maps = JSON.parse(fs.readFileSync(MAPS_PATH, 'utf8'));
    const map = maps[String(only)];
    if (!map) {
        console.error(`\n✖ No map for product ${only} in ${path.basename(MAPS_PATH)}.`);
        console.error('  Bindings are declared, never inferred from filenames. Run without --product');
        console.error('  to list what needs one, then add an entry.');
        process.exit(1);
    }

    const gid = `gid://shopify/Product/${only}`;
    const d = await shopify.gql(Q, { id: gid }, { isMutation: false });
    const p = d.product;
    if (!p) { console.error(`\n✖ Product ${only} not found.`); process.exit(1); }

    console.log(`\n${p.title}  (${p.legacyResourceId})`);

    // ── Apply `order` IN MEMORY first, so everything below — the preview, the inheritance check,
    //    the alt map — speaks about the order the product will END UP in. An earlier version
    //    validated against the pre-reorder list and printed bindings that were plainly wrong; a
    //    dry run that describes a state which will never exist is worse than no dry run.
    //    `order` lists CURRENT positions in their desired sequence; every other key in the map
    //    refers to the resulting positions. Media ids survive a reorder, so only the preview and
    //    the inheritance walk depend on this.
    const current = p.media.nodes.filter((m) => m.image);
    let sequence = current;
    let reorderMoves = null;
    if (Array.isArray(map.order)) {
        if (map.order.length !== current.length) {
            console.error(`\n✖ order lists ${map.order.length} positions but the product has ${current.length} photos.`);
            process.exit(1);
        }
        if (new Set(map.order).size !== map.order.length || map.order.some((n) => !current[n - 1])) {
            console.error('\n✖ order must be a permutation of the existing positions.');
            process.exit(1);
        }
        sequence = map.order.map((oldPos) => current[oldPos - 1]);
        if (map.order.some((oldPos, i) => oldPos !== i + 1)) {
            reorderMoves = map.order.map((oldPos, i) => ({ id: current[oldPos - 1].id, newPosition: String(i) }));
            console.log('\nREORDER (an unbound photo takes the options of the photo before it):');
            map.order.forEach((oldPos, i) => {
                if (oldPos !== i + 1) console.log(`   was ${oldPos}, becomes ${i + 1}   ${fileOf(current[oldPos - 1].image.url).slice(0, 52)}`);
            });
        }
    }

    const media = sequence
        .map((m, i) => ({ n: i + 1, id: m.id, alt: m.alt, url: m.image && m.image.url,
            w: m.image && m.image.width, h: m.image && m.image.height }));
    const byPos = {}; media.forEach((m) => { byPos[m.n] = m; });

    // ── Every pair the product actually sells must be in the map. A partial bind leaves the
    //    product LOOKING fixed while still showing one colour for two.
    const pairs = [...new Set(p.variants.nodes.map(pairOf))].sort();
    const missing = pairs.filter((k) => !map.bind[k]);
    if (missing.length) {
        console.error(`\n✖ The map does not cover every (Style x Colour) pair this product sells:`);
        missing.forEach((k) => console.error(`     ${k}`));
        console.error('  A partial bind is worse than none — it looks fixed and still sells the wrong colour.');
        process.exit(1);
    }
    const badPos = Object.entries(map.bind).filter(([, n]) => !byPos[n]);
    if (badPos.length) {
        console.error(`\n✖ Map points at media positions that do not exist: ${badPos.map(([k, n]) => `${k}->${n}`).join(', ')}`);
        process.exit(1);
    }
    const dupe = Object.values(map.bind).length !== new Set(Object.values(map.bind)).size;
    if (dupe) {
        console.error('\n✖ Two pairs map to the SAME photo. That is the defect this script exists to fix.');
        process.exit(1);
    }

    // ── Simulate the theme's inheritance for unbound photos.
    const boundPairByPosition = {};
    Object.entries(map.bind).forEach(([pair, n]) => { boundPairByPosition[n] = pair; });
    const inherit = inheritedOptions(media, boundPairByPosition);

    console.log('\nMEDIA (gallery order):');
    for (const m of media) {
        const pair = boundPairByPosition[m.n];
        const tag = pair ? `BOUND  ${pair}` : `product-level, inherits ${inherit[m.n] || '(nothing)'}`;
        console.log(`  [${m.n}] ratio ${(m.w / m.h).toFixed(2)}  ${tag}`);
        console.log(`       ${fileOf(m.url).slice(0, 60)}`);
    }

    // ── The lifestyle-photo guard: does its position really yield what the map claims?
    const declared = map.productLevel || {};
    let wrongInherit = 0;
    for (const [n, want] of Object.entries(declared)) {
        if (boundPairByPosition[n]) {
            console.error(`\n✖ Position ${n} is declared product-level but the map also binds it.`);
            process.exit(1);
        }
        const got = inherit[n];
        if (got !== want) {
            console.error(`\n✖ Product-level photo at position ${n} would inherit "${got}", not "${want}".`);
            console.error('  Media order is load-bearing — an unbound photo takes the options of the nearest');
            console.error('  preceding bound one. Move it next to the flat-lay it matches, or fix the map.');
            wrongInherit++;
        }
    }
    const undeclared = media.filter((m) => !boundPairByPosition[m.n] && !declared[m.n]);
    if (undeclared.length) {
        console.error(`\n✖ Unbound photo(s) with no productLevel declaration: ${undeclared.map((m) => m.n).join(', ')}`);
        console.error('  Declare what each should inherit so the position is checked, not assumed.');
        wrongInherit++;
    }
    if (wrongInherit) process.exit(1);

    // ── What changes.
    const bindFixes = [];
    for (const v of p.variants.nodes) {
        const want = byPos[map.bind[pairOf(v)]];
        const cur = v.image ? fileOf(v.image.url) : null;
        if (cur !== fileOf(want.url)) bindFixes.push({ id: v.id, mediaId: want.id, pair: pairOf(v), from: cur, to: fileOf(want.url) });
    }
    const altFixes = Object.entries(map.alt || {})
        .filter(([n, text]) => byPos[n] && byPos[n].alt !== text)
        .map(([n, text]) => ({ id: byPos[n].id, n, from: byPos[n].alt, to: text }));

    if (!bindFixes.length && !altFixes.length) {
        console.log('\n✔ Already correct — every pair has its own photo and alt text matches.');
        return;
    }

    if (bindFixes.length) {
        console.log(`\nRE-BIND ${bindFixes.length} variant(s):`);
        const grouped = {};
        bindFixes.forEach((f) => (grouped[f.pair] = grouped[f.pair] || []).push(f));
        Object.entries(grouped).forEach(([pair, list]) => {
            console.log(`   ${pair.padEnd(28)} ${list.length} size(s)  ${String(list[0].from).slice(0, 34)} -> ${list[0].to.slice(0, 34)}`);
        });
    }
    if (altFixes.length) {
        console.log('\nALT TEXT:');
        altFixes.forEach((f) => {
            console.log(`   [${f.n}] was: ${f.from}`);
            console.log(`        now: ${f.to}`);
        });
    }

    if (!live) {
        console.log(`\nDry run. Re-run with --product ${only} --live to apply.`);
        return;
    }

    if (reorderMoves) {
        const res = await shopify.gql(M_REORDER, { id: gid, moves: reorderMoves });
        const jobId = res.productReorderMedia && res.productReorderMedia.job && res.productReorderMedia.job.id;
        // Reorder is a background job — binding before it lands would race the gallery order.
        for (let i = 0; i < 30 && jobId; i++) {
            const j = await shopify.gql(Q_JOB, { id: jobId }, { isMutation: false });
            if (j.job && j.job.done) break;
            await new Promise((r) => setTimeout(r, 1000));
        }
        console.log('✔ reordered');
    }

    for (let i = 0; i < bindFixes.length; i += 100) {
        const batch = bindFixes.slice(i, i + 100);
        await shopify.gql(M_BIND, { productId: p.id, variants: batch.map((f) => ({ id: f.id, mediaId: f.mediaId })) });
        console.log(`✔ bound ${batch.length} variant(s)`);
    }
    if (altFixes.length) {
        await shopify.gql(M_ALT, { files: altFixes.map((f) => ({ id: f.id, alt: f.to })) });
        console.log(`✔ updated ${altFixes.length} alt text(s)`);
    }

    // ── Re-read and assert, rather than trusting the mutation's own response.
    const after = await shopify.gql(Q, { id: p.id }, { isMutation: false });

    // Order is part of correctness here, not cosmetics — it is what gives every unbound photo its
    // meaning. Assert the gallery really landed in the sequence the inheritance check was run against.
    const landed = after.product.media.nodes.filter((m) => m.image).map((m) => m.id);
    const wanted = media.map((m) => m.id);
    if (landed.join(',') !== wanted.join(',')) {
        console.error('\n✖ Gallery order is not what was validated — unbound photos may inherit the wrong colour.');
        process.exit(1);
    }

    const seen = {};
    for (const v of after.product.variants.nodes) {
        if (!v.image) { console.error('\n✖ A variant has no image after binding.'); process.exit(1); }
        const k = pairOf(v);
        if (seen[k] && seen[k] !== fileOf(v.image.url)) {
            console.error(`\n✖ ${k} resolves to more than one photo — sizes disagree.`);
            process.exit(1);
        }
        seen[k] = fileOf(v.image.url);
    }
    const distinct = new Set(Object.values(seen));
    if (distinct.size !== Object.keys(seen).length) {
        console.error('\n✖ Two (Style x Colour) pairs STILL share a photo.');
        Object.entries(seen).forEach(([k, f]) => console.error(`     ${k.padEnd(28)} ${f}`));
        process.exit(1);
    }
    console.log('\n✔ Verified by re-reading — every pair resolves to its own distinct photo:');
    Object.entries(seen).forEach(([k, f]) => console.log(`     ${k.padEnd(28)} ${f.slice(0, 48)}`));
}

main().catch((e) => {
    console.error('\nFAILED:', shopify.redactShopify(e));
    process.exit(1);
});
