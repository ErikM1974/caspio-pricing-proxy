#!/usr/bin/env node
/**
 * Two redirects send Pizza and Pipes traffic to the Calico Cat Motel.
 *
 *   node scripts/253gear-fix-pizza-redirects.js          # dry run
 *   node scripts/253gear-fix-pizza-redirects.js --live
 *
 * WHAT IS WRONG. Measured 2026-08-09 over 90 days of Shopify session data:
 *
 *   /products/copy-of-pizza-and-pipes-hoodie-34071   61 sessions -> calico-cat-motel-34072
 *   /products/copy-of-pizza-and-pipes-t-shirt-34071  51 sessions -> calico-cat-motel-34072
 *
 * 112 people who searched for Pizza and Pipes, found it in Google, clicked, and were
 * handed a motel. Meanwhile `pizza-and-pipes-34071` is ACTIVE and sitting right there.
 *
 * HOW IT HAPPENED, because the mechanism will recur. Somebody duplicated the Pizza and
 * Pipes products in the Shopify admin to build the Calico Cat products. Shopify names a
 * duplicate `copy-of-<original-handle>`. When those duplicates were renamed to Calico Cat,
 * Shopify auto-created a redirect from the old handle to the new one — which is
 * technically correct (that URL really was the Calico Cat product for a while) and
 * semantically disastrous, because Google had already indexed the URL as Pizza and Pipes.
 *
 * 🔴 NOT MY DOING, AND I CHECKED. `253gear-growth/data/redirects-before-flatten.json` —
 * the pre-change snapshot taken before the redirect-chain flattening — already contains
 * these two rows pointing at Calico Cat. The flatten resolved the chain to the final live
 * product and faithfully preserved a destination that was already wrong. That snapshot
 * existing is the only reason this could be answered rather than argued about.
 *
 * ⚠️ ANY `copy-of-` HANDLE IN A REDIRECT IS SUSPECT for exactly this reason. The leaks
 * panel on the Design Queue now flags them.
 */

'use strict';

require('dotenv').config();
const shopify = require('./../src/utils/shopify-client');

const TARGET = '/products/pizza-and-pipes-34071';

const FIXES = [
    { path: '/products/copy-of-pizza-and-pipes-hoodie-34071', sessions90d: 61 },
    { path: '/products/copy-of-pizza-and-pipes-t-shirt-34071', sessions90d: 51 }
];

const Q_REDIRECTS = `
query($cursor: String) {
  urlRedirects(first: 250, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes { id path target }
  }
}`;

const Q_PRODUCT = `
query($handle: String!) {
  productByIdentifier(identifier: { handle: $handle }) { id title handle status }
}`;

const M_UPDATE = `
mutation($id: ID!, $redirect: UrlRedirectInput!) {
  urlRedirectUpdate(id: $id, urlRedirect: $redirect) {
    urlRedirect { id path target }
    userErrors { field message }
  }
}`;

async function allRedirects() {
    const out = [];
    let cursor = null;
    for (let i = 0; i < 12; i++) {
        const d = await shopify.gql(Q_REDIRECTS, { cursor }, { isMutation: false });
        out.push(...d.urlRedirects.nodes);
        if (!d.urlRedirects.pageInfo.hasNextPage) break;
        cursor = d.urlRedirects.pageInfo.endCursor;
    }
    return out;
}

async function main() {
    const live = process.argv.includes('--live');
    if (!shopify.isConfigured()) {
        console.error('Shopify not configured:', shopify.missingConfig().join(', '));
        process.exit(1);
    }

    // Refuse to point traffic at something that is not there. Sending 112 people from one
    // wrong page to a second wrong page would be worse than leaving it alone.
    const dest = (await shopify.gql(Q_PRODUCT, { handle: 'pizza-and-pipes-34071' }, { isMutation: false })).productByIdentifier;
    if (!dest || dest.status !== 'ACTIVE') {
        console.error(`\n✖ ${TARGET} is not an ACTIVE product (${dest ? dest.status : 'not found'}). Refusing to redirect to it.`);
        process.exit(1);
    }
    console.log(`\nDestination verified: ${dest.title} (${dest.status})`);

    const redirects = await allRedirects();
    const byPath = new Map(redirects.map((r) => [r.path, r]));

    const plan = [];
    for (const f of FIXES) {
        const r = byPath.get(f.path);
        if (!r) {
            console.error(`\n✖ No redirect exists for ${f.path}. Nothing to update — investigate rather than creating one blind.`);
            process.exit(1);
        }
        if (r.target === TARGET) {
            console.log(`  = ${f.path} already points at ${TARGET}`);
            continue;
        }
        plan.push({ ...f, id: r.id, from: r.target });
    }

    if (!plan.length) {
        console.log('\nNothing to change.');
        return;
    }

    console.log('\nPlanned changes:');
    plan.forEach((p) => {
        console.log(`  ${p.path}`);
        console.log(`      ${p.from}  ->  ${TARGET}      (${p.sessions90d} sessions in 90d)`);
    });
    const total = plan.reduce((a, p) => a + p.sessions90d, 0);
    console.log(`\n  ${total} sessions per 90 days currently landing on the wrong product.`);

    if (!live) {
        console.log('\nDry run. Re-run with --live to apply.');
        return;
    }

    for (const p of plan) {
        const res = await shopify.gql(M_UPDATE, { id: p.id, redirect: { path: p.path, target: TARGET } });
        const errs = (res.urlRedirectUpdate && res.urlRedirectUpdate.userErrors) || [];
        if (errs.length) {
            console.error(`✖ ${p.path}: ${errs.map((e) => e.message).join('; ')}`);
            process.exit(1);
        }
        console.log(`✔ updated ${p.path}`);
    }

    // Re-read rather than trusting the mutation response — the house rule, and the reason
    // two earlier "successful" edits were caught having changed nothing.
    const after = new Map((await allRedirects()).map((r) => [r.path, r.target]));
    let bad = 0;
    for (const p of plan) {
        const now = after.get(p.path);
        if (now !== TARGET) { console.error(`✖ ${p.path} still points at ${now}`); bad++; }
    }
    if (bad) { console.error(`\n✖ ${bad} redirect(s) did not take.`); process.exit(1); }

    console.log(`\n✔ Verified by re-reading: both paths now resolve to ${TARGET}.`);
}

main().catch((e) => {
    console.error('\nFAILED:', shopify.redactShopify(e));
    process.exit(1);
});
