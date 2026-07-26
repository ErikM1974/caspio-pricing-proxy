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
 *   - The 2026 Q1 block covers a CLOSED quarter, so its numbers move only when an eligibility
 *     RULE changes — never on their own. They were re-baselined once, on 2026-07-26, when
 *     webstore accounts became ineligible. If they shift without a rule change behind it,
 *     that is a bug, not a stale fixture.
 *     Inside that block, `Nika 2026 Q1 new accounts = 3` is the load-bearing one: it is the
 *     caps-history regression. If it reads 8, someone dropped retired order type 1 "Caps"
 *     from the history lookback and the bonus is about to pay cap-only customers as brand-new
 *     programs. See memory/EMB_BONUS_Q3_2026.md in the Pricing Index repo.
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
    // ⚠️ RE-BASELINED 2026-07-26 when webstore accounts became ineligible: 98 → 68 and
    // 280 → 189. The drop IS the feature — a webstore account can never earn a bounty, so
    // listing it as someone to call was telling a rep to chase money that doesn't exist.
    check('Nika still-dormant matches probe', dorm.reps['Nika Lao'].stillDormantCount, 68, 1);
    check('Taneisha still-dormant matches probe', dorm.reps['Taneisha Clark'].stillDormantCount, 189, 2);

    // The exclusion is customer-level and easy to half-fix: `Inksoft_Store` alone flags only
    // 11 of the 19 Hops N Drops locations (Bonney Lake and Lacey read false while ordering
    // through the store monthly), so a test that trusts the flag passes while the bonus is
    // still wrong. Assert on the NAMES — they are the case that exposed the gap.
    for (const rep of ['Nika Lao', 'Taneisha Clark']) {
        const leaked = dorm.reps[rep].accounts.filter(a => /hops\s*n\s*drops/i.test(a.company || ''));
        check(`    ${rep} call list has no webstore accounts`, leaked.length, 0);
    }

    console.log('\n=== BONUS COMPUTATION ===');
    const b = await helpers.computeEmbroideryBonus('Q3', 2026);
    console.log(`  window ${b.dateRange.start}..${b.dateRange.end} · config ${b.configSource}`);
    console.log(`  company Q3 to date: ${M(b.teamKicker.companyRevenue)} (${b.teamKicker.companyOrders} orders)`);
    // ⚠️ BASIS CHANGED 2026-07-26: the kicker measures company EMBROIDERY (types 21 + retired 1),
    // not all order types. $166,960 was the all-types figure. Three numbers are in play and only
    // one is right — all-types $166,960 · eligible-only ~$41,696 · ALL-account embroidery $73,328.
    // Getting it wrong is silent: the strip still renders, it just measures the wrong business.
    // Eligible-only would have been near-useless as a team goal — company eligible embroidery
    // ($186,214) is barely above the two reps' combined baselines ($193,228), so the kicker would
    // have re-paid the same dollars their individual rate already pays.
    check('company Q3-to-date matches oracle', b.teamKicker.companyRevenue, 73328, 60);
    console.log(`  kicker: reached ${b.teamKicker.reached ? M(b.teamKicker.reached.target) : 'none'} · next ${b.teamKicker.next ? M(b.teamKicker.next.target) : '—'} (${M(b.teamKicker.amountToNext)} to go)`);

    // Per-rep Q3-to-date ELIGIBLE embroidery (current ownership, webstore accounts removed).
    // Pre-exclusion these read Nika $53,849 · Taneisha $18,404. Nika's book turned out to be
    // ~45% webstore by embroidery revenue, which is why hers more than halves and Taneisha's
    // barely moves. Her baseline moved in the SAME deploy ($235,000 → $104,189) — excluding the
    // revenue while leaving the old goal would have made her target unreachable.
    const ORACLE_REV = { 'Nika Lao': 24780, 'Taneisha Clark': 15841 };
    // Bounty counts at the $1,000 bar. Each rep lost exactly one bounty-earning account to the
    // exclusion, which re-ranked what qualified underneath: Nika 3 react → 2, Taneisha 4 new → 3.
    const ORACLE_CNT = { 'Nika Lao': { n: 0, r: 2 }, 'Taneisha Clark': { n: 3, r: 0 } };

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

        // 🔑 NO DEAD ZONE. This is the entire reason the four rungs were replaced: between them,
        // a rep's next order earned nothing, and one who couldn't reach the next rung before
        // quarter-end was better off pushing orders into the following quarter. The plan was
        // paying people to do the wrong thing.
        //
        // Asserting the invariant on the LIVE response rather than a synthetic input, so it
        // proves the shipped path is continuous and stays valid as the quarter moves.
        const rate = r.ladder.rate;
        if (rate) {
            const expected = Math.round(Math.max(0, r.ladder.pctOfBaseline - rate.startPct) * rate.perPoint * 100) / 100;
            check('    rate payout is continuous in % of goal', rate.payout, expected, 0.6);
            console.log(`     rate: ${r.ladder.pctOfBaseline}% − ${rate.startPct}% = ${rate.pointsEarned}pt`
                + ` × $${rate.perPoint} = $${rate.payout} · +0.5pt would add $${rate.perPoint / 2}`);
        }
        // There must never be a zero-total screen: a rep below the rate's start still earns
        // bounties from day one. A rep who opens their dashboard to $0 stops opening it.
        if (r.ladder.pctOfBaseline < (rate ? rate.startPct : 100) && r.counts.new + r.counts.reactivated > 0) {
            check('    below rate start, bounties still pay', r.totalBonus > 0, true);
        }
    }

    // --- Regression: caps history must be honoured (2026 Q1, Nika: 3 new NOT 8) ---
    console.log('\n=== REGRESSION: caps history honoured (2026 Q1 Nika new should be 3, not 8) ===');
    const q1 = await helpers.computeEmbroideryBonus('Q1', 2026);
    // 🔒 THE GUARD: 3, never 8. Cap embroidery was its own order type (1) until it folded into
    // Custom Embroidery (21) at the 2025 Q3→Q4 boundary. A history query that reads type 21 alone
    // sees a cap-only pre-merge customer as having never embroidered and pays them as a NEW
    // program. This assertion is unrelated to the webstore work and must survive it.
    check('Nika 2026 Q1 new accounts', q1.reps['Nika Lao'].counts.new, 3);
    check('Nika 2026 Q1 reactivated', q1.reps['Nika Lao'].counts.reactivated, 2);
    check('Taneisha 2026 Q1 new accounts', q1.reps['Taneisha Clark'].counts.new, 8);
    check('Taneisha 2026 Q1 reactivated', q1.reps['Taneisha Clark'].counts.reactivated, 6);
    // Q1 eligible revenue. Pre-exclusion: Nika $230,720 · Taneisha $138,337 ($138,705 probe less
    // $368 for customer 13500, Rainier Pure Beef, which is on the excluded-customer list).
    check('Nika 2026 Q1 revenue', q1.reps['Nika Lao'].ladder.revenue, 124494, 60);
    check('Taneisha 2026 Q1 revenue (excl. 13500)', q1.reps['Taneisha Clark'].ladder.revenue, 111885, 60);

    // The continuity check in the Q3 block is TRIVIAL while both reps sit below 85% — 0 points
    // pays $0 whatever the arithmetic does, so it would pass even if the rate were broken.
    // Q1 exercises it for real: Taneisha finished that quarter at 111.88%, well past the start.
    // (Q1 has no Rep_Bonus_Config row, so it runs on FALLBACK_CONFIG — which also proves the
    // fallback path computes a rate rather than silently reverting to rungs.)
    const tq1 = q1.reps['Taneisha Clark'].ladder;
    check('Q1 rate exercises a non-zero payout', tq1.rate && tq1.rate.pointsEarned > 0, true);
    check('Q1 rate payout is continuous in % of goal',
        tq1.rate.payout,
        Math.round(Math.max(0, tq1.pctOfBaseline - tq1.rate.startPct) * tq1.rate.perPoint * 100) / 100, 0.6);

    console.log(`\n${failures === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}`);
    process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
