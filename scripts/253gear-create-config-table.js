#!/usr/bin/env node
/**
 * Create and seed the Caspio table `Shopify_Config_2026`.
 *
 *   node scripts/253gear-create-config-table.js            # dry run — shows the plan
 *   node scripts/253gear-create-config-table.js --live     # create + seed
 *
 * IDEMPOTENT. Re-running never drops or duplicates: an existing table is left alone,
 * and a row whose Config_Key is already present is skipped rather than re-inserted.
 * Nothing here deletes anything — Caspio DDL is destructive and irreversible, and the
 * standing rule on this account is that deletion is Erik's own click.
 *
 * Why the API rather than a CSV import: Erik's rule is ~1,000+ rows go through a
 * Caspio data import (separate meter, ~0 Integrations calls). This is 11 rows and one
 * table, so per-row writes are the cheaper, more precise path — the import setup would
 * cost more than the calls save.
 */

require('dotenv').config();
const axios = require('axios');
const config = require('../config');
const { getCaspioAccessToken } = require('../src/utils/caspio');
const { ROWS } = require('./253gear-seed-config');

const TABLE = 'Shopify_Config_2026';

// 🔴 DDL goes through v3 (`/integrations/rest/v3`), NOT v2.
//
// config.caspio.apiBaseUrl is the v2 base, and v2 will happily accept
// `POST /tables {Name, Fields}` — it returns success, creates the table, and SILENTLY
// DISCARDS every field. Worse, v2 then answers `GET /tables/<name>/fields` on its own
// creation with an HTTP 500 Runtime Error page, which reads like a corrupt table when
// it is really just an empty one. v3 handles the same table fine.
//
// The seven working scripts/create-*-table.js in this repo all require `../src/config`,
// whose apiBaseUrl IS v3 — that difference is the whole reason they work.
const BASE = config.caspio.apiV3BaseUrl;

// Caspio types: STRING = text(255), TEXT = text(64000).
//
// Shape copied from the seven working scripts/create-*-table.js in this repo — the key
// is `Fields`, NOT `Columns` (Caspio answers a `Columns` body with a flat
// IncorrectBodyParameter and no hint), Caspio adds the PK itself, and the house
// pattern stores timestamps as app-written STRINGs rather than a Caspio TIMESTAMP.
//
// Config_Value MUST be TEXT: the description prompt and the JSON blobs blow past 255.
const TABLE_DEF = {
    Name: TABLE,
    Fields: [
        { Name: 'Config_Key', Type: 'STRING', Unique: true },
        { Name: 'Config_Value', Type: 'TEXT' },
        { Name: 'Value_Type', Type: 'STRING' },
        { Name: 'Notes', Type: 'STRING' },
        { Name: 'Active', Type: 'STRING' },
        { Name: 'Updated_At', Type: 'STRING' }
    ]
};

async function auth() {
    const token = await getCaspioAccessToken();
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function tableExists(headers) {
    const r = await axios.get(`${BASE}/tables`, { headers, validateStatus: () => true });
    if (r.status !== 200) throw new Error(`Could not list tables (HTTP ${r.status})`);
    return (r.data.Result || []).includes(TABLE);
}

async function existingKeys(headers) {
    const r = await axios.get(`${BASE}/tables/${TABLE}/records`, {
        headers, params: { 'q.select': 'Config_Key', 'q.limit': 1000 }, validateStatus: () => true
    });
    if (r.status !== 200) return [];
    return (r.data.Result || []).map((x) => x.Config_Key);
}

async function main() {
    const live = process.argv.includes('--live');
    const headers = await auth();

    console.log(`\nTable: ${TABLE}`);
    console.log(`Fields: ${TABLE_DEF.Fields.map((f) => `${f.Name}(${f.Type})`).join(', ')}`);
    console.log(`Seed rows: ${ROWS.length} (${ROWS.filter((r) => r.Active === 'No').length} inactive)\n`);

    const exists = await tableExists(headers);
    console.log(exists ? `✔ ${TABLE} already exists — leaving its schema alone.` : `• ${TABLE} does not exist yet.`);

    if (!live) {
        console.log('\nDry run. Re-run with --live to create and seed.');
        return;
    }

    if (!exists) {
        const r = await axios.post(`${BASE}/tables`, TABLE_DEF,
            { headers, validateStatus: () => true });
        if (r.status >= 400) {
            throw new Error(`Create table failed (HTTP ${r.status}): ${JSON.stringify(r.data).slice(0, 400)}`);
        }
        console.log(`✔ Created ${TABLE}`);
    }

    // Add any missing fields. This also REPAIRS a table created against v2, which
    // silently drops the Fields array and leaves a valid but empty table behind —
    // additive, so it never touches a field that already exists.
    const fieldsResp = await axios.get(`${BASE}/tables/${TABLE}/fields`,
        { headers, validateStatus: () => true });
    const present = (fieldsResp.data && fieldsResp.data.Result || []).map((f) => f.Name);
    const missing = TABLE_DEF.Fields.filter((f) => !present.includes(f.Name));

    if (missing.length) {
        console.log(`• ${present.length} field(s) present, adding ${missing.length}.`);
        for (const field of missing) {
            const fr = await axios.post(`${BASE}/tables/${TABLE}/fields`, field,
                { headers, validateStatus: () => true });
            if (fr.status >= 400) {
                throw new Error(`Add field ${field.Name} failed (HTTP ${fr.status}): ${JSON.stringify(fr.data).slice(0, 300)}`);
            }
            console.log(`  + field ${field.Name} (${field.Type})`);
        }
    } else {
        console.log(`✔ All ${TABLE_DEF.Fields.length} fields already present.`);
    }

    const already = await existingKeys(headers);
    let inserted = 0, skipped = 0;

    for (const row of ROWS) {
        if (already.includes(row.Config_Key)) {
            console.log(`  – skip ${row.Config_Key} (already present)`);
            skipped++;
            continue;
        }
        const body = {
            Config_Key: row.Config_Key,
            Config_Value: row.Config_Value,
            Value_Type: row.Value_Type,
            Notes: row.Notes,
            Active: row.Active
        };
        const r = await axios.post(`${BASE}/tables/${TABLE}/records`, body,
            { headers, validateStatus: () => true });
        if (r.status >= 400) {
            console.error(`  ✖ ${row.Config_Key}: HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
            continue;
        }
        console.log(`  + ${row.Config_Key}${row.Active === 'No' ? '  (inactive)' : ''}`);
        inserted++;
    }

    console.log(`\nInserted ${inserted}, skipped ${skipped}.`);
    console.log('\nNext: POST /api/shopify/config/refresh-collections to discover the real tag');
    console.log('vocabulary from the live collections, then paste it into tag_vocabulary.');
    console.log('Still needed: the crewneck price (its row is seeded Active=No on purpose,');
    console.log('so the publisher refuses that garment rather than inventing a price).');
}

main().catch((e) => {
    console.error('\nFAILED:', e.message);
    process.exit(1);
});
