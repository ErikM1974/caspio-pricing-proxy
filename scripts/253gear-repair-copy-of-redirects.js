#!/usr/bin/env node
/**
 * Repair EVERY `copy-of-` redirect that points at the wrong design, in one pass.
 *
 *   node scripts/253gear-repair-copy-of-redirects.js          # dry run
 *   node scripts/253gear-repair-copy-of-redirects.js --live
 *
 * This replaces the hand-written one-offs (Pizza and Pipes, then Fife/Flying Boots/Edgewood).
 * Fixing them individually was fine for two; the deeper landing-page window then surfaced a
 * cascade, and at that point a rule beats a list.
 *
 * THE MECHANISM, once more, because it will happen again the next time somebody duplicates a
 * product: Shopify names a duplicate `copy-of-<original-handle>`. Renaming that duplicate makes
 * Shopify auto-create a redirect from the copy-of handle to the NEW product. Perfectly correct
 * from Shopify's side — that URL genuinely was the new product for a while — and wrong the
 * instant Google has the URL indexed under the ORIGINAL design's name.
 *
 * THE RULE. Every product carries a 4-6 digit ShopWorks design number, and it survives renames,
 * which is exactly when these redirects are minted. So:
 *
 *   source path contains #NNNNN  AND  an ACTIVE product exists carrying #NNNNN
 *      -> point the redirect at that product. It is the design the URL names.
 *
 * Anything else is LEFT ALONE and reported. Specifically:
 *   - no design number in the source     -> cannot prove intent, do not guess
 *   - the number has no active product   -> the design is retired; a human picks the fallback
 *   - already pointing at the right one  -> nothing to do
 *
 * 🔴 IT WILL NOT INVENT A DESTINATION. The earlier Edgewood case (#31713, design retired) was
 * sent to a collection by hand precisely because no rule can decide that safely. This script
 * reports those and stops.
 */

'use strict';

require('dotenv').config();
const shopify = require('./../src/utils/shopify-client');

const Q_REDIRECTS = `
query($cursor: String) {
  urlRedirects(first: 250, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes { id path target }
  }
}`;

const Q_PRODUCTS = `
query($cursor: String) {
  products(first: 250, after: $cursor, query: "status:active") {
    pageInfo { hasNextPage endCursor }
    nodes { handle title }
  }
}`;

const M = `
mutation($id: ID!, $redirect: UrlRedirectInput!) {
  urlRedirectUpdate(id: $id, urlRedirect: $redirect) {
    urlRedirect { id path target }
    userErrors { field message }
  }
}`;

/** Last 4-6 digit run in a string — the design number. */
const designNumber = (s) => {
    const m = String(s || '').match(/\b(\d{4,6})\b/g);
    return m ? m[m.length - 1] : null;
};

async function pageAll(query, pick) {
    const out = [];
    let cursor = null;
    for (let i = 0; i < 12; i++) {
        const d = await shopify.gql(query, { cursor }, { isMutation: false });
        const conn = pick(d);
        out.push(...conn.nodes);
        if (!conn.pageInfo.hasNextPage) break;
        cursor = conn.pageInfo.endCursor;
    }
    return out;
}

async function main() {
    const live = process.argv.includes('--live');
    if (!shopify.isConfigured()) {
        console.error('Shopify not configured:', shopify.missingConfig().join(', '));
        process.exit(1);
    }

    const [redirects, products] = await Promise.all([
        pageAll(Q_REDIRECTS, (d) => d.urlRedirects),
        pageAll(Q_PRODUCTS, (d) => d.products)
    ]);

    // design number -> active product. A number appearing twice is ambiguous, so it is
    // dropped rather than guessed between.
    const byNumber = new Map();
    const dupes = new Set();
    products.forEach((p) => {
        const n = designNumber(p.handle);
        if (!n) return;
        if (byNumber.has(n)) dupes.add(n);
        byNumber.set(n, p);
    });
    dupes.forEach((n) => byNumber.delete(n));

    const fix = [];
    const retired = [];
    const noNumber = [];

    for (const r of redirects) {
        if (!/^\/products\/copy-of-/.test(r.path)) continue;
        const n = designNumber(r.path);
        if (!n) { noNumber.push(r); continue; }

        const want = byNumber.get(n);
        if (!want) { retired.push({ r, number: n }); continue; }

        const target = `/products/${want.handle}`;
        if (r.target === target) continue;                 // already correct
        fix.push({ id: r.id, path: r.path, from: r.target, to: target, number: n, title: want.title });
    }

    console.log(`\n${redirects.length} redirects, ${products.length} active products.`);
    console.log(`copy-of redirects needing repair: ${fix.length}`);

    if (fix.length) {
        console.log('\nWILL FIX — the URL names a design that is live under a different handle:');
        fix.forEach((f) => {
            console.log(`\n  ${f.path}`);
            console.log(`      was  ${f.from}`);
            console.log(`      now  ${f.to}      (#${f.number} — ${f.title})`);
        });
    }

    if (retired.length) {
        console.log(`\nLEFT ALONE — design retired, no active product carries the number (${retired.length}).`);
        console.log('  A human picks the fallback; a rule cannot do it safely.');
        retired.forEach((x) => console.log(`   #${x.number}  ${x.r.path}  ->  ${x.r.target}`));
    }
    if (noNumber.length) {
        console.log(`\nLEFT ALONE — no design number in the path, so intent cannot be proven (${noNumber.length}).`);
        noNumber.forEach((r) => console.log(`   ${r.path}  ->  ${r.target}`));
    }

    if (!fix.length) { console.log('\nNothing to change.'); return; }
    if (!live) { console.log('\nDry run. Re-run with --live to apply.'); return; }

    for (const f of fix) {
        const res = await shopify.gql(M, { id: f.id, redirect: { path: f.path, target: f.to } });
        const errs = (res.urlRedirectUpdate && res.urlRedirectUpdate.userErrors) || [];
        if (errs.length) { console.error(`✖ ${f.path}: ${errs.map((e) => e.message).join('; ')}`); process.exit(1); }
        console.log(`✔ ${f.path}`);
    }

    const after = new Map((await pageAll(Q_REDIRECTS, (d) => d.urlRedirects)).map((r) => [r.path, r.target]));
    let bad = 0;
    for (const f of fix) {
        if (after.get(f.path) !== f.to) { console.error(`✖ ${f.path} still points at ${after.get(f.path)}`); bad++; }
    }
    if (bad) { console.error(`\n✖ ${bad} did not take.`); process.exit(1); }

    console.log(`\n✔ Verified by re-reading: ${fix.length} redirect(s) now point at the design their URL names.`);
}

main().catch((e) => {
    console.error('\nFAILED:', shopify.redactShopify(e));
    process.exit(1);
});
