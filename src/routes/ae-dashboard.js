// ae-dashboard.js — AE Mission Control aggregate feed.
//
//   GET /api/ae-dashboard/summary?email=<rep email>[&refresh=1]
//
// ONE call returns everything the per-AE cockpit renders: KPI strip, action
// queue (overdue/untouched leads, stale quotes, art awaiting approval, kits
// not yet shipped), and the four work panels (leads / quotes / art / orders).
// Secret-gated at the server.js mount — browsers reach it through the main
// app's session-gated /api/crm-proxy/ae-dashboard/summary forwarder, which
// derives `email` from the verified SAML session (admin may ?viewAs=).
//
// Sources fan out via Promise.allSettled — a failed source lands in
// `errors.<key>` and its panel is null, so the page shows a visible per-panel
// error instead of blanking the whole cockpit (CLAUDE.md rule: never silent).
//
// Caspio budget: ~7 reads per cache miss, 3-minute in-memory TTL per rep.
// Two AEs refreshing all day ≈ single-digit thousands of calls/month.
'use strict';

const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages } = require('../utils/caspio');
const { buildDigestModel, todayPT, TERMINAL_STATUSES } = require('../utils/lead-followup-digest');

// Email → display names. Full names match Sales_Reps_2026.CustomerServiceRep /
// NW_Daily_Sales_By_Rep.RepName / Form_Submissions.Sales_Rep ("Taneisha Clark",
// verified live 2026-07-19); first names match ArtRequests.Sales_Rep.
// KEEP IN SYNC with the frontend map in dashboards/js/leads-common.js
// (EMAIL_TO_REP). NOTE: do NOT source full names from
// config/manageorders-emb-config.js SALES_REP_MAP — its ShopWorks-push variant
// spells Taneisha "Jones", which matches nothing in the CRM tables.
const AE_REGISTRY = {
    'taneisha@nwcustomapparel.com': { fullName: 'Taneisha Clark', firstName: 'Taneisha' },
    'nika@nwcustomapparel.com': { fullName: 'Nika Lao', firstName: 'Nika' },
    'erik@nwcustomapparel.com': { fullName: 'Erik Mickelson', firstName: 'Erik' },
};

const LEAD_FORM_IDS = ['jotform-lead', 'quote-request', 'webstore-request', 'team-roster', 'manual-lead'];
// Quote_Sessions statuses that mean "no follow-up needed". Anything else
// (Open, active, pending, sample-*, …) counts as open pipeline.
const QUOTE_CLOSED = new Set(['completed', 'abandoned', 'expired', 'converted', 'cancelled']);
const ART_CLOSED = new Set(['completed', 'cancelled', 'declined']);
const STALE_QUOTE_DAYS = 5;
const PANEL_LIMIT = 6;
const QUEUE_LIMIT = 10;

// ── cache ────────────────────────────────────────────────────────────────
const CACHE_TTL_MS = 3 * 60 * 1000;
const REFRESH_MIN_INTERVAL_MS = 30 * 1000;
const cache = new Map(); // email → { data, fetchedAt, lastForcedAt }

// ── date helpers ─────────────────────────────────────────────────────────
function isoDaysAgo(days) {
    const d = new Date(Date.now() - days * 86400000);
    return d.toISOString().slice(0, 10);
}

