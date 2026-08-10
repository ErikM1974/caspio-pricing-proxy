#!/usr/bin/env node
/**
 * Wire the store's best-performing page to the things it sells.
 *
 *   node scripts/253gear-link-blog-post.js          # dry run — prints every change
 *   node scripts/253gear-link-blog-post.js --live
 *
 * WHY THIS PAGE. Measured over 90 days: the Area Code 253 article pulls 232 sessions —
 * second only to the homepage at 277, and more than fifteen product pages combined. It is
 * 864 words long and contains exactly ONE product link, pointing at a redirect. Meanwhile
 * 26 products sit at a 15-session crawler floor with nothing pointing at them.
 *
 * This is the cheapest work available on the whole store: no new content, no new traffic,
 * just connecting an audience that already arrives to the catalogue it arrived near.
 *
 * 🔴 TWO OF THESE ARE BUG FIXES, NOT ADDITIONS:
 *   - `href="www.nwcustomapparel.com"` has no protocol, so browsers resolve it RELATIVE and
 *     it 404s inside the blog path. It has been broken since 2023 on the site's most-read page.
 *   - the one product link points at `/products/253-area-code-t-shirt-32187`, which is a
 *     redirect. Pointing straight at the live handle removes a hop for both readers and
 *     crawlers.
 *
 * RESTRAINT IS THE POINT. Six links added to 864 words, each one placed where the sentence
 * already names the thing. A page that reads like a link farm loses the trust that makes it
 * rank, and this page's ranking is the only asset in the exercise.
 */

'use strict';

require('dotenv').config();
const shopify = require('./../src/utils/shopify-client');

const ARTICLE_ID = 'gid://shopify/Article/559546990748';

const Q = `
query($id: ID!) {
  article(id: $id) { id title handle body }
}`;

const M = `
mutation($id: ID!, $article: ArticleUpdateInput!) {
  articleUpdate(id: $id, article: $article) {
    article { id handle }
    userErrors { field message code }
  }
}`;

/** Each entry must match EXACTLY ONCE or nothing is written. */
const EDITS = [
    {
        why: '🔴 BUG: no protocol, so this resolves relative and 404s. Broken since 2023.',
        from: '<a href="www.nwcustomapparel.com" title="Northwest Custom Apparel">',
        to: '<a href="https://www.nwcustomapparel.com" title="Northwest Custom Apparel">'
    },
    {
        why: '🔴 BUG: the only product link points at a redirect. Send it straight to the live handle.',
        from: '<a href="https://253gear.com/products/253-area-code-t-shirt-32187" title="253 T-Shirt">253 t-shirts </a>',
        to: '<a href="https://253gear.com/products/253-repeat-32187" title="253 Repeat T-Shirt">253 t-shirts </a>'
    },
    {
        why: 'the sentence already offers hoodies and caps — give it somewhere to go (61 products)',
        from: 'Our 253 range also includes hoodies and caps, each designed to represent the unique identity of the cities within this area code.',
        to: 'Our <a href="https://253gear.com/collections/253-gear" title="253 Gear Collection">253 range</a> '
            + 'also includes hoodies and caps, each designed to represent the unique identity of the cities within this area code.'
    },
    {
        why: 'Puyallup is named in a list of towns and has a 35-product collection',
        from: 'Think of towns like Gig Harbor, Puyallup, and Enumclaw, or places like Lakewood and University Place.',
        to: 'Think of towns like Gig Harbor, <a href="https://253gear.com/collections/puyallup-t-shirts" '
            + 'title="Puyallup and Sumner Collection">Puyallup</a>, and Enumclaw, or places like Lakewood and University Place.'
    },
    {
        why: 'Tacoma is the most-mentioned city in the post (8 times) and has the biggest city collection (41)',
        from: 'Reflecting the spirit of South Puget Sound and Tacoma, these area code',
        to: 'Reflecting the spirit of South Puget Sound and <a href="https://253gear.com/collections/tacoma" '
            + 'title="Tacoma Collection">Tacoma</a>, these area code'
    },
    {
        why: 'the sentence literally says "celebrate our local landmarks" and we sell a Landmarks design',
        from: 'You can also celebrate our local landmarks with sayings like ‘Mount Rainier 253’ or ‘Tacoma Dome Home’.',
        to: 'You can also celebrate our <a href="https://253gear.com/products/253-landmarks-32870" '
            + 'title="253 Landmarks">local landmarks</a> with sayings like ‘Mount Rainier 253’ or ‘Tacoma Dome Home’.'
    },
    {
        why: 'the shop is in Milton and Milton has its own collection',
        from: 'Proudly based in Milton, WA, Northwest Custom Apparel’s roots',
        to: 'Proudly based in <a href="https://253gear.com/collections/milton" title="Milton Collection">Milton, WA</a>, '
            + 'Northwest Custom Apparel’s roots'
    },
    {
        why: 'the closing line is the only call to action that is not a phone number',
        from: 'So, show your love for the South Puget Sound area and Tacoma with the unique 253 t-shirts from Northwest Custom Apparel.',
        to: 'So, show your love for the South Puget Sound area and Tacoma with the '
            + '<a href="https://253gear.com/collections/253-gear" title="Shop 253 Gear">unique 253 t-shirts</a> '
            + 'from Northwest Custom Apparel.'
    }
];

