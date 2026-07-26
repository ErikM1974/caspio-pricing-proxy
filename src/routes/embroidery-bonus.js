/**
 * Q3 2026 Embroidery Bonus Routes
 *
 * Replaces the Garment Tracker quarterly spiff. Pays on embroidery outcomes the rep
 * actually controls — new and reactivated embroidery accounts — plus a growth ladder
 * against each rep's own book history, plus a shared company kicker toward the $3M goal.
 *
 * 🔑 EMBROIDERY = id_OrderType 21, BUT history must ALSO include retired type 1 "Caps".
 *    Cap embroidery was its own order type until it folded into 21 at the 2025 Q3→Q4
 *    boundary (type 1: $44,341 in 2025 Q3 → $1,095 in Q4 → $0 from 2026 Q1). A cap-only
 *    pre-merge customer looks like it "never embroidered" under a 21-only lookback and
 *    would be paid as a brand-new program — measured at 5 falsely-new accounts for Nika
 *    in 2026 Q1 alone. NEVER drop type 1 from the history query.
 *
 * 🔑 Type 16 "Wow Embroidery" is EXCLUDED — 78 orders in 2026 at $0.00, 314 in 2025 at $30.
 *    It's internal redo/no-charge work; counting it inflates account counts with free work.
 *
 * 🔑 Ownership comes from Sales_Reps_2026, NEVER the order row's CustomerServiceRep
 *    (a stale snapshot that still shows retired reps). Rebuilding history through current
 *    ownership moves Nika's 2024 Q3 down $79,430 and Taneisha's 2025 Q3 up $63,105.
 *
 * Endpoints:
 *   GET  /api/embroidery-bonus/config    — Rep_Bonus_Config (falls back LOUDLY)
 *   GET  /api/embroidery-bonus           — live bounties + ladder + team kicker
 *   GET  /api/embroidery-bonus/dormant   — the call list: dormant embroidery accounts
 *   POST /api/embroidery-bonus/archive   — quarter-end freeze into EmbroideryBonusArchive
 */

const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages, makeCaspioRequest } = require('../utils/caspio');

const ORDER_ODBC_TABLE = 'ORDER_ODBC';
const SALES_REPS_TABLE = 'Sales_Reps_2026';
const CONFIG_TABLE = 'Rep_Bonus_Config';
const ARCHIVE_TABLE = 'EmbroideryBonusArchive';

const TRACKED_REPS = ['Nika Lao', 'Taneisha Clark'];

// Identity resolution stays server-side: the frontend forwarder passes the SAML-verified
// email, never a rep name, so a rep can't request a colleague's account list.
const EMAIL_TO_REP = {
    'nika@nwcustomapparel.com': 'Nika Lao',
    'taneisha@nwcustomapparel.com': 'Taneisha Clark',
};

function resolveRep(query) {
    const email = String(query.email || '').trim().toLowerCase();
    if (email && EMAIL_TO_REP[email]) return EMAIL_TO_REP[email];
    const rep = String(query.rep || '').trim();
    if (rep && TRACKED_REPS.includes(rep)) return rep;
    return null; // null = all tracked reps
}

// Current-quarter revenue scope. 21 = Custom Embroidery (includes caps since 2025 Q4).
const EMB_ORDER_TYPES = [21];
// History scope — MUST include retired type 1 "Caps". See header note.
const EMB_HISTORY_TYPES = [21, 1];

const DAY_MS = 86400000;

/**
 * Normalise a Caspio customer id for cross-table joins. ORDER_ODBC's `id_Customer` and
 * Sales_Reps_2026's `ID_Customer` are joined by value, and Caspio is known to hand back
 * padded/whitespaced key values on some tables — an untrimmed mismatch would silently drop
 * the account from the rep's book (no error, just a missing bounty).
 */
function cid(v) {
    return String(v == null ? '' : v).trim();
}

/**
 * Fallback config. Used ONLY when Rep_Bonus_Config is unreachable, and always paired with
 * configSource:'fallback' + a warning so the dashboard can surface it. Erik's #1 rule:
 * never let a wrong number render silently.
 *
 * Baselines derived 2026-07-25 from ORDER_ODBC on CURRENT ownership (Sales_Reps_2026):
 *   Nika      — Q3'25 $190,847 · best-ever Q3 $246,873 · seasonal norm $260,482 · proj $222,578
 *   Taneisha  — Q3'25  $72,520 · best-ever Q3 $112,981 · seasonal norm $108,265 · proj  $76,072
 */
const FALLBACK_CONFIG = {
    program: 'EMB',
    quarter: 'Q3',
    year: 2026,
    dateStart: '2026-07-01',
    dateEnd: '2026-09-30',
    orderTypeIds: EMB_ORDER_TYPES,
    historyOrderTypeIds: EMB_HISTORY_TYPES,
    excludedCustomerIds: [13500],           // Rainier Pure Beef (matches garment tracker)
    minAccountRevenue: 1000,
    dormancyMonths: 12,
    // Webstore accounts earn the Online Store commission instead — never both (Erik 2026-07-26).
    excludeOnlineStore: true,
    // Continuous growth rate: $60 per percentage point above 85% of goal, uncapped, pro-rata.
    // Replaced the 4-rung ladder because between rungs a rep earned nothing on extra effort —
    // and near quarter-end was better off deferring orders. Per POINT, not per dollar, so equal
    // percentage achievement pays equally regardless of book size.
    rateStartPct: 85,
    ratePerPoint: 60,
    newAccountBounty: 150,
    reactivatedBounty: 100,
    // ⚠️ These mirror the APPROVED Q3 2026 plan, not the pre-2026-07-26 draft. The fallback is
    // loud (configSource:'fallback' + a visible banner), so a stale number here is never silent —
    // but it is still a number a rep can read. Against the old $235,000 baseline Nika's live
    // $24,780 renders as 10.5% instead of 23.8%, which reads as "you are failing" during what is
    // actually a Caspio outage. Keep these in step with Rep_Bonus_Config whenever the plan moves.
    //
    // Kicker targets measure ALL company embroidery (types 21 + retired 1), every account and
    // every person, webstores included — deliberately wider than the individual bonus.
    teamKickers: [
        { target: 310000, pay: 500 },       // 2025 Q3 did $298,155 — within reach of a normal quarter
        { target: 340000, pay: 1000 },      // a stretch, but 2024 Q3 reached $380,036
    ],
    reps: {
        'Nika Lao': {
            baselineRevenue: 104189,
            rungs: [
                { pct: 85, pay: 150 },
                { pct: 100, pay: 400 },
                { pct: 115, pay: 700 },
                { pct: 130, pay: 1200 },
            ],
        },
        'Taneisha Clark': {
            baselineRevenue: 89039,
            rungs: [
                { pct: 85, pay: 150 },
                { pct: 100, pay: 400 },
                { pct: 115, pay: 700 },
                { pct: 130, pay: 1200 },
            ],
        },
    },
};

