#!/usr/bin/env node
/**
 * Calico Cat ownership tense, and the Tipperary rewrite.
 *
 *   node scripts/253gear-copy-calico-tipperary.js          # dry run
 *   node scripts/253gear-copy-calico-tipperary.js --live
 *
 * Both changes come out of a claim-by-claim verification pass — see
 * 253gear-growth/reports/copy_verification.md for the sources behind every sentence.
 *
 * CALICO CAT — one sentence, out of date rather than wrong. The page implies the family
 * still owns the motel. They sold: $1,550,000, MLS 2314884, and the current Pierce County
 * taxpayer of record is NOW TACOMA LLC. Pacific Lodge itself is still trading — verified
 * separately against live booking listings — so it is the ownership the page gets wrong,
 * not the status.
 *
 * 🔴 NOT TOUCHED HERE: the WSDOT survey-film sentence ("stamped 22 November 1982, SR 007
 * northbound"). It could not be sourced, and it is the highest-risk claim on the page
 * precisely because its precision reads as proof. But it may well be real and first-hand,
 * in which case it is the BEST sentence on the page and deserves citing rather than
 * hedging. That is Erik's answer to give, not mine to guess.
 *
 * TIPPERARY — a rewrite, because 6 of its 12 claims could not be sourced and every
 * colourful one was among them: the "St. Louis House" former name, the "county's
 * second-oldest saloon" line, the May 1958 holdup and its headline, the August 1997
 * electrical fire. None is DISPROVEN — 1958 small-paper archives are genuinely thin — but
 * all were stated as fact and none can be stood behind. That is the Flying Boots shape.
 *
 * What replaces them is duller on the surface and far stronger underneath: a county
 * building classification, a dated 1941 record, a 1998 commission hearing, a published
 * Court of Appeals opinion, and a named successor business that is open today. All of it
 * checkable.
 *
 * ⚠️ DELIBERATELY OMITTED: a 2025 obituary recording a marriage that began at the
 * Tipperary. It is the single best detail found — a real person, a real source, and it
 * exists nowhere else, which is exactly the information gain that put Clyde's at #1. It is
 * also a recently bereaved family who did not ask to appear on a t-shirt page. Erik was
 * asked and has not answered, and consent is not something to assume by momentum.
 */

'use strict';

require('dotenv').config();
const shopify = require('./../src/utils/shopify-client');

const Q = 'query($id: ID!) { product(id: $id) { id title descriptionHtml } }';
const M = `
mutation($product: ProductUpdateInput!) {
  productUpdate(product: $product) {
    product { id }
    userErrors { field message }   # plain UserError — no 'code'
  }
}`;

const CALICO_FROM = 'The family who owned it put about eighty thousand dollars into the place and reopened it as the Pacific Lodge, which is still taking bookings today.';
const CALICO_TO = 'The family who owned it then put about eighty thousand dollars into the place and reopened it as the Pacific Lodge in late 2017. They sold in 2024. It is still taking bookings today, under new owners.';

const TIP_FROM = '<p>A Parkland bar in a building that went up around 1928.</p>\n'
    + '<p>10713 Park Avenue South — a Tacoma mailing address but unincorporated county ground, out in Parkland near Pacific Lutheran. The building dates to roughly 1928 and was known as the St. Louis House before it was the Tipperary. The News Tribune once called it what may be the county’s second-oldest saloon, hedge included.</p>\n'
    + '<p>In May 1958 a gunman worked the till and the customers’ wallets; the paper ran a follow-up headlined "Risks own life for friend in holdup," and the bandit went on to admit three bar robberies. In August 1997 an electrical short did a hundred and fifty thousand dollars of damage and the place was rebuilt. It was still a PLU-era hangout into the mid-2000s. By 2011 the name was gone and another bar had the building. Nobody ever wrote down when the Tipperary opened or when it finally closed — that part still lives with the people who drank there.</p>';

