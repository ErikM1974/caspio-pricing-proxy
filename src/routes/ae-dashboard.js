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

// ── Data-quality radar ("go back and finish this ShopWorks entry") ───────
// Scans the rep's recently-ENTERED orders (ORDER_ODBC, by date_OrderPlaced)
// for essential fields ShopWorks lets you skip: contact first/last/phone/
// email, ship-to address, payment terms, requested-ship date, and sales tax
// that looks wrong (taxable dollars, $0 tax, customer not tax-exempt). Then
// joins the same orders' customers to CompanyContactsMerge2026 (the ShopWorks
// Cust mirror) and flags setup gaps there too: customer type, phone, default
// terms, incomplete address, tax-exempt without an exemption number.
// "This is the order — this is the customer that needs field updates."
//
// Only OPEN / in-process orders are flagged — once an order is invoiced or
// shipped the entry is closed and re-keying missing fields no longer helps the
// AE (Erik, 2026-07-20). WEBSTORE order types are excluded entirely: those
// orders are created by the InkSoft / online-store integration, where the
// contact + ship-to data lives on the storefront platform and is never keyed
// into ShopWorks — flagging them as "missing fields" is noise, not a to-do.
//
// Ship METHOD is joined into ORDER_ODBC by the bandit order-sync (pulled from
// Addr.ShipMethod — it is NOT an Orders-table column), so the literal check is
// live: a ship method chosen with a blank ship-to block is a hard error.
// cur_Shipping>0 is kept only as a secondary fallback. (2026-07-20)
const DQ_CACHE_TTL_MS = 10 * 60 * 1000;
const dqCache = new Map(); // email → { data, fetchedAt }
const DQ_WINDOW_DAYS = 30;
// Return everything flagged — the Mission Control card paginates ("show 5 +
// expand"). A 30-day window per rep never approaches these caps in practice.
const DQ_ORDER_LIMIT = 100;
const DQ_CUSTOMER_LIMIT = 100;
// id_OrderType values whose contact/ship data lives on an external storefront,
// not in ShopWorks: 31 Inksoft (the Python-Inksoft push default), 6 Online
// Store, 34 Shopify. Verified against the OnSite Order-Types map (2026-07-20;
// only 31 currently appears in either AE's recent orders). Erik-editable.
const DQ_WEBSTORE_ORDER_TYPES = new Set([31, 6, 34]);

function dqBlank(v) { return String(v == null ? '' : v).trim() === ''; }

// Addr.ShipMethod is set on almost EVERY order, and "Customer Pickup" is the
// single most common value (verified live against Addr, 2026-07-20) — so a
// blank ship-to on a pickup is normal, not an error. These are the methods that
// are NOT a real carrier shipment: the pickup family, and not-yet-decided
// placeholders. Only a real carrier method (UPS Ground, FedEx, …) with a blank
// ship-to is the "picked a method, never entered the address" gap. Matched
// case-insensitively; substring for the pickup family (covers "Customer Pickup",
// "Will Call", "Pick Up", etc.). Erik-tunable as new placeholder values appear.
const DQ_NONSHIP_PLACEHOLDERS = new Set(['need ship method', 'ask when done', 'tbd', 'n/a', 'na', 'none', '?']);
function isNonShippingMethod(m) {
    const s = String(m || '').trim().toLowerCase();
    if (!s) return true;
    if (s.includes('pickup') || s.includes('pick up') || s.includes('will call') || s.includes('will-call')) return true;
    return DQ_NONSHIP_PLACEHOLDERS.has(s);
}

