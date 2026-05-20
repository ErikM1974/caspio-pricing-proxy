#!/usr/bin/env node
/**
 * benchmark-mo-pull.js — Measure real-world /order-pull latency for sizing
 * a customer-history endpoint.
 *
 * Question: how fast is a live MO query for "last N days of orders" + filter
 * by id_Customer in-memory? Compare to Caspio orders table query.
 */

require('dotenv').config();
const axios = require('axios');
const { getToken, MANAGEORDERS_PUSH_BASE_URL } = require('../lib/manageorders-push-auth');

function isoDate(d) { return d.toISOString().split('T')[0]; }

async function pullMO(dateFrom, dateTo) {
  const token = await getToken();
  const t0 = Date.now();
  const r = await axios.get(`${MANAGEORDERS_PUSH_BASE_URL}/order-pull`, {
    params: { date_from: dateFrom, date_to: dateTo },
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    timeout: 60000,
  });
  const ms = Date.now() - t0;
  const orders = r.data?.result || [];
  return { ms, count: orders.length, orders };
}

async function pullCaspio() {
  const t0 = Date.now();
  // Hit our existing Caspio orders endpoint (the synced copy)
  const r = await axios.get(
    'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/customers',
    { timeout: 30000 }
  );
  const ms = Date.now() - t0;
  const data = Array.isArray(r.data) ? r.data : (r.data?.data || r.data || []);
  return { ms, count: Array.isArray(data) ? data.length : 0 };
}

async function main() {
  console.log('=== Live latency benchmark: MO /order-pull vs Caspio ===\n');

  const today = new Date();
  const fmt = (label, r) => {
    const sec = (r.ms / 1000).toFixed(2);
    console.log(`  ${label.padEnd(28)} ${String(r.ms).padStart(5)}ms (${sec}s) · ${r.count} orders`);
  };

  // Warm-up: prime token cache
  console.log('Priming token cache...');
  await pullMO(isoDate(new Date(today.getTime() - 86400000)), isoDate(today));
  console.log('');

  // Run each test 3 times to see consistency
  const runs = 3;
  const windows = [
    { label: '7-day window',   days: 7 },
    { label: '30-day window',  days: 30 },
    { label: '90-day window',  days: 90 },
    { label: '365-day window', days: 365 },
  ];

  for (const w of windows) {
    console.log(`--- ${w.label} (${w.days} days) ---`);
    const times = [];
    let lastCount = 0;
    for (let i = 0; i < runs; i++) {
      const end = new Date(today);
      const start = new Date(today);
      start.setDate(start.getDate() - w.days);
      const r = await pullMO(isoDate(start), isoDate(end));
      times.push(r.ms);
      lastCount = r.count;
      fmt(`  run ${i + 1}`, r);
    }
    const avg = Math.round(times.reduce((a, b) => a + b, 0) / runs);
    console.log(`  AVG: ${avg}ms · ${lastCount} orders\n`);

    // Time the in-memory filter for one customer (using id_Customer=107 = Star Sportswear from real data)
    if (lastCount > 0) {
      // Pull once more and time the filter step
      const end = new Date(today);
      const start = new Date(today);
      start.setDate(start.getDate() - w.days);
      const pullR = await pullMO(isoDate(start), isoDate(end));
      const t0 = Date.now();
      const filtered = pullR.orders.filter(o => o.id_Customer === 107);
      const filterMs = Date.now() - t0;
      console.log(`  Filter step (id_Customer=107): ${filterMs}ms · ${filtered.length} matches\n`);
    }
  }

  // Caspio orders endpoint comparison
  console.log('--- Caspio /api/manageorders/customers (existing endpoint) ---');
  for (let i = 0; i < 3; i++) {
    const r = await pullCaspio();
    fmt(`  run ${i + 1}`, r);
  }
  console.log('');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
