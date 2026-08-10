#!/usr/bin/env node
/**
 * The remaining three redirects that send people to the wrong town.
 *
 *   node scripts/253gear-fix-misrouted-redirects.js          # dry run
 *   node scripts/253gear-fix-misrouted-redirects.js --live
 *
 * Same bug as the Pizza and Pipes pair fixed on 9 Aug, found by the same rule. Duplicating a
 * product in the Shopify admin creates a `copy-of-<handle>`; renaming that duplicate makes
 * Shopify auto-create a redirect from the old handle to the NEW product. Correct from
 * Shopify's point of view — that URL really was the new product for a while — and wrong the
 * moment Google has indexed the URL under the original's name.
 *
 * The tell is the design number. Every product carries a 4-6 digit ShopWorks number and it
 * survives renames, which is exactly when these redirects get made. A redirect whose number
 * CHANGES is pointing at a different design.
 *
 *   /products/copy-of-fife-t-shirt-31913          -> milton-logo-31868      #31913 -> #31868
 *   /products/copy-of-flying-boots-cafe-t-shirt-34075 -> tipperary-tavern-34085  #34075 -> #34085
 *   /products/copy-of-edgewood-exists-t-shirt-31713   -> fife-logo-31913     #31713 -> #31913
 *
 * 🔑 THE THIRD ONE IS DIFFERENT AND IS HANDLED DIFFERENTLY. Design #31713 "Edgewood Exists"
 * no longer exists in any status — so unlike the other two there is no correct product to
 * point at. Guessing a substitute ("I Love Edgewood" is the nearest) would be inventing an
 * answer. It goes to the Edgewood COLLECTION instead: somebody who clicked an Edgewood shirt
 * link gets every Edgewood shirt, which is honest about the original being gone.
 */

'use strict';

require('dotenv').config();
const shopify = require('./../src/utils/shopify-client');

const FIXES = [
    {
        path: '/products/copy-of-fife-t-shirt-31913',
        to: '/products/fife-logo-31913',
        sessions90d: 25,
        why: 'design #31913 is Fife Logo. It was sending Fife traffic to Milton.',
        expectProduct: 'fife-logo-31913'
    },
    {
        path: '/products/copy-of-flying-boots-cafe-t-shirt-34075',
        to: '/products/fly-high-with-the-flying-boots-cafe-34075',
        sessions90d: 27,
        why: 'design #34075 is the Flying Boots Cafe, and it is live. It was sending that traffic to Tipperary Tavern.',
        expectProduct: 'fly-high-with-the-flying-boots-cafe-34075'
    },
    {
        path: '/products/copy-of-edgewood-exists-t-shirt-31713',
        to: '/collections/edgewood',
        sessions90d: 31,
        why: 'design #31713 no longer exists in any status, so there is no correct product. The Edgewood '
            + 'collection is the honest destination — every Edgewood shirt, rather than a guessed substitute.',
        expectCollection: 'edgewood'
    }
];

const Q_REDIRECTS = `
query($cursor: String) {
  urlRedirects(first: 250, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes { id path target }
  }
}`;

const Q_PRODUCT = 'query($h: String!) { productByIdentifier(identifier: { handle: $h }) { handle status } }';
const Q_COLLECTION = 'query($h: String!) { collectionByIdentifier(identifier: { handle: $h }) { handle title } }';

const M = `
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

    // Every destination must exist before anything is pointed at it. Moving traffic from one
    // wrong page to a missing one would be worse than leaving it alone.
    for (const f of FIXES) {
        if (f.expectProduct) {
            const p = (await shopify.gql(Q_PRODUCT, { h: f.expectProduct }, { isMutation: false })).productByIdentifier;
            if (!p || p.status !== 'ACTIVE') {
                console.error(`\n✖ ${f.to} is not an ACTIVE product (${p ? p.status : 'not found'}). Refusing.`);
                process.exit(1);
            }
        } else {
            const c = (await shopify.gql(Q_COLLECTION, { h: f.expectCollection }, { isMutation: false })).collectionByIdentifier;
            if (!c) { console.error(`\n✖ collection ${f.expectCollection} not found. Refusing.`); process.exit(1); }
        }
    }
    console.log('\nAll destinations verified.');

    const byPath = new Map((await allRedirects()).map((r) => [r.path, r]));
    const plan = [];
    for (const f of FIXES) {
        const r = byPath.get(f.path);
        if (!r) { console.error(`\n✖ no redirect exists for ${f.path} — investigate rather than creating one blind.`); process.exit(1); }
        if (r.target === f.to) { console.log(`  = ${f.path} already correct`); continue; }
        plan.push({ ...f, id: r.id, from: r.target });
    }

    if (!plan.length) { console.log('\nNothing to change.'); return; }

    console.log('\nPlanned changes:');
    plan.forEach((p) => {
        console.log(`\n  ${p.path}   (${p.sessions90d} sessions / 90d)`);
        console.log(`      ${p.from}`);
        console.log(`   -> ${p.to}`);
        console.log(`      ${p.why}`);
    });
    console.log(`\n  ${plan.reduce((a, p) => a + p.sessions90d, 0)} sessions per 90 days currently misrouted.`);

    if (!live) { console.log('\nDry run. Re-run with --live to apply.'); return; }

    for (const p of plan) {
        const res = await shopify.gql(M, { id: p.id, redirect: { path: p.path, target: p.to } });
        const errs = (res.urlRedirectUpdate && res.urlRedirectUpdate.userErrors) || [];
        if (errs.length) { console.error(`✖ ${p.path}: ${errs.map((e) => e.message).join('; ')}`); process.exit(1); }
        console.log(`✔ updated ${p.path}`);
    }

    const after = new Map((await allRedirects()).map((r) => [r.path, r.target]));
    let bad = 0;
    for (const p of plan) {
        if (after.get(p.path) !== p.to) { console.error(`✖ ${p.path} still points at ${after.get(p.path)}`); bad++; }
    }
    if (bad) { console.error(`\n✖ ${bad} redirect(s) did not take.`); process.exit(1); }

    console.log('\n✔ Verified by re-reading: all three now resolve correctly.');
}

main().catch((e) => {
    console.error('\nFAILED:', shopify.redactShopify(e));
    process.exit(1);
});
