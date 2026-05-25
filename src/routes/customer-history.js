/**
 * Customer History API
 * GET /api/customer-history/:idCustomer
 *
 * Returns an aggregated profile of a customer's past 90 days of orders from
 * ManageOrders /order-pull. Used by the DTG form (and other quote builders)
 * to display a "📋 customer history" pill when a rep picks a customer.
 *
 * SCOPE (Phase 1 — 2026-05-20): READ-ONLY. The frontend uses this to
 * DISPLAY patterns and SUGGEST backfills, but never auto-fills fields.
 * After 2 weeks of real-world usage, we'll add surgical auto-fill on a
 * field-by-field basis where the signal is high and reps want it.
 *
 * Caching: 6-hour TTL keyed by idCustomer. In-memory Map; resets on dyno
 * restart. For a customer with 5 past orders the profile JSON is ~1KB,
 * so even 3000+ customers in cache = ~3MB total. Fine without Redis.
 *
 * Latency targets (verified by benchmark-mo-pull.js):
 *   Cache hit:  <50ms
 *   Cache miss: ~400-700ms (90-day MO pull + aggregation)
 */

const express = require('express');
const axios = require('axios');
const { getToken, MANAGEORDERS_PUSH_BASE_URL } = require('../../lib/manageorders-push-auth');

const router = express.Router();

// === Cache ===
// Key: `${idCustomer}:${windowDays}` — separates the 90-day DTG pill cache
// from the 365-day EMB-chat-bot cache so they don't clobber each other.
const profileCache = new Map();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

// === Constants ===
// Default window when the caller doesn't pass ?windowDays — keeps the
// existing DTG pill behavior unchanged. EMB chat bot passes ?windowDays=365.
const DEFAULT_HISTORY_WINDOW_DAYS = 90;
const MAX_HISTORY_WINDOW_DAYS = 730; // 2 years — MO retention cap

// NWCA's office / staff phone numbers that should be treated as "blank"
// for backfill purposes. If a contact's phone matches one of these, the
// real customer phone is probably missing and we should suggest a better
// value from past orders. Keep this list narrow — false positives mean
// we'd discard real customer numbers.
const NWCA_DEFAULT_PHONES = new Set([
  '253-922-5793',  // NWCA main line
  '253-229-9214',  // NWCA office secondary
  '2539225793',
  '2532299214',
]);

function normPhone(p) {
  return String(p || '').replace(/[^0-9]/g, '');
}
function isDefaultPhone(p) {
  if (!p) return true;
  const norm = normPhone(p);
  if (norm.length < 10) return true;
  // Check both formatted and stripped versions
  if (NWCA_DEFAULT_PHONES.has(p)) return true;
  if (NWCA_DEFAULT_PHONES.has(norm)) return true;
  return false;
}

// === Helpers ===

function isoDate(d) { return d.toISOString().split('T')[0]; }

/**
 * Parse MO's MM/DD/YYYY date strings to JS Date.
 * Returns null if unparseable.
 */
function parseMoDate(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  const d = new Date(`${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}T12:00:00Z`);
  return isNaN(d) ? null : d;
}

/**
 * Pull all orders from MO for a date range, then filter in-memory to the
 * specified id_Customer. /order-pull doesn't accept a customer filter param,
 * but 90 days of orders is small enough to scan locally.
 */
async function pullCustomerOrders(idCustomer, dateFrom, dateTo) {
  const token = await getToken();
  const r = await axios.get(`${MANAGEORDERS_PUSH_BASE_URL}/order-pull`, {
    params: { date_from: dateFrom, date_to: dateTo },
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    timeout: 30000,
  });
  const all = r.data?.result || [];
  return all.filter(o => Number(o.id_Customer) === Number(idCustomer));
}