const TIP_TO = '<p>A Parkland tavern that has been a tavern since about 1928 — and still is, under a different name.</p>\n'
    + '<p>10713 Park Avenue South. A Tacoma mailing address, but unincorporated county ground, out in Parkland about a block and a half down from Pacific Lutheran. Pierce County’s own building record is unusually blunt about what the place is: under <em>Built-As</em> the classification reads <strong>Bar/Tavern</strong>, year built around 1928. Whatever else happened to it in a century, nobody ever tried to make it something other than a bar.</p>\n'
    + '<p>The earliest we can put the name in writing is <strong>5 February 1941</strong> — and not in a newspaper. It turns up in a border-crossing record, where somebody gave the Tipperary as where they could be found. After that the trail is the ordinary municipal kind, which is its own sort of proof a place is real. On <strong>9 December 1998</strong> the Parkland Area Advisory Commission sat down to item NP2-98: <em>NONCONFORMING USE — TIPPERARY TAVERN</em>. A published Washington Court of Appeals opinion lays out the ownership chain back to 1984. Roland E. Moore held the building until <strong>4 May 2018</strong>.</p>\n'
    + '<p>It was still going in the mid-2000s — a Pacific Lutheran student from around 2004 remembers drinking there, which is about what you would expect of the nearest bar to a Lutheran university. Close enough to walk. Far enough to be somebody else’s problem.</p>\n'
    + '<p>Then the name went. By 2012 the sign read <strong>Hard Luck Bar &amp; Grill</strong>, which is what it reads today, and the county still lists the site under use code 5820 — taverns. No opening date and no closing date for the Tipperary has surfaced in any public record we could search. What we can say is that it was trading in December 1998, still trading around 2004, and gone by 2012.</p>\n'
    + '<p>Which means if you drank there, you know more about this building than the county does. Tell us and we will put it on this page.</p>';

const EDITS = [
    {
        id: 'gid://shopify/Product/6105789399196',
        name: 'Calico Cat Motel #34072',
        changes: [{ why: 'the family sold in 2024 — present tense implies they still own it', from: CALICO_FROM, to: CALICO_TO }]
    },
    {
        id: 'gid://shopify/Product/6119879999644',
        name: 'Tipperary Tavern #34085',
        changes: [{ why: 'replace 6 unsourceable claims with 6 sourced ones', from: TIP_FROM, to: TIP_TO }]
    }
];

const words = (html) => String(html).replace(/<[^>]+>/g, ' ').trim().split(/\s+/).filter(Boolean).length;

async function main() {
    const live = process.argv.includes('--live');
    if (!shopify.isConfigured()) {
        console.error('Shopify not configured:', shopify.missingConfig().join(', '));
        process.exit(1);
    }

    const plan = [];
    for (const t of EDITS) {
        const p = (await shopify.gql(Q, { id: t.id }, { isMutation: false })).product;
        if (!p) { console.error(`\n✖ ${t.name} not found.`); process.exit(1); }
        let html = p.descriptionHtml;
        for (const c of t.changes) {
            const hits = html.split(c.from).length - 1;
            if (hits !== 1) {
                console.error(`\n✖ ${t.name}: expected exactly 1 match, found ${hits}.`);
                console.error('  Refusing to write — a replacement that matches nothing ships a fix that fixes nothing.');
                process.exit(1);
            }
            html = html.split(c.from).join(c.to);
        }
        plan.push({ t, before: p.descriptionHtml, after: html });
    }

    for (const { t, before, after } of plan) {
        console.log(`\n${t.name}   ${words(before)} words -> ${words(after)}`);
        t.changes.forEach((c) => console.log(`   • ${c.why}`));
    }

    if (!live) {
        console.log('\nDry run. Re-run with --live to apply.');
        return;
    }

    for (const { t, after } of plan) {
        await shopify.gql(M, { product: { id: t.id, descriptionHtml: after } });
        console.log(`✔ updated ${t.name}`);
    }

    // ── Re-read and assert, rather than trusting the mutation's response.
    let bad = 0;
    for (const { t } of plan) {
        const now = (await shopify.gql(Q, { id: t.id }, { isMutation: false })).product.descriptionHtml;
        for (const c of t.changes) {
            if (now.includes(c.from)) { console.error(`✖ ${t.name}: old wording survives`); bad++; }
            if (!now.includes(c.to)) { console.error(`✖ ${t.name}: new wording missing`); bad++; }
        }
        // The specific unsourceable claims must be gone from the rendered text, not merely
        // edited around — that is the whole point of the rewrite.
        const text = now.replace(/<[^>]+>/g, ' ');
        for (const gone of ['St. Louis House', 'second-oldest saloon', 'Risks own life', 'hundred and fifty thousand']) {
            if (text.includes(gone)) { console.error(`✖ ${t.name}: unsourced claim survives — "${gone}"`); bad++; }
        }
    }
    if (bad) { console.error(`\n✖ ${bad} problem(s) on re-read.`); process.exit(1); }

    console.log('\n✔ Verified by re-reading: new wording in place, and every unsourced claim gone.');
}

main().catch((e) => {
    console.error('\nFAILED:', shopify.redactShopify(e));
    process.exit(1);
});
