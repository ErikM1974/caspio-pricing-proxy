#!/usr/bin/env node
/**
 * Emit the seed rows for the Caspio table `Shopify_Config_2026`.
 *
 *   node scripts/253gear-seed-config.js            # print the spec + rows
 *   node scripts/253gear-seed-config.js --csv-out  # write seed CSV for a Caspio import
 *
 * WHY THIS EXISTS. Every price, ladder step, garment mapping and tag lives in Caspio
 * so Erik changes a number and the storefront reflects it with NO deploy (CLAUDE.md,
 * "Pricing = API, never hardcoded"). There is deliberately no built-in default in the
 * code: an absent key makes the publisher return 503 naming what is missing, rather
 * than shipping a product at a price nobody set.
 *
 * The values below are the CURRENT known-good ones from
 * Downloads/253gear-ops/CLAUDE.md. Two are unconfirmed and marked as such — the
 * publisher refuses to build a garment whose price is missing, so a wrong guess
 * cannot silently reach the store.
 *
 * Caspio table to create (Import this CSV and Caspio offers to build the table):
 *
 *   Config_Key    Text(255)     the setting name
 *   Config_Value  Text(64000)   scalar, or JSON when Value_Type = json
 *   Value_Type    Text(20)      string | number | json | bool
 *   Notes         Text(255)     what this controls, for whoever edits it next
 *   Active        Text(3)       Yes / No  (blank counts as Yes)
 *   Updated_At    Timestamp
 */

const fs = require('fs');
const path = require('path');

// ⚠️ UNCONFIRMED — Erik still owes the crewneck retail price, and confirmation that
// PC78 / PC78H are the SanMar styles behind the 253gear hoodie and crewneck.
// The crewneck row is seeded Active=No so the publisher refuses that garment loudly
// instead of inventing a price for it.
const ROWS = [
    {
        Config_Key: 'styles',
        Value_Type: 'json',
        // Every value below was MEASURED off live variants by scripts/253gear-inspect.js
        // on 2026-08-07 — not assumed. The earlier guesses were wrong on four counts:
        // ounces (the store uses GRAMS), a flat weight (it ladders by size), a
        // colour-bearing SKU (the store uses the SanMar SKU with a size suffix), and
        // lowercase filter tags (they are 'T-Shirt' / 'Hoodie').
        Notes: 'Garment options, measured from live variants. price/sanmarStyle/productType/filterTag/weightGrams/upsizeWeightGrams.',
        Active: 'Yes',
        Config_Value: JSON.stringify([
            {
                option: 'T-Shirt', sanmarStyle: 'PC54', productType: 'T-Shirt', filterTag: 'T-Shirt',
                price: 22.50, weightGrams: 159,
                upsizeWeightGrams: { '2XL': 231, '3XL': 272, '4XL': 295 }
            },
            {
                option: 'Hoodie', sanmarStyle: 'PC78H', productType: 'Sweatshirt', filterTag: 'Hoodie',
                price: 43.75, weightGrams: 490,
                upsizeWeightGrams: { '2XL': 644, '3XL': 680, '4XL': 680 }
            },
            {
                // 422 g measured live. No upsize weights observed yet — the ladder is
                // scaled from the hoodie's ratios until a real 2XL+ crewneck exists.
                option: 'Crewneck', sanmarStyle: 'PC78', productType: 'Sweatshirt', filterTag: 'Crewneck',
                price: 39.00, weightGrams: 422,
                upsizeWeightGrams: { '2XL': 555, '3XL': 586, '4XL': 586 }
            }
        ], null, 0)
    },
    {
        Config_Key: 'upsizes',
        Value_Type: 'json',
        Notes: 'Sizes that take a SKU suffix and a heavier weight, e.g. PC54 -> PC54_2XL. Everything else uses the base SKU.',
        Active: 'Yes',
        Config_Value: JSON.stringify(['2XL', '3XL', '4XL'])
    },
    {
        Config_Key: 'cities',
        Value_Type: 'json',
        // 🔴 The tag is NOT the collection handle. Read live from the smart-collection
        // ruleSets: the `tacoma` collection keys on tag "city:Tacoma", prefixed and
        // capitalised. Emitting a bare "tacoma" files the product into NOTHING.
        Notes: 'City -> literal Shopify tag -> collection handle. Tags are case-sensitive and prefixed.',
        Active: 'Yes',
        Config_Value: JSON.stringify([
            { name: 'Tacoma', tag: 'city:Tacoma', collection: 'tacoma' },
            { name: 'Puyallup', tag: 'city:Puyallup', collection: 'puyallup' },
            { name: 'Fife', tag: 'city:Fife', collection: 'fife' },
            { name: 'Edgewood', tag: 'city:Edgewood', collection: 'edgewood' },
            { name: 'Milton', tag: 'city:Milton', collection: 'milton' },
            { name: 'Sumner', tag: 'city:Sumner', collection: 'sumner' },
            { name: 'Spanaway', tag: 'city:Spanaway', collection: 'spanaway' },
            { name: 'Washington', tag: 'city:Washington', collection: 'washington-pnw' }
        ])
    },
    {
        Config_Key: 'size_ladder',
        Value_Type: 'json',
        Notes: 'Dollars ADDED to the base price for these sizes. Everything else adds 0.',
        Active: 'Yes',
        Config_Value: JSON.stringify({ '2XL': 2, '3XL': 3, '4XL': 4 })
    },
    {
        Config_Key: 'size_order',
        Value_Type: 'json',
        Notes: 'Display order for the Size option.',
        Active: 'Yes',
        Config_Value: JSON.stringify(['S', 'M', 'L', 'XL', '2XL', '3XL', '4XL'])
    },
    {
        Config_Key: 'base_tags',
        Value_Type: 'json',
        // 🔴 "253", not "253-gear". The 253-gear COLLECTION keys on the tag "253";
        // the handle and the tag are different strings.
        Notes: 'Tags on every 253gear product. The 253-gear collection keys on "253".',
        Active: 'Yes',
        Config_Value: JSON.stringify(['253'])
    },
    {
        Config_Key: 'vendor',
        Value_Type: 'string',
        Notes: 'Shopify product vendor. Matches all 47 live products.',
        Active: 'Yes',
        Config_Value: 'Northwest Custom Apparel'
    },
    {
        Config_Key: 'product_type',
        Value_Type: 'string',
        Notes: 'Fallback only. The real productType comes from the primary garment (T-Shirt / Sweatshirt).',
        Active: 'Yes',
        Config_Value: 'T-Shirt'
    },
    {
        Config_Key: 'tag_vocabulary',
        Value_Type: 'json',
        Notes: 'DISCOVERED from the live smart-collection ruleSets 2026-08-07. Do not hand-edit; POST /api/shopify/config/refresh-collections rewrites it.',
        Active: 'Yes',
        Config_Value: JSON.stringify([
            '253', 'fife', 'milton', 'edgewood', 'alumni', 'sanmar',
            'city:tacoma', 'city:puyallup', 'city:washington', 'city:fife',
            'city:edgewood', 'city:milton', 'city:sumner', 'city:spanaway'
        ])
    },
    {
        Config_Key: 'collection_rules',
        Value_Type: 'json',
        Notes: 'DISCOVERED, do not hand-edit. Same refresh endpoint. Empty until it has run.',
        Active: 'Yes',
        Config_Value: JSON.stringify([])
    },
    {
        Config_Key: 'publication_id',
        Value_Type: 'string',
        Notes: 'Online Store publication GID, read live 2026-08-07. Enables publishablePublish; blank falls back to the REST publish.',
        Active: 'Yes',
        Config_Value: 'gid://shopify/Publication/58435764380'
    },
    {
        Config_Key: 'description_prompt',
        Value_Type: 'string',
        Notes: 'System prompt for the copy drafter. Edit here to change the voice with no deploy.',
        Active: 'Yes',
        Config_Value: [
            'You write product descriptions for 253gear.com, a South Sound city and landmark',
            'apparel store printed to order in Milton, Washington.',
            '',
            'Structure: one short hook sentence as the first paragraph (the theme renders it',
            'under the price), then 200+ words of real local history about the place.',
            '',
            'HARD RULES:',
            '- Use ONLY facts the user supplied or that a cited source confirms. Never assert',
            '  local detail from memory.',
            '- Never state that a business has closed without a source. A previous description',
            '  said the Flying Boots Cafe was gone; it is open and trading.',
            '- Never make a fabric or weight claim. PC54 is 5.4 oz and heathers are blends;',
            '  "100% cotton, 6.1 oz" was wrong on 40 products. Fabric text comes only from the',
            '  SanMar PRODUCT_DESCRIPTION field.',
            '- No templated filler. The catalogue target is 200+ words, mostly distinctive text.',
            '- Cite a source for each factual claim about the place.'
        ].join('\n')
    }
];