// === Brand + category inference (string heuristics on PartNumber + PartDescription) ===
// Used by aggregateProfile() to roll up the customer's purchases into
// brand-level and category-level totals for the bot tool.
function guessBrand(basePartNumber, description) {
  const pn = String(basePartNumber || '').toUpperCase();
  const desc = String(description || '').toLowerCase();
  // Order matters — longest prefix wins
  if (pn.startsWith('NKDC') || pn.startsWith('NKBV') || pn.startsWith('NKAQ') || /\bnike\b/i.test(desc)) return 'Nike';
  if (pn.startsWith('CTK') || pn.startsWith('CT') || /\bcarhartt\b/i.test(desc)) return 'Carhartt';
  if (pn.startsWith('TM1M') || pn.startsWith('TM1L') || /\btravismathew\b/i.test(desc)) return 'TravisMathew';
  if (pn.startsWith('LST') || pn.startsWith('ST') || /\bsport-tek\b/i.test(desc)) return 'Sport-Tek';
  if (pn.startsWith('LPC') || pn.startsWith('PC') || /\bport\s*&?\s*(co|company)\b/i.test(desc)) return 'Port & Co';
  if (pn.startsWith('L') && pn.match(/^L\d/)) return 'Port Authority'; // L500, L474 etc — Port Auth ladies polos
  if (pn.startsWith('K') && pn.match(/^K\d/)) return 'Port Authority'; // K500, K100 etc
  if (pn.startsWith('J') && pn.match(/^J\d/)) return 'Port Authority'; // J317, J329 etc — jackets
  if (pn.startsWith('C') && pn.match(/^C\d/)) return 'Port Authority'; // C402, C865 etc — caps
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
  if (pn.match(/^11[12]/) || /\brichardson\b/i.test(desc)) return 'Richardson';
  if (pn.match(/^(VL|LVL)/) || /\bvolunteer\b/i.test(desc)) return 'Volunteer Knitwear';
  if (pn.match(/^G\d/) || /\bgildan\b/i.test(desc)) return 'Gildan';
  if (pn.match(/^\d{3,4}M$/) || /\bjerzees\b/i.test(desc)) return 'Jerzees';
  return null;
}

function guessCategory(description) {
  const d = String(description || '').toLowerCase();
  if (/\b(hood|hooded|sweatshirt|fleece pullover|fleece\s+hooded)\b/.test(d)) return 'Hoodie/Sweatshirt';
  if (/\b(t-shirt|tee\b|crew\s+neck|ringer)\b/.test(d)) return 'T-Shirt';
  if (/\bpolo\b/.test(d)) return 'Polo';
  if (/\b(cap|hat|trucker|snapback|fitted|beanie)\b/.test(d)) return 'Cap/Hat';
  if (/\b(jacket|vest|softshell|soft\s+shell|parka|coat|fleece\s+vest)\b/.test(d)) return 'Jacket/Outerwear';
  if (/\b(woven|button|oxford|denim|flannel)\b/.test(d)) return 'Woven Shirt';
  if (/\b(bag|backpack|tote|duffel|cooler)\b/.test(d)) return 'Bag';
  if (/\b(apron|smock)\b/.test(d)) return 'Apron';
  if (/\b(pant|jogger|short|legging|sweatpant)\b/.test(d)) return 'Pant/Short';
  return null;
}

/**
 * Find most common value in an array, with tiebreak to most-recent
 * (assumes input is sorted newest-first). Returns null for empty arrays.
 */
function mostCommon(arr) {
  if (!arr || !arr.length) return null;
  const counts = new Map();
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v == null || v === '') continue;
    if (!counts.has(v)) counts.set(v, { count: 0, lastIdx: i });
    counts.get(v).count++;
  }
  if (!counts.size) return null;
  // Sort by count DESC, then by lastIdx ASC (more recent = lower idx since input is newest-first)
  let best = null;
  for (const [val, { count, lastIdx }] of counts) {
    if (!best || count > best.count || (count === best.count && lastIdx < best.lastIdx)) {
      best = { val, count, lastIdx };
    }
  }
  return best.val;
}

/**
 * Aggregate orders into a profile.
 */