// One order → list of {field, severity ('err'|'warn'), text} issues.
function dqOrderIssues(o, cust) {
    const issues = [];
    const add = (field, severity, text) => issues.push({ field, severity, text });

    if (dqBlank(o.ContactFirst)) add('first-name', 'err', 'no contact first name');
    if (dqBlank(o.ContactLast)) add('last-name', 'err', 'no contact last name');
    if (dqBlank(o.ContactPhone)) add('phone', 'err', 'no contact phone');
    if (dqBlank(o.ContactEmail)) add('email', 'err', 'no contact email');

    // Ship-to address block. The hard failure is a real CARRIER ship method
    // chosen (Addr.ShipMethod, joined onto the order by the bandit sync) with the
    // ship-to block blank — "UPS Ground picked, address never entered". Pickup /
    // placeholder methods are NOT real shipments (isNonShippingMethod), so a
    // blank ship-to on those is a pickup (fine) not an error. This method check
    // is the PRIMARY signal; cur_Shipping>0 is demoted to a SECONDARY fallback
    // that only catches rows synced before ShipMethod backfilled, or orders
    // charged for shipping with the method field left blank. No digits in the
    // block = no street # / ZIP = not a real address.
    const ship = String(o.Invoice_AddressBlock_Shipping || '').trim();
    const shipMethod = String(o.ShipMethod || '').trim();
    const realShippingMethod = shipMethod !== '' && !isNonShippingMethod(shipMethod);
    const shippingCharged = num(o.cur_Shipping) > 0;
    if (!ship) {
        if (realShippingMethod) {
            add('ship-address', 'err', `ship method "${shipMethod}" chosen but NO ship-to address`);
        } else if (shippingCharged) {
            add('ship-address', 'err', 'shipping charged but NO ship-to address');
        } else {
            add('ship-address', 'warn', 'no ship-to address (OK only if pickup)');
        }
    } else if (!/\d/.test(ship)) {
        add('ship-address', 'warn', 'ship-to address looks incomplete (no street # or ZIP)');
    }

    if (dqBlank(o.TermsName)) add('terms', 'err', 'no payment terms');

    const placed = String(o.date_OrderPlaced || '').slice(0, 10);
    const reqShip = String(o.date_OrderRequestedToShip || '').slice(0, 10);
    if (!reqShip) add('due-date', 'err', 'no requested-ship date');
    else if (placed && reqShip < placed) add('due-date', 'err', `ship date ${reqShip} is before order date`);
    else if (placed && reqShip > String(new Date(Date.parse(placed + 'T12:00:00Z') + 365 * 86400000).toISOString()).slice(0, 10)) {
        add('due-date', 'warn', `ship date ${reqShip} is over a year out — typo?`);
    }

    // Sales tax sanity: taxable dollars, zero tax, and the customer record
    // does NOT say tax-exempt → someone skipped the tax setup.
    const taxable = num(o.cur_Taxable01);
    const tax = num(o.cnCur_SalesTaxTotal);
    const custExempt = cust ? cust.isTaxExempt : false;
    if (taxable > 0 && tax === 0 && !custExempt) add('tax', 'err', 'taxable order but $0 sales tax (customer is not tax-exempt)');

    return issues;
}

// One customer (merged CompanyContactsMerge2026 rows) → setup issues.
function dqCustomerIssues(c) {
    const issues = [];
    const add = (field, severity, text) => issues.push({ field, severity, text });
    if (dqBlank(c.customerType)) add('customer-type', 'err', 'customer type not set');
    if (dqBlank(c.companyPhone) && dqBlank(c.phoneBest)) add('phone', 'err', 'no phone on the customer record');
    if (dqBlank(c.paymentTerms)) add('terms', 'warn', 'no default payment terms');
    if (c.hasCompleteAddress === 0) add('address', 'warn', 'address incomplete');
    if (c.isTaxExempt && dqBlank(c.taxExemptNumber)) add('tax', 'err', 'marked tax-exempt but no exemption # on file');
    return issues;
}