// ── Cache ───────────────────────────────────────────────────────────────
// Two tiers: quarter-to-date data moves constantly (5 min), pre-quarter history is
// effectively frozen once the quarter opens (6 h) and is the expensive pull.
const cache = new Map();
const TTL_LIVE = 5 * 60 * 1000;
const TTL_HISTORY = 6 * 60 * 60 * 1000;

function getCached(key, ttl) {
    const e = cache.get(key);
    if (e && Date.now() - e.timestamp < ttl) return e.data;
    return null;
}
function setCache(key, data) {
    cache.set(key, { data, timestamp: Date.now() });
}
function clearCache() {
    cache.clear();
}

// ── Helpers ─────────────────────────────────────────────────────────────

const QUARTER_MONTHS = { Q1: [1, 3], Q2: [4, 6], Q3: [7, 9], Q4: [10, 12] };

function quarterRange(quarter, year) {
    const [m1, m2] = QUARTER_MONTHS[quarter] || QUARTER_MONTHS.Q3;
    const lastDay = new Date(Date.UTC(year, m2, 0)).getUTCDate();
    return {
        start: `${year}-${String(m1).padStart(2, '0')}-01`,
        end: `${year}-${String(m2).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
    };
}

function currentQuarter() {
    return `Q${Math.floor(new Date().getMonth() / 3) + 1}`;
}

function orderTypeClause(ids) {
    return `(${ids.map(id => `id_OrderType=${id}`).join(' OR ')})`;
}

function num(v) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
}

function round2(n) {
    return Math.round(n * 100) / 100;
}

/**
 * Pull ORDER_ODBC rows, deduped by ID_Order.
 *
 * ⚠️ ORDER_ODBC repeats a row per design block — dedupe by ID_Order or dollars double-count.
 * ⚠️ q.orderBy PK_ID is REQUIRED: unordered multi-page reads silently drop rows, which makes
 *    accounts look new and OVERPAYS the bonus (same trap as commission-payouts.js:426).
 * ⚠️ fetchAllCaspioPages defaults to maxPages 20 (20k rows) and truncates SILENTLY — pass it.
 */
async function pullOrders(where, select, { maxPages = 60 } = {}) {
    // ⚠️ Use fetchAllCaspioPages, NEVER makeCaspioRequest, for bulk reads.
    // makeCaspioRequest is @deprecated and logs `JSON.stringify(response.data)` on EVERY
    // response (caspio.js:77) — on 1,000-row pages that is megabytes of serialization per
    // call, and because it is an argument expression you cannot silence it by stubbing
    // console.log. It also already unwraps `.Result`, so a `resp.Result` keyset loop reads
    // undefined and silently returns zero rows. Both bit here on 2026-07-25.
    const rows = await fetchAllCaspioPages(`/tables/${ORDER_ODBC_TABLE}/records`, {
        'q.where': where,
        'q.select': select,
        'q.orderBy': 'PK_ID',   // stable sort — unordered multi-page reads DROP rows
        'q.limit': 1000,
    }, { maxPages, totalTimeout: 180000 });

    // ORDER_ODBC repeats a row per design block — dedupe or dollars double-count.
    const seen = new Set();
    const out = [];
    for (const r of rows) {
        const k = String(r.ID_Order);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(r);
    }
    return out;
}

/**
 * Embroidery history for every customer, up to (but excluding) `beforeDate`.
 * Uses types 21 + 1 so pre-merge cap-only customers are recognised.
 * Returns Map<id_Customer, { firstMs, lastMs, lifetime, orders }>.
 */
async function loadEmbHistory(beforeDate, historyTypes) {
    const key = `hist:${beforeDate}:${historyTypes.join(',')}`;
    const hit = getCached(key, TTL_HISTORY);
    if (hit) return hit;

    const where = `${orderTypeClause(historyTypes)} AND sts_Invoiced=1 AND date_OrderInvoiced<'${beforeDate}'`;
    const rows = await pullOrders(where, 'PK_ID,ID_Order,id_Customer,date_OrderInvoiced,cur_Subtotal');

    const map = new Map();
    for (const r of rows) {
        const custId = cid(r.id_Customer);
        const ms = new Date(r.date_OrderInvoiced).getTime();
        if (!Number.isFinite(ms)) continue;
        let e = map.get(custId);
        // `dates` powers the target roadmap (reorder cadence + "is Q3 their season").
        // ~7k embroidery orders total, so holding the timestamps is cheap.
        if (!e) { e = { firstMs: ms, lastMs: ms, lifetime: 0, orders: 0, dates: [] }; map.set(custId, e); }
        if (ms < e.firstMs) e.firstMs = ms;
        if (ms > e.lastMs) e.lastMs = ms;
        e.lifetime += num(r.cur_Subtotal);
        e.orders++;
        e.dates.push(ms);
    }
    setCache(key, map);
    return map;
}

/**
 * Non-embroidery order activity per customer, for the "first embroidery program" list —
 * accounts that already buy from us (DTG, transfers, screen print…) but have never
 * embroidered. Windowed to `sinceDate` because a customer who last bought 5 years ago
 * isn't a warm lead; that also keeps this well under the pagination cap.
 * Type 16 "Wow Embroidery" excluded here too — it's $0.00 internal redo work.
 */
async function loadOtherActivity(sinceDate, beforeDate, embTypes) {
    const key = `other:${sinceDate}:${beforeDate}`;
    const hit = getCached(key, TTL_HISTORY);
    if (hit) return hit;

    // ⚡ Plain date range, types filtered in JS. Caspio is ~4.5x SLOWER with
    // `id_OrderType<>21 AND <>1 AND <>16` in the WHERE than without it (16.8s vs 3.7s
    // measured 2026-07-25 on this same window) — and it returns fewer rows for the extra
    // cost. Never push a multi-term `<>` filter into a Caspio WHERE on a big table; pull
    // the range and exclude in memory.
    const skip = new Set([...embTypes, 16]);
    const where = `sts_Invoiced=1 `
        + `AND date_OrderInvoiced>='${sinceDate}' AND date_OrderInvoiced<'${beforeDate}'`;
    const rows = await pullOrders(where, 'PK_ID,ID_Order,id_Customer,id_OrderType,date_OrderInvoiced,cur_Subtotal');

    const map = new Map();
    for (const r of rows) {
        if (skip.has(Number(r.id_OrderType))) continue;
        const custId = cid(r.id_Customer);
        const ms = new Date(r.date_OrderInvoiced).getTime();
        if (!Number.isFinite(ms)) continue;
        let e = map.get(custId);
        if (!e) { e = { lifetime: 0, orders: 0, lastMs: ms }; map.set(custId, e); }
        e.lifetime += num(r.cur_Subtotal);
        e.orders++;
        if (ms > e.lastMs) e.lastMs = ms;
    }
    setCache(key, map);
    return map;
}

/** Quarter-to-date embroidery, grouped by customer. */
async function loadQuarterEmbroidery(start, end, orderTypes) {
    const key = `qtr:${start}:${end}:${orderTypes.join(',')}`;
    const hit = getCached(key, TTL_LIVE);
    if (hit) return hit;

    const where = `${orderTypeClause(orderTypes)} AND sts_Invoiced=1 `
        + `AND date_OrderInvoiced>='${start}' AND date_OrderInvoiced<='${end}'`;
    const rows = await pullOrders(where, 'PK_ID,ID_Order,id_Customer,CompanyName,date_OrderInvoiced,cur_Subtotal');

    const map = new Map();
    for (const r of rows) {
        const custId = cid(r.id_Customer);
        let e = map.get(custId);
        if (!e) { e = { revenue: 0, orders: 0, company: r.CompanyName || '' }; map.set(custId, e); }
        e.revenue += num(r.cur_Subtotal);
        e.orders++;
        if (!e.company && r.CompanyName) e.company = r.CompanyName;
    }
    setCache(key, map);
    return map;
}

/**
 * Company-wide EMBROIDERY for the quarter — the team kicker basis (Erik, 2026-07-26).
 *
 * Deliberately WIDER than the individual bonus: every account and every person, webstore
 * customers included. The individual bonus excludes online-store accounts, so if the kicker
 * used the same scope it would just re-pay the two reps' own work — company eligible Q3
 * embroidery is $186,214 against their combined baselines of $193,228, i.e. they ARE the
 * eligible embroidery business. Measuring all embroidery keeps it a genuine team goal.
 *
 * Was all-order-types until 2026-07-26; renamed so nobody assumes it is still whole-company
 * revenue. The shared staff-dashboard strip reads this too.
 */
async function loadCompanyEmbroidery(start, end, embTypes) {
    const key = `companyEmb:${start}:${end}:${embTypes.join(',')}`;
    const hit = getCached(key, TTL_LIVE);
    if (hit) return hit;

    const where = `${orderTypeClause(embTypes)} AND sts_Invoiced=1 `
        + `AND date_OrderInvoiced>='${start}' AND date_OrderInvoiced<='${end}'`;
    const rows = await pullOrders(where, 'PK_ID,ID_Order,cur_Subtotal');
    const total = rows.reduce((s, r) => s + num(r.cur_Subtotal), 0);
    const data = { total: round2(total), orders: rows.length };
    setCache(key, data);
    return data;
}

/**
 * Customers that transact through an InkSoft webstore — NOT eligible for this bonus.
 * They already earn the Online Store commission; counting them here double-pays.
 *
 * 🔴 The `Sales_Reps_2026.Inksoft_Store` flag alone is NOT enough. Of the 19 Hops N Drops
 * locations it catches only 11 — Bonney Lake and Lacey are flagged false while ordering
 * through the store monthly. The union with actual type-31 order history catches 19 of 19.
 * Don't try to correct the flag either: Sales_Reps_2026 is re-synced from ShopWorks every
 * 15 minutes and ShopWorks write-back is off the table.
 */
async function loadOnlineStoreCustomers() {
    const key = 'onlineStoreCustomers';
    const hit = getCached(key, TTL_HISTORY);
    if (hit) return hit;

    const rows = await pullOrders(`id_OrderType=31 AND sts_Invoiced=1`, 'PK_ID,ID_Order,id_Customer');
    const set = new Set(rows.map(r => cid(r.id_Customer)));
    setCache(key, set);
    return set;
}

/**
 * Rep → { customerIds:Set, meta:Map<id,{company,tier}> } from Sales_Reps_2026.
 * SOURCE OF TRUTH for ownership. Mirrors getRepCustomerIds() in commission-payouts.js:407
 * but also carries CompanyName/Account_Tier so the dormant call list can render.
 */
async function loadOwnership(reps) {
    const key = `own:${reps.join(',')}`;
    const hit = getCached(key, TTL_LIVE);
    if (hit) return hit;

    const out = {};
    for (const rep of reps) {
        const escaped = rep.replace(/'/g, "''");
        const records = await fetchAllCaspioPages(`/tables/${SALES_REPS_TABLE}/records`, {
            'q.where': `CustomerServiceRep='${escaped}'`,
            'q.select': 'ID_Customer,CompanyName,Account_Tier,Inksoft_Store',
            'q.orderBy': 'PK_ID',
            'q.limit': 1000,
        }, { maxPages: 20 });

        const customerIds = new Set();
        const meta = new Map();
        for (const r of records) {
            const custId = cid(r.ID_Customer);
            customerIds.add(custId);
            meta.set(custId, {
                company: r.CompanyName || '',
                tier: r.Account_Tier || '',
                inksoftStore: String(r.Inksoft_Store).trim().toLowerCase() === 'true',
            });
        }
        out[rep] = { customerIds, meta };
    }
    setCache(key, out);
    return out;
}

// ── Config ──────────────────────────────────────────────────────────────

function coerceBool(v) {
    if (typeof v === 'boolean') return v;
    const s = String(v || '').trim().toLowerCase();
    return s === 'true' || s === 'yes' || s === '1' || s === 'y';
}

function parseIdList(v, fallback) {
    if (v === undefined || v === null || String(v).trim() === '') return fallback;
    const ids = String(v).split(',').map(s => parseInt(String(s).trim(), 10)).filter(Number.isFinite);
    return ids.length ? ids : fallback;
}

/**
 * Load bonus config from Caspio. On ANY failure (table missing, no active rows, network)
 * returns the JS fallback with configSource:'fallback' and a human-readable warning —
 * the dashboard MUST surface that. Never fail silently into a wrong bonus number.
 */
async function loadConfig(quarter, year) {
    const key = `cfg:${quarter}:${year}`;
    const hit = getCached(key, TTL_LIVE);
    if (hit) return hit;

    const range = quarterRange(quarter, year);
    const fallback = () => ({
        ...FALLBACK_CONFIG,
        quarter,
        year,
        dateStart: range.start,
        dateEnd: range.end,
        configSource: 'fallback',
        warning: `Bonus config could not be read from Caspio table ${CONFIG_TABLE}. `
            + 'Showing built-in default rates — these may not match the current plan. '
            + 'Verify before paying.',
    });

    let rows;
    try {
        // Year is filtered in JS, not in the WHERE. Rep_Bonus_Config stores every column as
        // STRING (the house pattern — see scripts/create-rep-bonus-config-table.js), so an
        // unquoted `Year=2026` is a type mismatch while a quoted one would break if the column
        // were ever recreated as a number. Filtering client-side is correct either way, and the
        // result set is a handful of rows.
        rows = await fetchAllCaspioPages(`/tables/${CONFIG_TABLE}/records`, {
            'q.where': `Program='EMB' AND Quarter='${quarter}'`,
            'q.orderBy': 'PK_ID',
            'q.limit': 100,
        }, { maxPages: 5 });
        rows = (rows || []).filter(r => String(r.Year ?? '').trim() === String(year));
    } catch (err) {
        console.error(`[embroidery-bonus] config read FAILED (${CONFIG_TABLE}):`, err.message);
        const cfg = fallback();
        setCache(key, cfg);
        return cfg;
    }

    const active = (rows || []).filter(r => coerceBool(r.Is_Active));
    if (!active.length) {
        console.warn(`[embroidery-bonus] no active ${CONFIG_TABLE} rows for ${quarter} ${year} — using fallback`);
        const cfg = fallback();
        setCache(key, cfg);
        return cfg;
    }

    const first = active[0];
    const cfg = {
        program: 'EMB',
        quarter,
        year,
        dateStart: first.Date_Start || range.start,
        dateEnd: first.Date_End || range.end,
        orderTypeIds: parseIdList(first.Order_Type_Ids, EMB_ORDER_TYPES),
        historyOrderTypeIds: parseIdList(first.History_Order_Type_Ids, EMB_HISTORY_TYPES),
        excludedCustomerIds: parseIdList(first.Excluded_Customer_Ids, FALLBACK_CONFIG.excludedCustomerIds),
        minAccountRevenue: num(first.Min_Account_Revenue) || FALLBACK_CONFIG.minAccountRevenue,
        dormancyMonths: num(first.Dormancy_Months) || FALLBACK_CONFIG.dormancyMonths,
        // FAIL SAFE: only an explicit "No" turns the exclusion off. A missing column, a blank
        // cell or a typo all leave webstore accounts excluded — over-paying silently is the
        // worse failure, and this table is hand-edited.
        excludeOnlineStore: first.Exclude_Online_Store === undefined
            ? true
            : String(first.Exclude_Online_Store).trim().toLowerCase() !== 'no',
        rateStartPct: num(first.Rate_Start_Pct) || FALLBACK_CONFIG.rateStartPct,
        ratePerPoint: num(first.Rate_Per_Point) || FALLBACK_CONFIG.ratePerPoint,
        newAccountBounty: num(first.New_Account_Bounty),
        reactivatedBounty: num(first.Reactivated_Bounty),
        teamKickers: [
            { target: num(first.Team_Kicker1_Target), pay: num(first.Team_Kicker1_Pay) },
            { target: num(first.Team_Kicker2_Target), pay: num(first.Team_Kicker2_Pay) },
        ].filter(k => k.target > 0),
        reps: {},
        configSource: 'caspio',
    };

    for (const r of active) {
        const rep = (r.Rep || '').trim();
        if (!rep) continue;
        const rungs = [1, 2, 3, 4]
            .map(i => ({ pct: num(r[`Rung${i}_Pct`]), pay: num(r[`Rung${i}_Pay`]) }))
            .filter(x => x.pct > 0)
            .sort((a, b) => a.pct - b.pct);
        cfg.reps[rep] = {
            baselineRevenue: num(r.Baseline_Revenue),
            rungs: rungs.length ? rungs : FALLBACK_CONFIG.reps[rep]?.rungs || [],
            notes: r.Notes || '',
        };
    }

    setCache(key, cfg);
    return cfg;
}

// ── Core computation ────────────────────────────────────────────────────

/**
 * Classify one rep's qualifying accounts and compute their bonus.
 *
 * NEW       — no embroidery (21 or 1) invoiced before the quarter opened
 * REACTIVATED — has embroidery history, but none within `dormancyMonths` before quarter open
 * REPEAT    — ordered embroidery within the dormancy window; earns nothing
 */
function classifyRep(repName, cfg, ownership, quarterMap, history, quarter, nowMs, inkCustomers) {
    const own = ownership[repName];
    const repCfg = cfg.reps[repName] || {};
    const startMs = new Date(cfg.dateStart).getTime();
    const dormantCutoff = startMs - (cfg.dormancyMonths * 30.44 * DAY_MS);
    const excluded = new Set((cfg.excludedCustomerIds || []).map(cid));
    const isOnlineStore = makeIsOnlineStore(cfg, own, inkCustomers || new Set());

    const accounts = { new: [], reactivated: [], repeat: [] };
    let quarterRevenue = 0;
    let excludedAccounts = 0;
    let excludedRevenue = 0;

    for (const [custId, q] of quarterMap) {
        if (!own || !own.customerIds.has(custId)) continue;  // ownership is the gate
        if (excluded.has(custId)) continue;
        // Webstore accounts earn the Online Store commission instead — never both. Excluded
        // from the revenue AND from bounty eligibility, not just filtered out of the lists.
        if (isOnlineStore(custId)) { excludedAccounts++; excludedRevenue += q.revenue; continue; }
        quarterRevenue += q.revenue;                        // counts ALL eligible owned embroidery

        if (q.revenue < cfg.minAccountRevenue) continue;    // bounty needs the $ floor

        const h = history.get(custId);
        const meta = own.meta.get(custId) || {};
        const row = {
            idCustomer: custId,
            company: q.company || meta.company || `Customer ${custId}`,
            tier: meta.tier || '',
            revenue: round2(q.revenue),
            orders: q.orders,
            lifetimeEmbroidery: round2(h ? h.lifetime : 0),
            lastEmbroideryDate: h ? new Date(h.lastMs).toISOString().slice(0, 10) : null,
        };

        if (!h) {
            accounts.new.push({ ...row, bounty: cfg.newAccountBounty });
        } else if (h.lastMs < dormantCutoff) {
            accounts.reactivated.push({ ...row, bounty: cfg.reactivatedBounty });
        } else {
            accounts.repeat.push(row);
        }
    }

    const byRevenue = (a, b) => b.revenue - a.revenue;
    accounts.new.sort(byRevenue);
    accounts.reactivated.sort(byRevenue);
    accounts.repeat.sort(byRevenue);

    const bountyTotal = round2(
        accounts.new.length * cfg.newAccountBounty
        + accounts.reactivated.length * cfg.reactivatedBounty
    );

    const baseline = repCfg.baselineRevenue || 0;
    const pctExact = baseline ? (quarterRevenue / baseline) * 100 : 0;

    const ladder = {
        baseline: round2(baseline),
        revenue: round2(quarterRevenue),
        pctOfBaseline: round2(pctExact),
        excludedOnlineStoreAccounts: excludedAccounts,
        excludedOnlineStoreRevenue: round2(excludedRevenue),
    };

    // Continuous rate is the live mechanic; the rung ladder is kept ONLY as a fallback so the
    // whole thing reverts from a single Caspio cell (zero Rate_Per_Point) with no deploy.
    if (cfg.ratePerPoint > 0) {
        // Pro-rata on the UNROUNDED percentage — no cliffs, no dead zones. Between the old
        // rungs a rep earned nothing on extra effort and was better off deferring orders into
        // next quarter; that is exactly what this removes.
        const points = Math.max(0, pctExact - cfg.rateStartPct);
        ladder.rate = {
            startPct: cfg.rateStartPct,
            perPoint: cfg.ratePerPoint,
            pointsEarned: Math.round(points * 100) / 100,
            revenueAtStart: round2(baseline * cfg.rateStartPct / 100),
            payout: round2(points * cfg.ratePerPoint),
        };
        ladder.payout = ladder.rate.payout;
        ladder.rungs = [];
        ladder.rungReached = null;
        ladder.nextRung = null;
        ladder.amountToNextRung = 0;
    } else {
        const rungs = (repCfg.rungs || []).map(r => ({
            pct: r.pct,
            pay: r.pay,
            threshold: round2(baseline * r.pct / 100),
        }));
        let reached = null;
        let next = null;
        for (const r of rungs) {
            if (quarterRevenue >= r.threshold) reached = r;
            else if (!next) next = r;
        }
        ladder.rungs = rungs;
        ladder.rungReached = reached;
        ladder.nextRung = next;
        ladder.amountToNextRung = next ? round2(Math.max(0, next.threshold - quarterRevenue)) : 0;
        ladder.payout = reached ? reached.pay : 0;
    }

    ladder.pace = computePace(quarter, ladder, cfg, nowMs);

    return {
        rep: repName,
        accounts,
        counts: {
            new: accounts.new.length,
            reactivated: accounts.reactivated.length,
            repeat: accounts.repeat.length,
        },
        bounties: {
            newAccountBounty: cfg.newAccountBounty,
            reactivatedBounty: cfg.reactivatedBounty,
            payout: bountyTotal,
        },
        ladder,
    };
}

/**
 * Full bonus computation for a quarter. Exported as `helpers.computeEmbroideryBonus`
 * so commission-payouts.js can call it in-process without an HTTP hop.
 */
async function computeEmbroideryBonus(quarter, year) {
    const cfg = await loadConfig(quarter, year);
    const reps = Object.keys(cfg.reps).length ? Object.keys(cfg.reps) : TRACKED_REPS;

    const [ownership, quarterMap, history, company, inkCustomers] = await Promise.all([
        loadOwnership(reps),
        loadQuarterEmbroidery(cfg.dateStart, cfg.dateEnd, cfg.orderTypeIds),
        loadEmbHistory(cfg.dateStart, cfg.historyOrderTypeIds),
        // Kicker basis is company EMBROIDERY across every account (webstores included) —
        // deliberately a wider scope than the individual bonus. See loadCompanyEmbroidery().
        loadCompanyEmbroidery(cfg.dateStart, cfg.dateEnd, cfg.historyOrderTypeIds),
        loadOnlineStoreCustomers(),
    ]);

    // Team kicker — highest target cleared pays, shared by every tracked rep.
    const kickers = (cfg.teamKickers || []).slice().sort((a, b) => a.target - b.target);
    let kickerReached = null;
    let kickerNext = null;
    for (const k of kickers) {
        if (company.total >= k.target) kickerReached = k;
        else if (!kickerNext) kickerNext = k;
    }
    const teamKicker = {
        companyRevenue: company.total,
        companyOrders: company.orders,
        tiers: kickers,
        reached: kickerReached,
        next: kickerNext,
        amountToNext: kickerNext ? round2(Math.max(0, kickerNext.target - company.total)) : 0,
        payoutEach: kickerReached ? kickerReached.pay : 0,
    };

    const result = {
        program: 'EMB',
        quarter,
        year,
        dateRange: { start: cfg.dateStart, end: cfg.dateEnd },
        configSource: cfg.configSource,
        orderTypeIds: cfg.orderTypeIds,
        historyOrderTypeIds: cfg.historyOrderTypeIds,
        minAccountRevenue: cfg.minAccountRevenue,
        dormancyMonths: cfg.dormancyMonths,
        teamKicker,
        reps: {},
        generatedAt: new Date().toISOString(),
    };
    if (cfg.warning) result.warning = cfg.warning;

    const nowMs = Date.now();
    for (const rep of reps) {
        const r = classifyRep(rep, cfg, ownership, quarterMap, history, quarter, nowMs, inkCustomers);
        r.totalBonus = round2(r.bounties.payout + r.ladder.payout + teamKicker.payoutEach);
        result.reps[rep] = r;
    }

    return result;
}

/**
 * Dormant embroidery accounts — the call list.
 * Accounts the rep owns today, with proven embroidery history, that have not embroidered
 * within `dormancyMonths`. As of 2026-07-01 this is 98 for Nika ($430,164 lifetime) and
 * 280 for Taneisha ($1,209,659) — 378 accounts holding $1,639,823 of lifetime embroidery.
 */
async function computeDormant(quarter, year, repFilter) {
    const cfg = await loadConfig(quarter, year);
    const reps = repFilter
        ? [repFilter]
        : (Object.keys(cfg.reps).length ? Object.keys(cfg.reps) : TRACKED_REPS);

    const [ownership, history, quarterMap, inkCustomers] = await Promise.all([
        loadOwnership(reps),
        loadEmbHistory(cfg.dateStart, cfg.historyOrderTypeIds),
        loadQuarterEmbroidery(cfg.dateStart, cfg.dateEnd, cfg.orderTypeIds),
        loadOnlineStoreCustomers(),
    ]);

    const startMs = new Date(cfg.dateStart).getTime();
    const dormantCutoff = startMs - (cfg.dormancyMonths * 30.44 * DAY_MS);
    const excluded = new Set((cfg.excludedCustomerIds || []).map(cid));

    const out = {};
    for (const rep of reps) {
        const own = ownership[rep];
        const isOnlineStore = makeIsOnlineStore(cfg, own, inkCustomers);
        const list = [];
        if (own) {
            for (const custId of own.customerIds) {
                if (excluded.has(custId)) continue;
                if (isOnlineStore(custId)) continue;   // earns the Online Store commission instead
                const h = history.get(custId);
                if (!h) continue;                       // no embroidery history = not reactivatable
                if (h.lastMs >= dormantCutoff) continue; // ordered recently = not dormant
                const meta = own.meta.get(custId) || {};
                const q = quarterMap.get(custId);
                list.push({
                    idCustomer: custId,
                    company: meta.company || `Customer ${custId}`,
                    tier: meta.tier || '',
                    lifetimeEmbroidery: round2(h.lifetime),
                    embroideryOrders: h.orders,
                    lastEmbroideryDate: new Date(h.lastMs).toISOString().slice(0, 10),
                    monthsDormant: Math.floor((startMs - h.lastMs) / DAY_MS / 30.44),
                    bountyIfWon: cfg.reactivatedBounty,
                    quarterToDateRevenue: q ? round2(q.revenue) : 0,
                    alreadyReactivated: !!q && q.revenue >= cfg.minAccountRevenue,
                });
            }
        }
        // Two views, both wanted:
        //   count            — dormant when the quarter OPENED = the bounty-eligible universe
        //   stillDormantCount— not yet won back = what the rep should actually call today
        list.sort((a, b) => b.lifetimeEmbroidery - a.lifetimeEmbroidery);
        const still = list.filter(a => a.quarterToDateRevenue === 0);
        out[rep] = {
            count: list.length,
            lifetimeEmbroideryTotal: round2(list.reduce((s, x) => s + x.lifetimeEmbroidery, 0)),
            stillDormantCount: still.length,
            stillDormantLifetimeTotal: round2(still.reduce((s, x) => s + x.lifetimeEmbroidery, 0)),
            alreadyReactivatedCount: list.length - still.length,
            accounts: list,
        };
    }

    return {
        quarter,
        year,
        asOf: cfg.dateStart,
        dormancyMonths: cfg.dormancyMonths,
        configSource: cfg.configSource,
        reps: out,
    };
}

/**
 * The target roadmap — three ranked lists per rep answering "who do I call to earn more".
 *
 *   A. Win back      — embroidered before, quiet 12+ months. Ranked by what they're
 *                      actually worth: typical order size × how reliably they used to
 *                      buy × whether Q3 is historically their season × how cold they've gone.
 *   B. First program — buys other decoration from us but has NEVER embroidered. Warm
 *                      relationship, no embroidery yet: the $75 bounty.
 *   C. Almost there  — already embroidering this quarter but under the minimum.
 *
 * 🔴 List C MUST exclude repeat customers. An account that ordered embroidery within the
 * dormancy window earns NOTHING at the threshold, so listing it as "$34 more → $50" is a
 * lie that burns the rep the first time they chase it. Measured on real data: 23 of Nika's
 * 26 under-threshold accounts were repeats — the naive list overstated her available
 * bounties by 5x. Only New and Reactivated qualify.
 */
/**
 * How much of a typical quarter's embroidery has landed by `now`.
 *
 * NOT straight-line on days. Q3 embroidery is strongly back-loaded — measured across
 * 2021-2025, July averages 30% of the quarter, August 37%, September 33%. Straight-line
 * would say 28% elapsed on Jul 26 when only ~25% of the money typically has, which makes
 * a rep look further behind than they are. Getting this wrong is what made a rung that
 * was clearing on trajectory read as unreachable.
 *
 * Other quarters have no measured curve, so they fall back to elapsed days.
 */
const Q3_MONTH_SHARE = { 7: 0.30, 8: 0.37, 9: 0.33 };

function seasonalShareElapsed(quarter, startMs, endMs, nowMs) {
    if (nowMs <= startMs) return 0;
    if (nowMs >= endMs) return 1;
    if (quarter === 'Q3') {
        const d = new Date(nowMs);
        const month = d.getUTCMonth() + 1;
        const dayOfMonth = d.getUTCDate();
        const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), month, 0)).getUTCDate();
        let share = 0;
        for (const m of [7, 8, 9]) {
            if (m < month) share += Q3_MONTH_SHARE[m];
            else if (m === month) share += Q3_MONTH_SHARE[m] * (dayOfMonth / daysInMonth);
        }
        return Math.max(0, Math.min(share, 1));
    }
    return (nowMs - startMs) / (endMs - startMs);
}

/**
 * Pace: what this rep is tracking toward if they carry on as they are. Lets the UI say
 * "on pace to clear this" instead of showing a big raw gap that reads as hopeless early
 * in a quarter.
 */
function computePace(quarter, ladder, cfg, nowMs) {
    const startMs = new Date(cfg.dateStart).getTime();
    const endMs = new Date(cfg.dateEnd + 'T23:59:59').getTime();
    const elapsed = seasonalShareElapsed(quarter, startMs, endMs, nowMs);
    if (elapsed <= 0.02) return null;              // too early to project anything honest

    const projected = round2(ladder.revenue / elapsed);
    const base = {
        asOf: new Date(nowMs).toISOString().slice(0, 10),
        pctOfQuarterElapsed: Math.round(elapsed * 1000) / 10,
        basis: quarter === 'Q3' ? 'seasonal (Jul 30% / Aug 37% / Sep 33%, 2021-25 avg)' : 'elapsed days',
        projectedRevenue: projected,
    };

    // Rate mode: there is no "next rung" to clear, so pace reports the projected finish and
    // what it would pay. Two states only — earning, or not yet at the start line.
    if (ladder.rate) {
        const projectedPct = ladder.baseline ? (projected / ladder.baseline) * 100 : 0;
        const projPoints = Math.max(0, projectedPct - ladder.rate.startPct);
        const startRevenue = ladder.rate.revenueAtStart;
        return {
            ...base,
            projectedPct: round2(projectedPct),
            onPaceForPay: round2(projPoints * ladder.rate.perPoint),
            shortfallToStartAtPace: round2(Math.max(0, startRevenue - projected)),
            status: projPoints > 0 ? 'earning' : 'below-start',
        };
    }

    const rungs = ladder.rungs || [];
    let onPace = null;
    for (const r of rungs) if (projected >= r.threshold) onPace = r;
    const nextAtPace = rungs.find(r => projected < r.threshold) || null;
    const next = ladder.nextRung;
    let status = 'no-rungs';
    if (next) status = projected >= next.threshold ? 'on-pace' : 'behind';
    else if (ladder.rungReached) status = 'topped-out';

    return {
        ...base,
        onPaceForRungPct: onPace ? onPace.pct : null,
        onPaceForPay: onPace ? onPace.pay : 0,
        nextRungAtPacePct: nextAtPace ? nextAtPace.pct : null,
        shortfallToNextAtPace: next ? round2(Math.max(0, next.threshold - projected)) : 0,
        status,
    };
}

/**
 * The one predicate. An account is out of the bonus if EITHER signal fires — see
 * loadOnlineStoreCustomers() for why the flag alone misses 8 of 19 Hops N Drops locations.
 * Used by the ladder revenue, the bounties, the dormant list and all three target lists;
 * if you add a fourth consumer, route it through here too.
 */
function makeIsOnlineStore(cfg, own, inkCustomers) {
    if (cfg.excludeOnlineStore === false) return () => false;
    return (custId) => {
        const meta = own && own.meta.get(custId);
        return !!(meta && meta.inksoftStore) || inkCustomers.has(custId);
    };
}

function median(arr) {
    if (!arr.length) return 0;
    const s = arr.slice().sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function computeTargets(quarter, year, repFilter) {
    const cfg = await loadConfig(quarter, year);
    const reps = repFilter
        ? [repFilter]
        : (Object.keys(cfg.reps).length ? Object.keys(cfg.reps) : TRACKED_REPS);

    const startMs = new Date(cfg.dateStart).getTime();
    const since = new Date(startMs - 548 * DAY_MS).toISOString().slice(0, 10); // ~18 months

    const [ownership, history, quarterMap, otherAct, inkCustomers] = await Promise.all([
        loadOwnership(reps),
        loadEmbHistory(cfg.dateStart, cfg.historyOrderTypeIds),
        loadQuarterEmbroidery(cfg.dateStart, cfg.dateEnd, cfg.orderTypeIds),
        loadOtherActivity(since, cfg.dateStart, cfg.historyOrderTypeIds),
        loadOnlineStoreCustomers(),
    ]);

    const dormantCutoff = startMs - (cfg.dormancyMonths * 30.44 * DAY_MS);
    const excluded = new Set((cfg.excludedCustomerIds || []).map(cid));
    const out = {};

    for (const rep of reps) {
        const own = ownership[rep];
        const isOnlineStore = makeIsOnlineStore(cfg, own, inkCustomers);
        const winBack = [];
        const firstProgram = [];
        const almostThere = [];
        if (!own) { out[rep] = { winBack, firstProgram, almostThere }; continue; }

        for (const custId of own.customerIds) {
            if (excluded.has(custId)) continue;
            // Never suggest a webstore account — chasing one earns nothing on this bonus.
            // This is what wrongly put the whole Hops N Drops chain at the top of Taneisha's
            // "never embroidered" list.
            if (isOnlineStore(custId)) continue;
            const meta = own.meta.get(custId) || {};
            const company = meta.company || `Customer ${custId}`;
            const h = history.get(custId);
            const q = quarterMap.get(custId);
            const qRev = q ? q.revenue : 0;

            // --- C. Almost there: already ordering, under the bar, and WOULD earn ---
            if (qRev > 0 && qRev < cfg.minAccountRevenue) {
                const isNew = !h;
                const isReact = h && h.lastMs < dormantCutoff;
                if (isNew || isReact) {
                    almostThere.push({
                        idCustomer: custId, company, tier: meta.tier || '',
                        quarterRevenue: round2(qRev),
                        gapToBounty: round2(cfg.minAccountRevenue - qRev),
                        category: isNew ? 'New' : 'Reactivated',
                        bounty: isNew ? cfg.newAccountBounty : cfg.reactivatedBounty,
                    });
                }
                continue;
            }
            if (qRev > 0) continue;   // already qualified, or a repeat — nothing to chase

            // --- A. Win back ---
            if (h && h.lastMs < dormantCutoff) {
                const ds = (h.dates || []).slice().sort((a, b) => a - b);
                const gaps = [];
                for (let i = 1; i < ds.length; i++) gaps.push((ds[i] - ds[i - 1]) / DAY_MS);
                const medianGap = Math.round(median(gaps));
                let q3Orders = 0;
                for (const d of ds) { const m = new Date(d).getUTCMonth(); if (m >= 6 && m <= 8) q3Orders++; }
                const q3Share = ds.length ? q3Orders / ds.length : 0;
                const avgOrder = h.orders ? h.lifetime / h.orders : 0;
                const monthsDormant = Math.floor((startMs - h.lastMs) / DAY_MS / 30.44);

                // Score = typical order size, weighted by loyalty, Q3-season fit, and recency.
                const loyalty = Math.min(h.orders / 6, 1);
                const seasonal = 1 + q3Share;
                const recency = monthsDormant <= 24 ? 1 : (monthsDormant <= 36 ? 0.6 : 0.3);
                winBack.push({
                    idCustomer: custId, company, tier: meta.tier || '',
                    lifetimeEmbroidery: round2(h.lifetime), embroideryOrders: h.orders,
                    avgOrderValue: round2(avgOrder), monthsDormant,
                    medianReorderDays: medianGap,
                    q3SharePct: Math.round(q3Share * 100),
                    bounty: cfg.reactivatedBounty,
                    score: round2(avgOrder * loyalty * seasonal * recency),
                });
                continue;
            }

            // --- B. First embroidery program (no embroidery history at all) ---
            if (!h) {
                const o = otherAct.get(custId);
                if (!o) continue;                       // no orders with us = not a warm lead
                const monthsSinceOrder = Math.floor((startMs - o.lastMs) / DAY_MS / 30.44);
                firstProgram.push({
                    idCustomer: custId, company, tier: meta.tier || '',
                    otherSpend: round2(o.lifetime), otherOrders: o.orders,
                    monthsSinceOrder,
                    bounty: cfg.newAccountBounty,
                    score: round2(o.lifetime),
                });
            }
        }

        winBack.sort((a, b) => b.score - a.score);
        firstProgram.sort((a, b) => b.score - a.score);
        almostThere.sort((a, b) => a.gapToBounty - b.gapToBounty);

        out[rep] = {
            winBack, firstProgram, almostThere,
            summary: {
                winBackCount: winBack.length,
                winBackLifetime: round2(winBack.reduce((s, x) => s + x.lifetimeEmbroidery, 0)),
                firstProgramCount: firstProgram.length,
                firstProgramSpend: round2(firstProgram.reduce((s, x) => s + x.otherSpend, 0)),
                almostThereCount: almostThere.length,
                almostThereGap: round2(almostThere.reduce((s, x) => s + x.gapToBounty, 0)),
                almostThereBounty: round2(almostThere.reduce((s, x) => s + x.bounty, 0)),
            },
        };
    }

    return {
        quarter, year, asOf: cfg.dateStart,
        minAccountRevenue: cfg.minAccountRevenue,
        dormancyMonths: cfg.dormancyMonths,
        configSource: cfg.configSource,
        reps: out,
    };
}

// ── Routes ──────────────────────────────────────────────────────────────

/** GET /api/embroidery-bonus/config?quarter&year */
router.get('/embroidery-bonus/config', async (req, res) => {
    const quarter = (req.query.quarter || currentQuarter()).toUpperCase();
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    try {
        const cfg = await loadConfig(quarter, year);
        res.json({ success: true, config: cfg });
    } catch (err) {
        console.error('[embroidery-bonus] config error:', err.message);
        res.status(500).json({ success: false, error: 'Failed to load embroidery bonus config', details: err.message });
    }
});

/** GET /api/embroidery-bonus/targets?quarter&year&email|rep — the "who to call" roadmap. */
router.get('/embroidery-bonus/targets', async (req, res) => {
    const quarter = (req.query.quarter || currentQuarter()).toUpperCase();
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const rep = resolveRep(req.query);
    try {
        const data = await computeTargets(quarter, year, rep);
        res.json({ success: true, ...data });
    } catch (err) {
        console.error('[embroidery-bonus] targets error:', err.message);
        res.status(500).json({ success: false, error: 'Failed to build target roadmap', details: err.message });
    }
});

/** GET /api/embroidery-bonus/dormant?quarter&year&email|rep — email wins (see resolveRep). */
router.get('/embroidery-bonus/dormant', async (req, res) => {
    const quarter = (req.query.quarter || currentQuarter()).toUpperCase();
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const rep = resolveRep(req.query);
    try {
        const data = await computeDormant(quarter, year, rep);
        res.json({ success: true, ...data });
    } catch (err) {
        console.error('[embroidery-bonus] dormant error:', err.message);
        res.status(500).json({ success: false, error: 'Failed to build dormant account list', details: err.message });
    }
});

/**
 * POST /api/embroidery-bonus/archive?quarter&year
 * Freezes the quarter's qualifying accounts into EmbroideryBonusArchive.
 * Idempotent: existing rows for (Program, Quarter, Year) are deleted first.
 */
router.post('/embroidery-bonus/archive', express.json(), async (req, res) => {
    const quarter = (req.query.quarter || req.body?.quarter || currentQuarter()).toUpperCase();
    const year = parseInt(req.query.year || req.body?.year, 10) || new Date().getFullYear();

    try {
        const data = await computeEmbroideryBonus(quarter, year);

        // Idempotency: clear this quarter's rows before rewriting.
        let deleted = 0;
        try {
            const del = await makeCaspioRequest(
                'delete',
                `/tables/${ARCHIVE_TABLE}/records`,
                { 'q.where': `Program='EMB' AND Quarter='${quarter}' AND Year=${year}` }
            );
            deleted = del?.RecordsAffected ?? 0;
        } catch (e) {
            console.warn('[embroidery-bonus] archive pre-delete skipped:', e.message);
        }

        const archivedAt = new Date().toISOString();
        let written = 0;
        const errors = [];

        for (const [rep, r] of Object.entries(data.reps)) {
            const rows = [
                ...r.accounts.new.map(a => ({ ...a, Category: 'New' })),
                ...r.accounts.reactivated.map(a => ({ ...a, Category: 'Reactivated' })),
            ];
            for (const a of rows) {
                try {
                    await makeCaspioRequest('post', `/tables/${ARCHIVE_TABLE}/records`, {}, {
                        Program: 'EMB',
                        Quarter: quarter,
                        Year: year,
                        Rep: rep,
                        Category: a.Category,
                        id_Customer: a.idCustomer,
                        CompanyName: a.company,
                        Revenue: a.revenue,
                        BonusAmount: a.bounty,
                        ArchivedAt: archivedAt,
                    });
                    written++;
                } catch (e) {
                    errors.push(`${rep}/${a.company}: ${e.message}`);
                }
            }
        }

        clearCache();
        res.json({
            success: errors.length === 0,
            quarter, year,
            deleted, written,
            errors: errors.length ? errors : undefined,
        });
    } catch (err) {
        console.error('[embroidery-bonus] archive error:', err.message);
        res.status(500).json({ success: false, error: 'Failed to archive embroidery bonus', details: err.message });
    }
});

/**
 * GET /api/embroidery-bonus?quarter&year&scope&email|rep
 * Must stay AFTER the more specific routes above.
 *
 * 🔒 Bonus dollars are compensation. Three scopes, narrowest wins:
 *   scope=team   → team kicker + company revenue ONLY, `reps` is always {}. Safe for the
 *                  shared staff dashboard, which every employee opens. The endpoint
 *                  physically cannot return a rep's earnings in this mode.
 *   email=/rep=  → that one rep. Mission Control passes the SAML-verified email, so a rep
 *                  can never receive a colleague's figures.
 *   (neither)    → every tracked rep. Admin-only by way of the frontend forwarder.
 */
router.get('/embroidery-bonus', async (req, res) => {
    const quarter = (req.query.quarter || currentQuarter()).toUpperCase();
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const teamOnly = String(req.query.scope || '').toLowerCase() === 'team';
    const only = teamOnly ? null : resolveRep(req.query);
    try {
        const data = await computeEmbroideryBonus(quarter, year);
        if (teamOnly) {
            data.reps = {};
            data.scope = 'team';
        } else if (only) {
            data.reps = data.reps[only] ? { [only]: data.reps[only] } : {};
            data.scope = 'rep';
        } else {
            data.scope = 'all';
        }
        res.json({ success: true, ...data });
    } catch (err) {
        console.error('[embroidery-bonus] compute error:', err.message);
        res.status(500).json({ success: false, error: 'Failed to compute embroidery bonus', details: err.message });
    }
});

module.exports = router;
module.exports.helpers = {
    computeEmbroideryBonus,
    computeDormant,
    computeTargets,
    loadConfig,
    FALLBACK_CONFIG,
};
