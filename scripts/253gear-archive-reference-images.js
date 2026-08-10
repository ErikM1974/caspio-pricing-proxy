#!/usr/bin/env node
/**
 * Pull the Tacoma Public Library reference photographs into our own file store, so Steve
 * always has them.
 *
 *   node scripts/253gear-archive-reference-images.js          # dry run
 *   node scripts/253gear-archive-reference-images.js --live
 *
 * WHY. The library's WEB VIEWER for this collection is restricted — it answers "the
 * collection cannot be displayed, log in and refresh". Their IIIF image endpoint is open, so
 * the briefs currently link there. That works today and is entirely outside our control
 * tomorrow: a collection can be re-permissioned, a URL scheme can change, and the reference
 * behind a design brief quietly becomes a broken link.
 *
 * ✅ RIGHTS ARE CLEAR AND WERE CHECKED FIRST. The library states, in the item metadata's own
 * Rights field: "Images used must credit Tacoma Public Library as follows: Northwest Room at
 * The Tacoma Public Library, (image number)". Attribution-only, no commercial restriction. So
 * every record here carries that exact credit string, and the dashboard renders it next to the
 * image. The credit is not decoration — it is the licence.
 *
 * 🔴 FACEBOOK PHOTOGRAPHS ARE DELIBERATELY NOT INCLUDED. Lori Haun's Pat's Drive In picture
 * and Rob Riley's Bowling Center print are other people's property with no stated licence —
 * and on the Bowling Center print somebody publicly asked for a credit and never got one, so
 * even the photographer is unknown. Those stay as links. "She approved" is not a licence, and
 * copying somebody's photograph into our storage on the strength of an ambiguous yes is
 * exactly how the goodwill just earned gets spent.
 *
 * WHERE IT GOES. POST /api/files/upload → Caspio Files API v3 → externalKey, served back by
 * GET /api/files/:externalKey. That is the store this codebase already uses for artwork, and
 * it is what Erik meant by "upload it to Caspio" — the Files API, not table rows. It is a
 * PUBLIC read endpoint, which the library's attribution-only terms permit.
 *
 * ⚠️ NOT via /api/files/import-from-url. That route has an SSRF host allowlist and the library
 * is not on it. Weakening a security guard to save a download step is a bad trade; this
 * fetches locally and uploads the bytes.
 */

'use strict';

require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const FormData = require('form-data');
const axios = require('axios');

const PROXY = process.env.PROXY_BASE_URL || 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';

const CREDIT = (imageNumber) =>
    `Northwest Room at The Tacoma Public Library, ${imageNumber}`;

const IIIF = (id, width) =>
    `https://tacomalibrary.contentdm.oclc.org/digital/iiif/p17061coll21/${id}/full/${width},/0/default.jpg`;

const IMAGES = [
    { cdmId: 33470, imageNumber: 'D144357-1', slug: 'hiho-bus-advert-1965',
      note: 'THE LOGO. Tacoma Transit Bus #303, 18 Feb 1965.' },
    { cdmId: 15781, imageNumber: 'A149103-2', slug: 'hiho-street-view-1966',
      note: 'Street view, 8 Jul 1966.' },
    { cdmId: 17250, imageNumber: 'D137936-1', slug: 'hiho-aerial-1963',
      note: 'Aerial, 9 Mar 1963 — earliest dated proof the centre existed.' },
    { cdmId: 16150, imageNumber: 'D149103-3', slug: 'hiho-elvins-end-1966',
      note: 'The Elvins end, 8 Jul 1966.' },
    { cdmId: 24275, imageNumber: 'D150443-1', slug: 'hiho-interior-1967',
      note: 'Interior with a Green Giant display, 20 Jan 1967.' }
];

/** Re-read the licence from the library rather than trusting this file's comment. */
async function confirmRights(cdmId) {
    const url = `https://tacomalibrary.contentdm.oclc.org/digital/api/collections/p17061coll21/items/${cdmId}/false`;
    const { data } = await axios.get(url, { timeout: 30000 });
    const f = (data.fields || []).find((x) => /^rights$/i.test(x.label));
    return f ? String(f.value) : null;
}

/**
 * 🔴 STEP THE WIDTH DOWN UNTIL THE LIBRARY WILL ACTUALLY RENDER IT.
 *
 * Two of these five source scans are smaller than 1600px, and the library's IIIF server does
 * not upscale — it answers `501 NOT_IMPLEMENTED` with a 50-byte HTML body. On the first run
 * that surfaced as "FAILED: 501" partway through, which I read as a flaky UPLOAD and retried
 * three times against the wrong end of the pipe. It was the DOWNLOAD, it was deterministic,
 * and it was the library politely saying "that size does not exist".
 *
 * The magic-byte check below is what stopped a 50-byte error page being stored as a
 * photograph, so the guard earned its place — but a guard that only says "not a JPEG" sends
 * you hunting in the wrong place. Hence trying real sizes, and reporting which one worked.
 */
