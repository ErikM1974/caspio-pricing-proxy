#!/usr/bin/env node
/**
 * build-customer-profiles-10yr.js
 *
 * EMB Smart Phase E1 ETL — joins 3 source files into 3 Caspio-importable CSVs
 * giving the chat bot 10 years of customer + product intelligence.
 *
 * INPUTS (default paths — override via CLI flags):
 *   --contacts=<path>   CompanyContactsMerge2026 export
 *                       (default ~/Downloads/CompanyContactsMerge2026_2026-May-25_0731.csv)
 *   --line-items=<path> All Sanmar Line Items since 1-1-16
 *                       (default ~/Downloads/All Sanmar Line Items to date since 1-1-16.csv)
 *   --bridge=<path>     Order IDS and customers since 2016
 *                       (default ~/Downloads/Order IDS and customers since 2016.xlsx)
 *
 * OUTPUTS (written to ~/Downloads/):
 *   customer_profiles_10yr_YYYYMMDD.csv          (~13K rows — one per active customer)
 *   sanmar_style_performance_10yr_YYYYMMDD.csv   (~3.4K rows — one per SanMar style)
 *   industry_lookalikes_v3_YYYYMMDD.csv          (~400 rows — top 25 styles per Customer_Type)
 *
 * QUALITY VALIDATION (printed to stdout + log file):
 *   - Absher Construction expected ~3,693 orders / $278K
 *   - PC54 expected ~9K units, ~54% margin
 *   - Construction industry expected ~3,849 customers
 *   - Reports unmatched bridge company names so Erik can clean Caspio
 *
 * USAGE:
 *   node scripts/build-customer-profiles-10yr.js               # full run
 *   node scripts/build-customer-profiles-10yr.js --quick       # skip fuzzy matching (faster)
 *   node scripts/build-customer-profiles-10yr.js --validate    # validate-only, no CSV write
 *
 * Created 2026-05-25 — EMB Smart Phase E1.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const xlsx = require('xlsx');

const { normalize, buildMatchIndex, fuzzyMatch } = require('./lib/company-name-normalize');

// ── CLI args ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function arg(name, fallback) {
    const m = args.find(a => a.startsWith('--' + name + '='));
    return m ? m.split('=').slice(1).join('=') : fallback;
}
const ARG_QUICK = args.includes('--quick');
const ARG_VALIDATE_ONLY = args.includes('--validate');

const DOWNLOADS = path.join(os.homedir(), 'Downloads');
const CONTACTS_PATH = arg('contacts', path.join(DOWNLOADS, 'CompanyContactsMerge2026_2026-May-25_0731.csv'));
const LINE_ITEMS_PATH = arg('line-items', path.join(DOWNLOADS, 'All Sanmar Line Items to date since 1-1-16.csv'));
const BRIDGE_PATH = arg('bridge', path.join(DOWNLOADS, 'Order IDS and customers since 2016.xlsx'));
const SANMAR_BULK_PATH = arg('sanmar-bulk', path.join(DOWNLOADS, 'Sanmar_Bulk_251816_Feb2024_2026-May-25_0815.csv'));

const dateStamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const OUT_CUSTOMER = path.join(DOWNLOADS, `customer_profiles_10yr_${dateStamp}.csv`);
const OUT_STYLE = path.join(DOWNLOADS, `sanmar_style_performance_10yr_${dateStamp}.csv`);
const OUT_INDUSTRY = path.join(DOWNLOADS, `industry_lookalikes_v3_${dateStamp}.csv`);
const LOG_PATH = path.join(__dirname, '.build-customer-profiles-10yr.log');

// ── Logging ───────────────────────────────────────────────────────────────
function log(msg) {
    const ts = new Date().toISOString();
    const line = `[${ts}] ${msg}\n`;
    fs.appendFileSync(LOG_PATH, line);
    process.stdout.write(line);
}

// ── CSV parser (robust — handles quotes, embedded commas, BOM) ─────────────
function parseCsv(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const rows = []; let row = [], field = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQ) {
            if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
            else field += c;
        } else {
            if (c === '"') inQ = true;
            else if (c === ',') { row.push(field); field = ''; }
            else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
            else if (c === '\r') { /* skip */ }
            else field += c;
        }
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows;
}