const countLinks = (html, re) => (String(html).match(re) || []).length;

async function main() {
    const live = process.argv.includes('--live');
    if (!shopify.isConfigured()) {
        console.error('Shopify not configured:', shopify.missingConfig().join(', '));
        process.exit(1);
    }

    const art = (await shopify.gql(Q, { id: ARTICLE_ID }, { isMutation: false })).article;
    if (!art) { console.error('\n✖ Article not found.'); process.exit(1); }
    console.log(`\n${art.title}`);
    console.log(`  /blogs/area-code-253-t-shirts/${art.handle}`);

    const before = art.body;
    let html = before;

    for (const e of EDITS) {
        const hits = html.split(e.from).length - 1;
        if (hits !== 1) {
            console.error(`\n✖ Expected exactly 1 match, found ${hits}, for:`);
            console.error(`   ${e.from.slice(0, 100)}`);
            console.error('  Refusing to write. A replacement that matches nothing ships a fix that fixes nothing.');
            process.exit(1);
        }
        html = html.split(e.from).join(e.to);
    }

    const prodRe = /href="[^"]*\/products\/[^"]*"/g;
    const collRe = /href="[^"]*\/collections\/[^"]*"/g;
    console.log('\nChanges:');
    EDITS.forEach((e) => console.log(`  • ${e.why}`));
    console.log('\n           product links   collection links');
    console.log(`  before        ${String(countLinks(before, prodRe)).padStart(2)}               ${countLinks(before, collRe)}`);
    console.log(`  after         ${String(countLinks(html, prodRe)).padStart(2)}               ${countLinks(html, collRe)}`);

    // Sanity: the post is 864 words and must stay a post, not a directory.
    const words = String(html).replace(/<[^>]+>/g, ' ').trim().split(/\s+/).filter(Boolean).length;
    const totalLinks = countLinks(html, /<a /g);
    console.log(`\n  ${words} words, ${totalLinks} links — 1 link per ${Math.round(words / totalLinks)} words.`);
    if (totalLinks / words > 0.02) {
        console.error('  ✖ Too dense. A page that reads like a link farm loses the trust that makes it rank.');
        process.exit(1);
    }

    if (!live) {
        console.log('\nDry run. Re-run with --live to apply.');
        return;
    }

    const res = await shopify.gql(M, { id: ARTICLE_ID, article: { body: html } });
    const errs = (res.articleUpdate && res.articleUpdate.userErrors) || [];
    if (errs.length) {
        console.error('\n✖ ' + errs.map((e) => `${e.field}: ${e.message}`).join('; '));
        process.exit(1);
    }

    // Re-read rather than trusting the mutation response.
    const after = (await shopify.gql(Q, { id: ARTICLE_ID }, { isMutation: false })).article.body;
    let bad = 0;
    for (const e of EDITS) {
        if (after.includes(e.from)) { console.error(`✖ old text survives: ${e.from.slice(0, 60)}`); bad++; }
        if (!after.includes(e.to)) { console.error(`✖ new text missing: ${e.to.slice(0, 60)}`); bad++; }
    }
    if (after.includes('href="www.')) { console.error('✖ a protocol-less href survives'); bad++; }
    if (bad) { console.error(`\n✖ ${bad} problem(s) on re-read.`); process.exit(1); }

    console.log('\n✔ Verified by re-reading: every edit landed, and no protocol-less link remains.');
}

main().catch((e) => {
    console.error('\nFAILED:', shopify.redactShopify(e));
    process.exit(1);
});
