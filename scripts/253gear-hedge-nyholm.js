#!/usr/bin/env node
/**
 * Hedge the unverified claims on the two Nyholm windmill pages.
 *
 *   node scripts/253gear-hedge-nyholm.js          # dry run — shows every edit in context
 *   node scripts/253gear-hedge-nyholm.js --live
 *
 * WHY. Both pages state two things as fact that could not be sourced on 2026-08-08:
 *
 *   1. That the City of Edgewood bought the windmill in May 2024 for $125.
 *   2. That $125 is what Peter Nyholm paid Sears for it in 1902.
 *
 * The only sourced statement found is Don Nelson, in 2016, saying it was **believed** Nyholm
 * "purchased the windmill from a catalog and built it on his own" — no price, no Sears. A
 * hedged, second-hand recollection had hardened into a stated fact with a dollar figure, and
 * the memorable $1-to-$125 anecdote rests entirely on it.
 *
 * Meanwhile the City of Edgewood's own building-evaluation report — dated June 2023, so it
 * may simply predate the sale — names **East Pierce Fire and Rescue** as the "current
 * apparent owner", not Nelson's association. Not a contradiction, but not a confirmation.
 *
 * 🔴 THIS IS THE FLYING BOOTS ERROR SHAPE: a confident, specific, charming sentence about a
 * real place that nobody checked. The fix is not deletion — the anecdote is probably true and
 * is exactly the kind of detail that makes these pages rank. The fix is saying who says so.
 *
 * WHAT IS NOT TOUCHED, because it verified cleanly: built 1902; moved 24 August 1980; now at
 * 2284 Meridian Avenue; moved from Jovita Blvd & Meridian; Don Nelson as president of the
 * Edgewood-Nyholm Windmill Association and former volunteer fire chief. Over-hedging good
 * copy would be its own kind of damage.
 *
 * Erik can settle this with two phone calls — the Edgewood city clerk for the 2024 council
 * action, and Don Nelson for the $1/$125 story. A sourced first-hand quote would make these
 * pages stronger than they are now, not weaker.
 */

'use strict';

require('dotenv').config();
const shopify = require('./../src/utils/shopify-client');

const Q = `
query($id: ID!) { product(id: $id) { id title descriptionHtml } }`;

const M = `
mutation($product: ProductUpdateInput!) {
  productUpdate(product: $product) {
    product { id }
    userErrors { field message }   # plain UserError — no 'code'
  }
}`;

/**
 * Exact-string edits. Each must match once and only once — a replacement that silently
 * matches nothing is how a "fix" ships without fixing anything.
 */
const EDITS = [
    {
        id: 'gid://shopify/Product/6161724080284',
        name: 'Nyholm is My Home #31945',
        changes: [
            {
                why: 'catalogue purchase is second-hand and hedged in the only source; the 2024 sale is unconfirmed',
                from: 'Peter Nyholm ordered it out of a catalogue in 1902. It is still standing — and in 2024 the city bought it for $125.',
                to: 'Peter Nyholm put it up in 1902. It is still standing — and by local account the city bought it in 2024 for $125.'
            },
            {
                why: 'Nelson said in 2016 it was BELIEVED Nyholm ordered it from a catalogue; Sears specifically is unsourced',
                from: 'four storeys, ordered from a Sears, Roebuck catalogue and built on his own land',
                to: 'four storeys, said to have been ordered from a Sears, Roebuck catalogue and built on his own land'
            },
            {
                why: 'the $1-to-$125 anecdote and the 1902 price are both unsourced; attribute rather than assert, and invite the correction',
                from: '<p>There is a coda worth knowing. In May 2024 Nelson’s nonprofit offered to sell the windmill to the City of Edgewood, so that its future would be settled for good. He opened at one dollar. The city talked him <em>up</em> — to $125, so the price would match what Peter Nyholm paid Sears for it in 1902.</p>',
                to: '<p>There is a coda worth knowing, and we pass it on the way it was told to us. In May 2024, the story goes, Nelson’s nonprofit offered to sell the windmill to the City of Edgewood so its future would be settled for good. He opened at one dollar. The city talked him <em>up</em> — to $125, to match what Nyholm is said to have paid Sears in 1902.</p>\n<p>We have not been able to confirm either figure in the written record. If you sat in that meeting, or you know what the windmill actually cost in 1902, tell us and we will correct this page.</p>'
            }
        ]
    },
    {
        id: 'gid://shopify/Product/9191629848732',
        name: 'Edgewood Nyholm Windmill #40749',
        changes: [
            {
                why: 'same unsourced sale and 1902 price, stated flatly',
                from: 'In May 2024 the City of Edgewood bought it outright — for $125, a price picked deliberately to match what Nyholm paid Sears for it in 1902.',
                to: 'By local account, in May 2024 the City of Edgewood bought it outright for $125 — a price picked to match what Nyholm is said to have paid Sears in 1902. We have not been able to confirm either figure in the written record; if you know better, tell us and we will correct it.'
            }
        ]
    }
];