// ── CSV escape (writer side) ──────────────────────────────────────────────
function csvEscape(v) {
    const s = String(v == null ? '' : v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
}

// ── Size suffix stripping for PartNumber ──────────────────────────────────
const SIZE_SUFFIX = /_(?:XS|S|M|L|XL|2XL|3XL|4XL|5XL|6XL|2X|3X|4X|5X|6X|OSFA|S\/M|M\/L|L\/XL|X\/L|XLT|XXLT|2XLT|3XLT)$/i;
function stripSize(pn) {
    let p = String(pn || '').trim().toUpperCase();
    while (SIZE_SUFFIX.test(p)) { const n = p.replace(SIZE_SUFFIX, ''); if (n === p || !n) break; p = n; }
    return p;
}

// ── Brand inference (copied from customer-history.js — shared heuristic) ──
function guessBrand(pn, desc) {
    pn = String(pn || '').toUpperCase();
    desc = String(desc || '').toLowerCase();
    if (pn.startsWith('NKDC') || pn.startsWith('NKBV') || pn.startsWith('NKAQ') || /\bnike\b/i.test(desc)) return 'Nike';
    if (pn.startsWith('CTK') || pn.startsWith('CT') || /\bcarhartt\b/i.test(desc)) return 'Carhartt';
    if (pn.startsWith('TM1M') || pn.startsWith('TM1L') || /\btravismathew\b/i.test(desc)) return 'TravisMathew';
    if (pn.startsWith('LST') || pn.startsWith('ST') || /\bsport-tek\b/i.test(desc)) return 'Sport-Tek';
    if (pn.startsWith('LPC') || pn.startsWith('PC') || /\bport\s*&?\s*(co|company)\b/i.test(desc)) return 'Port & Co';
    if (/^L\d/.test(pn)) return 'Port Authority';
    if (/^K\d/.test(pn)) return 'Port Authority';
    if (/^J\d/.test(pn)) return 'Port Authority';
    if (/^C\d/.test(pn)) return 'Port Authority';
    if (pn.startsWith('CP')) return 'Port & Co';
    if (pn.startsWith('CS') || pn.startsWith('CWF') || pn.startsWith('CSV') || /\bcornerstone\b/i.test(desc)) return 'CornerStone';
    if (pn.startsWith('NEA') || pn.startsWith('NE') || pn.startsWith('NEB') || /\bnew\s+era\b/i.test(desc)) return 'New Era';
    if (pn.startsWith('BC') || /\bbella\b/i.test(desc)) return 'Bella + Canvas';
    if (pn.startsWith('NL') || /\bnext\s*level\b/i.test(desc)) return 'Next Level';
    if (pn.startsWith('DT') || pn.startsWith('DM') || /\bdistrict\b/i.test(desc)) return 'District';
    if (pn.startsWith('EB') || /\beddie\s+bauer\b/i.test(desc)) return 'Eddie Bauer';
    if (pn.startsWith('NF0A') || /\bnorth\s+face\b/i.test(desc)) return 'The North Face';
    if (pn.startsWith('OG') || /\bogio\b/i.test(desc)) return 'OGIO';
    if (pn.startsWith('RK') || pn.startsWith('SP') || /\bred\s+kap\b/i.test(desc)) return 'Red Kap';
    if (/^11[12]/.test(pn) || /\brichardson\b/i.test(desc)) return 'Richardson';
    if (/^(VL|LVL)/.test(pn) || /\bvolunteer\b/i.test(desc)) return 'Volunteer Knitwear';
    if (/^G\d/.test(pn) || /\bgildan\b/i.test(desc)) return 'Gildan';
    if (/^\d{3,4}M$/.test(pn) || /\bjerzees\b/i.test(desc)) return 'Jerzees';
    return null;
}

// ── PHASE 0: Stream-read SanMar bulk catalog (~425 MB) → dedup'd by STYLE ──
// Returns Map<STYLE, { product_title, brand_name, category_name, subcategory_name,
//                       companion_styles, keywords, msrp, case_price }>
// Streams line-by-line to avoid loading the whole 425 MB file at once. Only
// keeps the first row encountered per STYLE (catalog metadata is identical
// across color/size variants of the same style).
async function loadSanmarBulkCatalog() {
    log('═══ PHASE 0: Streaming SanMar bulk catalog (large file — ~425 MB) ═══');
    const readline = require('readline');
    const stream = fs.createReadStream(SANMAR_BULK_PATH, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let header = null;
    let colIdx = {};
    let parseBuf = '';   // accumulates lines when a quoted field spans newlines
    let inQ = false;     // are we inside a quoted field across multiple lines?
    let rowCount = 0;
    const catalogByStyle = new Map();

    // Simple CSV row parser — for a SINGLE physical line (no embedded newlines)
    function parseLine(line) {
        const out = []; let field = '', q = false;
        for (let i = 0; i < line.length; i++) {
            const c = line[i];
            if (q) {
                if (c === '"') { if (line[i + 1] === '"') { field += '"'; i++; } else q = false; }
                else field += c;
            } else {
                if (c === '"') q = true;
                else if (c === ',') { out.push(field); field = ''; }
                else field += c;
            }
        }
        out.push(field);
        return out;
    }

    function processCompleteRow(physical) {
        // Strip BOM if first row
        if (rowCount === 0 && physical.charCodeAt(0) === 0xFEFF) physical = physical.slice(1);
        const r = parseLine(physical);
        if (!header) {
            header = r;
            colIdx = Object.fromEntries(header.map((h, i) => [h, i]));
            // Verify required columns exist
            const required = ['STYLE', 'PRODUCT_TITLE', 'BRAND_NAME', 'CATEGORY_NAME'];
            for (const c of required) {
                if (colIdx[c] == null) throw new Error(`Bulk CSV missing required column: ${c}`);
            }
            return;
        }
        const style = (r[colIdx.STYLE] || '').trim().toUpperCase();
        if (!style || catalogByStyle.has(style)) return;
        catalogByStyle.set(style, {
            product_title: (r[colIdx.PRODUCT_TITLE] || '').trim(),
            brand_name: (r[colIdx.BRAND_NAME] || '').trim(),
            category_name: (r[colIdx.CATEGORY_NAME] || '').trim(),
            subcategory_name: (r[colIdx.SUBCATEGORY_NAME] || '').trim(),
            companion_styles: (r[colIdx.COMPANION_STYLES] || '').trim(),
            keywords: (r[colIdx.KEYWORDS] || '').trim().slice(0, 250), // truncate — some are very long
            msrp: parseFloat(r[colIdx.MSRP]) || 0,
            case_price: parseFloat(r[colIdx.CASE_PRICE]) || 0,
            product_status: (r[colIdx.PRODUCT_STATUS] || '').trim(),
        });
    }

    // Determine if a complete physical row is buffered (quotes balanced)
    function quotesBalanced(s) {
        let n = 0;
        for (let i = 0; i < s.length; i++) if (s[i] === '"') n++;
        return n % 2 === 0;
    }

    for await (const line of rl) {
        if (parseBuf) parseBuf += '\n' + line;
        else parseBuf = line;
        if (quotesBalanced(parseBuf)) {
            processCompleteRow(parseBuf);
            rowCount++;
            parseBuf = '';
            if (rowCount % 25000 === 0) log(`  ...${rowCount} bulk rows processed, ${catalogByStyle.size} unique styles cached`);
        }
        // else: still inside a quoted field — keep accumulating
    }
    if (parseBuf) processCompleteRow(parseBuf);
    log(`  ✓ Bulk catalog: ${rowCount} physical rows, ${catalogByStyle.size} unique STYLE keys cached`);
    return catalogByStyle;
}

// ── PHASE 1: Read contacts CSV ────────────────────────────────────────────
function loadContacts() {
    log('═══ PHASE 1: Loading contacts CSV ═══');
    const text = fs.readFileSync(CONTACTS_PATH, 'utf8');
    const rows = parseCsv(text);
    const header = rows[0];
    const data = rows.slice(1).filter(r => r.length > 1);
    log(`  Loaded ${data.length} contact rows, ${header.length} columns`);
    const idx = Object.fromEntries(header.map((h, i) => [h, i]));
    // Convert rows to objects, KEEPING ALL FIELDS (we'll project later)
    const records = data.map(r => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
    return { records, header, idx };
}

// ── PHASE 2: Read bridge XLSX (forward-fill continuation rows) ────────────
function loadBridge() {
    log('═══ PHASE 2: Loading bridge XLSX + forward-filling continuation rows ═══');
    const wb = xlsx.readFile(BRIDGE_PATH);
    const sh = wb.Sheets[wb.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(sh, { header: 1, raw: false, defval: '' });
    const header = rows[0];
    // Forward-fill ID_Order + CompanyName from prior row when blank
    let lastOrder = '', lastCompany = '';
    const filled = [];
    for (let i = 1; i < rows.length; i++) {
        const r = [...rows[i]];
        const orderStr = String(r[0] ?? '').trim();
        const companyStr = String(r[1] ?? '').trim();
        if (orderStr) lastOrder = orderStr; else r[0] = lastOrder;
        if (companyStr) lastCompany = companyStr; else r[1] = lastCompany;
        if (r[0]) filled.push({
            id_Order: r[0],
            CompanyName: r[1],
            DesignName: r[2] || '',
            ProfitLoss_01_cur: parseFloat(r[3]) || 0,
            ProfitLoss_01_pct: parseFloat(r[4]) || 0,
            Subtotal: parseFloat(r[7]) || 0,
            TotalInvoice: parseFloat(r[10]) || 0,
        });
    }
    log(`  Bridge raw rows: ${rows.length - 1}, after forward-fill: ${filled.length}`);
    // Build order → {company, designs[], totals} map (multiple rows per order — each is a design)
    const orderMap = new Map();
    for (const r of filled) {
        if (!orderMap.has(r.id_Order)) {
            orderMap.set(r.id_Order, {
                id_Order: r.id_Order, CompanyName: r.CompanyName,
                designs: [], totalInvoice: 0,
            });
        }
        const e = orderMap.get(r.id_Order);
        if (r.DesignName) e.designs.push(r.DesignName);
        // TotalInvoice usually appears on FIRST design row of an order — others repeat or blank
        if (r.TotalInvoice > e.totalInvoice) e.totalInvoice = r.TotalInvoice;
    }
    log(`  Distinct id_Order in bridge: ${orderMap.size}`);
    return orderMap;
}

// ── PHASE 3: Read line items CSV ──────────────────────────────────────────
function loadLineItems() {
    log('═══ PHASE 3: Loading line items CSV ═══');
    const text = fs.readFileSync(LINE_ITEMS_PATH, 'utf8');
    const rows = parseCsv(text);
    const header = rows[0];
    const data = rows.slice(1).filter(r => r.length > 1 && r[0]);
    log(`  Loaded ${data.length} line items, ${header.length} columns`);
    const idx = Object.fromEntries(header.map((h, i) => [h, i]));

    // Normalize each row into an object
    const sizesIdx = ['S (other)', 'M', 'L', 'XL', '2XL', '3XL (other)'].map(k => idx[k]);
    const items = data.map(r => {
        const units = sizesIdx.reduce((s, i) => s + (parseFloat(r[i]) || 0), 0);
        return {
            id_Order: String(r[idx['id_Order']] || '').trim(),
            PartNumber_raw: r[idx['PartNumber']] || '',
            PartNumber: stripSize(r[idx['PartNumber']] || ''),
            PartColor: String(r[idx['PartColor']] || '').trim(),
            PartDescription: String(r[idx['PartDescriptionUnits']] || '').trim(),
            units,
            cost: parseFloat(r[idx['cnCur_LineCost_Purchased']]) || 0,
            unitPrice: parseFloat(r[idx['cnCur_UnitPriceUsed']]) || 0,
            linePrice: parseFloat(r[idx['cnCur_LinePrice_Req']]) || 0,
        };
    });
    return items;
}

// ── PHASE 4: Join everything via company name + order id ──────────────────
function joinData(contactsResult, orderMap, lineItems) {
    log('═══ PHASE 4: Joining contacts × bridge × line items ═══');
    // Build company-name match index from contacts
    log('  Building company-name match index from contacts...');
    const matchIndex = buildMatchIndex(contactsResult.records, r => r.CustomerCompanyName);
    log(`  Index built: ${matchIndex.byNormalized.size} normalized + ${matchIndex.byStripped.size} stripped + ${matchIndex.allNames.length} for fuzzy fallback`);

    // For each unique CompanyName in the bridge, try to match to a contact record
    const bridgeCompanies = new Set();
    for (const o of orderMap.values()) bridgeCompanies.add(o.CompanyName);
    log(`  Distinct bridge company names: ${bridgeCompanies.size}`);

    // bridgeCompanyName → matched contact record (or null)
    const companyToContact = new Map();
    let matchStats = { exact: 0, normalized: 0, stripped: 0, fuzzy: 0, none: 0 };
    const unmatchedExamples = [];
    for (const company of bridgeCompanies) {
        const m = ARG_QUICK
            ? { matched: matchIndex.byNormalized.get(normalize(company)) || null,
                source: matchIndex.byNormalized.has(normalize(company)) ? 'normalized' : 'none' }
            : fuzzyMatch(company, matchIndex);
        companyToContact.set(company, m.matched);
        if (m.matched) matchStats[m.source]++;
        else { matchStats.none++; if (unmatchedExamples.length < 30) unmatchedExamples.push(company); }
    }
    const matched = matchStats.normalized + matchStats.stripped + matchStats.fuzzy + matchStats.exact;
    log(`  Match results: ${matched}/${bridgeCompanies.size} (${(100 * matched / bridgeCompanies.size).toFixed(1)}%)`);
    log(`    Normalized: ${matchStats.normalized}, Stripped: ${matchStats.stripped}, Fuzzy: ${matchStats.fuzzy}, None: ${matchStats.none}`);

    // Now: walk line items, look up order → company → contact
    // Build customer-level aggregations
    log('  Aggregating per customer + per style...');
    const customerAgg = new Map();  // id_Customer (string) → aggregation
    const styleAgg = new Map();     // PartNumber (stripped) → aggregation
    const styleOrderPairs = new Map(); // PartNumber → Set<id_Order> (for pair counting)
    const orderToParts = new Map(); // id_Order → Set<PartNumber> (for pair counting)

    let liUnmatchedOrder = 0, liUnmatchedCompany = 0, liMatched = 0;

    for (const li of lineItems) {
        if (!li.PartNumber || li.units <= 0) continue;

        // Track for pair-counting regardless of customer match
        if (!orderToParts.has(li.id_Order)) orderToParts.set(li.id_Order, new Set());
        orderToParts.get(li.id_Order).add(li.PartNumber);

        // Style-level aggregation runs over ALL line items (don't need customer match)
        if (!styleAgg.has(li.PartNumber)) {
            styleAgg.set(li.PartNumber, {
                style: li.PartNumber,
                product_title: li.PartDescription,
                units: 0, revenue: 0, cost: 0, orderIds: new Set(),
                colors: new Map(),     // color → units
                customerTypes: new Map(), // type → units
            });
        }
        const s = styleAgg.get(li.PartNumber);
        s.units += li.units;
        s.revenue += li.linePrice;
        s.cost += li.cost;
        s.orderIds.add(li.id_Order);
        if (li.PartColor) s.colors.set(li.PartColor, (s.colors.get(li.PartColor) || 0) + li.units);
        if (!s.product_title && li.PartDescription) s.product_title = li.PartDescription;

        // Customer-level aggregation requires matching order → company → contact
        const order = orderMap.get(li.id_Order);
        if (!order) { liUnmatchedOrder++; continue; }
        const contact = companyToContact.get(order.CompanyName);
        if (!contact) { liUnmatchedCompany++; continue; }
        liMatched++;

        // Tag style with customer type
        const ctype = (contact.Customer_Type || '').trim() || 'Unknown';
        s.customerTypes.set(ctype, (s.customerTypes.get(ctype) || 0) + li.units);

        const cid = String(contact.id_Customer || '');
        if (!cid) continue;
        if (!customerAgg.has(cid)) {
            customerAgg.set(cid, {
                id_Customer: cid,
                CustomerCompanyName: contact.CustomerCompanyName || order.CompanyName,
                Customer_Type: contact.Customer_Type || '',
                Account_Tier: contact.Account_Tier || '',
                Sales_Rep: contact.Sales_Rep || contact.CustomerCustomerServiceRep || '',
                Account_Owner: contact.Account_Owner || '',
                Email_Salesrep: contact.Email_Salesrep || '',
                Is_Active: contact.Is_Active || '',
                Is_Dead: contact.Is_Dead || '',
                Is_Stale: contact.Is_Stale || '',
                Is_Tax_Exempt: contact.Is_Tax_Exempt || '',
                Customer_Warning: contact.Customer_Warning || '',
                Payment_Terms: contact.Payment_Terms || '',
                CustTerms: contact.CustTerms || '',
                Phone_Best: contact.Phone_Best || '',
                Email: contact.ContactNumbersEmail || contact.Email || '',
                Address: contact.Address || '',
                City: contact.City || '',
                State: contact.State || '',
                Zip: contact.Zip || '',
                Website: contact.Website || '',
                YTD_Sales: parseFloat(contact.YTD_Sales) || 0,
                Last_Order_Date: contact.Last_Order_Date || '',
                // Computed:
                totalRevenue: 0, orderIds: new Set(),
                styleUnits: new Map(),    // "PartNumber|color" → units
                styleTotals: new Map(),   // PartNumber → units (rollup ignoring color)
                brandUnits: new Map(),
                lastOrderId: 0,
                lastStyleBought: '', lastColorBought: '',
                designs: new Map(),       // designName → count (for top_design_type)
            });
        }
        const c = customerAgg.get(cid);
        c.orderIds.add(li.id_Order);
        c.totalRevenue += li.linePrice;
        const skey = `${li.PartNumber}|${li.PartColor}`;
        c.styleUnits.set(skey, (c.styleUnits.get(skey) || 0) + li.units);
        c.styleTotals.set(li.PartNumber, (c.styleTotals.get(li.PartNumber) || 0) + li.units);
        const brand = guessBrand(li.PartNumber, li.PartDescription);
        if (brand) c.brandUnits.set(brand, (c.brandUnits.get(brand) || 0) + li.units);
        // Track "most recent" via highest id_Order (no date in line items file)
        const orderNum = parseInt(li.id_Order, 10);
        if (Number.isFinite(orderNum) && orderNum > c.lastOrderId) {
            c.lastOrderId = orderNum;
            c.lastStyleBought = li.PartNumber;
            c.lastColorBought = li.PartColor;
        }
        if (order.designs && order.designs.length) {
            for (const d of order.designs) {
                c.designs.set(d, (c.designs.get(d) || 0) + 1);
            }
        }
    }

    log(`  Line item match: ${liMatched} matched, ${liUnmatchedOrder} no-order, ${liUnmatchedCompany} no-contact-for-company`);

    // Compute "frequently paired with" for each style
    log('  Computing style cross-sell pairs...');
    const pairCount = new Map();
    for (const parts of orderToParts.values()) {
        const arr = [...parts];
        if (arr.length < 2) continue;
        for (let i = 0; i < arr.length; i++) {
            for (let j = i + 1; j < arr.length; j++) {
                if (!pairCount.has(arr[i])) pairCount.set(arr[i], new Map());
                if (!pairCount.has(arr[j])) pairCount.set(arr[j], new Map());
                pairCount.get(arr[i]).set(arr[j], (pairCount.get(arr[i]).get(arr[j]) || 0) + 1);
                pairCount.get(arr[j]).set(arr[i], (pairCount.get(arr[j]).get(arr[i]) || 0) + 1);
            }
        }
    }

    return { customerAgg, styleAgg, pairCount, matchStats, unmatchedExamples };
}

// ── PHASE 5: Compute industry aggregates from customer aggregates ─────────
function buildIndustryLookalikes(customerAgg) {
    log('═══ PHASE 5: Building Industry_Lookalikes_v3 (Customer_Type-driven) ═══');
    const industryAgg = new Map(); // Customer_Type → { customers, items, totalUnits, totalRev, reps }
    for (const c of customerAgg.values()) {
        const ct = c.Customer_Type || 'Uncategorized';
        if (ct === 'DEAD') continue; // skip dead — bot doesn't sell to them
        if (!industryAgg.has(ct)) {
            industryAgg.set(ct, {
                industry: ct,
                customerCount: 0, totalUnits: 0, totalRevenue: 0,
                items: new Map(),      // "style|color" → units
                customers: [],
                reps: new Map(),       // rep → revenue
                orderSizes: [],        // for avg
            });
        }
        const b = industryAgg.get(ct);
        b.customerCount++;
        let custUnits = 0;
        for (const [skey, u] of c.styleUnits) {
            b.items.set(skey, (b.items.get(skey) || 0) + u);
            custUnits += u;
        }
        b.totalUnits += custUnits;
        b.totalRevenue += c.totalRevenue;
        b.customers.push({ name: c.CustomerCompanyName, id: c.id_Customer, units: custUnits, revenue: c.totalRevenue });
        if (c.Sales_Rep) b.reps.set(c.Sales_Rep, (b.reps.get(c.Sales_Rep) || 0) + c.totalRevenue);
        if (c.orderIds.size > 0) b.orderSizes.push(custUnits / c.orderIds.size);
    }
    log(`  Built ${industryAgg.size} industry buckets`);
    return industryAgg;
}

// ── PHASE 6: Margin computation per style ─────────────────────────────────
function annotateStyleMargins(styleAgg) {
    for (const s of styleAgg.values()) {
        s.avgMarginPct = s.revenue > 0 ? Math.round((1 - s.cost / s.revenue) * 1000) / 10 : 0;
        s.avgSellPrice = s.units > 0 ? Math.round((s.revenue / s.units) * 100) / 100 : 0;
        s.avgOurCost = s.units > 0 ? Math.round((s.cost / s.units) * 100) / 100 : 0;
    }
    // Rank by units (Decade_Rank)
    const ranked = [...styleAgg.values()].sort((a, b) => b.units - a.units);
    ranked.forEach((s, i) => { s.decadeRank = i + 1; });
}

// ── PHASE 7: Write CSVs ──────────────────────────────────────────────────
function writeCustomerProfilesCsv(customerAgg) {
    const header = [
        'id_Customer', 'CustomerCompanyName', 'Customer_Type', 'Account_Tier',
        'Sales_Rep', 'Account_Owner', 'Email_Salesrep',
        'Is_Active', 'Is_Dead', 'Is_Stale', 'Is_Tax_Exempt',
        'Customer_Warning', 'Payment_Terms', 'CustTerms',
        'Phone_Best', 'Email', 'Address', 'City', 'State', 'Zip', 'Website',
        'YTD_Sales', 'Last_Order_Date',
        'Total_Revenue_10yr', 'Order_Count_10yr', 'Avg_Order_Size', 'Avg_Margin_Pct',
        'Top_Design_Type', 'Top_5_Styles', 'Top_Style_Top_3_Colors',
        'Top_3_Brands', 'Last_Style_Bought', 'Last_Color_Bought',
        'Reorder_Probability',
    ];
    const rows = [header];

    for (const c of customerAgg.values()) {
        if (c.Customer_Type === 'DEAD') continue;
        if (c.orderIds.size === 0) continue; // skip customers with no actual purchases

        const rev10yr = Math.round(c.totalRevenue);
        const orderCount = c.orderIds.size;
        const avgOrderSize = orderCount > 0 ? Math.round([...c.styleTotals.values()].reduce((a, b) => a + b, 0) / orderCount) : 0;

        // Top 5 styles by units
        const top5Styles = [...c.styleTotals.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([pn, u]) => `${pn} (${u})`)
            .join(', ');

        // Top style → top 3 colors
        const top5Names = [...c.styleTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 1);
        const topStyle = top5Names[0]?.[0] || '';
        const topColors = topStyle
            ? [...c.styleUnits.entries()]
                .filter(([k]) => k.startsWith(topStyle + '|'))
                .sort((a, b) => b[1] - a[1])
                .slice(0, 3)
                .map(([k, u]) => { const color = k.split('|')[1]; return `${color || '(no color)'} (${u})`; })
                .join(', ')
            : '';

        const top3Brands = [...c.brandUnits.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([b, u]) => `${b} (${u})`)
            .join(', ');

        const topDesign = [...c.designs.entries()]
            .sort((a, b) => b[1] - a[1])[0]?.[0] || '';

        // Margin: estimated as we don't have per-customer margin in this file
        // but we can approximate from style margins weighted by their order share
        // (skip for v1 — compute later if needed)
        const avgMarginPct = 0; // placeholder — order-level margin from bridge XLSX is in cur_JobCost_ProfitLoss_01

        // Reorder probability heuristic:
        //   high: 5+ orders, last order recently (we can't compute "recently" without dates,
        //   so use lastOrderId proximity to max=141933)
        //   medium: 2-4 orders
        //   low: 1 order
        const reorderProb = orderCount >= 5 ? 'high' : orderCount >= 2 ? 'medium' : 'low';

        rows.push([
            csvEscape(c.id_Customer), csvEscape(c.CustomerCompanyName), csvEscape(c.Customer_Type),
            csvEscape(c.Account_Tier), csvEscape(c.Sales_Rep), csvEscape(c.Account_Owner),
            csvEscape(c.Email_Salesrep),
            csvEscape(c.Is_Active), csvEscape(c.Is_Dead), csvEscape(c.Is_Stale), csvEscape(c.Is_Tax_Exempt),
            csvEscape(c.Customer_Warning), csvEscape(c.Payment_Terms), csvEscape(c.CustTerms),
            csvEscape(c.Phone_Best), csvEscape(c.Email), csvEscape(c.Address),
            csvEscape(c.City), csvEscape(c.State), csvEscape(c.Zip), csvEscape(c.Website),
            c.YTD_Sales, csvEscape(c.Last_Order_Date),
            rev10yr, orderCount, avgOrderSize, avgMarginPct,
            csvEscape(topDesign), csvEscape(top5Styles), csvEscape(topColors),
            csvEscape(top3Brands), csvEscape(c.lastStyleBought), csvEscape(c.lastColorBought),
            reorderProb,
        ]);
    }
    fs.writeFileSync(OUT_CUSTOMER, rows.map(r => r.join(',')).join('\n') + '\n', 'utf8');
    log(`✓ Wrote ${OUT_CUSTOMER}: ${rows.length - 1} customer rows`);
}

function writeStylePerformanceCsv(styleAgg, pairCount, sanmarCatalog) {
    const header = [
        'style', 'product_title', 'brand_name', 'category_name', 'subcategory_name',
        'decade_rank',
        'total_units_10yr', 'total_revenue_10yr', 'total_orders_10yr',
        'avg_margin_pct', 'avg_sell_price', 'avg_our_cost',
        'msrp', 'current_case_price', 'product_status',
        'top_color_1', 'top_color_1_units',
        'top_color_2', 'top_color_2_units',
        'top_color_3', 'top_color_3_units',
        'customer_types_that_buy',
        'frequently_paired_with',
        'companion_styles',  // SanMar-curated companions (men's↔ladies' pairs etc)
        'keywords',          // SanMar feature tags (for chat semantic match)
    ];
    const rows = [header];

    // Sort by decade rank (units desc)
    const sorted = [...styleAgg.values()].sort((a, b) => a.decadeRank - b.decadeRank);

    for (const s of sorted) {
        if (s.units < 5) continue; // skip noise — anything with < 5 units lifetime

        const topColors = [...s.colors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
        const c1 = topColors[0] || ['', 0];
        const c2 = topColors[1] || ['', 0];
        const c3 = topColors[2] || ['', 0];

        // Customer types that buy — top 5 with %
        const totalTypedUnits = [...s.customerTypes.values()].reduce((a, b) => a + b, 0);
        const topTypes = [...s.customerTypes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
        const customerTypesStr = topTypes
            .map(([t, u]) => `${t} (${Math.round(100 * u / Math.max(totalTypedUnits, 1))}%)`)
            .join(', ');

        // Frequently paired with — top 3 other styles
        const pairs = pairCount.get(s.style);
        const topPairs = pairs ? [...pairs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3) : [];
        const pairsStr = topPairs.map(([p, c]) => `${p} (${c})`).join(', ');

        // SanMar catalog enrichment (authoritative — replaces our guessBrand heuristic
        // + adds CATEGORY_NAME / SUBCATEGORY_NAME / COMPANION_STYLES / KEYWORDS)
        const cat = sanmarCatalog?.get(s.style) || {};
        const productTitle = cat.product_title || s.product_title || '';
        const brandName = cat.brand_name || '';
        const categoryName = cat.category_name || '';
        const subcategoryName = cat.subcategory_name || '';
        const msrp = cat.msrp || 0;
        const casePrice = cat.case_price || 0;
        const productStatus = cat.product_status || '';
        const companionStyles = cat.companion_styles || '';
        const keywords = cat.keywords || '';

        rows.push([
            csvEscape(s.style), csvEscape(productTitle), csvEscape(brandName),
            csvEscape(categoryName), csvEscape(subcategoryName),
            s.decadeRank,
            Math.round(s.units), Math.round(s.revenue), s.orderIds.size,
            s.avgMarginPct, s.avgSellPrice, s.avgOurCost,
            msrp, casePrice, csvEscape(productStatus),
            csvEscape(c1[0]), c1[1],
            csvEscape(c2[0]), c2[1],
            csvEscape(c3[0]), c3[1],
            csvEscape(customerTypesStr),
            csvEscape(pairsStr),
            csvEscape(companionStyles),
            csvEscape(keywords),
        ]);
    }
    fs.writeFileSync(OUT_STYLE, rows.map(r => r.join(',')).join('\n') + '\n', 'utf8');
    log(`✓ Wrote ${OUT_STYLE}: ${rows.length - 1} style rows`);
}

function writeIndustryLookalikesCsv(industryAgg) {
    const header = [
        'industry', 'style_rank', 'style', 'total_units',
        'top_color_1', 'top_color_1_units',
        'top_color_2', 'top_color_2_units',
        'top_color_3', 'top_color_3_units',
        'industry_customer_count', 'industry_total_units', 'industry_total_revenue',
        'exemplar_customers',
        'avg_order_size', 'avg_margin_pct', 'most_active_rep',
    ];
    const rows = [header];

    // Sort industries by customer count desc
    const sortedIndustries = [...industryAgg.values()].sort((a, b) => b.customerCount - a.customerCount);
    for (const ind of sortedIndustries) {
        // Group items by style → sum colors
        const byStyle = new Map();
        for (const [skey, u] of ind.items) {
            const [pn, color] = skey.split('|');
            if (!byStyle.has(pn)) byStyle.set(pn, { totalUnits: 0, colors: [] });
            const e = byStyle.get(pn);
            e.totalUnits += u;
            e.colors.push({ color, units: u });
        }
        // Top 25 styles per industry
        const topStyles = [...byStyle.entries()]
            .sort((a, b) => b[1].totalUnits - a[1].totalUnits)
            .slice(0, 25);

        const exemplars = ind.customers.sort((a, b) => b.revenue - a.revenue).slice(0, 5)
            .map(c => c.name).filter(Boolean).join('; ');
        const mostActiveRep = [...ind.reps.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
        const avgOrderSize = ind.orderSizes.length > 0
            ? Math.round(ind.orderSizes.reduce((a, b) => a + b, 0) / ind.orderSizes.length)
            : 0;
        const avgMarginPct = 0; // requires margin from line items joined to industry; deferred

        topStyles.forEach(([style, e], i) => {
            const sortedColors = e.colors.sort((a, b) => b.units - a.units).slice(0, 3);
            const c1 = sortedColors[0] || { color: '', units: 0 };
            const c2 = sortedColors[1] || { color: '', units: 0 };
            const c3 = sortedColors[2] || { color: '', units: 0 };
            rows.push([
                csvEscape(ind.industry), i + 1, csvEscape(style), Math.round(e.totalUnits),
                csvEscape(c1.color), c1.units,
                csvEscape(c2.color), c2.units,
                csvEscape(c3.color), c3.units,
                ind.customerCount, Math.round(ind.totalUnits), Math.round(ind.totalRevenue),
                csvEscape(exemplars),
                avgOrderSize, avgMarginPct, csvEscape(mostActiveRep),
            ]);
        });
    }
    fs.writeFileSync(OUT_INDUSTRY, rows.map(r => r.join(',')).join('\n') + '\n', 'utf8');
    log(`✓ Wrote ${OUT_INDUSTRY}: ${rows.length - 1} industry-style rows`);
}

// ── PHASE 8: Quality validation ───────────────────────────────────────────
function validate(customerAgg, styleAgg, industryAgg, matchStats, unmatchedExamples) {
    log('═══ PHASE 8: Quality validation ═══');

    // Find Absher Construction
    const absher = [...customerAgg.values()].find(c => /^absher construction/i.test(c.CustomerCompanyName.trim()));
    if (absher) {
        log(`✓ Absher Construction: ${absher.orderIds.size} orders / $${Math.round(absher.totalRevenue)} (expected ~3,693 / $278K)`);
        log(`    Customer_Type: ${absher.Customer_Type}, Tier: ${absher.Account_Tier}, Rep: ${absher.Sales_Rep}`);
        const t5 = [...absher.styleTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
        log(`    Top 5 styles: ${t5.map(([pn, u]) => pn + '(' + u + ')').join(', ')}`);
    } else {
        log('  ⚠ Absher Construction not found — match likely failed; check fuzzy match');
    }

    // PC54 style perf
    const pc54 = styleAgg.get('PC54');
    if (pc54) {
        log(`✓ PC54 style: ${Math.round(pc54.units)} units / $${Math.round(pc54.revenue)} rev / ${pc54.orderIds.size} orders / ${pc54.avgMarginPct}% margin`);
    }

    // Construction industry
    const construction = industryAgg.get('Construction');
    if (construction) {
        log(`✓ Construction industry: ${construction.customerCount} customers (expected ~3,849), ${Math.round(construction.totalUnits)} units, $${Math.round(construction.totalRevenue)}`);
    }
    const corporate = industryAgg.get('Corporate');
    if (corporate) {
        log(`✓ Corporate industry: ${corporate.customerCount} customers (expected ~6,062)`);
    }

    // Match stats
    const tot = Object.values(matchStats).reduce((a, b) => a + b, 0);
    log(`✓ Company name match coverage: ${tot - matchStats.none} / ${tot} (${(100 * (tot - matchStats.none) / tot).toFixed(1)}%)`);

    if (unmatchedExamples.length > 0) {
        log(`  Unmatched company name examples (first 30 — Erik to clean in Caspio if desired):`);
        for (const ex of unmatchedExamples) log(`     - ${ex}`);
    }
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
    fs.writeFileSync(LOG_PATH, '');
    log('═══════════════════════════════════════════════════════════════');
    log('NWCA 10-YEAR CUSTOMER INTELLIGENCE ETL');
    log('  Mode:        ' + (ARG_VALIDATE_ONLY ? 'VALIDATE-ONLY' : ARG_QUICK ? 'QUICK (no fuzzy match)' : 'FULL (with fuzzy match)'));
    log('  Contacts:    ' + CONTACTS_PATH);
    log('  Line items:  ' + LINE_ITEMS_PATH);
    log('  Bridge:      ' + BRIDGE_PATH);
    log('  SanMar bulk: ' + SANMAR_BULK_PATH);
    if (!ARG_VALIDATE_ONLY) {
        log('  Output 1:    ' + OUT_CUSTOMER);
        log('  Output 2:    ' + OUT_STYLE);
        log('  Output 3:    ' + OUT_INDUSTRY);
    }
    log('═══════════════════════════════════════════════════════════════');

    const sanmarCatalog = await loadSanmarBulkCatalog();
    const contactsResult = loadContacts();
    const orderMap = loadBridge();
    const lineItems = loadLineItems();
    const { customerAgg, styleAgg, pairCount, matchStats, unmatchedExamples } = joinData(contactsResult, orderMap, lineItems);
    annotateStyleMargins(styleAgg);
    const industryAgg = buildIndustryLookalikes(customerAgg);

    if (!ARG_VALIDATE_ONLY) {
        log('═══ PHASE 7: Writing CSVs ═══');
        writeCustomerProfilesCsv(customerAgg);
        writeStylePerformanceCsv(styleAgg, pairCount, sanmarCatalog);
        writeIndustryLookalikesCsv(industryAgg);
    }

    validate(customerAgg, styleAgg, industryAgg, matchStats, unmatchedExamples);

    log('═══════════════════════════════════════════════════════════════');
    log('✅ DONE.');
    if (!ARG_VALIDATE_ONLY) {
        log(`   3 CSVs ready in ~/Downloads/ — import to Caspio:`);
        log(`     1. Customer_Profile_10yr_2026     ← ${path.basename(OUT_CUSTOMER)}`);
        log(`     2. Sanmar_Style_Performance_10yr_2026  ← ${path.basename(OUT_STYLE)}`);
        log(`     3. Industry_Lookalikes_2026 (REPLACE rows)  ← ${path.basename(OUT_INDUSTRY)}`);
    }
}

main().catch(err => {
    log('FATAL: ' + (err.stack || err.message));
    process.exit(1);
});