async function buildDataQuality(rep) {
    const rows = await fetchAllCaspioPages('/tables/ORDER_ODBC/records', {
        'q.where': `CustomerServiceRep='${escWhere(rep.fullName)}' AND date_OrderPlaced>='${isoDaysAgo(DQ_WINDOW_DAYS)}'`,
        'q.select': 'ID_Order,id_Customer,id_OrderType,CompanyName,date_OrderPlaced,date_OrderRequestedToShip,' +
            'ContactFirst,ContactLast,ContactPhone,ContactEmail,Invoice_AddressBlock_Shipping,ShipMethod,' +
            'TermsName,cur_Shipping,cur_Taxable01,cnCur_SalesTaxTotal,sts_Invoiced,sts_Shipped',
        'q.pageSize': 1000,
        'q.orderBy': 'PK_ID',
    }, { maxPages: 4 });

    // ORDER_ODBC repeats an order row per design block — dedupe by ID_Order.
    const orders = new Map();
    for (const r of rows) {
        if (!orders.has(r.ID_Order)) orders.set(r.ID_Order, r);
    }

    // Only OPEN, non-webstore orders are actionable: once invoiced or shipped
    // the entry is closed, and webstore/online-store orders keep their contact
    // + ship data on the storefront platform, never in ShopWorks. Both are
    // dropped BEFORE the customer join so the customer section stays scoped to
    // customers behind orders the AE can actually still fix.
    const isActionable = (o) =>
        !DQ_WEBSTORE_ORDER_TYPES.has(parseInt(o.id_OrderType, 10)) &&
        parseInt(o.sts_Invoiced, 10) !== 1 &&
        parseInt(o.sts_Shipped, 10) !== 1;
    const openOrders = [...orders.values()].filter(isActionable);

    // Customer records behind the ACTIONABLE orders (chunked IN() reads on the
    // Cust mirror). Multiple contact rows per customer — first non-blank wins.
    const custIds = [...new Set(openOrders
        .map((o) => parseInt(o.id_Customer, 10)).filter((n) => Number.isInteger(n) && n > 0))];
    const custById = new Map();
    for (const ids of chunk(custIds, 40)) {
        if (!ids.length) continue;
        const custRows = await fetchAllCaspioPages('/tables/CompanyContactsMerge2026/records', {
            'q.where': `id_Customer IN (${ids.join(',')})`,
            'q.select': 'id_Customer,Company_Name,CustomerCompanyName,Customer_Type,Company_Phone,Phone_Best,' +
                'Payment_Terms,Is_Tax_Exempt,Tax_Exempt_Number,Has_Complete_Address',
            'q.pageSize': 1000,
            'q.orderBy': 'PK_ID',
        }, { maxPages: 4 });
        for (const r of custRows) {
            const key = parseInt(r.id_Customer, 10);
            if (!custById.has(key)) {
                custById.set(key, {
                    idCustomer: key, company: '', customerType: '', companyPhone: '', phoneBest: '',
                    paymentTerms: '', isTaxExempt: false, taxExemptNumber: '', hasCompleteAddress: null,
                });
            }
            const c = custById.get(key);
            if (!c.company) c.company = String(r.Company_Name || r.CustomerCompanyName || '').trim();
            if (!c.customerType) c.customerType = String(r.Customer_Type || '').trim();
            if (!c.companyPhone) c.companyPhone = String(r.Company_Phone || '').trim();
            if (!c.phoneBest) c.phoneBest = String(r.Phone_Best || '').trim();
            if (!c.paymentTerms) c.paymentTerms = String(r.Payment_Terms || '').trim();
            if (parseInt(r.Is_Tax_Exempt, 10) === 1) c.isTaxExempt = true;
            if (!c.taxExemptNumber) c.taxExemptNumber = String(r.Tax_Exempt_Number || '').trim();
            const hca = parseInt(r.Has_Complete_Address, 10);
            // any contact row with a complete address clears the flag
            if (c.hasCompleteAddress !== 1 && (hca === 0 || hca === 1)) c.hasCompleteAddress = hca;
        }
    }

    // Order findings — an order is only LISTED when it carries at least one
    // hard error; warn-level issues (e.g. blank ship-to, which is normal on
    // pickup orders) ride along as context but never flag an order alone.
    // Verified live 2026-07-19: without this, blank-ship-to warns on pickup
    // orders drowned the real gaps (80/125 of Nika's orders "flagged").
    // Most errors first, then newest entered first. (All are open/in-process —
    // invoiced & shipped orders were filtered out above.)
    const flaggedOrders = [];
    for (const o of openOrders) {
        const cust = custById.get(parseInt(o.id_Customer, 10)) || null;
        const issues = dqOrderIssues(o, cust);
        if (!issues.some((i) => i.severity === 'err')) continue;
        flaggedOrders.push({
            idOrder: o.ID_Order,
            idCustomer: parseInt(o.id_Customer, 10) || null,
            company: o.CompanyName || (cust && cust.company) || '',
            placedDate: String(o.date_OrderPlaced || '').slice(0, 10),
            requestedShipDate: String(o.date_OrderRequestedToShip || '').slice(0, 10),
            errCount: issues.filter((i) => i.severity === 'err').length,
            issues,
        });
    }
    flaggedOrders.sort((a, b) =>
        (b.errCount - a.errCount) || String(b.placedDate).localeCompare(String(a.placedDate)));

    // Customer findings — only customers who actually ordered in the window.
    const flaggedCustomers = [];
    for (const c of custById.values()) {
        const issues = dqCustomerIssues(c);
        if (!issues.length) continue;
        flaggedCustomers.push({
            idCustomer: c.idCustomer,
            company: c.company || ('Customer #' + c.idCustomer),
            errCount: issues.filter((i) => i.severity === 'err').length,
            issues,
        });
    }
    flaggedCustomers.sort((a, b) => (b.errCount - a.errCount) || String(a.company).localeCompare(String(b.company)));

    const topOrders = flaggedOrders.slice(0, DQ_ORDER_LIMIT);
    const topCustomers = flaggedCustomers.slice(0, DQ_CUSTOMER_LIMIT);
    return {
        rep: { email: rep.email, fullName: rep.fullName, firstName: rep.firstName },
        generatedAt: new Date().toISOString(),
        windowDays: DQ_WINDOW_DAYS,
        ordersScanned: openOrders.length,
        ordersExcluded: orders.size - openOrders.length,
        customersScanned: custById.size,
        counts: {
            ordersFlagged: flaggedOrders.length,
            customersFlagged: flaggedCustomers.length,
            orderErrors: flaggedOrders.reduce((s, o) => s + o.errCount, 0),
        },
        orders: topOrders,
        customers: topCustomers,
        ordersTruncated: flaggedOrders.length - topOrders.length,
        customersTruncated: flaggedCustomers.length - topCustomers.length,
    };
}

