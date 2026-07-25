// Verify embroidery-bonus.js against the probe oracle. Run from the proxy repo root.
/**
 * Manual verification for the Q3 2026 Embroidery Bonus — run from the REPO ROOT:
 *
 *     node tests/manual/verify-embroidery-bonus.js
 *
 * Not a jest test on purpose: it hits live Caspio and the full-history pull takes minutes,
 * well past jest's 30s testTimeout. Run it after any change to embroidery-bonus.js,
 * commission-payouts.js's getEmbroideryBonus(), or the Rep_Bonus_Config table.
 *
 * WHICH ASSERTIONS ARE DURABLE:
 *   - The 2026 Q1 block is FROZEN (closed quarter) — those numbers must never change. It is
 *     the caps-history regression: Nika's "new account" count must be 3, not 8. If it reads 8,
 *     someone dropped retired order type 1 "Caps" from the history lookback and the bonus is
 *     about to overpay. See memory/EMB_BONUS_Q3_2026.md in the Pricing Index repo.
 *   - The Q3 2026 numbers MOVE as the quarter progresses; treat mismatches there as
 *     "re-baseline the expected values", not necessarily as a bug.
 *   - The reconciliation checks (counts add up, totals fold) are always valid.
 */
const fs = require('fs');
const path = require('path');
// Load the proxy's .env by hand so this runs without dotenv on the path.
for (const line of fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const { helpers } = require(path.join(process.cwd(), 'src', 'routes', 'embroidery-bonus'));

const M = n => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');
let failures = 0;
function check(label, actual, expected, tol = 0) {
    const ok = typeof expected === 'number'
        ? Math.abs(actual - expected) <= tol
        : actual === expected;
    console.log(`  ${ok ? '✅' : '❌'} ${label}: got ${typeof actual === 'number' ? M(actual) : actual}` +
        (ok ? '' : `  — EXPECTED ${typeof expected === 'number' ? M(expected) : expected}`));
    if (!ok) failures++;
    return ok;
}

(async () => {
    console.log('=== CONFIG ===');
    const cfg = await helpers.loadConfig('Q3', 2026);
    console.log(`  source: ${cfg.configSource}`);
    if (cfg.warning) console.log(`  ⚠️  ${cfg.warning}`);
    console.log(`  window: ${cfg.dateStart} .. ${cfg.dateEnd}`);
    console.log(`  revenue types ${JSON.stringify(cfg.orderTypeIds)} · history types ${JSON.stringify(cfg.historyOrderTypeIds)}`);
    console.log(`  bounties: new $${cfg.newAccountBounty} · react $${cfg.reactivatedBounty} · min $${cfg.minAccountRevenue} · dormancy ${cfg.dormancyMonths}mo`);
    for (const [rep, r] of Object.entries(cfg.reps)) {
        console.log(`  ${rep}: baseline ${M(r.baselineRevenue)} · rungs ${r.rungs.map(x => `${x.pct}%=$${x.pay}`).join(' ')}`);
    }

    // The original probe reported 98 / 280 "dormant". The route reports MORE because it is
    // strictly more correct on two counts, both verified in diag.js + pre2019.js:
    //   (a) it counts dormancy AS OF QUARTER OPEN (the bounty-eligible universe); accounts
    //       already won back during Q3 stay in `count` and drop out of `stillDormantCount`
    //   (b) its history query has NO lower date bound — ORDER_ODBC holds embroidery back to
    //       2000 (56 orders / 10 customers pre-2019). e.g. Kingfisher Charters embroidered in
    //       2018, so it is Reactivated ($50), NOT a new program ($75). The probe couldn't see it.
    console.log('\n=== DORMANT CALL LIST ===');
    const dorm = await helpers.computeDormant('Q3', 2026, null);
    for (const rep of ['Nika Lao', 'Taneisha Clark']) {
        const d = dorm.reps[rep];
        console.log(`  ${rep}: ${d.count} dormant at quarter open (${M(d.lifetimeEmbroideryTotal)} lifetime)`
            + ` → ${d.stillDormantCount} still to call (${M(d.stillDormantLifetimeTotal)})`
            + ` · ${d.alreadyReactivatedCount} already won back`);
        check(`    ${rep} counts reconcile`, d.stillDormantCount + d.alreadyReactivatedCount, d.count);
        const top = d.accounts.filter(a => a.quarterToDateRevenue === 0).slice(0, 3);
        console.log(`      top targets: ${top.map(a => `${a.company} ${M(a.lifetimeEmbroidery)} (${a.monthsDormant}mo)`).join(' | ')}`);
    }
    check('Nika still-dormant matches probe', dorm.reps['Nika Lao'].stillDormantCount, 98, 1);
    check('Taneisha still-dormant matches probe', dorm.reps['Taneisha Clark'].stillDormantCount, 280, 2);

    console.log('\n=== BONUS COMPUTATION ===');
    const b = await helpers.computeEmbroideryBonus('Q3', 2026);
    console.log(`  window ${b.dateRange.start}..${b.dateRange.end} · config ${b.configSource}`);
    console.log(`  company Q3 to date: ${M(b.teamKicker.companyRevenue)} (${b.teamKicker.companyOrders} orders)`);
    // Oracle: company Q3 Jul 1-25 all types = $166,960
    check('company Q3-to-date matches oracle', b.teamKicker.companyRevenue, 166960, 60);
    console.log(`  kicker: reached ${b.teamKicker.reached ? M(b.teamKicker.reached.target) : 'none'} · next ${b.teamKicker.next ? M(b.teamKicker.next.target) : '—'} (${M(b.teamKicker.amountToNext)} to go)`);

    // Oracle per-rep Q3-to-date embroidery (current ownership): Nika $53,849 · Taneisha $18,404
    const ORACLE_REV = { 'Nika Lao': 53849, 'Taneisha Clark': 18404 };
    // Oracle bounty counts at $1000 bar, 2026 Q3*: Nika 0 new + 3 react · Taneisha 4 new + 0 react
    const ORACLE_CNT = { 'Nika Lao': { n: 0, r: 3 }, 'Taneisha Clark': { n: 4, r: 0 } };

    for (const [rep, r] of Object.entries(b.reps)) {
        console.log(`\n  --- ${rep} ---`);
        check('    Q3 embroidery revenue', r.ladder.revenue, ORACLE_REV[rep], 60);
        check('    new accounts', r.counts.new, ORACLE_CNT[rep].n);
        check('    reactivated accounts', r.counts.reactivated, ORACLE_CNT[rep].r);
        console.log(`     repeat accounts: ${r.counts.repeat}`);
        console.log(`     ladder: ${M(r.ladder.revenue)} / ${M(r.ladder.baseline)} = ${r.ladder.pctOfBaseline}%` +
            ` · rung ${r.ladder.rungReached ? r.ladder.rungReached.pct + '% ($' + r.ladder.rungReached.pay + ')' : 'none'}` +
            ` · next ${r.ladder.nextRung ? r.ladder.nextRung.pct + '% at ' + M(r.ladder.nextRung.threshold) + ' (' + M(r.ladder.amountToNextRung) + ' to go)' : '—'}`);
        console.log(`     payout: bounties $${r.bounties.payout} + ladder $${r.ladder.payout} + kicker $${b.teamKicker.payoutEach} = $${r.totalBonus}`);
        if (r.accounts.new.length) console.log(`     new: ${r.accounts.new.map(a => `${a.company} ${M(a.revenue)}`).join(' | ')}`);
        if (r.accounts.reactivated.length) console.log(`     react: ${r.accounts.reactivated.map(a => `${a.company} ${M(a.revenue)}`).join(' | ')}`);
    }

    // --- Regression: caps history must be honoured (2026 Q1, Nika: 3 new NOT 8) ---
    console.log('\n=== REGRESSION: caps history honoured (2026 Q1 Nika new should be 3, not 8) ===');
    const q1 = await helpers.computeEmbroideryBonus('Q1', 2026);
    check('Nika 2026 Q1 new accounts', q1.reps['Nika Lao'].counts.new, 3);
    check('Nika 2026 Q1 reactivated', q1.reps['Nika Lao'].counts.reactivated, 4);
    check('Taneisha 2026 Q1 new accounts', q1.reps['Taneisha Clark'].counts.new, 8);
    check('Taneisha 2026 Q1 reactivated', q1.reps['Taneisha Clark'].counts.reactivated, 6);
    // Oracle Q1 revenue on current ownership: Nika $230,720 · Taneisha $138,705
    check('Nika 2026 Q1 revenue', q1.reps['Nika Lao'].ladder.revenue, 230720, 60);
    // $138,705 probe − $368 customer 13500 (Rainier Pure Beef, on the exclusion list) = $138,337.
    // Confirmed to the dollar in diag.js: the route applies the exclusion, the probe never did.
    check('Taneisha 2026 Q1 revenue (excl. 13500)', q1.reps['Taneisha Clark'].ladder.revenue, 138337, 60);

    console.log(`\n${failures === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}`);
    process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
