// One-time fix for CreditCard_NWCA_ATMOS.Month_Reconciled format (2026-08-03).
//
// The InkSoft Atmos formatter emitted Mon-YY ("Aug-26") while the table's own convention
// is YY-Mon ("25-Feb", "26-May", "26-Jun" — 1,354 rows). The 92 charges imported on
// 2026-08-03 were the only rows in the wrong order, so they grouped with nothing. The
// formatter now emits YY-Mon (month_year_to_reconciled() in the InkSoft repo's
// web/atmos_formatter.py, mirrored in static/atmos_formatter.js applyRecon()); this
// realigns the rows already in Caspio.
//
// SURGICAL BY DESIGN: touches ONLY Month_Reconciled. Every other column — including
// Reconciled, GL_Account and any vendor corrections made by hand after the import — is
// left exactly as it is. One Caspio PUT updates all matching rows at once.
//
// DRY RUN by default. Pass --write to execute.
//   node scripts/fix-atmos-month-reconciled.js                    (report only)
//   node scripts/fix-atmos-month-reconciled.js --write            (execute)
//   node scripts/fix-atmos-month-reconciled.js --from Aug-26 --to 26-Aug --write

const axios = require('axios');
const { getCaspioAccessToken, fetchAllCaspioPages } = require('../src/utils/caspio');
const config = require('../config');

const api = config.caspio.apiBaseUrl;
const T = 'CreditCard_NWCA_ATMOS';
const WRITE = process.argv.includes('--write');

function arg(name, dflt) {
    const i = process.argv.indexOf(name);
    return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const FROM = arg('--from', 'Aug-26');
const TO = arg('--to', '26-Aug');

// Caspio string literals are single-quoted; double any quote in the value.
const esc = s => String(s).replace(/'/g, "''");

(async () => {
    if (!/^[A-Za-z0-9-]+$/.test(FROM) || !/^[A-Za-z0-9-]+$/.test(TO)) {
        console.error('FROM/TO must be simple month tokens like Aug-26 / 26-Aug.');
        process.exit(1);
    }
    console.log(`Month_Reconciled: '${FROM}'  ->  '${TO}'\n`);

    const where = `Month_Reconciled='${esc(FROM)}'`;
    const rows = await fetchAllCaspioPages(`/tables/${T}/records`, {
        'q.where': where,
        'q.select': 'PK_ID,Reference_ID,Amount,Month_Reconciled,Reconciled',
        'q.orderBy': 'PK_ID',
        'q.pageSize': 1000
    });

    console.log('Rows matching  :', rows.length);
    if (!rows.length) {
        console.log(`Nothing with Month_Reconciled='${FROM}'. Already fixed, or wrong --from.`);
        return;
    }

    // Sanity: these should be exactly the rows imported by the fixed formatter.
    const prefixed = rows.filter(r => String(r.Reference_ID || '').startsWith('R')).length;
    const net = rows.reduce((a, r) => a + (parseFloat(r.Amount) || 0), 0);
    const reconciled = rows.filter(r => r.Reconciled === true || r.Reconciled === 'true').length;
    console.log('R-prefixed keys:', prefixed, '/', rows.length);
    console.log('Net amount     : $' + net.toFixed(2));
    console.log('Already marked Reconciled:', reconciled, '(left untouched either way)');

    if (prefixed !== rows.length) {
        console.log('\n⚠ Some matching rows are NOT from this import. Inspect before writing:');
        rows.filter(r => !String(r.Reference_ID || '').startsWith('R'))
            .slice(0, 10)
            .forEach(r => console.log(`   PK_ID=${r.PK_ID} ref=${r.Reference_ID} $${r.Amount}`));
    }

    if (!WRITE) {
        console.log('\nDRY RUN — nothing written. Re-run with --write to execute.');
        return;
    }

    const token = await getCaspioAccessToken();
    const res = await axios.put(
        `${api}/tables/${T}/records?q.where=${encodeURIComponent(where)}`,
        { Month_Reconciled: TO },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 30000 }
    );
    const affected = (res.data && (res.data.RecordsAffected != null ? res.data.RecordsAffected
                                                                    : res.data.recordsAffected));
    console.log('\nDONE. Records affected:', affected != null ? affected : JSON.stringify(res.data));

    const left = await fetchAllCaspioPages(`/tables/${T}/records`, {
        'q.where': where, 'q.select': 'PK_ID', 'q.orderBy': 'PK_ID', 'q.pageSize': 1000
    });
    console.log(`Rows still on '${FROM}': ${left.length} (expect 0)`);
})().catch(e => {
    console.error('FATAL:', e.response ? JSON.stringify(e.response.data) : e.message);
    process.exit(1);
});
