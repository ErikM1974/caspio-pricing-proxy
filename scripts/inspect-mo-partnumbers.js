#!/usr/bin/env node
/**
 * inspect-mo-partnumbers.js — list every unique PartNumber in
 * ManageOrders_LineItems with its units, so we can decide which are
 * service codes (AL, CTR-*, EMBLEM, STK-*) vs real SanMar styles.
 */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');
const config = require('../src/config');
const { getCaspioAccessToken } = require('../src/utils/caspio');

async function rawGet(resourcePath, params = {}) {
    const token = await getCaspioAccessToken();
    return (await axios.get(`${config.caspio.apiBaseUrl}${resourcePath}`, {
        params, headers: { Authorization: `Bearer ${token}` }, timeout: 60000,
    })).data;
}

const SIZE_RE = /_(?:XS|S|M|L|XL|2XL|3XL|4XL|5XL|6XL|2X|3X|4X|5X|6X|OSFA|S\/M|M\/L|L\/XL|X\/L|XLT|XXLT|2XLT|3XLT)$/i;
function stripSize(pn) {
    let p = String(pn || '').trim();
    while (SIZE_RE.test(p)) { const next = p.replace(SIZE_RE, ''); if (next === p || !next) break; p = next; }
    return p.toUpperCase();
}

(async () => {
    const all = [];
    let page = 1;
    while (true) {
        const r = await rawGet('/tables/ManageOrders_LineItems/records', {
            'q.where': 'id_Order IS NOT NULL',
            'q.pageSize': 1000,
            'q.pageNumber': page,
            'q.select': 'PartNumber,PartDescription,LineQuantity,Size01,Size02,Size03,Size04,Size05,Size06',
        });
        const got = r.Result || [];
        all.push(...got);
        if (got.length < 1000) break;
        page++;
    }
    console.log(`Pulled ${all.length} total line items`);

    // Aggregate by base PartNumber
    const byPN = new Map();
    for (const li of all) {
        const pn = stripSize(li.PartNumber);
        if (!pn) continue;
        let units = Number(li.LineQuantity) || 0;
        if (units === 0) for (let i = 1; i <= 6; i++) units += Number(li[`Size0${i}`]) || 0;
        if (!byPN.has(pn)) byPN.set(pn, { pn, units: 0, lines: 0, sampleDesc: li.PartDescription || '' });
        const e = byPN.get(pn);
        e.units += units;
        e.lines++;
        if (!e.sampleDesc && li.PartDescription) e.sampleDesc = li.PartDescription;
    }

    const sorted = [...byPN.values()].sort((a, b) => b.lines - a.lines);
    console.log(`\nTotal unique part numbers (base): ${sorted.length}`);
    console.log(`\n=== Top 60 by line-item count ===`);
    console.log('LINES UNITS    PARTNUMBER                          DESCRIPTION');
    sorted.slice(0, 60).forEach(e => {
        console.log(`${String(e.lines).padStart(4)} ${String(e.units).padStart(6)}    ${e.pn.padEnd(35)} ${(e.sampleDesc || '').slice(0, 60)}`);
    });
})().catch(e => { console.error('FATAL:', e.response?.data || e.message); process.exit(1); });
