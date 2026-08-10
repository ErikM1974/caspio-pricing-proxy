#!/usr/bin/env node
/**
 * Send blank-garment searchers to the page that answers them.
 *
 *   node scripts/253gear-redirect-blank-skus.js          # dry run
 *   node scripts/253gear-redirect-blank-skus.js --live
 *
 * THE LEAK. Measured over 90 days: 1,000 sessions land on 253gear.com/products/<style-number>
 * and hit a 404. There are 127 redirects on the store and not one covers a blank SKU. These
 * pages existed once, were deleted rather than redirected, and Google still sends people.
 *
 * WHO THEY ARE, and why this is not an SEO chore. Nobody types "NKBQ5230" casually. A person
 * searching a Port & Company or Bella+Canvas style number is sourcing, spec'ing or pricing a
 * job — and NWCA decorates exactly these garments. Somebody who needs 100 printed PC54s is
 * worth far more than a $22.50 retail tee. On the numbers these may be the most valuable
 * visitors 253gear receives, and every one of them currently hits a dead end.
 *
 * 🔑 ONE-TO-ONE, NEVER A BLANKET REDIRECT. Each SKU goes to ITS OWN teamnwca product page,
 * verified to exist before anything is pointed at it. Dumping six dead URLs on a homepage is
 * the pattern search engines treat as a soft 404 — it reads as tidying rather than moving.
 * Six exact matches are the case they handle cleanly: the content moved, here is where.
 *
 * ⚠️ CROSS-DOMAIN, SO THE SIGNAL LEAVES. A 301 hands 253gear's residual ranking for these
 * terms to teamnwca. That is the intent — teamnwca is where the answer lives — but it is a
 * one-way door in practice, and worth Erik knowing it was deliberate rather than incidental.
 *
 * ⏳ IT IS ALSO A CLOSING WINDOW. 253gear ranks for these only because the pages once existed.
 * That decays on its own. The traffic is worth capturing now or not at all.
 */

'use strict';

require('dotenv').config();
const shopify = require('./../src/utils/shopify-client');

/** Where the answers actually live. Confirmed public + indexable, no login gate. */
const DEST = (sku) => `https://www.teamnwca.com/product.html?style=${sku}`;

/** Probe target — the app that serves those pages. */
const PROBE = 'https://sanmar-inventory-app-4cd7b252508d.herokuapp.com/product?style=';

const SKUS = [
    { sku: 'PC54', path: '/products/pc54', sessions90d: 269 },
    { sku: 'PC147', path: '/products/pc147', sessions90d: 239 },
    { sku: 'BC3001', path: '/products/bc3001', sessions90d: 197 },
    { sku: 'PC54Y', path: '/products/pc54y', sessions90d: 122 },
    { sku: 'NKBQ5230', path: '/products/nkbq5230', sessions90d: 116 },
    { sku: 'LPC54', path: '/products/lpc54', sessions90d: 57 },
    // The tail, surfaced once the first six stopped dominating the dead-URL list.
    { sku: 'PC55Y', path: '/products/pc55y', sessions90d: 22 },
    { sku: 'S021R', path: '/products/s021r', sessions90d: 12 },
    { sku: '5100P', path: '/products/5100p', sessions90d: 7 }
];

const Q_REDIRECTS = `
query($cursor: String) {
  urlRedirects(first: 250, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes { id path target }
  }
}`;

const M_CREATE = `
mutation($redirect: UrlRedirectInput!) {
  urlRedirectCreate(urlRedirect: $redirect) {
    urlRedirect { id path target }
    userErrors { field message }
  }
}`;

const M_UPDATE = `
mutation($id: ID!, $redirect: UrlRedirectInput!) {
  urlRedirectUpdate(id: $id, urlRedirect: $redirect) {
    urlRedirect { id path target }
    userErrors { field message }
  }
}`;

/**
 * Confirm the destination is a real product page before sending anyone there.
 * Moving 1,000 people from one dead end to another would be strictly worse than
 * leaving them alone, because it would also look deliberate.
 */