// GET /data-quality?email=  (mounted at /api/ae-dashboard, secret-gated)
router.get('/data-quality', async (req, res) => {
    const email = String(req.query.email || '').toLowerCase().trim();
    const reg = AE_REGISTRY[email];
    if (!reg) return res.status(404).json({ error: 'Unknown AE email' });
    const rep = { email, ...reg };

    const entry = dqCache.get(email);
    if (entry && Date.now() - entry.fetchedAt < DQ_CACHE_TTL_MS) {
        return res.json({ ...entry.data, cacheHit: true });
    }
    try {
        const data = await buildDataQuality(rep);
        dqCache.set(email, { data, fetchedAt: Date.now() });
        res.json({ ...data, cacheHit: false });
    } catch (error) {
        console.error('[ae-dashboard] data-quality radar failed:', error.message);
        res.status(500).json({ error: 'Failed to build data-quality radar', details: error.message });
    }
});

// ── Purchasing tracker ("did Bradley order my blanks?") ──────────────────
// The AEs submit blanks-purchase requests to Bradley via the JotForm
// "Purchasing" form (Order # fields = ShopWorks work-order numbers). This
// endpoint joins that form to the ShopWorks PurchaseOrders mirror so the rep
// can see each request move: Sent to Bradley → Ordered (PO issued, vendor) →
// Received (counted in by receiving) → Invoiced/Shipped (ORDER_ODBC flags).
const PURCHASING_FORM_ID = '241646601815152';
const PURCHASING_WINDOW_DAYS = 60;
const PURCHASING_CACHE_TTL_MS = 15 * 60 * 1000;
const purchasingCache = new Map(); // email → { data, fetchedAt }

