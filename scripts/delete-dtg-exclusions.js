// One-off: delete Brian's flagged (style, color) pairs from DTG_Top_Sellers_2026.
//
// Flow:
//   1. For each exclusion, GET matching rows to confirm what we're about to delete
//   2. Print a preview
//   3. If --commit flag passed, DELETE; otherwise dry-run
//
// Usage:
//   node scripts/delete-dtg-exclusions.js          # dry-run (preview only)
//   node scripts/delete-dtg-exclusions.js --commit # actually delete

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');

const TABLE = 'DTG_Top_Sellers_2026';
const COMMIT = process.argv.includes('--commit');

const exclusions = [
    { style: 'PC55',   color: 'Safety Green'  },
    { style: 'PC55',   color: 'Safety Orange' },
    { style: 'NL3600', color: 'Natural'       },
    { style: 'NL3600', color: 'Gold'          },
    { style: 'DT5000', color: 'Neon Green'    },
    { style: 'PC850H', color: 'White'         },
    { style: 'PC54LS', color: 'Yellow'        },
    { style: 'PC55LS', color: 'Safety Green'  },
    { style: 'PC55LS', color: 'Safety Orange' },
    { style: 'PC55LS', color: 'Orange'        },
    { style: 'PC54Y',  color: 'Gold'          },
];

async function getToken() {
    const domain = process.env.CASPIO_ACCOUNT_DOMAIN;
    const r = await axios.post(`https://${domain}/oauth/token`,
        new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: process.env.CASPIO_CLIENT_ID,
            client_secret: process.env.CASPIO_CLIENT_SECRET,
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    return r.data.access_token;
}

async function findRows(token, style, color) {
    const domain = process.env.CASPIO_ACCOUNT_DOMAIN;
    const where = `style='${style}' AND color_name='${color.replace(/'/g, "''")}'`;
    const r = await axios.get(
        `https://${domain}/rest/v2/tables/${TABLE}/records`,
        {
            headers: { Authorization: `Bearer ${token}` },
            params: { 'q.where': where, 'q.select': 'PK_ID,style,color_name,catalog_color,color_units_sold,color_rank' },
        });
    return r.data.Result || [];
}

async function deleteRows(token, style, color) {
    const domain = process.env.CASPIO_ACCOUNT_DOMAIN;
    const where = `style='${style}' AND color_name='${color.replace(/'/g, "''")}'`;
    const r = await axios.delete(
        `https://${domain}/rest/v2/tables/${TABLE}/records`,
        {
            headers: { Authorization: `Bearer ${token}` },
            params: { 'q.where': where },
        });
    return r.data;
}

async function main() {
    console.log(`\n${COMMIT ? '🔴 LIVE RUN — DELETING ROWS' : '🟢 DRY RUN — preview only (pass --commit to delete)'}\n`);
    const token = await getToken();
    console.log('Token acquired.\n');

    let foundCount = 0;
    let missingCount = 0;
    const matched = [];

    for (const ex of exclusions) {
        const rows = await findRows(token, ex.style, ex.color);
        if (!rows.length) {
            console.log(`  ❌ NO MATCH:  ${ex.style.padEnd(8)} ${ex.color}`);
            missingCount++;
            continue;
        }
        for (const r of rows) {
            console.log(`  ✓  FOUND:     ${ex.style.padEnd(8)} ${ex.color.padEnd(15)} → PK_ID ${r.PK_ID}, catalog "${r.catalog_color}", rank #${r.color_rank}, ${r.color_units_sold} units`);
            foundCount++;
            matched.push({ ...ex, pk_id: r.PK_ID });
        }
    }

    console.log(`\nSummary: ${foundCount} rows matched, ${missingCount} not found.`);

    if (!COMMIT) {
        console.log('\nDry-run only. Re-run with --commit to delete.');
        return;
    }

    if (!foundCount) {
        console.log('\nNothing to delete.');
        return;
    }

    console.log('\nDeleting…');
    const deleted = [];
    for (const ex of exclusions) {
        try {
            const result = await deleteRows(token, ex.style, ex.color);
            console.log(`  🗑  ${ex.style.padEnd(8)} ${ex.color.padEnd(15)} → deleted ${result.RecordsAffected ?? '?'} row(s)`);
            deleted.push({ ...ex, affected: result.RecordsAffected });
        } catch (e) {
            console.log(`  ⚠ ${ex.style} ${ex.color}: ${e.response?.status} ${e.response?.data?.Message || e.message}`);
        }
    }

    const totalAffected = deleted.reduce((s, d) => s + (d.affected || 0), 0);
    console.log(`\nTotal rows deleted: ${totalAffected}`);
}

main().catch((e) => {
    console.error('FATAL', e.response?.data || e.message);
    process.exit(1);
});
