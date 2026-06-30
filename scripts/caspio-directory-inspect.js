#!/usr/bin/env node
/**
 * Read-only inspection of the Caspio "Staff" directory (logins) — lists the
 * directory, its users, and the FIELDS each user carries, so we can decide where
 * to store a per-user Role/Access value for app-side RBAC (#2 follow-on / role model).
 *
 * Read-only: GETs only. Run: `node scripts/caspio-directory-inspect.js`
 * (uses the proxy's local .env Caspio creds, same as caspio-entitlement-probe.js).
 */
'use strict';
const axios = require('axios');
const config = require('../src/config');
const { getCaspioAccessToken } = require('../src/utils/caspio');

const BASE = config.caspio.apiBaseUrl; // .../integrations/rest/v3

function redact(v) {
  // Never print password hashes or tokens.
  if (v == null) return v;
  const s = String(v);
  return /pass|hash|token|secret/i.test(s) ? '«redacted»' : v;
}

async function main() {
  const token = await getCaspioAccessToken();
  const H = { headers: { Authorization: `Bearer ${token}` } };

  console.log('=== GET /directories ===');
  const dirs = (await axios.get(`${BASE}/directories`, H)).data;
  const list = dirs.Result || dirs.result || [];
  list.forEach(d => console.log(JSON.stringify(d)));

  for (const d of list) {
    const id = d.ExternalKey || d.externalKey || d.Id || d.id;
    const name = d.Name || d.name;
    console.log(`\n=== Users in directory "${name}" (${id}) ===`);
    try {
      const usersResp = (await axios.get(`${BASE}/directories/${encodeURIComponent(id)}/users`, H)).data;
      const users = usersResp.Result || usersResp.result || [];
      console.log(`(count: ${users.length})`);
      if (users.length) {
        console.log('FIELDS available on a user object:', Object.keys(users[0]).join(', '));
        console.log('\nUsers (sensitive fields redacted):');
        users.forEach(u => {
          const safe = {};
          for (const k of Object.keys(u)) safe[k] = redact(u[k]);
          console.log('  ' + JSON.stringify(safe));
        });
      }
    } catch (e) {
      console.log('  users fetch failed:', e.response ? `${e.response.status} ${JSON.stringify(e.response.data)}` : e.message);
    }
  }
}

main().catch(e => { console.error('FATAL:', e.response ? JSON.stringify(e.response.data) : e.message); process.exit(1); });
