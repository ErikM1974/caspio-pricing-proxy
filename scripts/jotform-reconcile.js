#!/usr/bin/env node
/**
 * JotForm lead reconcile (Heroku Scheduler task) — webhook-miss backstop.
 *
 * Hits POST /api/jotform/sync, which pulls the last N days of submissions from
 * all 6 JotForm lead forms and ingests anything Form_Submissions doesn't have
 * (dedupe on External_ID). Webhooks are the real-time path; this catches the
 * occasional delivery JotForm drops or the proxy 200-acks but fails to store.
 *
 * Heroku Scheduler command: `npm run jotform-reconcile`
 * Recommended interval: Daily (e.g. 06:00 PT).
 * Cost: ~6 JotForm calls + a handful of Caspio calls per run.
 *
 * Env: CRM_API_SECRET (present on the app), optional BASE_URL, --days N (default 2).
 */
'use strict';
require('dotenv').config();

const axios = require('axios');

const BASE_URL = process.env.BASE_URL || 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';
const SECRET = process.env.CRM_API_SECRET || '';
const daysArg = process.argv.indexOf('--days');
const DAYS = daysArg >= 0 ? parseInt(process.argv[daysArg + 1], 10) || 2 : 2;

async function main() {
  if (!SECRET) { console.error('CRM_API_SECRET is not set'); process.exit(1); }
  const started = Date.now();
  const resp = await axios.post(`${BASE_URL}/api/jotform/sync`, { days: DAYS }, {
    headers: { 'Content-Type': 'application/json', 'x-crm-api-secret': SECRET },
    timeout: 120000,
  });
  const r = resp.data || {};
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`[jotform-reconcile] last ${DAYS}d: fetched ${r.fetched}, inserted ${r.inserted}, already present ${r.skipped} (${secs}s)`);
  for (const [title, t] of Object.entries(r.forms || {})) {
    if (t.inserted) console.log(`  ⚠ ${title}: ${t.inserted} lead(s) had been MISSED by the webhook — recovered`);
  }
}

main().catch((e) => {
  console.error('[jotform-reconcile] FAILED:', e.response ? JSON.stringify(e.response.data).slice(0, 300) : e.message);
  process.exit(1);
});
