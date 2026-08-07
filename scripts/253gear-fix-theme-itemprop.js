#!/usr/bin/env node
/**
 * Fix the structured-data product name on 253gear.com.
 *
 *   node scripts/253gear-fix-theme-itemprop.js          # dry run — shows the diff
 *   node scripts/253gear-fix-theme-itemprop.js --live   # write it to the published theme
 *
 * THE DEFECT. sections/product-template.liquid emits schema.org Product microdata, and
 * the name it hands Google is the FULL product title — design number included:
 *
 *     <meta itemprop="name" content="{{ product.title }}">        <- line ~28
 *
 * while the H1 a shopper sees is correctly stripped:
 *
 *     {%- assign display_title = product.title | split: ' #' | first -%}   <- line ~118
 *     <h1 itemprop="name" ...>{{ display_title }}</h1>                     <- line ~119
 *
 * So every one of the ~47 live products tells Google it is called "Retro Sumner #34293".
 *
 * 🔴 WHY NOT JUST USE display_title AT LINE 28. It is assigned NINETY LINES LATER.
 * Liquid renders top to bottom, so an unassigned variable there renders EMPTY — that
 * would replace "leaks the design number" with "has no product name at all", which is
 * strictly worse for search. The filter chain is inlined instead: self-contained, no
 * ordering dependency, and byte-identical output to the H1.
 *
 * SAFETY
 *  - Targets the PUBLISHED theme, resolved at runtime by role. The reference notes
 *    warn that reading the wrong theme id reports files as missing; hardcoding an id
 *    that has since changed is exactly how that happens.
 *  - Refuses unless the defective line is found EXACTLY once, and refuses if the fix
 *    already appears — so a re-run is a no-op, not a double edit.
 *  - Writes a local backup of the original before touching anything.
 *  - Re-reads the file afterwards and verifies the change landed.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const shopify = require('../src/utils/shopify-client');

const FILE = 'sections/product-template.liquid';
const BEFORE = `<meta itemprop="name" content="{{ product.title }}">`;
const AFTER = `<meta itemprop="name" content="{{ product.title | split: ' #' | first }}">`;

const Q_PUBLISHED_THEME = `
query { themes(first: 20) { nodes { id name role } } }`;

const Q_READ_FILE = `
query($id:ID!, $f:[String!]) {
  theme(id:$id) {
    files(filenames:$f, first:5) {
      nodes { filename size body { ... on OnlineStoreThemeFileBodyText { content } } }
    }
  }
}`;

const M_WRITE_FILE = `
mutation($id:ID!, $files:[OnlineStoreThemeFilesUpsertFileInput!]!) {
  themeFilesUpsert(themeId:$id, files:$files) {
    upsertedThemeFiles { filename }
    userErrors { filename code message }
  }
}`;

async function publishedTheme() {
    const data = await shopify.gql(Q_PUBLISHED_THEME, {}, { isMutation: false });
    const nodes = (data.themes && data.themes.nodes) || [];
    const main = nodes.find((t) => String(t.role).toUpperCase() === 'MAIN');
    if (!main) {
        throw new Error(`No published (MAIN) theme found. Saw: ${nodes.map((t) => `${t.name}[${t.role}]`).join(', ')}`);
    }
    return main;
}

async function readFile(themeId) {
    const data = await shopify.gql(Q_READ_FILE, { id: themeId, f: [FILE] }, { isMutation: false });
    const node = ((data.theme && data.theme.files && data.theme.files.nodes) || [])[0];
    if (!node || !node.body || typeof node.body.content !== 'string') {
        throw new Error(`Could not read ${FILE} from the published theme.`);
    }
    return node.body.content;
}

async function main() {
    const live = process.argv.includes('--live');

    if (!shopify.isConfigured()) {
        console.error('Shopify is not configured. Missing:', shopify.missingConfig().join(', '));
        console.error('Add them to caspio-pricing-proxy/.env before running this.');
        process.exit(1);
    }

    const theme = await publishedTheme();
    console.log(`Published theme: ${theme.name}  (${theme.id})`);

    const original = await readFile(theme.id);
    const lines = original.split('\n');

    const already = original.includes(AFTER);
    const hits = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.includes(BEFORE));

    if (already) {
        console.log('\n✔ Already fixed — the inlined filter is present. Nothing to do.');
        return;
    }
    if (hits.length !== 1) {
        console.error(`\n✖ Expected exactly ONE occurrence of the defective line, found ${hits.length}.`);
        console.error('  Refusing to guess. The template may have changed since this script was written.');
        process.exit(1);
    }

    const at = hits[0].i;
    console.log(`\nFound the defect at line ${at + 1}:`);
    console.log(`  - ${lines[at].trim()}`);
    console.log(`  + ${lines[at].replace(BEFORE, AFTER).trim()}`);

    const patched = original.replace(BEFORE, AFTER);
    if (patched === original) {
        console.error('\n✖ Replacement produced no change. Aborting.');
        process.exit(1);
    }

    if (!live) {
        console.log('\nDry run. Re-run with --live to write it to the published theme.');
        return;
    }

    const backupDir = path.join(__dirname, '..', '.cache');
    fs.mkdirSync(backupDir, { recursive: true });
    const backup = path.join(backupDir, 'product-template.before-itemprop-fix.liquid');
    fs.writeFileSync(backup, original, 'utf8');
    console.log(`\nBacked up the original to:\n  ${backup}`);

    const result = await shopify.gql(M_WRITE_FILE, {
        id: theme.id,
        files: [{ filename: FILE, body: { type: 'TEXT', value: patched } }]
    });
    const upserted = (result.themeFilesUpsert && result.themeFilesUpsert.upsertedThemeFiles) || [];
    console.log(`✔ Wrote ${upserted.map((f) => f.filename).join(', ') || '(nothing?)'}`);

    // Trust the re-read, not the mutation's own response.
    const after = await readFile(theme.id);
    if (!after.includes(AFTER) || after.includes(BEFORE)) {
        console.error('\n✖ Re-read does NOT show the fix. Restore from the backup above.');
        process.exit(1);
    }
    console.log('✔ Verified by re-reading the theme file.');
    console.log('\nGoogle will pick this up on its next crawl. To see it now, view-source on any');
    console.log('product page and check the <meta itemprop="name"> tag near the top.');
}

main().catch((e) => {
    console.error('\nFAILED:', shopify.redactShopify(e));
    process.exit(1);
});