async function main() {
    const live = process.argv.includes('--live');
    if (!shopify.isConfigured()) {
        console.error('Shopify not configured:', shopify.missingConfig().join(', '));
        process.exit(1);
    }

    const plan = [];
    for (const target of EDITS) {
        const p = (await shopify.gql(Q, { id: target.id }, { isMutation: false })).product;
        if (!p) { console.error(`\n✖ ${target.name} not found.`); process.exit(1); }

        let html = p.descriptionHtml;
        const applied = [];
        for (const c of target.changes) {
            const hits = html.split(c.from).length - 1;
            if (hits !== 1) {
                console.error(`\n✖ ${target.name}: expected exactly 1 match, found ${hits}`);
                console.error(`   for: ${c.from.slice(0, 90)}…`);
                console.error('   Refusing to write. A replacement that matches nothing ships a fix that fixes nothing.');
                process.exit(1);
            }
            html = html.split(c.from).join(c.to);
            applied.push(c);
        }
        plan.push({ target, before: p.descriptionHtml, after: html, applied });
    }

    for (const { target, applied } of plan) {
        console.log(`\n${target.name}`);
        applied.forEach((c, i) => {
            console.log(`\n   ${i + 1}. ${c.why}`);
            console.log(`      -  ${c.from.replace(/<[^>]+>/g, '').trim().slice(0, 150)}`);
            console.log(`      +  ${c.to.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 220)}`);
        });
    }

    if (!live) {
        console.log('\nDry run. Re-run with --live to apply.');
        return;
    }

    for (const { target, after } of plan) {
        await shopify.gql(M, { product: { id: target.id, descriptionHtml: after } });
        console.log(`✔ updated ${target.name}`);
    }

    // ── Re-read and assert, rather than trusting the mutation's own response.
    let bad = 0;
    for (const { target, applied } of plan) {
        const now = (await shopify.gql(Q, { id: target.id }, { isMutation: false })).product.descriptionHtml;
        for (const c of applied) {
            if (now.includes(c.from)) { console.error(`✖ ${target.name}: old wording still present`); bad++; }
            if (!now.includes(c.to)) { console.error(`✖ ${target.name}: new wording missing`); bad++; }
        }
        // The flat assertions must be gone from the rendered text, not merely edited around.
        const text = now.replace(/<[^>]+>/g, ' ');
        if (/the city bought it outright — for \$125/.test(text) || /paid Sears for it in 1902/.test(text)) {
            console.error(`✖ ${target.name}: an unhedged assertion survives`); bad++;
        }
    }
    if (bad) { console.error(`\n✖ ${bad} problem(s) on re-read.`); process.exit(1); }

    console.log('\n✔ Verified by re-reading: every claim is now attributed, and no unhedged assertion survives.');
}

main().catch((e) => {
    console.error('\nFAILED:', shopify.redactShopify(e));
    process.exit(1);
});
