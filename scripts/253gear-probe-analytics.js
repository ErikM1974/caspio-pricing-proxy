#!/usr/bin/env node
/**
 * What analytics can we actually READ from 253gear today?
 *
 *   node scripts/253gear-probe-analytics.js
 *
 * Erik asked for "current metrics of who is visiting 253gear.com" on Steve's dashboard.
 * Before wiring a single panel, establish what data exists — because the answer already
 * found on the Google side was "none": that account has zero Search Console properties,
 * zero Ads accounts, and a GA4 property whose only stream has never received a hit.
 *
 * A traffic panel with no traffic source behind it is worse than no panel. It looks like
 * a measurement.
 *
 * So: probe Shopify, which is the one place that definitely HAS the numbers, and find out
 * exactly which of them our credential is allowed to see. READ ONLY — every query here is
 * a query, there is no mutation in this file.
 */

'use strict';

require('dotenv').config();
const shopify = require('./../src/utils/shopify-client');

const PROBES = [
    {
        name: 'granted scopes',
        why: 'the ceiling on everything else here',
        q: 'query { currentAppInstallation { accessScopes { handle } } }',
        show: (d) => (d.currentAppInstallation.accessScopes || []).map((s) => s.handle).sort().join(', ')
    },
    {
        name: 'shop identity',
        why: 'confirms which store we are pointed at',
        q: 'query { shop { name myshopifyDomain primaryDomain { host } currencyCode } }',
        show: (d) => `${d.shop.name} — ${d.shop.primaryDomain.host} (${d.shop.myshopifyDomain}) ${d.shop.currencyCode}`
    },
    {
        name: 'orders (read_orders)',
        why: 'WHAT SELLS beats what gets visited — a sale is the signal, a session is a proxy for it',
        q: 'query { orders(first: 3, sortKey: CREATED_AT, reverse: true) { nodes { name createdAt } } }',
        show: (d) => `${d.orders.nodes.length} recent order(s): `
            + d.orders.nodes.map((o) => `${o.name} ${String(o.createdAt).slice(0, 10)}`).join(', ')
    },
    {
        name: 'ShopifyQL sessions (read_reports)',
        why: 'the actual traffic numbers, if we are allowed them',
        // Corrected 2026-08-09 against the live API. The original guess was wrong three
        // ways and every one of them is a trap worth keeping written down:
        //   - there is no TableResponse union member; tableData hangs straight off
        //   - `parseErrors` is [String!]! so a { code message } selection is rejected
        //   - there is no sum() function; the measure is the bare column, `SHOW sessions`
        q: 'query { shopifyqlQuery(query: "FROM sessions SHOW sessions SINCE -30d UNTIL today") '
            + '{ parseErrors tableData { columns { name } rows } } }',
        show: (d) => JSON.stringify(d.shopifyqlQuery.tableData.rows)
    },
    {
        name: 'product sales rank (read_orders)',
        why: 'if this works, Steve can be told which SUBJECTS actually sold — the real ranking input',
        q: 'query { orders(first: 25, sortKey: CREATED_AT, reverse: true) { nodes { lineItems(first: 10) { nodes { title quantity } } } } }',
        show: (d) => {
            const tally = {};
            d.orders.nodes.forEach((o) => o.lineItems.nodes.forEach((li) => {
                tally[li.title] = (tally[li.title] || 0) + li.quantity;
            }));
            const top = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 5);
            return top.length ? top.map(([t, n]) => `${n}× ${t.slice(0, 45)}`).join(' | ') : '(no line items)';
        }
    }
];

async function main() {
    if (!shopify.isConfigured()) {
        console.error('Shopify not configured:', shopify.missingConfig().join(', '));
        process.exit(1);
    }

    const summary = [];
    for (const p of PROBES) {
        process.stdout.write(`\n▸ ${p.name}\n  ${p.why}\n  `);
        try {
            const d = await shopify.gql(p.q, {}, { isMutation: false });
            const out = p.show(d);
            console.log(`✔ ${out}`);
            summary.push({ probe: p.name, ok: true });
        } catch (e) {
            // The message is the useful part — an ACCESS_DENIED names the missing scope,
            // which is exactly the thing Erik would need to grant.
            const msg = shopify.redactShopify(e);
            console.log(`✖ ${String(msg && msg.message ? msg.message : msg).slice(0, 220)}`);
            summary.push({ probe: p.name, ok: false });
        }
    }

    console.log('\n─────────────────────────────────────────');
    summary.forEach((s) => console.log(`  ${s.ok ? '✔' : '✖'}  ${s.probe}`));
    console.log('\nA ✖ on orders or ShopifyQL is a SCOPE problem, not a code problem.');
    console.log('read_orders + read_reports were granted 2026-08-09 (app version V4). Note that');
    console.log('releasing a new app version is NOT enough — the token keeps reporting the OLD');
    console.log('scope set until the install itself is re-authorised through the grant screen.');
}

main().catch((e) => {
    console.error('\nFAILED:', shopify.redactShopify(e));
    process.exit(1);
});