function aggregateProfile(orders, idCustomer) {
  if (!orders || !orders.length) {
    return {
      idCustomer,
      orderCount: 0,
      hasHistory: false,
    };
  }

  // Sort newest-first by date_OrderPlaced
  const sorted = orders
    .map(o => ({ ...o, _parsed: parseMoDate(o.date_OrderPlaced) }))
    .filter(o => o._parsed)
    .sort((a, b) => b._parsed - a._parsed);

  if (!sorted.length) {
    return { idCustomer, orderCount: orders.length, hasHistory: true, dateParsingFailed: true };
  }

  // Use the most recent 5 orders for behavioral patterns (avoids ancient
  // outliers; if customer changed terms 8 orders ago, we follow the new
  // pattern after just a few orders).
  const recent = sorted.slice(0, 5);

  // --- Behavioral aggregations ---
  const topTerms = mostCommon(recent.map(o => o.Terms));
  const topShipMethod = mostCommon(
    recent.flatMap(o =>
      (o.ShippingAddresses || []).map(s => s.ShipMethod).filter(Boolean)
    )
  );

  // Last design # used (from most recent order with a design)
  let lastDesignId = null;
  let lastDesignName = null;
  for (const o of sorted) {
    const d = (o.Designs || []).find(x => x.id_Design);
    if (d) {
      lastDesignId = d.id_Design;
      lastDesignName = d.DesignName || null;
      break;
    }
  }

  // === Top items / brands / categories ===
  // Bump scan to LAST 50 orders (used to be 20) — 1-year window pulls more
  // history, so widen the sample for richer signal.
  const recentForItems = sorted.slice(0, 50);

  // Top 5 (style, color) combos by UNIT volume (was top 3 by frequency).
  // Unit volume is a better signal — one big order shouldn't be eclipsed by
  // five 1-piece reorders. Strip size suffix so PC54_2X aggregates with PC54.
  const SIZE_SUFFIX_RE = /_(?:XS|S|M|L|XL|2XL|3XL|4XL|5XL|6XL|2X|3X|4X|5X|6X|OSFA|S\/M|M\/L|L\/XL|X\/L|XLT|XXLT|2XLT|3XLT)$/i;
  function stripSize(pn) {
    let p = String(pn || '').trim().toUpperCase();
    while (SIZE_SUFFIX_RE.test(p)) {
      const next = p.replace(SIZE_SUFFIX_RE, '');
      if (next === p || !next) break;
      p = next;
    }
    return p;
  }
  function lineUnits(l) {
    const lq = Number(l.Qty) || Number(l.LineQuantity) || 0;
    if (lq > 0) return lq;
    let s = 0;
    for (let i = 1; i <= 6; i++) s += Number(l[`Size0${i}`]) || 0;
    return s;
  }

  const itemUnits = new Map(); // "BASE|color" → units
  const brandUnits = new Map(); // brand → units
  const categoryUnits = new Map(); // category → units
  for (const o of recentForItems) {
    for (const li of (o.LinesOE || [])) {
      const base = stripSize(li.PartNumber);
      const color = String(li.Color || '').trim();
      const units = lineUnits(li);
      if (!base || units <= 0) continue;
      itemUnits.set(`${base}|${color}`, (itemUnits.get(`${base}|${color}`) || 0) + units);
      const brand = guessBrand(base, li.PartDescription);
      if (brand) brandUnits.set(brand, (brandUnits.get(brand) || 0) + units);
      const cat = guessCategory(li.PartDescription);
      if (cat) categoryUnits.set(cat, (categoryUnits.get(cat) || 0) + units);
    }
  }

  const topItems = [...itemUnits.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([key, units]) => {
      const [partNumber, color] = key.split('|');
      return { partNumber, color, units };
    });
  const topBrands = [...brandUnits.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([brand, units]) => ({ brand, units }));
  const topCategories = [...categoryUnits.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([category, units]) => ({ category, units }));

  // === Spend stats ===
  const totalRevenue = sorted.reduce((sum, o) => sum + (Number(o.cur_TotalInvoice) || Number(o.cnCur_TotalInvoice) || 0), 0);
  const avgOrderSize = sorted.length > 0 ? Math.round(totalRevenue / sorted.length) : 0;

  // --- Contact backfill candidates ---
  // From the most recent N orders, find any contact field with a non-default
  // value. We pick "most-recent valid" rather than "most-common" — phone
  // changes happen, and the latest value is usually the right one.
  const contactBackfill = {};
  for (const o of sorted) {
    if (!contactBackfill.phone && o.ContactPhone && !isDefaultPhone(o.ContactPhone)) {
      contactBackfill.phone = o.ContactPhone;
      contactBackfill.phoneFromOrderDate = o.date_OrderPlaced;
    }
    if (!contactBackfill.email && o.ContactEmail) {
      contactBackfill.email = o.ContactEmail;
      contactBackfill.emailFromOrderDate = o.date_OrderPlaced;
    }
    if (!contactBackfill.firstName && o.ContactNameFirst) {
      contactBackfill.firstName = o.ContactNameFirst;
    }
    if (!contactBackfill.lastName && o.ContactNameLast) {
      contactBackfill.lastName = o.ContactNameLast;
    }
    if (contactBackfill.phone && contactBackfill.email && contactBackfill.firstName) break;
  }

  // --- Last ship-to address (non-pickup) ---
  let lastShipTo = null;
  for (const o of sorted) {
    const ship = (o.ShippingAddresses || [])[0];
    if (ship && ship.ShipMethod && ship.ShipMethod !== 'Customer Pickup' && ship.ShipAddress01) {
      lastShipTo = {
        address1: ship.ShipAddress01 || '',
        address2: ship.ShipAddress02 || '',
        city: ship.ShipCity || '',
        state: ship.ShipState || '',
        zip: ship.ShipZip || '',
        fromOrderDate: o.date_OrderPlaced,
      };
      break;
    }
  }

  // --- Dates ---
  const lastOrderDate = sorted[0].date_OrderPlaced;
  const firstOrderDate = sorted[sorted.length - 1].date_OrderPlaced;
  const lastOrderDaysAgo = Math.round((Date.now() - sorted[0]._parsed.getTime()) / 86400000);

  return {
    idCustomer,
    hasHistory: true,
    orderCount: sorted.length,
    firstOrderDate,
    lastOrderDate,
    lastOrderDaysAgo,
    // Behavioral
    topTerms,
    topShipMethod,
    lastDesignId,
    lastDesignName,
    topItems,
    topBrands,        // NEW (EMB Smart A1) — bot grounds brand recommendations
    topCategories,    // NEW (EMB Smart A1) — bot grounds category recommendations
    totalRevenue,     // NEW (EMB Smart A1)
    avgOrderSize,     // NEW (EMB Smart A1)
    // Backfill candidates
    contactBackfill,
    lastShipTo,
  };
}

