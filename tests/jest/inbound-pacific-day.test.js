/**
 * The SanMar inbound report's "today" is PACIFIC, not UTC.
 *
 * WHY (2026-08-26)
 * Every day seed in sanmar-orders.js was `new Date().toISOString().slice(0, 10)`.
 * Heroku runs UTC; Milton is UTC-7 in summer, UTC-8 in winter. So from about
 * 5:00 PM Pacific the default board silently rolled over to TOMORROW — and took
 * everything keyed off it with it:
 *
 *   - the default `date` the board renders,
 *   - `rushFieldsFor(date, dueDate)`, which decides the RUSH badge and pastDue,
 *   - the received / follow-on comparison.
 *
 * A rep checking at 5:30 PM to answer "where is my customer's order?" saw a day
 * that had not happened yet. Nothing looked broken, because the rest of the date
 * maths is UTC-internally-consistent — which is exactly why it survived.
 *
 * These sheets are printed and handed to Ruthie, Nika and Taneisha, so the day on
 * the paper has to be the day in the building.
 */

const fs = require('fs');
const path = require('path');

const RAW = fs.readFileSync(
    path.join(__dirname, '../../src/routes/sanmar-orders.js'), 'utf8');
// Strip comments before pattern-matching. The rationale comment added with the fix
// quotes the offending expression verbatim, and a naive grep flags the explanation
// of the bug as the bug.
const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const { accountDay } = require('../../src/utils/account-time');

describe('the day seed is the Milton clock', () => {
    test('no raw UTC day seed survives in the route', () => {
        // The exact expression that caused it: a NO-ARGUMENT `new Date()` reduced to a
        // day string. If this reappears in live code, the 5 PM rollover is back.
        // Deliberately narrow: `d.toISOString().slice(0,10)` on a Date built from
        // Date.UTC(...) is pure calendar arithmetic (the holiday table at ~:776-784)
        // and is correct as it stands.
        expect(SRC).not.toMatch(/new Date\(\s*\)\.toISOString\(\)\.slice\(0, ?10\)/);
    });

    test('the route defines localDay() and sources it from the shared account clock', () => {
        // Reuse, not a second definition of "today" — the meter and the pacing
        // math already agree on America/Los_Angeles, DST included.
        expect(SRC).toMatch(/require\('\.\.\/utils\/account-time'\)/);
        expect(SRC).toMatch(/function localDay\(\)\s*\{\s*return accountDay\(\);/);
    });

    test('every "today" in the route goes through localDay()', () => {
        const seeds = SRC.match(/const today = [^\n;]+;/g) || [];
        expect(seeds.length).toBeGreaterThanOrEqual(4);
        for (const seed of seeds) expect(seed).toBe('const today = localDay();');
    });
});

describe('the boundary that actually bit us', () => {
    // 2026-08-26T01:30:00Z is 6:30 PM Pacific on 2026-08-25 (PDT, UTC-7).
    // UTC says the 26th; Milton says the 25th. Milton is right.
    const EVENING = new Date('2026-08-26T01:30:00Z');

    test('6:30 PM Pacific is still the SAME Pacific day, not tomorrow', () => {
        expect(accountDay(EVENING)).toBe('2026-08-25');
        expect(EVENING.toISOString().slice(0, 10)).toBe('2026-08-26');  // the old, wrong answer
    });

    test('the same instant in WINTER also resolves to the previous day (PST, UTC-8)', () => {
        // 5:30 PM Pacific on 2026-01-14. Guards the DST half of the same bug —
        // the rollover happens an hour earlier once the clocks go back.
        const winter = new Date('2026-01-15T01:30:00Z');
        expect(accountDay(winter)).toBe('2026-01-14');
    });

    test('mid-morning Pacific is unambiguous in both clocks — the fix changes nothing there', () => {
        const morning = new Date('2026-08-26T16:00:00Z');   // 9:00 AM PDT
        expect(accountDay(morning)).toBe('2026-08-26');
        expect(morning.toISOString().slice(0, 10)).toBe('2026-08-26');
    });
});

describe('the printed sheet can say when it was generated', () => {
    test('the payload carries a Pacific stamp beside the UTC one', () => {
        // A sheet picked up off the printer at noon must be distinguishable from
        // one printed at 6 AM; these get handed around the shop all day.
        expect(RAW).toMatch(/generatedAt: new Date\(\)\.toISOString\(\)/);
        expect(RAW).toMatch(/generatedAtLocal: new Date\(\)\.toLocaleString\('en-US'/);
        expect(RAW).toMatch(/timeZone: 'America\/Los_Angeles'/);
    });
});