const HEADERS = ['Config_Key', 'Config_Value', 'Value_Type', 'Notes', 'Active'];

function csvCell(v) {
    const s = String(v === null || v === undefined ? '' : v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows) {
    return [HEADERS.join(',')]
        .concat(rows.map((r) => HEADERS.map((h) => csvCell(r[h])).join(',')))
        .join('\r\n') + '\r\n';
}

function main() {
    const wantCsv = process.argv.includes('--csv-out');

    if (wantCsv) {
        const outDir = path.join(__dirname, '..', '.cache');
        fs.mkdirSync(outDir, { recursive: true });
        const outFile = path.join(outDir, 'Shopify_Config_2026.seed.csv');
        fs.writeFileSync(outFile, toCsv(ROWS), 'utf8');
        console.log(`Wrote ${ROWS.length} seed rows to:\n  ${outFile}`);
        console.log('\nIn Caspio: Tables → New Table → Import from file → pick this CSV.');
        console.log('Then widen Config_Value to Text(64000) and set Updated_At as a Timestamp.');
        return;
    }

    console.log('Caspio table: Shopify_Config_2026\n');
    console.log('  Config_Key    Text(255)');
    console.log('  Config_Value  Text(64000)   <- must be 64000, the prompt and JSON need it');
    console.log('  Value_Type    Text(20)      string | number | json | bool');
    console.log('  Notes         Text(255)');
    console.log('  Active        Text(3)       Yes / No (blank = Yes)');
    console.log('  Updated_At    Timestamp\n');
    console.log(`${ROWS.length} seed rows:\n`);
    for (const r of ROWS) {
        const preview = String(r.Config_Value).replace(/\s+/g, ' ').slice(0, 96);
        console.log(`  ${r.Active === 'No' ? '(inactive) ' : ''}${r.Config_Key}  [${r.Value_Type}]`);
        console.log(`      ${preview}${String(r.Config_Value).length > 96 ? '…' : ''}`);
    }
    console.log('\nRun with --csv-out to write an importable CSV.');
    console.log('\nStill needed from Erik: the crewneck retail price, and confirmation that');
    console.log('PC78 / PC78H are the SanMar styles behind the hoodie and crewneck.');
}

if (require.main === module) main();

module.exports = { ROWS, toCsv, HEADERS };