// === Routes ===

/**
 * GET /api/customer-history/:idCustomer
 *
 * Response:
 * {
 *   idCustomer: 107,
 *   hasHistory: true,
 *   orderCount: 12,
 *   lastOrderDate: "05/14/2026",
 *   lastOrderDaysAgo: 6,
 *   topTerms: "Net 10",
 *   topShipMethod: "Customer Pickup",
 *   lastDesignId: 37603,
 *   lastDesignName: "Star Sportswear — DTG",
 *   topItems: [{ partNumber: "PC61", color: "Red", count: 8 }, ...],
 *   contactBackfill: {
 *     phone: "206-555-0142",         // suggested if Caspio phone is blank/default
 *     email: "brucea@starsportswear.com",
 *     firstName: "Bruce",
 *     lastName: "Amundson"
 *   },
 *   lastShipTo: { address1, city, state, zip, fromOrderDate },  // if any non-pickup history
 *   _source: "cache" | "live"
 * }
 */
router.get('/customer-history/:idCustomer', async (req, res) => {
  const idCustomer = Number(req.params.idCustomer);
  if (!Number.isInteger(idCustomer) || idCustomer <= 0) {
    return res.status(400).json({ error: 'idCustomer must be a positive integer' });
  }

  // Parse + clamp the window. Default 90d preserves the existing DTG pill
  // behavior. EMB chat bot passes ?windowDays=365.
  const requestedWindow = parseInt(req.query.windowDays, 10);
  const windowDays = (Number.isFinite(requestedWindow) && requestedWindow > 0)
    ? Math.min(requestedWindow, MAX_HISTORY_WINDOW_DAYS)
    : DEFAULT_HISTORY_WINDOW_DAYS;

  // Cache key includes window so 90-day + 365-day responses don't clobber.
  const cacheKey = `${idCustomer}:${windowDays}`;
  const cached = profileCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) {
    return res.json({ ...cached.profile, windowDays, _source: 'cache', _cachedAt: new Date(cached.ts).toISOString() });
  }

  // Cache miss — pull from MO
  try {
    const today = new Date();
    const past = new Date(today);
    past.setDate(past.getDate() - windowDays);

    const t0 = Date.now();
    const orders = await pullCustomerOrders(idCustomer, isoDate(past), isoDate(today));
    const profile = aggregateProfile(orders, idCustomer);
    const elapsed = Date.now() - t0;

    profileCache.set(cacheKey, { ts: Date.now(), profile });

    res.json({ ...profile, windowDays, _source: 'live', _elapsedMs: elapsed });
  } catch (err) {
    console.error(`[customer-history] error for idCustomer=${idCustomer} windowDays=${windowDays}:`, err.message);
    // Graceful failure — return empty profile so frontend just doesn't show the pill
    res.json({ idCustomer, hasHistory: false, error: err.message, windowDays, _source: 'error' });
  }
});

/**
 * GET /api/customer-history/cache/clear
 * Admin tool — invalidate the cache (useful after manual MO order edits).
 */
router.get('/customer-history/cache/clear', (req, res) => {
  const n = profileCache.size;
  profileCache.clear();
  res.json({ cleared: n });
});

module.exports = router;
