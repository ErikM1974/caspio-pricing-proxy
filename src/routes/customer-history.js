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
const profileCache = new Map(); // idCustomer (number) → { ts, profile }
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

// === Constants ===
const HISTORY_WINDOW_DAYS = 90;

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

  // Top 3 (style, color) combos by frequency, across last 20 orders
  const styleColorPairs = sorted.slice(0, 20).flatMap(o =>
    (o.LinesOE || [])
      .filter(l => l.PartNumber && l.Color)
      .map(l => `${l.PartNumber}|${l.Color}`)
  );
  const pairCounts = new Map();
  for (const p of styleColorPairs) {
    pairCounts.set(p, (pairCounts.get(p) || 0) + 1);
  }
  const topItems = Array.from(pairCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([key, count]) => {
      const [partNumber, color] = key.split('|');
      return { partNumber, color, count };
    });

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

  // Cache hit
  const cached = profileCache.get(idCustomer);
  if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) {
    return res.json({ ...cached.profile, _source: 'cache', _cachedAt: new Date(cached.ts).toISOString() });
  }

  // Cache miss — pull from MO
  try {
    const today = new Date();
    const past = new Date(today);
    past.setDate(past.getDate() - HISTORY_WINDOW_DAYS);

    const t0 = Date.now();
    const orders = await pullCustomerOrders(idCustomer, isoDate(past), isoDate(today));
    const profile = aggregateProfile(orders, idCustomer);
    const elapsed = Date.now() - t0;

    profileCache.set(idCustomer, { ts: Date.now(), profile });

    res.json({ ...profile, _source: 'live', _elapsedMs: elapsed });
  } catch (err) {
    console.error('[customer-history] error for idCustomer=' + idCustomer + ':', err.message);
    // Graceful failure — return empty profile so frontend just doesn't show the pill
    res.json({ idCustomer, hasHistory: false, error: err.message, _source: 'error' });
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
