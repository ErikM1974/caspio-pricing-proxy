#!/usr/bin/env node
/**
 * Register the proxy's lead-ingest webhook on the 6 JotForm lead forms.
 * Idempotent: lists each form's existing webhooks first and only POSTs the
 * registration when our URL is absent. One-off setup tool, run locally.
 *
 *   node scripts/register-jotform-webhooks.js                 # register all 6 (canary tip: --form first)
 *   node scripts/register-jotform-webhooks.js --form 233535928059162   # one form only
 *   node scripts/register-jotform-webhooks.js --list          # show current webhooks, change nothing
 *   node scripts/register-jotform-webhooks.js --remove        # remove OUR webhook wherever registered
 *   node scripts/register-jotform-webhooks.js --sample 21764724640151  # print one submission's
 *        field slugs + answers (verifies the normalizer's mapping against live data)
 *
 * Env (local .env): JOTFORM_API_KEY (Full Access — webhook writes need it),
 * JOTFORM_WEBHOOK_SECRET (same value as the Heroku config var), optional
 * BASE_URL (defaults to the production proxy).
 */
'use strict';
require('dotenv').config();

const axios = require('axios');
const { JOTFORM_FORMS, fetchJotformSubmissions } = require('../src/utils/jotform');

const API = 'https://api.jotform.com';
const KEY = process.env.JOTFORM_API_KEY || '';
const SECRET = process.env.JOTFORM_WEBHOOK_SECRET || '';
const BASE_URL = process.env.BASE_URL || 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';
const WEBHOOK_URL = `${BASE_URL}/api/jotform/webhook?secret=${SECRET}`;

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const flagValue = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : ''; };

const H = { headers: { APIKEY: KEY }, timeout: 30000 };

async function listWebhooks(formId) {
  const r = await axios.get(`${API}/form/${formId}/webhooks`, H);
  return r.data && r.data.content ? r.data.content : {}; // { "0": "https://…", … }
}

async function main() {
  if (!KEY) { console.error('JOTFORM_API_KEY is not set'); process.exit(1); }

  const sampleForm = flagValue('--sample');
  if (sampleForm) {
    const subs = await fetchJotformSubmissions(sampleForm, { limit: 1, orderby: 'id' });
    if (!subs.length) { console.log(`Form ${sampleForm}: no submissions to sample.`); return; }
    const sub = subs[0];
    console.log(`Form ${sampleForm} — submission ${sub.id} (${sub.created_at}):`);
    for (const a of Object.values(sub.answers || {})) {
      if (a.answer === undefined || a.answer === null || a.answer === '') continue;
      console.log(`  ${String(a.name).padEnd(28)} type=${String(a.type).padEnd(22)} label="${a.text}"`);
      console.log(`  ${' '.repeat(28)} answer=${JSON.stringify(a.answer).slice(0, 160)}`);
    }
    return;
  }

  if (!SECRET && !flag('--list')) { console.error('JOTFORM_WEBHOOK_SECRET is not set'); process.exit(1); }

  const only = flagValue('--form');
  const formIds = only ? [only] : Object.keys(JOTFORM_FORMS);
  let failures = 0;

  for (const formId of formIds) {
    const title = (JOTFORM_FORMS[formId] || {}).title || formId;
    try {
      const hooks = await listWebhooks(formId);
      const entries = Object.entries(hooks);
      const ourEntry = entries.find(([, url]) => String(url).startsWith(`${BASE_URL}/api/jotform/webhook`));

      if (flag('--list')) {
        console.log(`${title} (${formId}): ${entries.length ? entries.map(([, u]) => u).join(' | ') : '(no webhooks)'}`);
        continue;
      }

      if (flag('--remove')) {
        if (!ourEntry) { console.log(`${title}: nothing to remove`); continue; }
        await axios.delete(`${API}/form/${formId}/webhooks/${ourEntry[0]}`, H);
        console.log(`${title}: ✗ removed webhook #${ourEntry[0]}`);
        continue;
      }

      if (ourEntry) { console.log(`${title}: ✓ already registered (#${ourEntry[0]})`); continue; }
      await axios.post(`${API}/form/${formId}/webhooks`,
        new URLSearchParams({ webhookURL: WEBHOOK_URL }).toString(),
        { headers: { APIKEY: KEY, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000 });
      console.log(`${title}: ✓ registered`);
    } catch (e) {
      failures += 1;
      console.error(`${title}: FAILED — ${e.response ? JSON.stringify(e.response.data).slice(0, 200) : e.message}`);
    }
  }
  if (failures) process.exit(1);
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
