// One-time fix for CreditCard_NWCA_ATMOS: statements filed under the wrong YEAR (2026-08-03).
//
// The Feb/Mar/Apr 2026 statements were imported under 2025 labels, so `25-Feb`, `25-Mar` and
// `25-Apr` each hold TWO statements — the real 2025 one plus its 2026 counterpart — while
// `26-Feb`, `26-Mar` and `26-Apr` do not exist. Those three 2025 months are overstated and the
// 2026 months are missing, which throws off any year-over-year comparison.
//
// Safe to split on PayableDate year ONLY because a Feb/Mar/Apr statement never straddles a
// calendar boundary (a Feb cycle posts ~Jan 9 - Feb 6, same year). A JANUARY statement DOES
// straddle (Dec 9 - Jan 8), so this script must never be pointed at one — the guard below
// refuses any month whose window could cross a year end.
//
// SURGICAL: one Caspio PUT per month, scoped by label AND date range, touching only
// Month_Reconciled. Reconciled, GL_Account, vendor names and PO numbers are untouched.
//
// DRY RUN by default. Pass --write to execute.
//   node scripts/fix-atmos-statement-year.js
//   node scripts/fix-atmos-statement-year.js --write

const axios = require('axios');
const { getCaspioAccessToken, fetchAllCaspioPages } = require('../src/utils/caspio');
const config = require('../config');

const api = config.caspio.apiBaseUrl;
const T = 'CreditCard_NWCA_ATMOS';
const WRITE = process.argv.includes('--write');

// from-label -> to-label, and the calendar year the misfiled charges actually belong to.
const JOBS = [
    { from: '25-Feb', to: '26-Feb', year: 2026, month: 2 },
    { from: '25-Mar', to: '26-Mar', year: 2026, month: 3 },
    { from: '25-Apr', to: '26-Apr', year: 2026, month: 4 },
];

const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const d = v => new Date(String(v).slice(0, 10) + 'T00:00:00');
const fmt = x => `${x.getMonth() + 1}/${x.getDate()}/${x.getFullYear()}`;
const money = n => (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

(async () => {
    console.log(WRITE ? '*** WRITE MODE ***\n' : 'DRY RUN — nothing will be written.\n');
    const plan = [];

    for (const job of JOBS) {
        // A statement closing in month M posts from ~the 9th of M-1. Only M=1 can cross a year.
        if (job.month === 1) { console.log(`SKIP ${job.from}: a January cycle straddles the year end.`); continue; }

        const rows = await fetchAllCaspioPages(`/tables/${T}/records`, {
            'q.where': `Month_Reconciled='${job.from}'`,
            'q.select': 'PK_ID,PayableDate,Amount,Reconciled,Reference_ID,Month_Reconciled',
            'q.orderBy': 'PK_ID', 'q.pageSize': 1000
        });
        const target = await fetchAllCaspioPages(`/tables/${T}/records`, {
            'q.where': `Month_Reconciled='${job.to}'`, 'q.select': 'PK_ID',
            'q.orderBy': 'PK_ID', 'q.pageSize': 1000
        });

        const move = rows.filter(r => d(r.PayableDate).getFullYear() === job.year);
        const stay = rows.filter(r => d(r.PayableDate).getFullYear() !== job.year);
        const span = list => {
            const ds = list.map(r => d(r.PayableDate)).sort((a, b) => a - b);
            return ds.length ? `${fmt(ds[0])} .. ${fmt(ds[ds.length - 1])}` : '(none)';
        };
        const net = list => list.reduce((a, r) => a + (parseFloat(r.Amount) || 0), 0);

        console.log('='.repeat(72));
        console.log(`${job.from}  ->  ${job.to}      (${rows.length} rows under '${job.from}' today)`);
        console.log('='.repeat(72));
        console.log(`  STAYS as ${job.from} : ${String(stay.length).padStart(3)} rows  ${span(stay).padEnd(26)} ${money(net(stay))}`);
        console.log(`  MOVES to ${job.to} : ${String(move.length).padStart(3)} rows  ${span(move).padEnd(26)} ${money(net(move))}`);
        console.log(`  rows already on ${job.to}: ${target.length}`);

        const warn = [];
        if (!move.length) warn.push(`nothing posts in ${job.year} — already fixed?`);
        if (target.length) warn.push(`${job.to} already has ${target.length} row(s) — merging, not creating`);

        // The moved set must look like one statement closing in the target month.
        if (move.length) {
            const ds = move.map(r => d(r.PayableDate)).sort((a, b) => a - b);
            const lo = ds[0], hi = ds[ds.length - 1];
            const days = Math.round((hi - lo) / 86400000);
            const closes = `${MON[hi.getMonth()]} ${hi.getFullYear()}`;
            const want = `${MON[job.month - 1]} ${job.year}`;
            console.log(`  moved set spans ${days} days and closes in ${closes} (expect ${want})`);
            if (closes !== want) warn.push(`moved set closes in ${closes}, not ${want} — DO NOT WRITE`);
            if (days > 45) warn.push(`moved set spans ${days} days — wider than one cycle, inspect`);
            const rec = move.filter(r => r.Reconciled === true).length;
            if (rec) warn.push(`${rec} of the moved rows are already marked Reconciled`);
        }
        // The stayed set should equally look like the same month one year earlier.
        if (stay.length) {
            const ds = stay.map(r => d(r.PayableDate)).sort((a, b) => a - b);
            const hi = ds[ds.length - 1];
            const closes = `${MON[hi.getMonth()]} ${hi.getFullYear()}`;
            const want = `${MON[job.month - 1]} ${job.year - 1}`;
            console.log(`  remaining set closes in ${closes} (expect ${want})`);
            if (closes !== want) warn.push(`remaining set closes in ${closes}, not ${want} — inspect`);
        }
        warn.forEach(w => console.log(`  ⚠ ${w}`));

        const where = `Month_Reconciled='${job.from}' AND PayableDate>='${job.year}-01-01' `
                    + `AND PayableDate<'${job.year + 1}-01-01'`;
        console.log(`  where: ${where}`);
        console.log();
        plan.push({ job, where, move: move.length, blocked: warn.some(w => w.includes('DO NOT WRITE')) });
    }

    const totalMove = plan.reduce((a, p) => a + p.move, 0);
    const blocked = plan.filter(p => p.blocked);
    console.log('='.repeat(72));
    console.log(`PLAN: relabel ${totalMove} row(s) across ${plan.length} month(s). ` +
                `Caspio writes: ${plan.filter(p => p.move && !p.blocked).length}`);
    if (blocked.length) console.log(`BLOCKED: ${blocked.map(p => p.job.from).join(', ')} failed validation.`);
    console.log('='.repeat(72));

    if (!WRITE) { console.log('\nDRY RUN — nothing written. Re-run with --write to execute.'); return; }
    if (blocked.length) { console.error('\nRefusing to write: validation failed above.'); process.exit(1); }

    const token = await getCaspioAccessToken();
    const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    for (const p of plan) {
        if (!p.move) continue;
        const res = await axios.put(
            `${api}/tables/${T}/records?q.where=${encodeURIComponent(p.where)}`,
            { Month_Reconciled: p.job.to }, { headers: H, timeout: 30000 });
        const n = res.data && (res.data.RecordsAffected != null ? res.data.RecordsAffected : res.data.recordsAffected);
        console.log(`  ${p.job.from} -> ${p.job.to}: ${n != null ? n : JSON.stringify(res.data)} affected`);
    }
    console.log('\nDONE.');
})().catch(e => {
    console.error('FATAL:', e.response ? JSON.stringify(e.response.data) : e.message);
    process.exit(1);
});
