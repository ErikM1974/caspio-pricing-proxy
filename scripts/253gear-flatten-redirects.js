#!/usr/bin/env node
/**
 * Flatten multi-hop redirect chains so each one points straight at its final destination.
 *
 *   node scripts/253gear-flatten-redirects.js            # dry run — the whole chain map
 *   node scripts/253gear-flatten-redirects.js --live     # apply the SAME-design chains only
 *   node scripts/253gear-flatten-redirects.js --live --include-cross-design
 *
 * THE DEFECT. The catalogue was consolidated: each design once had separate T-Shirt, Hoodie
 * and Crewneck products, later merged into one multi-variant product. Products were created
 * by duplicating an existing one (hence the `copy-of-…` handles), renamed, renumbered, then
 * merged — and **every rename added a redirect hop. Shopify never flattens the chain.**
 *
 * Measured 2026-08-08: 127 redirects, 39 of them chains, up to 5 hops deep, zero loops.
 * Google still holds at least one of the stale URLs — a `site:` query returned
 * `/products/copy-of-pizza-and-pipes-t-shirt-34071` as the Calico Cat Motel result, which is
 * a handle from two renames ago named after a different design.
 *
 * 🔴 SAME-DESIGN VS CROSS-DESIGN. 25 of the 39 chains end on a DIFFERENT design number than
 * the source URL implies — `copy-of-calico-cat-motel-hoodie-34072` currently lands on Flying
 * Boots Cafe. Flattening those only makes a wrong destination arrive faster, so they need a
 * per-product decision and are EXCLUDED unless --include-cross-design is passed explicitly.
 * The default batch is the 14 whose source and destination agree.
 *
 * Nothing is deleted. Each redirect keeps its path and simply loses its middle hops, so the
 * old URL still resolves — just directly. Reversible from data/redirects.json.
 */

'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const shopify = require('./../src/utils/shopify-client');

const Q = `
query($cursor: String) {
  urlRedirects(first: 250, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes { id path target }
  }
}`;

const M = `
mutation($id: ID!, $urlRedirect: UrlRedirectInput!) {
  urlRedirectUpdate(id: $id, urlRedirect: $urlRedirect) {
    urlRedirect { id path target }
    userErrors { field message code }   # UrlRedirectUserError — this one DOES have code
  }
}`;

/** Trailing 4-6 digit run in a handle — the design number. */
const designOf = (s) => {
    const m = String(s).match(/(\d{4,6})(?!.*\d{4,6})/);
    return m ? m[1] : null;
};

async function fetchAll() {
    const all = [];
    let cursor = null;
    for (let i = 0; i < 20; i++) {
        const d = await shopify.gql(Q, { cursor }, { isMutation: false });
        all.push(...d.urlRedirects.nodes);
        if (!d.urlRedirects.pageInfo.hasNextPage) break;
        cursor = d.urlRedirects.pageInfo.endCursor;
    }
    return all;
}

/** Follow a path to its terminal destination, guarding against a cycle. */
function resolve(start, map) {
    const hops = [start];
    let t = start;
    const seen = new Set([start]);
    for (let i = 0; i < 10; i++) {
        if (map[t] === undefined) break;
        t = map[t];
        if (seen.has(t)) return { hops, terminal: null, loop: true };
        seen.add(t);
        hops.push(t);
    }
    return { hops, terminal: t, loop: false };
}

async function main() {
    const live = process.argv.includes('--live');
    const includeCross = process.argv.includes('--include-cross-design');

    if (!shopify.isConfigured()) {
        console.error('Shopify not configured:', shopify.missingConfig().join(', '));
        process.exit(1);
    }

    const all = await fetchAll();
    const map = {};
    all.forEach((r) => { map[r.path] = r.target; });

    const chains = [];
    for (const r of all) {
        if (map[r.target] === undefined) continue;           // already single-hop
        const { hops, terminal, loop } = resolve(r.path, map);
        if (loop) { console.error(`\n✖ Redirect LOOP at ${r.path} — refusing to touch anything.`); process.exit(1); }
        const a = designOf(hops[0]), b = designOf(terminal);
        chains.push({ id: r.id, path: r.path, from: r.target, to: terminal, hops: hops.length - 1, trail: hops, cross: Boolean(a && b && a !== b), a, b });
    }

    const same = chains.filter((c) => !c.cross);
    const cross = chains.filter((c) => c.cross);
    const batch = includeCross ? chains : same;

    console.log(`\nREDIRECTS: ${all.length} total, ${chains.length} chain(s), ${all.length - chains.length} already direct`);
    console.log(`   same-design  : ${same.length}   <- the default batch`);
    console.log(`   cross-design : ${cross.length}   <- excluded unless --include-cross-design`);

    if (cross.length && !includeCross) {
        console.log('\nEXCLUDED — these end on a DIFFERENT design than the source URL implies.');
        console.log('Flattening them would only make a wrong destination arrive faster:');
        cross.slice(0, 6).forEach((c) => console.log(`   #${c.a} -> #${c.b}  ${c.path.slice(0, 56)}`));
        if (cross.length > 6) console.log(`   ... and ${cross.length - 6} more (see exports/redirect_chains.csv)`);
    }

    if (!batch.length) { console.log('\n✔ Nothing to flatten.'); return; }

    console.log(`\nWILL FLATTEN ${batch.length} redirect(s):`);
    batch.forEach((c) => {
        console.log(`   ${c.hops} hops  ${c.path.slice(0, 56)}`);
        console.log(`             now -> ${c.from.slice(0, 60)}`);
        console.log(`             new -> ${c.to.slice(0, 60)}`);
    });

    if (!live) {
        console.log('\nDry run. Re-run with --live to apply.');
        console.log('Current targets are recorded in 253gear-growth/data/redirects.json — reversible.');
        return;
    }

    // Snapshot before mutating, so the change is undoable without a fresh pull.
    const backup = path.join(__dirname, `redirect-backup-${new Date().toISOString().slice(0, 10)}.json`);
    fs.writeFileSync(backup, JSON.stringify(all, null, 1));
    console.log(`\n✔ backup written: ${path.basename(backup)}`);

    let n = 0;
    for (const c of batch) {
        await shopify.gql(M, { id: c.id, urlRedirect: { path: c.path, target: c.to } });
        n++;
    }
    console.log(`✔ flattened ${n} redirect(s)`);

    // ── Re-read and assert, rather than trusting the mutation's own response.
    const after = await fetchAll();
    const map2 = {};
    after.forEach((r) => { map2[r.path] = r.target; });

    let stillChained = 0, wrongTarget = 0;
    for (const c of batch) {
        if (map2[c.path] !== c.to) { wrongTarget++; console.error(`   ✖ ${c.path} -> ${map2[c.path]} (expected ${c.to})`); }
        if (map2[map2[c.path]] !== undefined) stillChained++;
    }
    if (wrongTarget || stillChained) {
        console.error(`\n✖ ${wrongTarget} wrong target(s), ${stillChained} still chained.`);
        process.exit(1);
    }

    const remaining = after.filter((r) => map2[r.target] !== undefined);
    console.log('\n✔ Verified by re-reading:');
    console.log(`     every one of the ${batch.length} now points straight at its destination`);
    console.log(`     chains remaining on the store: ${remaining.length}${remaining.length ? '  (the cross-design ones, awaiting a decision)' : ''}`);
    console.log(`     total redirects: ${after.length} (unchanged — nothing was deleted)`);
}

main().catch((e) => {
    console.error('\nFAILED:', shopify.redactShopify(e));
    process.exit(1);
});
