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
    newAccountBounty: 75,
    reactivatedBounty: 50,
    teamKickers: [
        { target: 700000, pay: 250 },       // 2022 Q3 did $704,258
        { target: 740000, pay: 500 },       // $740,949 = the flat-Q4 $3M requirement
    ],
    reps: {
        'Nika Lao': {
            baselineRevenue: 235000,
            rungs: [
                { pct: 85, pay: 150 },
                { pct: 100, pay: 400 },
                { pct: 115, pay: 700 },
                { pct: 130, pay: 1200 },
            ],
        },
        'Taneisha Clark': {
            baselineRevenue: 100000,
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
    const rows = await fetchAllCaspioPages(`/tables/${ORDER_ODBC_TABLE}/records`, {
        'q.where': where,
        'q.select': select,
        'q.orderBy': 'PK_ID',
        'q.limit': 1000,
    }, { maxPages, totalTimeout: 180000 });

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
        if (!e) { e = { firstMs: ms, lastMs: ms, lifetime: 0, orders: 0 }; map.set(custId, e); }
        if (ms < e.firstMs) e.firstMs = ms;
        if (ms > e.lastMs) e.lastMs = ms;
        e.lifetime += num(r.cur_Subtotal);
        e.orders++;
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

/** Company-wide invoiced subtotal for the quarter, ALL order types — the team kicker basis. */
async function loadCompanyTotal(start, end) {
    const key = `company:${start}:${end}`;
    const hit = getCached(key, TTL_LIVE);
    if (hit) return hit;

    const where = `sts_Invoiced=1 AND date_OrderInvoiced>='${start}' AND date_OrderInvoiced<='${end}'`;
    const rows = await pullOrders(where, 'PK_ID,ID_Order,cur_Subtotal');
    const total = rows.reduce((s, r) => s + num(r.cur_Subtotal), 0);
    const data = { total: round2(total), orders: rows.length };
    setCache(key, data);
    return data;
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
            'q.select': 'ID_Customer,CompanyName,Account_Tier',
            'q.orderBy': 'PK_ID',
            'q.limit': 1000,
        }, { maxPages: 20 });

        const customerIds = new Set();
        const meta = new Map();
        for (const r of records) {
            const custId = cid(r.ID_Customer);
            customerIds.add(custId);
            meta.set(custId, { company: r.CompanyName || '', tier: r.Account_Tier || '' });
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
function classifyRep(repName, cfg, ownership, quarterMap, history) {
    const own = ownership[repName];
    const repCfg = cfg.reps[repName] || {};
    const startMs = new Date(cfg.dateStart).getTime();
    const dormantCutoff = startMs - (cfg.dormancyMonths * 30.44 * DAY_MS);
    const excluded = new Set((cfg.excludedCustomerIds || []).map(cid));

    const accounts = { new: [], reactivated: [], repeat: [] };
    let quarterRevenue = 0;

    for (const [custId, q] of quarterMap) {
        if (!own || !own.customerIds.has(custId)) continue;  // ownership is the gate
        if (excluded.has(custId)) continue;
        quarterRevenue += q.revenue;                        // ladder counts ALL owned embroidery

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

    // Ladder — only the highest rung reached pays.
    const baseline = repCfg.baselineRevenue || 0;
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

    const ladder = {
        baseline: round2(baseline),
        revenue: round2(quarterRevenue),
        pctOfBaseline: baseline ? round2(quarterRevenue / baseline * 100) : 0,
        rungs,
        rungReached: reached,
        nextRung: next,
        amountToNextRung: next ? round2(Math.max(0, next.threshold - quarterRevenue)) : 0,
        payout: reached ? reached.pay : 0,
    };

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

    const [ownership, quarterMap, history, company] = await Promise.all([
        loadOwnership(reps),
        loadQuarterEmbroidery(cfg.dateStart, cfg.dateEnd, cfg.orderTypeIds),
        loadEmbHistory(cfg.dateStart, cfg.historyOrderTypeIds),
        loadCompanyTotal(cfg.dateStart, cfg.dateEnd),
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

    for (const rep of reps) {
        const r = classifyRep(rep, cfg, ownership, quarterMap, history);
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

    const [ownership, history, quarterMap] = await Promise.all([
        loadOwnership(reps),
        loadEmbHistory(cfg.dateStart, cfg.historyOrderTypeIds),
        loadQuarterEmbroidery(cfg.dateStart, cfg.dateEnd, cfg.orderTypeIds),
    ]);

    const startMs = new Date(cfg.dateStart).getTime();
    const dormantCutoff = startMs - (cfg.dormancyMonths * 30.44 * DAY_MS);
    const excluded = new Set((cfg.excludedCustomerIds || []).map(cid));

    const out = {};
    for (const rep of reps) {
        const own = ownership[rep];
        const list = [];
        if (own) {
            for (const custId of own.customerIds) {
                if (excluded.has(custId)) continue;
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
    loadConfig,
    FALLBACK_CONFIG,
};