function escWhere(v) {
    return String(v == null ? '' : v).replace(/'/g, "''");
}

function num(v) { return parseFloat(v) || 0; }

// ── per-source fetchers (each = one Caspio read) ─────────────────────────

async function fetchLeads(rep) {
    // No Caspio date filter (datetime syntax is fragile — digest precedent);
    // rep filter keeps the row count small, JS does the windowing.
    const rows = await fetchAllCaspioPages('/tables/Form_Submissions/records', {
        'q.where': `Form_ID IN ('${LEAD_FORM_IDS.join("','")}') AND Status<>'Archived' AND Sales_Rep='${escWhere(rep.fullName)}'`,
        'q.select': 'Submission_ID,Form_ID,Company,Contact_Name,Email,Phone,Status,Due_Date,Lead_Value,Submitted_At,Sales_Rep',
        'q.pageSize': 1000,
        'q.orderBy': 'PK_ID',
    }, { maxPages: 2 });

    const model = buildDigestModel(rows, todayPT());
    const ninetyDaysMs = Date.now() - 90 * 86400000;
    let won90 = 0, lost90 = 0;
    const active = [];
    for (const row of rows) {
        const submittedMs = Date.parse(String(row.Submitted_At || ''));
        const recent = !isNaN(submittedMs) && submittedMs >= ninetyDaysMs;
        if (recent && row.Status === 'Won') won90++;
        if (recent && row.Status === 'Lost') lost90++;
        if (!TERMINAL_STATUSES.includes(row.Status)) active.push(row);
    }
    active.sort((a, b) => String(b.Submitted_At).localeCompare(String(a.Submitted_At)));

    const slim = (r) => ({
        submissionId: r.Submission_ID, formId: r.Form_ID, company: r.Company,
        contactName: r.Contact_Name, email: r.Email, phone: r.Phone,
        status: r.Status, dueDate: r.Due_Date, leadValue: num(r.Lead_Value),
        submittedAt: r.Submitted_At, daysOverdue: r.daysOverdue,
    });

    return {
        queue: {
            overdueLeads: model.overdue.slice(0, QUEUE_LIMIT).map(slim),
            dueTodayLeads: model.dueToday.slice(0, QUEUE_LIMIT).map(slim),
            newUntouchedLeads: model.newUntouched.slice(0, QUEUE_LIMIT).map(slim),
        },
        counts: {
            overdue: model.overdue.length,
            dueToday: model.dueToday.length,
            newUntouched: model.newUntouched.length,
            activeLeads: active.length,
        },
        winRate: { won90, lost90, rate: (won90 + lost90) ? Math.round((won90 / (won90 + lost90)) * 100) : null },
        panel: active.slice(0, PANEL_LIMIT).map(slim),
    };
}

async function fetchQuotes(rep) {
    const rows = await fetchAllCaspioPages('/tables/Quote_Sessions/records', {
        'q.where': `SalesRepEmail='${escWhere(rep.email)}' AND CreatedAt>'${isoDaysAgo(90)}'`,
        'q.select': 'PK_ID,QuoteID,CustomerName,CompanyName,CustomerEmail,TotalQuantity,TotalAmount,Status,CreatedAt,UpdatedAt,PushedToShopWorks',
        'q.pageSize': 500,
        'q.orderBy': 'PK_ID DESC',
    }, { maxPages: 2 });

    const now = Date.now();
    const open = [], stale = [];
    let openValue = 0;
    for (const q of rows) {
        const isClosed = QUOTE_CLOSED.has(String(q.Status || '').toLowerCase()) || q.PushedToShopWorks;
        if (isClosed) continue;
        open.push(q);
        openValue += num(q.TotalAmount);
        const touchedMs = Date.parse(String(q.UpdatedAt || q.CreatedAt || ''));
        if (!isNaN(touchedMs) && (now - touchedMs) / 86400000 >= STALE_QUOTE_DAYS) stale.push(q);
    }
    const slim = (q) => ({
        quoteId: q.QuoteID, customerName: q.CustomerName, companyName: q.CompanyName,
        customerEmail: q.CustomerEmail, totalAmount: num(q.TotalAmount), status: q.Status,
        createdAt: q.CreatedAt, updatedAt: q.UpdatedAt,
    });
    stale.sort((a, b) => String(a.UpdatedAt || a.CreatedAt).localeCompare(String(b.UpdatedAt || b.CreatedAt)));

    return {
        queue: { staleQuotes: stale.slice(0, QUEUE_LIMIT).map(slim) },
        counts: { openQuotes: open.length, staleQuotes: stale.length },
        openQuoteValue: Math.round(openValue * 100) / 100,
        panel: rows.slice(0, PANEL_LIMIT).map(slim),
    };
}

async function fetchArt(rep) {
    // ArtRequests.Sales_Rep is free-text: RECENT rows carry the full name
    // ("Taneisha Clark", verified live 2026-07-19); older rows carry the bare
    // first name ("Taneisha" — the rep-email-map.js convention). Match both.
    const rows = await fetchAllCaspioPages('/tables/ArtRequests/records', {
        'q.where': `(Sales_Rep='${escWhere(rep.fullName)}' OR Sales_Rep='${escWhere(rep.firstName)}') AND Date_Created>='${isoDaysAgo(90)}'`,
        'q.select': 'PK_ID,ID_Design,CompanyName,Status,Due_Date,Date_Created',
        'q.pageSize': 500,
        'q.orderBy': 'PK_ID DESC',
    }, { maxPages: 2 });

    const slim = (r) => ({
        idDesign: r.ID_Design, companyName: r.CompanyName, status: r.Status,
        dueDate: r.Due_Date, dateCreated: r.Date_Created,
    });
    const awaiting = rows.filter((r) => String(r.Status || '').toLowerCase() === 'awaiting approval');
    const openRows = rows.filter((r) => !ART_CLOSED.has(String(r.Status || '').toLowerCase()));

    return {
        queue: { artAwaitingApproval: awaiting.slice(0, QUEUE_LIMIT).map(slim) },
        counts: { awaitingApproval: awaiting.length, openArt: openRows.length },
        panel: openRows.slice(0, PANEL_LIMIT).map(slim),
    };
}

async function fetchOrders(rep) {
    const rows = await fetchAllCaspioPages('/tables/ORDER_ODBC/records', {
        'q.where': `CustomerServiceRep='${escWhere(rep.fullName)}' AND date_OrderInvoiced>='${isoDaysAgo(30)}'`,
        'q.select': 'ID_Order,CompanyName,cur_Subtotal,date_OrderInvoiced,sts_Invoiced,sts_Shipped,ORDER_TYPE',
        'q.pageSize': 500,
        'q.orderBy': 'ID_Order DESC',
    }, { maxPages: 2 });

    // ORDER_ODBC repeats an order row per design block — collapse by ID_Order
    // (same dedup the order-dashboard rollup does).
    const seen = new Map();
    for (const r of rows) {
        if (!seen.has(r.ID_Order)) seen.set(r.ID_Order, r);
    }
    const orders = [...seen.values()];
    orders.sort((a, b) => String(b.date_OrderInvoiced || '').localeCompare(String(a.date_OrderInvoiced || '')));
    const total30 = orders.reduce((sum, o) => sum + num(o.cur_Subtotal), 0);

    return {
        counts: { orders30: orders.length },
        total30: Math.round(total30 * 100) / 100,
        panel: orders.slice(0, PANEL_LIMIT).map((o) => ({
            idOrder: o.ID_Order, companyName: o.CompanyName, subtotal: num(o.cur_Subtotal),
            invoicedDate: o.date_OrderInvoiced, shipped: o.sts_Shipped === 1, orderType: o.ORDER_TYPE,
        })),
    };
}

async function fetchSales(rep) {
    const year = new Date().getFullYear();
    const rows = await fetchAllCaspioPages('/tables/NW_Daily_Sales_By_Rep/records', {
        'q.where': `RepName='${escWhere(rep.fullName)}' AND SalesDate>='${year}-01-01'`,
        'q.select': 'SalesDate,Revenue,OrderCount',
        'q.pageSize': 500,
        'q.orderBy': 'SalesDate DESC',
    }, { maxPages: 2 });

    const monthPrefix = new Date().toISOString().slice(0, 7); // YYYY-MM
    let ytd = 0, mtd = 0, ytdOrders = 0, lastArchivedDate = null;
    for (const r of rows) {
        const day = String(r.SalesDate || '').slice(0, 10);
        const rev = num(r.Revenue);
        ytd += rev;
        ytdOrders += parseInt(r.OrderCount, 10) || 0;
        if (day.startsWith(monthPrefix)) mtd += rev;
        if (!lastArchivedDate) lastArchivedDate = day; // rows are DESC
    }
    return {
        ytdSales: Math.round(ytd * 100) / 100,
        mtdSales: Math.round(mtd * 100) / 100,
        ytdOrders,
        lastArchivedDate,
    };
}

// Bonus & commission — read straight from Commission_Payouts, the PAYROLL
// system of record (the daily sync-commissions cron keeps the current
// quarter's rows fresh; Approved/Paid rows are locked snapshots of what was
// actually paid). One cheap Caspio read covers all three components (Online
// Store + Garment Spiff + Win-Back Bounty) with status + paycheck metadata —
// no need to recompute a quarter of InkSoft orders per dashboard load.
async function fetchPayouts(rep) {
    const year = new Date().getFullYear();
    const rows = await fetchAllCaspioPages('/tables/Commission_Payouts/records', {
        'q.where': `Year=${year} AND Rep='${escWhere(rep.fullName)}'`,
        'q.select': 'Commission_Type,Quarter,Year,Revenue_Base,Rate_Applied,Calculated_Amount,Bonus_Tier,Status,Paid_Date,Paycheck_Date,Payroll_Number,Last_Calculated',
        'q.pageSize': 200,
        'q.orderBy': 'PK_ID',
    }, { maxPages: 1 });

    const qIdx = Math.floor(new Date().getMonth() / 3); // 0-based quarter index
    const currentQuarter = 'Q' + (qIdx + 1);
    const previousQuarter = qIdx === 0 ? null : 'Q' + qIdx;
    const slim = (r) => ({
        type: r.Commission_Type, quarter: r.Quarter, amount: num(r.Calculated_Amount),
        base: num(r.Revenue_Base), rate: num(r.Rate_Applied), status: r.Status,
        paidDate: r.Paid_Date, paycheckDate: r.Paycheck_Date, payrollNumber: r.Payroll_Number,
        lastCalculated: r.Last_Calculated,
    });
    const sum = (list) => Math.round(list.reduce((s, x) => s + x.amount, 0) * 100) / 100;

    const current = rows.filter((r) => r.Quarter === currentQuarter).map(slim);
    const previous = previousQuarter ? rows.filter((r) => r.Quarter === previousQuarter).map(slim) : [];
    return {
        year,
        currentQuarter,
        previousQuarter,
        current: { rows: current, total: sum(current) },
        previous: {
            rows: previous,
            total: sum(previous),
            allPaid: previous.length > 0 && previous.every((r) => r.status === 'Paid'),
        },
        paidYtd: sum(rows.filter((r) => r.Status === 'Paid').map(slim)), // raw rows — Caspio field is capital-S Status
    };
}

async function fetchKits(rep) {
    const rows = await fetchAllCaspioPages('/tables/Marketing_Shipments/records', {
        'q.where': "(Status='Requested' OR Status='Packed')",
        'q.select': 'Shipment_ID,Submission_ID,Requested_By,Sales_Rep,Recipient_Name,Company,Status,Created_At',
        'q.pageSize': 500,
        'q.orderBy': 'PK_ID DESC',
    }, { maxPages: 1 });

    // Rep match is post-fetch (the queue is small): Sales_Rep holds a name
    // (full or first, free-text) and Requested_By holds the session email.
    const mine = rows.filter((r) => {
        const sr = String(r.Sales_Rep || '').trim().toLowerCase();
        const rb = String(r.Requested_By || '').trim().toLowerCase();
        return rb === rep.email
            || sr === rep.fullName.toLowerCase()
            || sr === rep.firstName.toLowerCase();
    });
    return {
        counts: { kitsPending: mine.length },
        queue: {
            kitsPending: mine.slice(0, QUEUE_LIMIT).map((r) => ({
                shipmentId: r.Shipment_ID, submissionId: r.Submission_ID,
                recipientName: r.Recipient_Name, company: r.Company,
                status: r.Status, createdAt: r.Created_At,
            })),
        },
    };
}

// ── assemble ─────────────────────────────────────────────────────────────

async function buildSummary(rep) {
    const sources = {
        leads: fetchLeads(rep),
        quotes: fetchQuotes(rep),
        art: fetchArt(rep),
        orders: fetchOrders(rep),
        sales: fetchSales(rep),
        payouts: fetchPayouts(rep),
        kits: fetchKits(rep),
    };
    const keys = Object.keys(sources);
    const settled = await Promise.allSettled(keys.map((k) => sources[k]));

    const out = {};
    const errors = {};
    keys.forEach((k, i) => {
        if (settled[i].status === 'fulfilled') out[k] = settled[i].value;
        else {
            errors[k] = settled[i].reason && settled[i].reason.message || 'lookup failed';
            console.error(`[ae-dashboard] ${rep.email} source '${k}' failed:`, errors[k]);
            out[k] = null;
        }
    });

    return {
        rep: { email: rep.email, fullName: rep.fullName, firstName: rep.firstName },
        generatedAt: new Date().toISOString(),
        kpis: {
            ytdSales: out.sales ? out.sales.ytdSales : null,
            mtdSales: out.sales ? out.sales.mtdSales : null,
            salesAsOf: out.sales ? out.sales.lastArchivedDate : null,
            openQuoteCount: out.quotes ? out.quotes.counts.openQuotes : null,
            openQuoteValue: out.quotes ? out.quotes.openQuoteValue : null,
            commissionQtd: out.payouts ? out.payouts.current.total : null,
            commissionQuarter: out.payouts ? `${out.payouts.currentQuarter} ${out.payouts.year}` : null,
            leadWinRate: out.leads ? out.leads.winRate.rate : null,
            leadsWon90: out.leads ? out.leads.winRate.won90 : null,
        },
        bonus: out.payouts,
        actionQueue: {
            overdueLeads: out.leads ? out.leads.queue.overdueLeads : null,
            dueTodayLeads: out.leads ? out.leads.queue.dueTodayLeads : null,
            newUntouchedLeads: out.leads ? out.leads.queue.newUntouchedLeads : null,
            staleQuotes: out.quotes ? out.quotes.queue.staleQuotes : null,
            artAwaitingApproval: out.art ? out.art.queue.artAwaitingApproval : null,
            kitsPending: out.kits ? out.kits.queue.kitsPending : null,
        },
        counts: {
            leads: out.leads ? out.leads.counts : null,
            quotes: out.quotes ? out.quotes.counts : null,
            art: out.art ? out.art.counts : null,
            orders: out.orders ? out.orders.counts : null,
            kits: out.kits ? out.kits.counts : null,
        },
        panels: {
            leads: out.leads ? out.leads.panel : null,
            quotes: out.quotes ? out.quotes.panel : null,
            art: out.art ? out.art.panel : null,
            orders: out.orders ? out.orders.panel : null,
        },
        orders30Total: out.orders ? out.orders.total30 : null,
        errors: Object.keys(errors).length ? errors : undefined,
    };
}

// ── Growth radar ("Money on the Table") ──────────────────────────────────
// Mines the rep's OWN order history (ORDER_ODBC, 24 months) for revenue that
// is statistically missing right now — two signals reps don't naturally see:
//   1. RHYTHM BREAK — the account has a measurable reorder cadence (median gap
//      between its own orders) and is now ≥1.6× past it. "Cintas orders every
//      6 weeks; it's been 13." Est. $ = its own average order value.
//   2. SEASON AHEAD — in the SAME upcoming 45-day window LAST year the account
//      spent real money (uniforms for the fair, hoodies for the crew). Est. $
//      = last year's spend in that window.
// Ranked by estimated $. This is deliberately per-account-relative math — a
// $400 account that's quiet 3× its own cadence outranks a whale that's right
// on schedule.
//
// Attribution note: orders are pulled by ORDER_ODBC.CustomerServiceRep (the
// order-time snapshot). A recently-reassigned account's OLD orders keep the
// old rep, so its cadence may be invisible for a while — acceptable for a
// radar (the summary's panels use current ownership; this is a lead list,
// not payroll).
const GROWTH_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — cadence moves daily, not hourly
const growthCache = new Map(); // email → { data, fetchedAt }
const GROWTH_LIMIT = 12;

function median(nums) {
    if (!nums.length) return 0;
    const s = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

async function buildGrowthRadar(rep) {
    const rows = await fetchAllCaspioPages('/tables/ORDER_ODBC/records', {
        'q.where': `CustomerServiceRep='${escWhere(rep.fullName)}' AND date_OrderInvoiced>='${isoDaysAgo(730)}'`,
        'q.select': 'ID_Order,id_Customer,CompanyName,date_OrderInvoiced,cur_Subtotal',
        'q.pageSize': 1000,
        'q.orderBy': 'PK_ID',
    }, { maxPages: 12 });

    // ORDER_ODBC repeats an order row per design block — dedupe by ID_Order.
    const orders = new Map();
    for (const r of rows) {
        if (!orders.has(r.ID_Order)) orders.set(r.ID_Order, r);
    }

    // Group per customer
    const byCust = new Map();
    for (const o of orders.values()) {
        const key = String(o.id_Customer || '');
        if (!key) continue;
        if (!byCust.has(key)) byCust.set(key, { company: o.CompanyName, orders: [] });
        const g = byCust.get(key);
        if (o.CompanyName) g.company = o.CompanyName;
        const day = String(o.date_OrderInvoiced || '').slice(0, 10);
        const amt = num(o.cur_Subtotal);
        if (day) g.orders.push({ day, amt });
    }

    const now = Date.now();
    const todayMs = now;
    const upcomingStartLY = new Date(now); upcomingStartLY.setFullYear(upcomingStartLY.getFullYear() - 1);
    const upcomingEndLY = new Date(upcomingStartLY.getTime() + 45 * 86400000);
    const lyStart = upcomingStartLY.toISOString().slice(0, 10);
    const lyEnd = upcomingEndLY.toISOString().slice(0, 10);

    const findings = [];
    for (const [custId, g] of byCust) {
        g.orders.sort((a, b) => a.day.localeCompare(b.day));
        const dates = g.orders.map((o) => Date.parse(o.day + 'T12:00:00Z'));
        const lastMs = dates[dates.length - 1];
        const daysSince = Math.round((todayMs - lastMs) / 86400000);
        const gaps = [];
        for (let i = 1; i < dates.length; i++) {
            const gap = Math.round((dates[i] - dates[i - 1]) / 86400000);
            if (gap > 0) gaps.push(gap); // same-day reorders don't define cadence
        }
        const medianGap = Math.round(median(gaps));
        const totalSpend = g.orders.reduce((s, o) => s + o.amt, 0);
        const avgOrder = g.orders.length ? Math.round((totalSpend / g.orders.length) * 100) / 100 : 0;
        const lyUpcoming = Math.round(g.orders
            .filter((o) => o.day >= lyStart && o.day <= lyEnd)
            .reduce((s, o) => s + o.amt, 0) * 100) / 100;

        const reasons = [];
        let estValue = 0;
        // Rhythm break: enough history to trust the cadence, cadence is a real
        // repeat pattern (10-120d), and they're well past it.
        if (gaps.length >= 3 && medianGap >= 10 && medianGap <= 120 && daysSince >= Math.round(medianGap * 1.6)) {
            reasons.push({
                type: 'rhythm',
                text: `usually orders every ~${medianGap} days — quiet for ${daysSince}`,
            });
            estValue = Math.max(estValue, avgOrder);
        }
        // Season ahead: real money in the same upcoming window last year, and
        // they haven't ordered recently (a fresh order likely IS the seasonal buy).
        if (lyUpcoming >= 400 && daysSince > 30) {
            reasons.push({
                type: 'season',
                text: `spent ${'$' + Math.round(lyUpcoming).toLocaleString('en-US')} in the next 45 days LAST year`,
            });
            estValue = Math.max(estValue, lyUpcoming);
        }
        if (!reasons.length) continue;

        findings.push({
            idCustomer: custId,
            company: g.company || ('Customer #' + custId),
            orderCount24mo: g.orders.length,
            medianGapDays: medianGap,
            daysSinceLastOrder: daysSince,
            lastOrderDate: g.orders[g.orders.length - 1].day,
            avgOrderValue: avgOrder,
            lyUpcoming45d: lyUpcoming,
            estValue: Math.round(estValue * 100) / 100,
            reasons,
        });
    }

    findings.sort((a, b) => b.estValue - a.estValue);
    const top = findings.slice(0, GROWTH_LIMIT);
    return {
        rep: { email: rep.email, fullName: rep.fullName, firstName: rep.firstName },
        generatedAt: new Date().toISOString(),
        windowMonths: 24,
        accountsScanned: byCust.size,
        flaggedCount: findings.length,
        potentialTotal: Math.round(findings.reduce((s, f) => s + f.estValue, 0) * 100) / 100,
        items: top,
        truncated: findings.length > top.length ? findings.length - top.length : 0,
    };
}

// GET /growth?email=  (mounted at /api/ae-dashboard, secret-gated)
router.get('/growth', async (req, res) => {
    const email = String(req.query.email || '').toLowerCase().trim();
    const reg = AE_REGISTRY[email];
    if (!reg) return res.status(404).json({ error: 'Unknown AE email' });
    const rep = { email, ...reg };

    const entry = growthCache.get(email);
    if (entry && Date.now() - entry.fetchedAt < GROWTH_CACHE_TTL_MS) {
        return res.json({ ...entry.data, cacheHit: true });
    }
    try {
        const data = await buildGrowthRadar(rep);
        growthCache.set(email, { data, fetchedAt: Date.now() });
        res.json({ ...data, cacheHit: false });
    } catch (error) {
        console.error('[ae-dashboard] growth radar failed:', error.message);
        res.status(500).json({ error: 'Failed to build growth radar', details: error.message });
    }
});

// GET /summary?email=&refresh=1  (mounted at /api/ae-dashboard, secret-gated)
router.get('/summary', async (req, res) => {
    const email = String(req.query.email || '').toLowerCase().trim();
    const reg = AE_REGISTRY[email];
    if (!reg) {
        return res.status(404).json({
            error: 'Unknown AE email',
            hint: `Add the rep to AE_REGISTRY in src/routes/ae-dashboard.js. Known: ${Object.keys(AE_REGISTRY).join(', ')}`,
        });
    }
    const rep = { email, ...reg };

    const now = Date.now();
    const entry = cache.get(email);
    const wantsRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
    // Honor refresh at most every 30s per rep; otherwise serve cache within TTL.
    const refreshAllowed = wantsRefresh && (!entry || now - (entry.lastForcedAt || 0) >= REFRESH_MIN_INTERVAL_MS);
    if (entry && now - entry.fetchedAt < CACHE_TTL_MS && !refreshAllowed) {
        return res.json({ ...entry.data, cacheHit: true });
    }

    try {
        const data = await buildSummary(rep);
        cache.set(email, {
            data,
            fetchedAt: now,
            lastForcedAt: refreshAllowed ? now : (entry ? entry.lastForcedAt : 0),
        });
        res.json({ ...data, cacheHit: false });
    } catch (error) {
        console.error('[ae-dashboard] summary failed:', error.message);
        res.status(500).json({ error: 'Failed to build AE dashboard summary', details: error.message });
    }
});

module.exports = router;