function chunk(arr, n) {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
}

// rep = null → company-wide "Purchasing Portal" view (every request to
// Bradley, with the requester attached). rep = an AE_REGISTRY entry → just
// that rep's requests (the Mission Control card).
async function buildPurchasing(rep) {
    const { fetchJotformSubmissions } = require('../utils/jotform');
    const sinceStr = new Date(Date.now() - PURCHASING_WINDOW_DAYS * 86400000)
        .toISOString().slice(0, 10) + ' 00:00:00';
    const subs = await fetchJotformSubmissions(PURCHASING_FORM_ID, {
        filter: { 'created_at:gt': sinceStr },
        limit: 500,
        orderby: 'id',
    });

    // Parse + (optionally) filter to one rep (the "Your Email" field).
    const mine = [];
    for (const s of subs) {
        const answers = s.answers || {};
        let email = '', poNum = '', orderType = '';
        const orders = [];
        for (const a of Object.values(answers)) {
            const name = String(a.name || '');
            const text = String(a.text || '');
            const val = a.answer;
            // JotForm answers we care about are plain strings (date/upload
            // fields come back as objects — skip those).
            if (typeof val !== 'string' || val.trim() === '') continue;
            if (name === 'yourEmail' || /your email/i.test(text)) email = String(val).toLowerCase().trim();
            else if (/^po\s*#/i.test(text)) poNum = String(val).trim();
            else if (/^order[_ ]?\d*$/i.test(name) || /^order\s*#/i.test(text)) {
                const num = parseInt(String(val).replace(/\D/g, ''), 10);
                if (Number.isInteger(num) && num > 1000) orders.push(num);
            } else if (name === 'typeOf' || /type of order/i.test(text)) orderType = String(val).trim();
        }
        if (rep && email !== rep.email) continue;
        if (!orders.length) continue;
        const reg = AE_REGISTRY[email];
        mine.push({
            submissionId: s.id,
            submittedAt: s.created_at,
            orderType,
            bradleyPo: poNum,
            requestedBy: email,
            requestedByName: reg ? reg.fullName : (email || 'Unknown'),
            orders: [...new Set(orders)],
        });
    }
    mine.sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt)));
    const recent = mine.slice(0, rep ? 20 : 250);

    // Cross-reference ShopWorks: PurchaseOrders (blanks POs per work order) +
    // ORDER_ODBC (company + production flags). Chunked IN() reads.
    const allOrderNums = [...new Set(recent.flatMap((m) => m.orders))];
    const posByOrder = new Map();
    const odbcByOrder = new Map();
    for (const ids of chunk(allOrderNums, 40)) {
        if (!ids.length) continue;
        const inList = ids.join(',');
        const poRows = await fetchAllCaspioPages('/tables/PurchaseOrders/records', {
            'q.where': `id_Order IN (${inList})`,
            'q.select': 'ID_PO,id_Order,VendorName,date_POIssued,date_Received,sts_Received',
            'q.orderBy': 'PK_ID',
            'q.pageSize': 500,
        }, { maxPages: 2 });
        for (const r of poRows) {
            const key = parseInt(r.id_Order, 10);
            if (!posByOrder.has(key)) posByOrder.set(key, []);
            posByOrder.get(key).push(r);
        }
        const odbcRows = await fetchAllCaspioPages('/tables/ORDER_ODBC/records', {
            'q.where': `ID_Order IN (${inList})`,
            'q.select': 'ID_Order,CompanyName,sts_Invoiced,sts_Shipped',
            'q.orderBy': 'PK_ID',
            'q.pageSize': 500,
        }, { maxPages: 2 });
        for (const r of odbcRows) {
            const key = parseInt(r.ID_Order, 10);
            if (!odbcByOrder.has(key)) odbcByOrder.set(key, r);
        }
    }

    const day = (v) => String(v || '').slice(0, 10);
    const items = recent.map((m) => ({
        ...m,
        orders: m.orders.map((num) => {
            const pos = posByOrder.get(num) || [];
            const odbc = odbcByOrder.get(num);
            const issued = pos.filter((p) => day(p.date_POIssued));
            const received = pos.filter((p) => day(p.date_Received) || parseInt(p.sts_Received, 10) === 1);
            let status = 'sent';                                    // Bradley has the request
            if (pos.length) status = 'ordered';                     // PO exists for this WO
            if (pos.length && received.length >= pos.length) status = 'received';
            else if (received.length) status = 'partial';
            if (odbc && parseInt(odbc.sts_Shipped, 10) === 1) status = 'shipped';
            else if (odbc && parseInt(odbc.sts_Invoiced, 10) === 1 && status === 'received') status = 'invoiced';
            return {
                orderNumber: num,
                company: odbc ? odbc.CompanyName : '',
                status,
                poCount: pos.length,
                vendors: [...new Set(pos.map((p) => p.VendorName).filter(Boolean))],
                // SanMar-vendor PO numbers — SanMar's invoice API is keyed by
                // PurchaseOrderNo, and our SanMar orders carry the ShopWorks
                // ID_PO as that number (same match the inbound dashboard uses),
                // so the portal can pull the actual SanMar invoice per PO.
                sanmarPos: [...new Set(pos.filter((p) => /sanmar/i.test(String(p.VendorName || ''))).map((p) => p.ID_PO))],
                orderedDate: issued.length ? day(issued[0].date_POIssued) : '',
                receivedDate: received.length ? day(received[received.length - 1].date_Received) : '',
            };
        }),
    }));

    const counts = { sent: 0, ordered: 0, partial: 0, received: 0, invoiced: 0, shipped: 0 };
    items.forEach((m) => m.orders.forEach((o) => { counts[o.status] = (counts[o.status] || 0) + 1; }));

    return {
        rep: rep ? { email: rep.email, fullName: rep.fullName, firstName: rep.firstName } : null,
        generatedAt: new Date().toISOString(),
        windowDays: PURCHASING_WINDOW_DAYS,
        submissionCount: mine.length,
        counts,
        items,
        truncated: mine.length > recent.length ? mine.length - recent.length : 0,
    };
}