async function download(cdmId, dest) {
    let lastErr = null;
    for (const width of [1600, 1200, 800, 600]) {
        try {
            const res = await axios.get(IIIF(cdmId, width), { responseType: 'arraybuffer', timeout: 60000 });
            const buf = Buffer.from(res.data);
            if (buf.length > 10000 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) {
                fs.writeFileSync(dest, buf);
                return { bytes: buf.length, width };
            }
            lastErr = new Error(`${width}px returned ${buf.length} bytes, not a JPEG`);
        } catch (e) {
            lastErr = new Error(`${width}px -> ${e.response ? e.response.status : e.message}`);
        }
    }
    throw new Error(`no renderable size for item ${cdmId}: ${lastErr && lastErr.message}`);
}

async function upload(file, name) {
    const fd = new FormData();
    fd.append('file', fs.createReadStream(file), { filename: name, contentType: 'image/jpeg' });
    const res = await axios.post(`${PROXY}/api/files/upload`, fd, {
        headers: fd.getHeaders(),
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 120000
    });
    const key = res.data && (res.data.externalKey || res.data.ExternalKey
        || (res.data.file && res.data.file.externalKey));
    if (!key) throw new Error('no externalKey in response: ' + JSON.stringify(res.data).slice(0, 200));
    return key;
}

async function main() {
    const live = process.argv.includes('--live');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tplref-'));

    console.log('\nConfirming the licence from the library, per image:\n');
    for (const im of IMAGES) {
        const rights = await confirmRights(im.cdmId);
        const ok = rights && /credit Tacoma Public Library/i.test(rights);
        console.log(`  ${ok ? '✔' : '✖'} ${im.imageNumber.padEnd(11)} ${rights ? rights.slice(0, 78) : '(no Rights field)'}`);
        if (!ok) {
            console.error('\n✖ Rights statement missing or changed. Stopping — the credit line IS the licence.');
            process.exit(1);
        }
    }

    if (!live) {
        console.log(`\nDry run — would archive ${IMAGES.length} image(s) to the Caspio file store.`);
        IMAGES.forEach((i) => console.log(`   ${i.slug}.jpg   ${CREDIT(i.imageNumber)}`));
        return;
    }

    const results = [];
    for (const im of IMAGES) {
        const file = path.join(tmp, `${im.slug}.jpg`);
        const got = await download(im.cdmId, file);
        const key = await upload(file, `253gear-ref-${im.slug}.jpg`);
        results.push({ ...im, externalKey: key, bytes: got.bytes, width: got.width,
            credit: CREDIT(im.imageNumber), url: `${PROXY}/api/files/${key}` });
        console.log(`✔ ${im.imageNumber.padEnd(11)} ${String(got.width).padStart(4)}px ${(got.bytes / 1024).toFixed(0).padStart(4)} KB  ->  ${key}`);
    }

    // Prove each one is actually retrievable before anything is written into a brief.
    console.log('\nVerifying every stored file reads back as a JPEG:');
    for (const r of results) {
        const res = await axios.get(r.url, { responseType: 'arraybuffer', timeout: 60000, validateStatus: () => true });
        const buf = Buffer.from(res.data || []);
        const good = res.status === 200 && buf.length > 10000 && buf[0] === 0xFF && buf[1] === 0xD8;
        console.log(`  ${good ? '✔' : '✖'} ${r.imageNumber}  HTTP ${res.status}  ${(buf.length / 1024).toFixed(0)} KB`);
        if (!good) { console.error('\n✖ A stored file does not read back. Not writing the briefs.'); process.exit(1); }
    }

    const out = path.join(__dirname, '..', '..', '253gear-growth', 'data', 'reference-images.json');
    fs.writeFileSync(out, JSON.stringify({
        _comment: 'Archived reference photographs. The credit string is REQUIRED by the library '
            + 'and must render wherever the image does — it is the licence, not a courtesy.',
        _source: 'Tacoma Public Library Northwest Room, collection p17061coll21',
        images: results.map(({ slug, imageNumber, externalKey, url, credit, note }) =>
            ({ slug, imageNumber, externalKey, url, credit, note }))
    }, null, 1));

    console.log(`\n✔ ${results.length} image(s) archived and verified.`);
    console.log(`  -> ${path.relative(process.cwd(), out)}`);
}

main().catch((e) => {
    console.error('\nFAILED:', e.response ? `${e.response.status} ${JSON.stringify(e.response.data).slice(0, 200)}` : e.message);
    process.exit(1);
});
