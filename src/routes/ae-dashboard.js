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
const commissionHelpers = require('./online-store-commissions').helpers;

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

async function fetchCommission(rep) {
    const quarter = commissionHelpers.getCurrentQuarter();
    const year = commissionHelpers.getCurrentYear();
    const dateRange = commissionHelpers.getQuarterDateRange(quarter, year);
    const orders = await commissionHelpers.fetchInkSoftOrders(quarter, year);
    const byRep = commissionHelpers.aggregateOrders(orders);
    const repData = byRep[rep.fullName] || { totalRevenue: 0, orderCount: 0, companies: {} };
    const result = commissionHelpers.calculateRepCommission(rep.fullName, repData, dateRange.end);
    return {
        quarter, year,
        totalCommission: result.totalCommission || 0,
        totalRevenue: result.totalRevenue || 0,
        baselineMet: !!result.baselineMet,
        baselineProgress: result.baselineProgress || 0,
        quarterlyBaseline: result.quarterlyBaseline || 0,
        shortfall: result.shortfall || 0,
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
        commission: fetchCommission(rep),
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
            commissionQtd: out.commission ? out.commission.totalCommission : null,
            commissionQuarter: out.commission ? `${out.commission.quarter} ${out.commission.year}` : null,
            leadWinRate: out.leads ? out.leads.winRate.rate : null,
            leadsWon90: out.leads ? out.leads.winRate.won90 : null,
        },
        commission: out.commission,
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
