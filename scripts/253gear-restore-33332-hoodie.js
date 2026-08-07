#!/usr/bin/env node
/**
 * Put the hoodie photo back on Historic Puyallup Raceways #33332, relabelled Athletic Heather.
 *
 *   node scripts/253gear-restore-33332-hoodie.js          # dry run
 *   node scripts/253gear-restore-33332-hoodie.js --live
 *
 * WHY THIS EXISTS. The product was recoloured to a single colour, Athletic Heather, and its
 * only hoodie photo — shot on an Ash garment — was deleted with it. That left the hoodie
 * falling back to a lifestyle photo of a TEE. Erik's call: the two greys are close enough
 * that the existing shot is fine, so restore it and fix the wording rather than wait on a
 * reshoot.
 *
 * 🔑 DELETING PRODUCT MEDIA DOES NOT DELETE THE FILE. `productDeleteMedia` detaches the
 * image from the product; the underlying file stays in Shopify Files, still READY, at a
 * DIFFERENT CDN url (the /products/ path, with no attachment UUID). The url the product was
 * serving 404s, so recovery has to go via a `files(query:)` lookup — not by re-uploading
 * bytes we no longer have locally.
 *
 * Three things change, and the description is not cosmetic: the body copy names the garment
 * colour, so leaving it saying "Ash" would contradict the Colour shown on the page.
 */

require('dotenv').config();
const shopify = require('./../src/utils/shopify-client');

const PRODUCT_ID = 'gid://shopify/Product/5762255585436';
const FILE_QUERY = '33332';
const FILE_MATCH = 'HistoricPuyallupRacewaysAshHoodieThumbnail';
const ALT = 'Historic Puyallup Raceways drag racing design on an Athletic Heather hoodie';
const BODY_FROM = '— Ash, heavyweight 50/50 blend, hooded';
const BODY_TO = '— Athletic Heather, heavyweight 50/50 blend, hooded';

const Q_FILES = `query($q: String) { files(first: 20, query: $q) { nodes { id fileStatus ... on MediaImage { image { url width height } } } } }`;

const Q_PRODUCT = `
{
  product(id: "${PRODUCT_ID}") {
    id title descriptionHtml
    media(first: 30) { nodes { id alt ... on MediaImage { image { url } } } }
    variants(first: 100) { nodes { id sku image { url } selectedOptions { name value } } }
  }
}`;

const M_CREATE_MEDIA = `
mutation($productId: ID!, $media: [CreateMediaInput!]!) {
  productCreateMedia(productId: $productId, media: $media) {
    media { ... on MediaImage { id status } }
    mediaUserErrors { field message code }
  }
}`;

const Q_MEDIA_STATUS = `
{ product(id: "${PRODUCT_ID}") { media(first: 30) { nodes { id ... on MediaImage { status image { url } } } } } }`;

const M_BIND = `
mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants { id }
    userErrors { field message code }
  }
}`;

const M_UPDATE = `
mutation($product: ProductUpdateInput!) {
  productUpdate(product: $product) { product { id } userErrors { field message } }   # UserError: no 'code'
}`;

const M_ALT = `
mutation($files: [FileUpdateInput!]!) {
  fileUpdate(files: $files) { files { id alt } userErrors { field message code } }
}`;

const opt = (v, n) => ((v.selectedOptions || []).find((o) => o.name === n) || {}).value || '';
const fileOf = (u) => String(u || '').split('?')[0].split('/').pop();