// GET /purchasing-all — company-wide Purchasing Portal feed (every request to
// Bradley in the window, requester attached). Secret-gated at the mount;
// browsers come through the main app's requireStaff forwarder (any staff).
router.get('/purchasing-all', async (req, res) => {
    const entry = purchasingCache.get('__all__');
    if (entry && Date.now() - entry.fetchedAt < PURCHASING_CACHE_TTL_MS) {
        return res.json({ ...entry.data, cacheHit: true });
    }
    try {
        const data = await buildPurchasing(null);
        purchasingCache.set('__all__', { data, fetchedAt: Date.now() });
        res.json({ ...data, cacheHit: false });
    } catch (error) {
        console.error('[ae-dashboard] purchasing portal failed:', error.message);
        res.status(500).json({ error: 'Failed to build purchasing portal', details: error.message });
    }
});

// GET /purchasing?email=  (mounted at /api/ae-dashboard, secret-gated)
router.get('/purchasing', async (req, res) => {
    const email = String(req.query.email || '').toLowerCase().trim();
    const reg = AE_REGISTRY[email];
    if (!reg) return res.status(404).json({ error: 'Unknown AE email' });
    const rep = { email, ...reg };

    const entry = purchasingCache.get(email);
    if (entry && Date.now() - entry.fetchedAt < PURCHASING_CACHE_TTL_MS) {
        return res.json({ ...entry.data, cacheHit: true });
    }
    try {
        const data = await buildPurchasing(rep);
        purchasingCache.set(email, { data, fetchedAt: Date.now() });
        res.json({ ...data, cacheHit: false });
    } catch (error) {
        console.error('[ae-dashboard] purchasing tracker failed:', error.message);
        res.status(500).json({ error: 'Failed to build purchasing tracker', details: error.message });
    }
});