async function destinationIsReal(sku) {
    const res = await fetch(PROBE + encodeURIComponent(sku), {
        signal: AbortSignal.timeout(25000),
        headers: { 'User-Agent': 'nwca-redirect-check' }
    });
    if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
    const html = await res.text();
    const title = (html.match(/<title>(.*?)<\/title>/s) || [, ''])[1].trim();
    if (html.length < 3000) return { ok: false, why: `page is only ${html.length} bytes` };
    if (/not found|error/i.test(title)) return { ok: false, why: `title reads "${title}"` };
    // The SKU must actually appear in the title — otherwise a fallback page is being served
    // and every SKU would "pass" against the same generic response.
    if (!new RegExp(sku, 'i').test(title)) return { ok: false, why: `title does not mention ${sku}: "${title}"` };
    if (/noindex/i.test(html)) return { ok: false, why: 'page is noindex — no point sending search traffic to it' };
    return { ok: true, title };
}

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

    console.log('\nVerifying every destination before anything is pointed at it:\n');
    let allGood = true;
    for (const s of SKUS) {
        const v = await destinationIsReal(s.sku);
        console.log(`  ${v.ok ? '✔' : '✖'} ${s.sku.padEnd(9)} ${v.ok ? v.title.slice(0, 62) : v.why}`);
        if (!v.ok) allGood = false;
    }
    if (!allGood) {
        console.error('\n✖ At least one destination is not a real product page. Refusing to redirect anyone.');
        process.exit(1);
    }

    const byPath = new Map((await allRedirects()).map((r) => [r.path, r]));
    const create = [];
    const update = [];
    for (const s of SKUS) {
        const target = DEST(s.sku);
        const existing = byPath.get(s.path);
        if (!existing) { create.push({ ...s, target }); continue; }
        if (existing.target === target) { console.log(`  = ${s.path} already correct`); continue; }
        update.push({ ...s, target, id: existing.id, from: existing.target });
    }

    const total = [...create, ...update].reduce((a, x) => a + x.sessions90d, 0);
    console.log(`\n${create.length} to create, ${update.length} to update — ${total} sessions per 90 days.`);
    create.forEach((c) => console.log(`  + ${c.path.padEnd(28)} -> ${c.target}   (${c.sessions90d}/90d)`));
    update.forEach((u) => console.log(`  ~ ${u.path.padEnd(28)} ${u.from} -> ${u.target}`));

    if (!create.length && !update.length) { console.log('\nNothing to change.'); return; }
    if (!live) { console.log('\nDry run. Re-run with --live to apply.'); return; }

    for (const c of create) {
        const res = await shopify.gql(M_CREATE, { redirect: { path: c.path, target: c.target } });
        const errs = (res.urlRedirectCreate && res.urlRedirectCreate.userErrors) || [];
        if (errs.length) { console.error(`✖ ${c.path}: ${errs.map((e) => e.message).join('; ')}`); process.exit(1); }
        console.log(`✔ created ${c.path}`);
    }
    for (const u of update) {
        const res = await shopify.gql(M_UPDATE, { id: u.id, redirect: { path: u.path, target: u.target } });
        const errs = (res.urlRedirectUpdate && res.urlRedirectUpdate.userErrors) || [];
        if (errs.length) { console.error(`✖ ${u.path}: ${errs.map((e) => e.message).join('; ')}`); process.exit(1); }
        console.log(`✔ updated ${u.path}`);
    }

    const after = new Map((await allRedirects()).map((r) => [r.path, r.target]));
    let bad = 0;
    for (const s of SKUS) {
        const got = after.get(s.path);
        if (got !== DEST(s.sku)) { console.error(`✖ ${s.path} -> ${got}`); bad++; }
    }
    if (bad) { console.error(`\n✖ ${bad} redirect(s) did not take.`); process.exit(1); }

    console.log(`\n✔ Verified by re-reading: all ${SKUS.length} blank SKUs now resolve to their own teamnwca page.`);
    console.log(`  ${total} sessions per 90 days that were hitting a 404 now land on the garment they searched for.`);
}

main().catch((e) => {
    console.error('\nFAILED:', shopify.redactShopify(e));
    process.exit(1);
});