async function main() {
    const live = process.argv.includes('--live');
    if (!shopify.isConfigured()) {
        console.error('Shopify not configured:', shopify.missingConfig().join(', '));
        process.exit(1);
    }

    const files = (await shopify.gql(Q_FILES, { q: FILE_QUERY }, { isMutation: false })).files.nodes || [];
    const src = files.find((f) => f.image && fileOf(f.image.url).includes(FILE_MATCH));
    if (!src) {
        console.error(`\n✖ The hoodie file is not in Shopify Files any more — it would have to be re-uploaded.`);
        process.exit(1);
    }
    if (src.fileStatus !== 'READY') {
        console.error(`\n✖ File is ${src.fileStatus}, not READY.`);
        process.exit(1);
    }

    const p = (await shopify.gql(Q_PRODUCT, {}, { isMutation: false })).product;
    const hoodies = p.variants.nodes.filter((v) => opt(v, 'Style') === 'Hoodie');
    const already = p.media.nodes.find((m) => m.image && fileOf(m.image.url).includes(FILE_MATCH));

    console.log(`\n${p.title}`);
    console.log(`   photos on product now : ${p.media.nodes.length}`);
    console.log(`   hoodie variants       : ${hoodies.length}, ${hoodies.filter((v) => v.image).length} with a photo`);
    console.log(`   recovered file        : ${fileOf(src.image.url)}  ${src.image.width}x${src.image.height}`);
    console.log('\nWILL DO:');
    console.log(`   - ${already ? 'photo already on product — skip re-add' : 're-attach the hoodie photo from Shopify Files'}`);
    console.log(`   - set its alt text to: "${ALT}"`);
    console.log(`   - bind ${hoodies.length} hoodie variant(s) to it`);
    const bodyHit = (p.descriptionHtml || '').includes(BODY_FROM);
    console.log(`   - description: ${bodyHit ? `"${BODY_FROM}"  ->  "${BODY_TO}"` : '⚠ phrase not found — description left alone'}`);

    if (!live) { console.log('\nDry run. Re-run with --live to apply.'); return; }

    let mediaId = already && already.id;
    if (!mediaId) {
        await shopify.gql(M_CREATE_MEDIA, {
            productId: PRODUCT_ID,
            media: [{ originalSource: src.image.url, mediaContentType: 'IMAGE', alt: ALT }]
        });
        // Binding to media still PROCESSING is how the unbound-variant defect happens.
        for (let i = 0; i < 30; i++) {
            const nodes = (await shopify.gql(Q_MEDIA_STATUS, {}, { isMutation: false })).product.media.nodes;
            const hit = nodes.find((m) => m.image && fileOf(m.image.url).includes(FILE_MATCH));
            if (hit && hit.status === 'READY') { mediaId = hit.id; break; }
            if (hit && hit.status === 'FAILED') { console.error('\n✖ Media FAILED to process.'); process.exit(1); }
            await new Promise((r) => setTimeout(r, 1500));
        }
        if (!mediaId) { console.error('\n✖ Media never reached READY.'); process.exit(1); }
        console.log('✔ photo re-attached and READY');
    }

    await shopify.gql(M_ALT, { files: [{ id: mediaId, alt: ALT }] });
    console.log('✔ alt text set');

    await shopify.gql(M_BIND, {
        productId: PRODUCT_ID,
        variants: hoodies.map((v) => ({ id: v.id, mediaId }))
    });
    console.log(`✔ bound ${hoodies.length} hoodie variant(s)`);

    if (bodyHit) {
        await shopify.gql(M_UPDATE, {
            product: { id: PRODUCT_ID, descriptionHtml: p.descriptionHtml.split(BODY_FROM).join(BODY_TO) }
        });
        console.log('✔ description updated');
    }

    // ── Re-read and assert.
    const now = (await shopify.gql(Q_PRODUCT, {}, { isMutation: false })).product;
    const nowHoodies = now.variants.nodes.filter((v) => opt(v, 'Style') === 'Hoodie');
    const tees = now.variants.nodes.filter((v) => opt(v, 'Style') === 'T-Shirt');
    const hoodiePhoto = new Set(nowHoodies.map((v) => fileOf(v.image && v.image.url)));
    const teePhoto = new Set(tees.map((v) => fileOf(v.image && v.image.url)));

    if (hoodiePhoto.size !== 1 || hoodiePhoto.has('undefined')) {
        console.error(`\n✖ Hoodie variants do not all share one photo: ${[...hoodiePhoto].join(', ')}`);
        process.exit(1);
    }
    if ([...hoodiePhoto][0] === [...teePhoto][0]) {
        console.error('\n✖ The hoodie is still showing the tee photo.');
        process.exit(1);
    }
    if (/\bAsh\b/i.test((now.descriptionHtml || '').replace(/<[^>]+>/g, ' '))) {
        console.error('\n✖ The description still says "Ash".');
        process.exit(1);
    }
    console.log('\n✔ Verified by re-reading:');
    console.log(`     T-Shirt -> ${[...teePhoto][0].slice(0, 46)}`);
    console.log(`     Hoodie  -> ${[...hoodiePhoto][0].slice(0, 46)}`);
    console.log('     description no longer mentions Ash');
}

main().catch((e) => {
    console.error('\nFAILED:', shopify.redactShopify(e));
    process.exit(1);
});
