// create-rep-bonus-config-table.js — one-time Caspio setup for the Q3 2026
// Embroidery Bonus (2026-07-25). Idempotent — safe to re-run; each step skips
// if already done.
//
//   1. `Rep_Bonus_Config`      — every rate, baseline and ladder rung, one row
//                                per rep per quarter. THE POINT of this table is
//                                that Erik can retune a number in the Caspio
//                                datasheet and the dashboards reflect it with NO
//                                DEPLOY (the Service_Codes precedent). Today all
//                                bonus numbers are hardcoded in this repo, which
//                                is why Q2's dud spiff couldn't be fixed mid-quarter.
//   2. `EmbroideryBonusArchive` — quarter-end freeze of qualifying accounts,
//                                mirroring GarmentTrackerArchive.
//   3. Seeds the two Q3 2026 rows (Nika / Taneisha).
//
// Schema notes (learned the hard way — see create-order-payments-table.js):
//   - This account 404s on /rest/v3 for table DESIGN; v2 POST /tables works but
//     accepts ONLY a minimal {Name, Columns:[{Name,Type}]} body. Unique /
//     Description / AUTONUMBER all trigger IncorrectBodyParameter.
//   - PK is auto-added — do NOT declare one.
//   - All columns STRING, matching the house pattern. embroidery-bonus.js reads
//     every value through num()/coerceBool(), so string storage is intentional
//     and safe; it also means Year must never be compared unquoted in a WHERE
//     (loadConfig filters Year in JS for exactly this reason).
//
// Run from the proxy repo root:
//   node scripts/create-rep-bonus-config-table.js            (dry run — prints the plan)
//   node scripts/create-rep-bonus-config-table.js --apply    (writes)
'use strict';
require('dotenv').config();
const axios = require('axios');

const APPLY = process.argv.includes('--apply');
const DOMAIN = process.env.CASPIO_ACCOUNT_DOMAIN;
// This account is v2-only: /rest/v3 404s for BOTH table design AND records, on new and
// existing tables alike (verified 2026-07-25 against Sales_Reps_2026 / Commission_Payouts).
// config.caspio.apiBaseUrl is v2 for the same reason — keep everything on v2 here.
const V2 = `https://${DOMAIN}/rest/v2`;

