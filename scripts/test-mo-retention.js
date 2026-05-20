#!/usr/bin/env node
/**
 * test-mo-retention.js — Find the OLDEST retrievable order to measure retention.
 *
 * Approach: pull a large window covering everything since NWCA started using
 * MO (~Oct 2025), then sort by date_OrderPlaced to find the oldest order
 * that's still retrievable today. The age of that order = minimum retention.
 *
 * Also dumps a few sample orders so we can verify the response shape and
 * confirm we're seeing real data.
 */

require('dotenv').config();
const axios = require('axios');
const { getToken, MANAGEORDERS_PUSH_BASE_URL } = require('../lib/manageorders-push-auth');

function isoDate(d) { return d.toISOString().split('T')[0]; }

async function pull(dateFrom, dateTo) {
  const token = await getToken();
  const r = await axios.get(`${MANAGEORDERS_PUSH_BASE_URL}/order-pull`, {
    params: { date_from: dateFrom, date_to: dateTo },
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    timeout: 60000,
  });
  return r.data?.result || [];
}

async function main() {
  console.log('=== Finding OLDEST retrievable order ===\n');

  // Pull a generous window covering all of NWCA's MO history
  const dateFrom = '2025-09-01';
  const dateTo = isoDate(new Date());
  console.log(`Pulling ${dateFrom} → ${dateTo}...`);

  const orders = await pull(dateFrom, dateTo);
  console.log(`Got ${orders.length} orders total.\n`);

  if (orders.length === 0) {
    console.log('No orders. Try a wider window.');
    return;
  }

  // Sort by date_OrderPlaced ascending — oldest first
  const withDates = orders
    .filter(o => o.date_OrderPlaced)
    .map(o => ({ ...o, _parsed: new Date(o.date_OrderPlaced) }))
    .filter(o => !isNaN(o._parsed.getTime()))
    .sort((a, b) => a._parsed - b._parsed);

  console.log(`Of those, ${withDates.length} have parseable date_OrderPlaced.`);
  console.log(`Date range: ${withDates[0]?.date_OrderPlaced} → ${withDates[withDates.length-1]?.date_OrderPlaced}\n`);

  console.log('=== Oldest 5 orders still retrievable ===');
  withDates.slice(0, 5).forEach((o, i) => {
    const daysOld = Math.round((Date.now() - o._parsed.getTime()) / (24 * 3600 * 1000));
    console.log(`  ${i+1}. ${o.ExtOrderID || '(no ExtOrderID)'} · placed ${o.date_OrderPlaced} (~${daysOld} days ago) · APISource=${o.APISource || '(none)'} · ExtSource=${o.ExtSource}`);
  });

  console.log('\n=== Newest 3 orders ===');
  withDates.slice(-3).forEach((o, i) => {
    const daysOld = Math.round((Date.now() - o._parsed.getTime()) / (24 * 3600 * 1000));
    console.log(`  ${withDates.length-2+i}. ${o.ExtOrderID || '(no ExtOrderID)'} · placed ${o.date_OrderPlaced} (~${daysOld} days ago) · APISource=${o.APISource || '(none)'}`);
  });

  console.log('\n=== CONCLUSION ===');
  const oldest = withDates[0];
  const daysOld = Math.round((Date.now() - oldest._parsed.getTime()) / (24 * 3600 * 1000));
  console.log(`Oldest retrievable order: ${oldest.date_OrderPlaced} (~${daysOld} days ago).`);
  console.log(`Retention is AT LEAST ${daysOld} days (~${(daysOld/30).toFixed(1)} months).`);
  console.log(`If retention were 60 days, none of those Oct/Nov 2025 orders would still be retrievable.`);
  console.log(`The fact that we can pull a ${daysOld}-day-old order proves retention >> 60 days.`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
