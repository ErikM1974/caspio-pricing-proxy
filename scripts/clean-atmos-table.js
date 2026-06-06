// One-time cleanup of CreditCard_NWCA_ATMOS: backfill Reference_ID, dedupe by reference,
// and give no-reference rows a placeholder key — so Reference_ID can be marked Unique.
//
// Identity per charge = the bare BoA reference (15+ digit run in InvoiceNumber). Rows with
// no reference are grouped by their exact InvoiceNumber and keyed "NOREF-<PK_ID>".
// For each group: keep the most-complete row (prefer one with a GL_Account, then Reconciled=Yes,
// then lowest PK_ID), set its Reference_ID, and DELETE the other copies by PK_ID.
//
// DRY RUN by default. Pass --write to perform PUTs (set Reference_ID) and DELETEs.
//   node scripts/clean-atmos-table.js            (dry run + report)
//   node scripts/clean-atmos-table.js --write    (execute)

const axios = require('axios');
const { getCaspioAccessToken, fetchAllCaspioPages } = require('../src/utils/caspio');
const config = require('../config');

const api = config.caspio.apiBaseUrl;
const T = 'CreditCard_NWCA_ATMOS';
const WRITE = process.argv.includes('--write');

function extractRef(inv) { const m = String(inv || '').match(/(\d{15,})/); return m ? m[1] : null; }
const sleep = ms => new Promise(r => setTimeout(r, ms));
function isRate(e) { const d = e && e.response && e.response.data; const s = d ? (typeof d === 'string' ? d : JSON.stringify(d)) : ''; return s.indexOf('api-calls-rate') !== -1 || s.toLowerCase().indexOf('rate limit') !== -1; }
async function retry(fn, n = 4) { let a = 0; while (true) { try { return await fn(); } catch (e) { if (!isRate(e) || a >= n) throw e; await sleep(1000 * 2 ** a); a++; } } }

// most-complete first: GL_Account set, then Reconciled true, then lowest PK_ID
function pickSurvivor(rows) {
    return rows.slice().sort((a, b) => {
        const ga = a.GL_Account != null ? 1 : 0, gb = b.GL_Account != null ? 1 : 0;
        if (ga !== gb) return gb - ga;
        const ra = (a.Reconciled === true || a.Reconciled === 'Yes') ? 1 : 0;
        const rb = (b.Reconciled === true || b.Reconciled === 'Yes') ? 1 : 0;
        if (ra !== rb) return rb - ra;
        return (a.PK_ID || 0) - (b.PK_ID || 0);
    })[0];
}

(async () => {
    const fetched = await fetchAllCaspioPages(`/tables/${T}/records`,
        { 'q.select': 'PK_ID,InvoiceNumber,Reference_ID,GL_Account,Reconciled', 'q.orderBy': 'PK_ID ASC', 'q.pageSize': 1000 });
    // Page-number pagination can overlap pages; PK_ID is the source of truth, so de-dupe the fetch.
    const seenPk = new Set();
    const rows = fetched.filter(r => { if (seenPk.has(r.PK_ID)) return false; seenPk.add(r.PK_ID); return true; });
    console.log('Rows fetched:', fetched.length, '| unique by PK_ID (real rows):', rows.length);

    const groups = new Map(); // key -> [rows]
    for (const r of rows) {
        const ref = extractRef(r.InvoiceNumber);
        const key = ref ? 'REF:' + ref : 'NOREF:' + String(r.InvoiceNumber || '');
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
    }

    const setRef = [];   // {pk, ref}  survivors needing Reference_ID set
    const del = [];      // pk's to delete (extra copies)
    let noRefGroups = 0, dupGroups = 0;

    for (const [key, grp] of groups) {
        const isNoRef = key.startsWith('NOREF:');
        const survivor = pickSurvivor(grp);
        const refValue = isNoRef ? ('NOREF-' + survivor.PK_ID) : key.slice(4);
        if (isNoRef) noRefGroups++;
        if (grp.length > 1) dupGroups++;
        if (String(survivor.Reference_ID || '') !== refValue) setRef.push({ pk: survivor.PK_ID, ref: refValue });
        for (const r of grp) if (r.PK_ID !== survivor.PK_ID) del.push(r.PK_ID);
    }

    console.log('\n=== PLAN ===');
    console.log('Distinct charges (groups):', groups.size);
    console.log('Groups with duplicates:', dupGroups);
    console.log('No-reference groups (placeholder key):', noRefGroups);
    console.log('Reference_ID values to SET (PUT):', setRef.length);
    console.log('Duplicate rows to DELETE:', del.length);
    console.log('Rows after cleanup:', rows.length - del.length, '(should equal distinct charges =', groups.size + ')');

    if (!WRITE) { console.log('\nDRY RUN — nothing written. Re-run with --write to execute.'); return; }

    const token = await getCaspioAccessToken();
    const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const BATCH = 6;
    async function batched(list, fn, label) {
        let ok = 0, err = 0;
        for (let i = 0; i < list.length; i += BATCH) {
            const b = list.slice(i, i + BATCH);
            const res = await Promise.allSettled(b.map(fn));
            res.forEach((x, j) => { if (x.status === 'rejected') { err++; console.error(`  ${label} err`, JSON.stringify(b[j]), x.reason.response ? JSON.stringify(x.reason.response.data) : x.reason.message); } else ok++; });
            if (i % 120 === 0) console.log(`  ${label} ${Math.min(i + BATCH, list.length)}/${list.length}`);
        }
        return { ok, err };
    }

    console.log('\n=== SET Reference_ID ===');
    const s = await batched(setRef, ({ pk, ref }) => retry(() => axios.put(
        `${api}/tables/${T}/records?q.where=PK_ID=${pk}`, { Reference_ID: ref },
        { headers: H, timeout: 20000 })), 'PUT');
    console.log('=== DELETE duplicates ===');
    const d = await batched(del, (pk) => retry(() => axios.delete(
        `${api}/tables/${T}/records?q.where=PK_ID=${pk}`, { headers: H, timeout: 20000 })), 'DEL');

    console.log(`\nDONE. Reference_ID set: ${s.ok} (err ${s.err}) | deleted: ${d.ok} (err ${d.err}).`);
})().catch(e => { console.error('FATAL:', e.response ? JSON.stringify(e.response.data) : e.message); process.exit(1); });