async function getToken() {
    const r = await axios.post(`https://${DOMAIN}/oauth/token`, new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.CASPIO_CLIENT_ID,
        client_secret: process.env.CASPIO_CLIENT_SECRET,
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    return r.data.access_token;
}

const CONFIG_COLUMNS = [
    'Program',                  // 'EMB'
    'Quarter', 'Year',
    'Rep',                      // full name, must match Sales_Reps_2026.CustomerServiceRep
    'Baseline_Revenue',
    'Rung1_Pct', 'Rung1_Pay',
    'Rung2_Pct', 'Rung2_Pay',
    'Rung3_Pct', 'Rung3_Pay',
    'Rung4_Pct', 'Rung4_Pay',
    'New_Account_Bounty', 'Reactivated_Bounty',
    'Min_Account_Revenue', 'Dormancy_Months',
    'Team_Kicker1_Target', 'Team_Kicker1_Pay',
    'Team_Kicker2_Target', 'Team_Kicker2_Pay',
    'Order_Type_Ids',           // '21' — current-quarter revenue scope
    'History_Order_Type_Ids',   // '21,1' — MUST keep retired type 1 "Caps" (see route header)
    'Excluded_Customer_Ids',    // '13500' Rainier Pure Beef
    'Date_Start', 'Date_End',
    'Is_Active',                // 'Yes' / 'No'
    'Notes',
];

const ARCHIVE_COLUMNS = [
    'Program', 'Quarter', 'Year', 'Rep',
    'Category',                 // 'New' | 'Reactivated'
    'id_Customer', 'CompanyName',
    'Revenue', 'BonusAmount', 'ArchivedAt',
];

const TABLES = [
    { Name: 'Rep_Bonus_Config', Columns: CONFIG_COLUMNS.map((n) => ({ Name: n, Type: 'STRING' })) },
    { Name: 'EmbroideryBonusArchive', Columns: ARCHIVE_COLUMNS.map((n) => ({ Name: n, Type: 'STRING' })) },
];

// Baselines derived 2026-07-25 from ORDER_ODBC on CURRENT ownership (Sales_Reps_2026),
// embroidery = type 21 unioned with retired type 1 "Caps". Provenance:
//   Nika     — Q3'25 $190,847 · best-ever Q3 $246,873 · seasonal norm $260,482 · proj $222,578
//   Taneisha — Q3'25  $72,520 · best-ever Q3 $112,981 · seasonal norm $108,265 · proj  $76,072
// Full reasoning: Pricing Index repo → memory/EMB_BONUS_Q3_2026.md
const SHARED = {
    Program: 'EMB', Quarter: 'Q3', Year: '2026',
    Rung1_Pct: '85', Rung1_Pay: '150',
    Rung2_Pct: '100', Rung2_Pay: '400',
    Rung3_Pct: '115', Rung3_Pay: '700',
    Rung4_Pct: '130', Rung4_Pay: '1200',
    New_Account_Bounty: '75', Reactivated_Bounty: '50',
    Min_Account_Revenue: '1000', Dormancy_Months: '12',
    Team_Kicker1_Target: '700000', Team_Kicker1_Pay: '250',
    Team_Kicker2_Target: '740000', Team_Kicker2_Pay: '500',
    Order_Type_Ids: '21',
    History_Order_Type_Ids: '21,1',
    Excluded_Customer_Ids: '13500',
    Date_Start: '2026-07-01', Date_End: '2026-09-30',
    Is_Active: 'Yes',
};

const SEED_ROWS = [
    {
        ...SHARED, Rep: 'Nika Lao', Baseline_Revenue: '235000',
        Notes: 'Base between her Q3-2025 ($190,847) and best-ever Q3 ($246,873). Rung 1 sits below her Q3 projection ($222,578) on purpose - a hold-your-pace rung. Raise Rung1_Pct to 95 if it should not pay for standing still.',
    },
    {
        ...SHARED, Rep: 'Taneisha Clark', Baseline_Revenue: '100000',
        Notes: 'Book inherited from Taylar Hanson 2025-08-12; its Q3 has never exceeded $112,981 and its Q3 tracks H1 (0.96x) rather than rising like Nika\'s (1.38x). Rung 3 = beat the book best-ever Q3.',
    },
];

async function tableExists(token, name) {
    try {
        await axios.get(`${V2}/tables/${name}/records`, { headers: { Authorization: `Bearer ${token}` } });
        return true;
    } catch (e) {
        if (e.response && e.response.status === 404) return false;
        throw e;
    }
}

async function main() {
    if (!DOMAIN || !process.env.CASPIO_CLIENT_ID) {
        console.error('Missing CASPIO_ACCOUNT_DOMAIN / CASPIO_CLIENT_ID — run from the proxy repo root with .env present.');
        process.exit(1);
    }
    console.log(APPLY ? '=== APPLY MODE — writing to Caspio ===' : '=== DRY RUN — pass --apply to write ===');
    const token = await getToken();

    for (const def of TABLES) {
        const exists = await tableExists(token, def.Name);
        if (exists) {
            console.log(`  • ${def.Name}: already exists — skipping create`);
        } else if (!APPLY) {
            console.log(`  • ${def.Name}: WOULD CREATE with ${def.Columns.length} STRING columns`);
            console.log(`      ${def.Columns.map((c) => c.Name).join(', ')}`);
        } else {
            await axios.post(`${V2}/tables`, def, {
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            });
            console.log(`  ✓ ${def.Name}: created (${def.Columns.length} columns)`);
        }
    }

    // Seed the two Q3 rows — skip any rep already present so re-runs never duplicate
    // or clobber a number Erik has since tuned in the datasheet.
    let existingReps = new Set();
    try {
        const r = await axios.get(`${V2}/tables/Rep_Bonus_Config/records`, {
            headers: { Authorization: `Bearer ${token}` },
            params: { 'q.where': "Program='EMB' AND Quarter='Q3'", 'q.limit': 100 },
        });
        existingReps = new Set((r.data.Result || []).map((x) => String(x.Rep || '').trim()));
    } catch (e) {
        if (!APPLY) console.log('  (table not created yet — seed preview below)');
        else throw e;
    }

    for (const row of SEED_ROWS) {
        if (existingReps.has(row.Rep)) {
            console.log(`  • seed ${row.Rep}: row already present — leaving it alone`);
            continue;
        }
        if (!APPLY) {
            console.log(`  • seed ${row.Rep}: WOULD INSERT baseline $${Number(row.Baseline_Revenue).toLocaleString()}, `
                + `rungs ${row.Rung1_Pct}/${row.Rung2_Pct}/${row.Rung3_Pct}/${row.Rung4_Pct}%, `
                + `bounties $${row.New_Account_Bounty}/$${row.Reactivated_Bounty}`);
            continue;
        }
        await axios.post(`${V2}/tables/Rep_Bonus_Config/records`, row, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        });
        console.log(`  ✓ seed ${row.Rep}: inserted`);
    }

    console.log(APPLY
        ? '\nDone. Reload the dashboards — the fallback warning should disappear and configSource should read "caspio".'
        : '\nDry run complete. Re-run with --apply to write.');
}

main().catch((e) => {
    console.error('FAILED:', e.response ? JSON.stringify(e.response.data) : e.message);
    process.exit(1);
});
