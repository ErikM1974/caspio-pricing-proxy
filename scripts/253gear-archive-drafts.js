#!/usr/bin/env node
/**
 * Archive draft products that are provably residue.
 *
 *   node scripts/253gear-archive-drafts.js          # dry run — names every product
 *   node scripts/253gear-archive-drafts.js --live
 *
 * ARCHIVE, NEVER DELETE. `status: ARCHIVED` hides a product from the admin's working list
 * and keeps every record — copy, images, variants, history. It is one field change back.
 * `productDelete` does not appear in this file and must not be added.
 *
 * TWO NARROW CATEGORIES ONLY, both approved individually:
 *
 *   1. Handle already begins `zz-` or `zz_`. Somebody deliberately renamed these to mark
 *      them for removal — this is acting on a decision already taken, not making one.
 *   2. A DRAFT whose design number already has a LIVE product. That is the
 *      publish-by-mistake risk: two records, one number, and the draft can go live by
 *      accident. Measured 2026-08-08: exactly 2 products.
 *
 * 🔴 EXPLICITLY NOT TOUCHED. 103 draft products are a public-safety fundraiser line — 54
 * distinct designs across Milton PD, Pierce County Sheriff, Bonney Lake PD, Orting PD,
 * Puyallup PD, East Pierce Fire and Federal Way, every one created between 20 Oct and 17
 * Dec 2020. That is a built, never-launched campaign, not residue. Archiving it during a
 * cleanup would bury a business decision. Also untouched: 64 drafts with no design number,
 * which need a human glance first. See 253gear-growth/reports/draft_products.md.
 */

'use strict';

require('dotenv').config();
const shopify = require('./../src/utils/shopify-client');

const Q = `
query($cursor: String) {
  products(first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes { id legacyResourceId title handle status }
  }
}`;

const Q_REDIRECTS = `
query($cursor: String) {
  urlRedirects(first: 250, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes { path target }
  }
}`;

const M = `
mutation($product: ProductUpdateInput!) {
  productUpdate(product: $product) {
    product { id status }
    userErrors { field message }   # plain UserError — no 'code' on this one
  }
}`;

const designOf = (t) => { const m = String(t).match(/#(\d{4,6})/); return m ? m[1] : null; };
const isZz = (h) => /^zz[-_]/i.test(String(h || ''));

async function pageAll(query, key) {
    const out = [];
    let cursor = null;
    for (let i = 0; i < 30; i++) {
        const d = await shopify.gql(query, { cursor }, { isMutation: false });
        out.push(...d[key].nodes);
        if (!d[key].pageInfo.hasNextPage) break;
        cursor = d[key].pageInfo.endCursor;
    }
    return out;
}

async function main() {
    const live = process.argv.includes('--live');
    if (!shopify.isConfigured()) {
        console.error('Shopify not configured:', shopify.missingConfig().join(', '));
        process.exit(1);
    }

    const products = await pageAll(Q, 'products');
    const drafts = products.filter((p) => p.status === 'DRAFT');
    const liveNumbers = new Set(products.filter((p) => p.status === 'ACTIVE').map((p) => designOf(p.title)).filter(Boolean));

    const zz = drafts.filter((p) => isZz(p.handle));
    const dupes = drafts.filter((p) => !isZz(p.handle) && designOf(p.title) && liveNumbers.has(designOf(p.title)));
    const batch = [...zz, ...dupes];

    console.log(`\n${products.length} products · ${drafts.length} draft`);
    console.log(`   zz- marked for removal        : ${zz.length}`);
    console.log(`   draft shadowing a LIVE design : ${dupes.length}`);
    console.log(`   NOT touched                   : ${drafts.length - batch.length}  (public-safety line + unnumbered)`);

    if (!batch.length) { console.log('\n✔ Nothing to archive.'); return; }

    // A redirect pointing INTO one of these would already be broken (a draft 404s on the
    // storefront), but archiving is a good moment to notice rather than compound it.
    const redirects = await pageAll(Q_REDIRECTS, 'urlRedirects');
    const targets = new Set(redirects.map((r) => r.target));
    const targeted = batch.filter((p) => targets.has(`/products/${p.handle}`));
    if (targeted.length) {
        console.log(`\n⚠️  ${targeted.length} of these is the target of a redirect — already broken, since a draft 404s:`);
        targeted.forEach((p) => console.log(`   /products/${p.handle}`));
        console.log('   Archiving does not make it worse, but the redirect should be repointed.');
    }

    console.log(`\nWILL ARCHIVE ${batch.length} draft(s):`);
    console.log(`\n  zz- marked (${zz.length}):`);
    zz.forEach((p) => console.log(`     ${p.legacyResourceId}  ${p.title.slice(0, 62)}`));
    console.log(`\n  shadowing a live design (${dupes.length}):`);
    dupes.forEach((p) => console.log(`     ${p.legacyResourceId}  #${designOf(p.title)} is LIVE elsewhere  ${p.title.slice(0, 46)}`));

    if (!live) {
        console.log('\nDry run. Re-run with --live to apply. Archiving is reversible; nothing is deleted.');
        return;
    }

    let n = 0;
    for (const p of batch) {
        await shopify.gql(M, { product: { id: p.id, status: 'ARCHIVED' } });
        n++;
    }
    console.log(`\n✔ archived ${n} draft(s)`);

    // ── Re-read and assert.
    const after = await pageAll(Q, 'products');
    const byId = {};
    after.forEach((p) => { byId[p.id] = p; });

    const notArchived = batch.filter((p) => byId[p.id] && byId[p.id].status !== 'ARCHIVED');
    if (notArchived.length) {
        console.error(`\n✖ ${notArchived.length} did not archive:`);
        notArchived.forEach((p) => console.error(`   ${p.legacyResourceId} is ${byId[p.id].status}`));
        process.exit(1);
    }

    const activeBefore = products.filter((p) => p.status === 'ACTIVE').length;
    const activeAfter = after.filter((p) => p.status === 'ACTIVE').length;
    if (activeBefore !== activeAfter) {
        console.error(`\n✖ ACTIVE count changed: ${activeBefore} -> ${activeAfter}. Nothing live should have moved.`);
        process.exit(1);
    }

    console.log('\n✔ Verified by re-reading:');
    console.log(`     all ${batch.length} are ARCHIVED`);
    console.log(`     drafts: ${drafts.length} -> ${after.filter((p) => p.status === 'DRAFT').length}`);
    console.log(`     ACTIVE unchanged at ${activeAfter} — nothing live was touched`);
    console.log(`     total product records: ${after.length} (unchanged — nothing deleted)`);
}

main().catch((e) => {
    console.error('\nFAILED:', shopify.redactShopify(e));
    process.exit(1);
});
