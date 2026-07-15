#!/usr/bin/env node
/**
 * One-time backfill: seed Digitizing_Mockups.Last_Notified_Status = Status
 * for every EXISTING row, so the digitizing AE-notification Caspio Task does
 * NOT email everyone about old designs the first time it runs.
 *
 * Context (2026-07-15): the status chokepoint (PUT /api/mockups/:id/status)
 * now emails the submitting AE and stamps Last_Notified_Status on every
 * transition. A Caspio scheduled Task backstops it by emailing rows where
 * `Last_Notified_Status <> Status`. But all pre-existing rows have a BLANK
 * Last_Notified_Status, so without this seed the Task would treat all ~117
 * historical rows as "un-notified" and blast their AEs. This marks them
 * caught-up as-of-now; the Task then only fires on genuine FUTURE changes.
 *
 * Idempotent: only touches rows where Last_Notified_Status IS NULL, so it can
 * be re-run safely and never clobbers a value the backend later stamped.
 * Notified_At is intentionally left blank for historical rows (they were not
 * actually notified now; the Task keys on Last_Notified_Status only).
 *
 * Default mode is DRY-RUN. Pass --apply to write.
 *
 * Usage:
 *   node scripts/backfill-mockup-notified-status.js            # Dry-run (read-only)
 *   node scripts/backfill-mockup-notified-status.js --apply    # Write the seed
 *
 * Env vars required: CASPIO_ACCOUNT_DOMAIN, CASPIO_CLIENT_ID, CASPIO_CLIENT_SECRET
 */

require('dotenv').config();
const axios = require('axios');

const APPLY = process.argv.includes('--apply');

const CASPIO_DOMAIN = process.env.CASPIO_ACCOUNT_DOMAIN;
const CASPIO_API_BASE = `https://${CASPIO_DOMAIN}/integrations/rest/v3`;
const MOCKUPS_TABLE = 'Digitizing_Mockups';

const required = ['CASPIO_ACCOUNT_DOMAIN', 'CASPIO_CLIENT_ID', 'CASPIO_CLIENT_SECRET']
    .filter(k => !process.env[k]);
if (required.length) {
    console.error('Missing env vars:', required.join(', '));
    process.exit(1);
}

async function getCaspioToken() {
    const resp = await axios.post(`https://${CASPIO_DOMAIN}/oauth/token`, new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.CASPIO_CLIENT_ID,
        client_secret: process.env.CASPIO_CLIENT_SECRET
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 });
    return resp.data.access_token;
}

async function fetchAllRows(token) {
    // Only rows still needing a seed (Last_Notified_Status blank). Page through
    // in case the table grows past a single page.
    const rows = [];
    let skip = 0;
    const pageSize = 1000;
    // Caspio fills a newly-added Text field with '' (empty string), NOT NULL,
    // on existing rows — so "un-seeded" must match both.
    const UNSEEDED = "(Last_Notified_Status IS NULL OR Last_Notified_Status='')";
    for (;;) {
        const url = `${CASPIO_API_BASE}/tables/${MOCKUPS_TABLE}/records`
            + `?q.where=${encodeURIComponent(UNSEEDED)}`
            + `&q.select=${encodeURIComponent('ID,Status')}`
            + `&q.orderBy=ID&q.limit=${pageSize}&q.skip=${skip}`;
        const resp = await axios.get(url, { headers: { Authorization: `Bearer ${token}` }, timeout: 30000 });
        const page = resp.data.Result || [];
        rows.push(...page);
        if (page.length < pageSize) break;
        skip += pageSize;
    }
    return rows;
}

async function seedStatus(token, status, count) {
    // Bulk PUT: set Last_Notified_Status for every row currently in `status`
    // that has not yet been seeded. One call updates all matching rows.
    const where = `Status='${status.replace(/'/g, "''")}' AND (Last_Notified_Status IS NULL OR Last_Notified_Status='')`;
    const url = `${CASPIO_API_BASE}/tables/${MOCKUPS_TABLE}/records?q.where=${encodeURIComponent(where)}`;
    const resp = await axios.put(url, { Last_Notified_Status: status }, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 30000
    });
    const affected = (resp.data && resp.data.RecordsAffected != null) ? resp.data.RecordsAffected : '?';
    console.log(`  [applied] Status="${status}" (${count} expected) -> RecordsAffected=${affected}`);
}

(async () => {
    console.log(`\n=== Backfill Last_Notified_Status  (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);
    const token = await getCaspioToken();
    const rows = await fetchAllRows(token);

    const byStatus = {};
    for (const r of rows) {
        const s = r.Status || '(blank)';
        byStatus[s] = (byStatus[s] || 0) + 1;
    }

    console.log(`Rows still needing a seed (Last_Notified_Status IS NULL): ${rows.length}`);
    Object.entries(byStatus).sort((a, b) => b[1] - a[1])
        .forEach(([s, c]) => console.log(`  ${String(c).padStart(4)}  Status="${s}"`));

    if (!rows.length) { console.log('\nNothing to seed. Done.'); return; }

    if (!APPLY) {
        console.log('\nDRY-RUN: no writes made. Re-run with --apply to seed the above.');
        return;
    }

    console.log('\nApplying (one bulk PUT per distinct status)...');
    for (const [status, count] of Object.entries(byStatus)) {
        if (status === '(blank)') {
            console.log(`  [skip] ${count} rows have a BLANK Status — not seeding (nothing for the Task to match).`);
            continue;
        }
        await seedStatus(token, status, count);
    }

    const remaining = await fetchAllRows(token);
    console.log(`\nDone. Rows still blank after apply: ${remaining.length} (expected 0, minus any blank-Status rows).`);
})().catch(err => {
    console.error('Backfill failed:', err.response ? JSON.stringify(err.response.data) : err.message);
    process.exit(1);
});
