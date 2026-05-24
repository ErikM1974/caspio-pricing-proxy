#!/usr/bin/env node
/**
 * probe-mo-date-range.js — find earliest + latest date_Ordered in MO Caspio table.
 */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');
const config = require('../src/config');
const { getCaspioAccessToken } = require('../src/utils/caspio');

async function rawGet(path, params = {}) {
    const token = await getCaspioAccessToken();
    return (await axios.get(`${config.caspio.apiBaseUrl}${path}`, {
        params, headers: { Authorization: `Bearer ${token}` }, timeout: 60000,
    })).data;
}

(async () => {
    // Oldest order
    const oldest = await rawGet('/tables/ManageOrders_Orders/records', {
        'q.select': 'id_Order,date_Ordered,date_Invoiced,CustomerName',
        'q.sort': 'date_Ordered ASC',
        'q.pageSize': 5,
    });
    console.log('=== 5 OLDEST orders ===');
    (oldest.Result || []).forEach(r => console.log(' ', r.date_Ordered, '·', r.id_Order, '·', r.CustomerName));

    // Newest order
    const newest = await rawGet('/tables/ManageOrders_Orders/records', {
        'q.select': 'id_Order,date_Ordered,date_Invoiced,CustomerName',
        'q.sort': 'date_Ordered DESC',
        'q.pageSize': 5,
    });
    console.log('\n=== 5 NEWEST orders ===');
    (newest.Result || []).forEach(r => console.log(' ', r.date_Ordered, '·', r.id_Order, '·', r.CustomerName));

    // Also try date_Invoiced ASC in case date_Ordered has nulls
    const oldestInv = await rawGet('/tables/ManageOrders_Orders/records', {
        'q.select': 'id_Order,date_Ordered,date_Invoiced,CustomerName',
        'q.sort': 'date_Invoiced ASC',
        'q.where': 'date_Invoiced IS NOT NULL',
        'q.pageSize': 5,
    });
    console.log('\n=== 5 OLDEST by date_Invoiced ===');
    (oldestInv.Result || []).forEach(r => console.log(' ', r.date_Invoiced, '·', r.id_Order, '·', r.CustomerName));
})().catch(e => { console.error('FATAL:', e.response?.data || e.message); process.exit(1); });