// ── Order due dates ("will this order ship on time?") ────────────────────
// The rep's UNSHIPPED ShopWorks orders measured against their requested-ship
// date, joined to the PurchaseOrders mirror so "are the blanks even here?" is
// answered on the same row. Two flags, nothing else:
//   LATE    — requested-ship date already passed and the order hasn't shipped.
//   AT RISK — due within DUE_SOON_DAYS and the blanks are NOT fully received
//             (no PO on the work order, or PO issued but receiving hasn't
//             counted it in). Due-soon orders whose blanks ARE in house are
//             considered on track and only counted, not listed.
// Orders with NO requested-ship date can't be judged here — the data-quality
// radar already flags those as entry errors.
const DUE_SOON_DAYS = 7;
const DUE_LOOKBACK_DAYS = 60; // how far past-due we keep showing a missed date
const DUE_LIMIT = 30;
const DUE_CACHE_TTL_MS = 10 * 60 * 1000;
const dueCache = new Map(); // email → { data, fetchedAt }

async function buildDueDates(rep) {
    const rows = await fetchAllCaspioPages('/tables/ORDER_ODBC/records', {
        'q.where': `CustomerServiceRep='${escWhere(rep.fullName)}' AND date_OrderRequestedToShip>='${isoDaysAgo(DUE_LOOKBACK_DAYS)}'`,
        'q.select': 'ID_Order,id_Customer,CompanyName,ORDER_TYPE,date_OrderPlaced,date_OrderRequestedToShip,cur_Subtotal,sts_Invoiced,sts_Shipped',
        'q.pageSize': 1000,
        'q.orderBy': 'PK_ID',
    }, { maxPages: 4 });

    // ORDER_ODBC repeats an order row per design block — dedupe by ID_Order.
    const orders = new Map();
    for (const r of rows) {
        if (!orders.has(r.ID_Order)) orders.set(r.ID_Order, r);
    }

    const today = todayPT();
    const todayMs = Date.parse(today + 'T12:00:00Z');
    const daysUntil = (day) => Math.round((Date.parse(day + 'T12:00:00Z') - todayMs) / 86400000);

    // Candidates = unshipped orders due on/before today+DUE_SOON_DAYS. Orders
    // due further out aren't judged yet; shipped orders made their date (or
    // are out the door either way).
    const candidates = [];
    let dueSoonTotal = 0;
    for (const o of orders.values()) {
        if (parseInt(o.sts_Shipped, 10) === 1) continue;
        const due = String(o.date_OrderRequestedToShip || '').slice(0, 10);
        if (!due) continue;
        const d = daysUntil(due);
        if (d > DUE_SOON_DAYS) continue;
        if (d >= 0) dueSoonTotal++;
        candidates.push({ o, due, d });
    }

    // Blanks status per candidate work order from the PurchaseOrders mirror
    // (same join the purchasing tracker uses). Chunked IN() reads.
    const candidateIds = [...new Set(candidates.map((c) => parseInt(c.o.ID_Order, 10)).filter((n) => Number.isInteger(n) && n > 0))];
    const posByOrder = new Map();
    for (const ids of chunk(candidateIds, 40)) {
        if (!ids.length) continue;
        const poRows = await fetchAllCaspioPages('/tables/PurchaseOrders/records', {
            'q.where': `id_Order IN (${ids.join(',')})`,
            'q.select': 'ID_PO,id_Order,VendorName,date_POIssued,date_Received,sts_Received',
            'q.pageSize': 500,
            'q.orderBy': 'PK_ID',
        }, { maxPages: 2 });
        for (const r of poRows) {
            const key = parseInt(r.id_Order, 10);
            if (!posByOrder.has(key)) posByOrder.set(key, []);
            posByOrder.get(key).push(r);
        }
    }

    const day = (v) => String(v || '').slice(0, 10);
    const late = [];
    const atRisk = [];
    for (const { o, due, d } of candidates) {
        const pos = posByOrder.get(parseInt(o.ID_Order, 10)) || [];
        const received = pos.filter((p) => day(p.date_Received) || parseInt(p.sts_Received, 10) === 1);
        let blanks = 'none';                                   // no PO on the WO yet
        if (pos.length) blanks = 'ordered';                    // PO issued, nothing counted in
        if (pos.length && received.length >= pos.length) blanks = 'received';
        else if (received.length) blanks = 'partial';

        const isLate = d < 0;
        if (!isLate && blanks === 'received') continue;        // due soon but blanks in house — on track

        const blanksText = blanks === 'none' ? 'blanks not purchased (no PO on this WO)'
            : blanks === 'ordered' ? 'blanks ordered, not received'
            : blanks === 'partial' ? 'blanks only partially received'
            : 'blanks received';
        const item = {
            idOrder: o.ID_Order,
            idCustomer: parseInt(o.id_Customer, 10) || null,
            company: o.CompanyName || '',
            orderType: o.ORDER_TYPE || '',
            placedDate: day(o.date_OrderPlaced),
            dueDate: due,
            daysUntilDue: d,
            subtotal: num(o.cur_Subtotal),
            invoiced: parseInt(o.sts_Invoiced, 10) === 1,
            blanks,
            poCount: pos.length,
            vendors: [...new Set(pos.map((p) => p.VendorName).filter(Boolean))],
            flag: isLate ? 'late' : 'risk',
            reason: isLate
                ? `${Math.abs(d)}d past due` + (blanks !== 'received' ? ' · ' + blanksText : '')
                : (d === 0 ? 'due TODAY' : `due in ${d}d`) + ' · ' + blanksText,
        };
        (isLate ? late : atRisk).push(item);
    }
    // Most urgent first: late = most overdue on top; at-risk = soonest due on top.
    late.sort((a, b) => a.daysUntilDue - b.daysUntilDue);
    atRisk.sort((a, b) => a.daysUntilDue - b.daysUntilDue);

    const lateTop = late.slice(0, DUE_LIMIT);
    const riskTop = atRisk.slice(0, DUE_LIMIT);
    return {
        rep: { email: rep.email, fullName: rep.fullName, firstName: rep.firstName },
        generatedAt: new Date().toISOString(),
        today,
        dueSoonDays: DUE_SOON_DAYS,
        lookbackDays: DUE_LOOKBACK_DAYS,
        ordersScanned: orders.size,
        counts: {
            late: late.length,
            atRisk: atRisk.length,
            dueSoonOnTrack: Math.max(0, dueSoonTotal - atRisk.length),
        },
        late: lateTop,
        atRisk: riskTop,
        lateTruncated: late.length - lateTop.length,
        atRiskTruncated: atRisk.length - riskTop.length,
    };
}

// GET /due-dates?email=  (mounted at /api/ae-dashboard, secret-gated)
router.get('/due-dates', async (req, res) => {
    const email = String(req.query.email || '').toLowerCase().trim();
    const reg = AE_REGISTRY[email];
    if (!reg) return res.status(404).json({ error: 'Unknown AE email' });
    const rep = { email, ...reg };

    const entry = dueCache.get(email);
    if (entry && Date.now() - entry.fetchedAt < DUE_CACHE_TTL_MS) {
        return res.json({ ...entry.data, cacheHit: true });
    }
    try {
        const data = await buildDueDates(rep);
        dueCache.set(email, { data, fetchedAt: Date.now() });
        res.json({ ...data, cacheHit: false });
    } catch (error) {
        console.error('[ae-dashboard] due-dates failed:', error.message);
        res.status(500).json({ error: 'Failed to build order due dates', details: error.message });
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
