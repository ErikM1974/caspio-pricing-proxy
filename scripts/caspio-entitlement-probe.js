/**
 * Caspio Platform API — Entitlement Probe (READ-ONLY)
 * --------------------------------------------------------------
 * Purpose: confirm which Caspio REST v3 capability groups THIS account's
 * plan actually exposes, so the capability reference
 * (../Pricing Index File 2025/memory/CASPIO_REST_API_REFERENCE.md) can state
 * "available / not entitled" instead of "likely plan-gated, verify first".
 *
 * Safety: GETs only. No POST/PUT/DELETE. Never logs the token or secret.
 * Reuses the proxy's own credentials via src/config (dotenv / Heroku env).
 *
 * Run locally:   node scripts/caspio-entitlement-probe.js
 * Run on Heroku: heroku run "node scripts/caspio-entitlement-probe.js" -a <app>
 */

const axios = require('axios');
const config = require('../src/config');

const BASE = config.caspio.apiBaseUrl; // .../integrations/rest/v3
const TIMEOUT = (config.timeouts && config.timeouts.perRequest) || 20000;

// Control = known-used groups (prove the token works). Target = untapped groups.
const PROBES = [
  { group: 'Tables',                 kind: 'control', path: '/tables' },
  { group: 'Views',                  kind: 'control', path: '/views' },
  { group: 'Files (folders)',        kind: 'control', path: '/files/folders' },
  { group: 'Outgoing Webhooks',      kind: 'target',  path: '/outgoingWebhooks' },
  { group: 'Directories (logins)',   kind: 'target',  path: '/directories' },
  { group: 'Data Import/Export Tasks', kind: 'target', path: '/dataImportExportTasks' },
  { group: 'Bridge Applications',    kind: 'target',  path: '/bridgeApplications' },
];

async function getToken() {
  const resp = await axios.post(
    config.caspio.tokenUrl,
    new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: config.caspio.clientId,
      client_secret: config.caspio.clientSecret,
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: TIMEOUT }
  );
  if (!resp.data || !resp.data.access_token) throw new Error('No access_token in token response');
  return resp.data.access_token;
}

function classify(status) {
  if (status >= 200 && status < 300) return 'AVAILABLE';
  if (status === 401) return 'AUTH-FAILED (token/creds)';
  if (status === 403) return 'NOT ENTITLED (forbidden)';
  if (status === 404) return 'NOT AVAILABLE (404)';
  return `UNEXPECTED (${status})`;
}

function countOf(data) {
  if (data && Array.isArray(data.Result)) return data.Result.length;
  if (Array.isArray(data)) return data.length;
  return null;
}

async function probe(token, p) {
  try {
    const resp = await axios.get(`${BASE}${p.path}`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: TIMEOUT,
      validateStatus: () => true, // never throw — we want the status either way
    });
    const verdict = classify(resp.status);
    const n = countOf(resp.data);
    let detail = n === null ? '' : `${n} item(s)`;
    if (resp.status >= 400) {
      const body = resp.data;
      const msg = body && (body.Message || body.message || (body.error && (body.error.message || body.error)) || '');
      detail = (typeof msg === 'string' ? msg : JSON.stringify(body)).slice(0, 120);
    }
    return { ...p, status: resp.status, verdict, detail };
  } catch (err) {
    return { ...p, status: 'ERR', verdict: 'REQUEST FAILED', detail: (err.code || err.message || '').slice(0, 120) };
  }
}

(async () => {
  if (!config.caspio.clientId || !config.caspio.clientSecret || !config.caspio.domain) {
    console.error('Missing CASPIO_ACCOUNT_DOMAIN / CASPIO_CLIENT_ID / CASPIO_CLIENT_SECRET in env. Aborting.');
    process.exit(2);
  }
  console.log(`\nCaspio entitlement probe (READ-ONLY)`);
  console.log(`Account domain: ${config.caspio.domain}`);
  console.log(`Base: ${BASE}\n`);

  let token;
  try {
    token = await getToken();
    console.log('Token: obtained OK (redacted)\n');
  } catch (e) {
    console.error('Could not obtain token:', e.response ? JSON.stringify(e.response.data) : e.message);
    process.exit(1);
  }

  const results = [];
  for (const p of PROBES) {
    // sequential to be gentle on the API; order = controls first
    results.push(await probe(token, p));
  }

  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad('GROUP', 26) + pad('KIND', 9) + pad('STATUS', 8) + pad('VERDICT', 26) + 'DETAIL');
  console.log('-'.repeat(95));
  for (const r of results) {
    console.log(pad(r.group, 26) + pad(r.kind, 9) + pad(r.status, 8) + pad(r.verdict, 26) + (r.detail || ''));
  }

  // Machine-readable block for folding back into the reference doc
  console.log('\n--- JSON ---');
  console.log(JSON.stringify(results.map(({ group, kind, status, verdict, detail }) => ({ group, kind, status, verdict, detail })), null, 2));
})();
