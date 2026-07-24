// Sticker pricing route — backs the contract sticker AI page + order-form Sticker method.
//
// Source of truth: Caspio table `Sticker_Pricing` (50 rows = 5 sizes × 10 qty tiers).
// Each row has a unique PartNumber (STK-{SIZE}-{QTY}) — used by the AI chat to quote
// line items and by ShopWorks push on customer accept.
//
// When the table doesn't exist yet, the route falls back to an inline grid that mirrors
// /calculators/sticker-manual-pricing.html. CSV for import: erik\Downloads\
// sticker-pricing-caspio-import.csv (50 rows). Once imported, the inline fallback can be
// removed in a follow-up.
//
// 2026-05-15: Added PartNumber field + 6x6 tier (10 SKUs, extrapolated from existing
// curve, qty-10000 manually capped at $12,000 to preserve volume-discount monotonicity).

const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages } = require('../utils/caspio');
const { createTtlCache, shouldBypass } = require('../utils/ttl-cache');

// 15-minute grid cache — takes sticker Caspio reads from O(pageviews) to ~4/hour
// per dyno, which is what makes a public zero-click configurator affordable
// against the account quota. Only verified-complete Caspio payloads are cached
// (see loadGrid) — the inline fallback and the degraded PartNumber-retry path
// are NEVER pinned, or a 30-second Caspio blip would freeze fallback prices in
// memory for 15 minutes with no signal (Erik's Rule 4).
const gridCache = createTtlCache({ name: 'sticker-grid', ttlMs: 15 * 60 * 1000, maxEntries: 4 });
const GRID_CACHE_KEY = 'sticker-grid-v1';

// Inline fallback — keep in sync with shared_components/js/sticker-pricing-service.js
// and calculators/sticker-manual-pricing.html.
const INLINE_GRID = [
  { PartNumber: 'STK-2X2-50',    Size: '2x2', Quantity: 50,    TotalPrice: 87.00,    PricePerSticker: 1.74, IsBestValue: false },
  { PartNumber: 'STK-2X2-100',   Size: '2x2', Quantity: 100,   TotalPrice: 104.00,   PricePerSticker: 1.04, IsBestValue: false },
  { PartNumber: 'STK-2X2-200',   Size: '2x2', Quantity: 200,   TotalPrice: 140.00,   PricePerSticker: 0.70, IsBestValue: true  },
  { PartNumber: 'STK-2X2-300',   Size: '2x2', Quantity: 300,   TotalPrice: 186.00,   PricePerSticker: 0.62, IsBestValue: false },
  { PartNumber: 'STK-2X2-500',   Size: '2x2', Quantity: 500,   TotalPrice: 234.00,   PricePerSticker: 0.47, IsBestValue: false },
  { PartNumber: 'STK-2X2-1000',  Size: '2x2', Quantity: 1000,  TotalPrice: 408.00,   PricePerSticker: 0.41, IsBestValue: false },
  { PartNumber: 'STK-2X2-2000',  Size: '2x2', Quantity: 2000,  TotalPrice: 654.00,   PricePerSticker: 0.33, IsBestValue: false },
  { PartNumber: 'STK-2X2-3000',  Size: '2x2', Quantity: 3000,  TotalPrice: 874.00,   PricePerSticker: 0.29, IsBestValue: false },
  { PartNumber: 'STK-2X2-5000',  Size: '2x2', Quantity: 5000,  TotalPrice: 1275.00,  PricePerSticker: 0.26, IsBestValue: false },
  { PartNumber: 'STK-2X2-10000', Size: '2x2', Quantity: 10000, TotalPrice: 2158.00,  PricePerSticker: 0.22, IsBestValue: false },
  { PartNumber: 'STK-3X3-50',    Size: '3x3', Quantity: 50,    TotalPrice: 98.00,    PricePerSticker: 1.96, IsBestValue: false },  // 2026-05-29: was 128.00/2.56 — broke volume monotonicity (50 cost more than 100). Lowered onto the curve.
  { PartNumber: 'STK-3X3-100',   Size: '3x3', Quantity: 100,   TotalPrice: 124.00,   PricePerSticker: 1.24, IsBestValue: false },
  { PartNumber: 'STK-3X3-200',   Size: '3x3', Quantity: 200,   TotalPrice: 234.00,   PricePerSticker: 1.17, IsBestValue: true  },
  { PartNumber: 'STK-3X3-300',   Size: '3x3', Quantity: 300,   TotalPrice: 296.00,   PricePerSticker: 0.99, IsBestValue: false },
  { PartNumber: 'STK-3X3-500',   Size: '3x3', Quantity: 500,   TotalPrice: 406.00,   PricePerSticker: 0.81, IsBestValue: false },
  { PartNumber: 'STK-3X3-1000',  Size: '3x3', Quantity: 1000,  TotalPrice: 656.00,   PricePerSticker: 0.66, IsBestValue: false },
  { PartNumber: 'STK-3X3-2000',  Size: '3x3', Quantity: 2000,  TotalPrice: 1089.00,  PricePerSticker: 0.54, IsBestValue: false },
  { PartNumber: 'STK-3X3-3000',  Size: '3x3', Quantity: 3000,  TotalPrice: 1482.00,  PricePerSticker: 0.49, IsBestValue: false },
  { PartNumber: 'STK-3X3-5000',  Size: '3x3', Quantity: 5000,  TotalPrice: 2199.00,  PricePerSticker: 0.44, IsBestValue: false },
  { PartNumber: 'STK-3X3-10000', Size: '3x3', Quantity: 10000, TotalPrice: 3790.00,  PricePerSticker: 0.38, IsBestValue: false },
  { PartNumber: 'STK-4X4-50',    Size: '4x4', Quantity: 50,    TotalPrice: 153.00,   PricePerSticker: 3.06, IsBestValue: false },
  { PartNumber: 'STK-4X4-100',   Size: '4x4', Quantity: 100,   TotalPrice: 212.00,   PricePerSticker: 2.12, IsBestValue: false },
  { PartNumber: 'STK-4X4-200',   Size: '4x4', Quantity: 200,   TotalPrice: 294.00,   PricePerSticker: 1.47, IsBestValue: true  },
  { PartNumber: 'STK-4X4-300',   Size: '4x4', Quantity: 300,   TotalPrice: 378.00,   PricePerSticker: 1.26, IsBestValue: false },
  { PartNumber: 'STK-4X4-500',   Size: '4x4', Quantity: 500,   TotalPrice: 544.00,   PricePerSticker: 1.09, IsBestValue: false },
  { PartNumber: 'STK-4X4-1000',  Size: '4x4', Quantity: 1000,  TotalPrice: 962.00,   PricePerSticker: 0.96, IsBestValue: false },
  { PartNumber: 'STK-4X4-2000',  Size: '4x4', Quantity: 2000,  TotalPrice: 1630.00,  PricePerSticker: 0.82, IsBestValue: false },
  { PartNumber: 'STK-4X4-3000',  Size: '4x4', Quantity: 3000,  TotalPrice: 2236.00,  PricePerSticker: 0.75, IsBestValue: false },
  { PartNumber: 'STK-4X4-5000',  Size: '4x4', Quantity: 5000,  TotalPrice: 3346.00,  PricePerSticker: 0.67, IsBestValue: false },
  { PartNumber: 'STK-4X4-10000', Size: '4x4', Quantity: 10000, TotalPrice: 5846.00,  PricePerSticker: 0.58, IsBestValue: false },
  { PartNumber: 'STK-5X5-50',    Size: '5x5', Quantity: 50,    TotalPrice: 183.00,   PricePerSticker: 3.66, IsBestValue: false },
  { PartNumber: 'STK-5X5-100',   Size: '5x5', Quantity: 100,   TotalPrice: 266.00,   PricePerSticker: 2.66, IsBestValue: false },
  { PartNumber: 'STK-5X5-200',   Size: '5x5', Quantity: 200,   TotalPrice: 412.00,   PricePerSticker: 2.06, IsBestValue: true  },
  { PartNumber: 'STK-5X5-300',   Size: '5x5', Quantity: 300,   TotalPrice: 536.00,   PricePerSticker: 1.79, IsBestValue: false },
  { PartNumber: 'STK-5X5-500',   Size: '5x5', Quantity: 500,   TotalPrice: 784.00,   PricePerSticker: 1.57, IsBestValue: false },
  { PartNumber: 'STK-5X5-1000',  Size: '5x5', Quantity: 1000,  TotalPrice: 1322.00,  PricePerSticker: 1.32, IsBestValue: false },
  { PartNumber: 'STK-5X5-2000',  Size: '5x5', Quantity: 2000,  TotalPrice: 2266.00,  PricePerSticker: 1.13, IsBestValue: false },
  { PartNumber: 'STK-5X5-3000',  Size: '5x5', Quantity: 3000,  TotalPrice: 3123.00,  PricePerSticker: 1.04, IsBestValue: false },
  { PartNumber: 'STK-5X5-5000',  Size: '5x5', Quantity: 5000,  TotalPrice: 4694.00,  PricePerSticker: 0.94, IsBestValue: false },
  { PartNumber: 'STK-5X5-10000', Size: '5x5', Quantity: 10000, TotalPrice: 8892.00,  PricePerSticker: 0.89, IsBestValue: false },
  // 6x6 — extrapolated from 3x3/4x4/5x5 curve at each qty (quadratic next-step formula),
  // qty=10000 manually capped at $12,000 to preserve volume-discount monotonicity.
  { PartNumber: 'STK-6X6-50',    Size: '6x6', Quantity: 50,    TotalPrice: 218.00,   PricePerSticker: 4.36, IsBestValue: false },
  { PartNumber: 'STK-6X6-100',   Size: '6x6', Quantity: 100,   TotalPrice: 383.00,   PricePerSticker: 3.83, IsBestValue: false },  // 2026-05-29: was 286.00/2.86 — under-extrapolated (only 7.5% over 5x5-100 despite 44% more area), made 200 cost less/pc. Raised to area-scaled.
  { PartNumber: 'STK-6X6-200',   Size: '6x6', Quantity: 200,   TotalPrice: 588.00,   PricePerSticker: 2.94, IsBestValue: true  },
  { PartNumber: 'STK-6X6-300',   Size: '6x6', Quantity: 300,   TotalPrice: 774.00,   PricePerSticker: 2.58, IsBestValue: false },
  { PartNumber: 'STK-6X6-500',   Size: '6x6', Quantity: 500,   TotalPrice: 1125.00,  PricePerSticker: 2.25, IsBestValue: false },
  { PartNumber: 'STK-6X6-1000',  Size: '6x6', Quantity: 1000,  TotalPrice: 1740.00,  PricePerSticker: 1.74, IsBestValue: false },
  { PartNumber: 'STK-6X6-2000',  Size: '6x6', Quantity: 2000,  TotalPrice: 2940.00,  PricePerSticker: 1.47, IsBestValue: false },
  { PartNumber: 'STK-6X6-3000',  Size: '6x6', Quantity: 3000,  TotalPrice: 4080.00,  PricePerSticker: 1.36, IsBestValue: false },
  { PartNumber: 'STK-6X6-5000',  Size: '6x6', Quantity: 5000,  TotalPrice: 6250.00,  PricePerSticker: 1.25, IsBestValue: false },
  { PartNumber: 'STK-6X6-10000', Size: '6x6', Quantity: 10000, TotalPrice: 12000.00, PricePerSticker: 1.20, IsBestValue: false },
];

const SETUP_FEE_PART = 'GRT-50';
const SETUP_FEE_AMOUNT = 50.00;

// 🔴 The unit price is ALWAYS derived as TotalPrice / Quantity — never the stored
// `PricePerSticker`. That Caspio column is truncated to 2dp and **26 of the 50
// rows do not reconcile**: STK-4X4-10000 publishes $0.58, which multiplies back
// to $5,800 against a real TotalPrice of $5,846 (a $46 gap). Any surface that
// shows a total and a per-unit side by side invites the customer to multiply, so
// the derived value is the only safe one to publish. TotalPrice is untouched —
// this corrects a *display* inconsistency, not a rate.
function deriveUnitPrice(row) {
  const qty = Number(row.Quantity) || 0;
  return qty > 0 ? Number(row.TotalPrice) / qty : 0;
}

// Adds the two fields a quantity ladder needs, so no consumer has to compute a
// price in the browser (Erik's iron rule — see pages/js/fall-catalog-2026.js:15).
//   unitPrice   — full-precision TotalPrice / Quantity
//   savingsPct  — % better per-piece than this size's SMALLEST tier; the first
//                 tier is always null (never badge the baseline against itself).
function decorateGrid(grid) {
  const bySize = {};
  for (const row of grid) {
    row.unitPrice = deriveUnitPrice(row);
    (bySize[row.Size] = bySize[row.Size] || []).push(row);
  }
  for (const size of Object.keys(bySize)) {
    const rows = bySize[size].sort((a, b) => a.Quantity - b.Quantity);
    const baseline = rows.length ? rows[0].unitPrice : 0;
    rows.forEach((row, i) => {
      row.savingsPct = (i === 0 || !(baseline > 0))
        ? null
        : Math.round((1 - row.unitPrice / baseline) * 100);
    });
  }
  return grid;
}

// "Best Value" badge — computed per size as the KNEE of the price-per-piece
// curve, NOT a hard-coded quantity. For each size we take the % per-piece
// improvement between consecutive tiers, then flag the tier where that
// improvement decelerates most (the curve goes from steep → flat). This
// overrides any stored/inline IsBestValue so the badge stays honest as prices
// change, and never lands on a tier that's pricier-per-piece than the next one.
// With the current grid this resolves to: 2x2/4x4/5x5/6x6 → 200, 3x3 → 100.
//
// 2026-07-24: switched from the stored PricePerSticker to the derived unitPrice
// (see deriveUnitPrice). Verified no behaviour change on the current grid — the
// five knees are identical either way — but the badge must not be decided by a
// field that doesn't reconcile with its own total.
function computeBestValue(grid) {
  const bySize = {};
  for (const row of grid) {
    row.IsBestValue = false;
    (bySize[row.Size] = bySize[row.Size] || []).push(row);
  }
  for (const size of Object.keys(bySize)) {
    const rows = bySize[size].sort((a, b) => a.Quantity - b.Quantity);
    if (rows.length === 0) continue;
    if (rows.length < 3) { rows[rows.length - 1].IsBestValue = true; continue; }
    // imp[i] = fractional per-piece improvement going from tier i to tier i+1.
    const imp = [];
    for (let i = 0; i < rows.length - 1; i++) {
      const prev = deriveUnitPrice(rows[i]);
      const next = deriveUnitPrice(rows[i + 1]);
      imp[i] = prev > 0 ? (prev - next) / prev : 0;
    }
    // Knee = the tier where the savings decelerate most (imp[i-1] - imp[i] max).
    let kneeIdx = rows.length - 1;
    let bestDecel = -Infinity;
    for (let i = 1; i < rows.length - 1; i++) {
      const decel = imp[i - 1] - imp[i];
      if (decel > bestDecel) { bestDecel = decel; kneeIdx = i; }
    }
    rows[kneeIdx].IsBestValue = true;
  }
  return grid;
}

// Pre-computed sorted size list (used by AI's quote_sticker_price tool for bounding-box lookups).
const STANDARD_SIZES = ['2x2', '3x3', '4x4', '5x5', '6x6'];
const STANDARD_QTYS = [50, 100, 200, 300, 500, 1000, 2000, 3000, 5000, 10000];

/**
 * Load the pricing grid. Tries Caspio first; falls back to INLINE_GRID on any
 * error. Handles the pre-CSV-import window where the PartNumber column doesn't
 * exist yet by retrying without it and deriving PartNumber from Size+Qty.
 *
 * Returns { grid: [...], source: 'caspio' | 'inline', degraded: boolean }.
 *
 * `degraded` is true when the PartNumber-retry path fired — the payload still
 * says source:'caspio' but the part numbers were reconstructed rather than read,
 * so it must not be cached (ttl-cache.js:11-14).
 *
 * Callers on an HTTP path pass { bypassCache: shouldBypass(req) } so `?refresh=true`
 * works; the AI tool has no `req` in scope and passes nothing.
 */
async function loadGrid({ bypassCache = false } = {}) {
  if (!bypassCache) {
    const hit = gridCache.get(GRID_CACHE_KEY);
    // Clone on read — computeBestValue/decorateGrid mutate rows in place, and a
    // caller must never be able to scribble on the cached copy.
    if (hit) return { grid: hit.grid.map(r => ({ ...r })), source: hit.source, degraded: false };
  }

  let degraded = false;
  try {
    let rows;
    try {
      rows = await fetchAllCaspioPages('/tables/Sticker_Pricing/records', {
        'q.select': 'PartNumber,Size,Quantity,TotalPrice,PricePerSticker,IsBestValue',
        'q.pageSize': 200,
      });
    } catch (innerErr) {
      console.warn('[sticker-pricing] PartNumber column missing, deriving from Size+Qty:', innerErr.message);
      degraded = true;
      rows = await fetchAllCaspioPages('/tables/Sticker_Pricing/records', {
        'q.select': 'Size,Quantity,TotalPrice,PricePerSticker,IsBestValue',
        'q.pageSize': 200,
      });
    }
    if (Array.isArray(rows) && rows.length) {
      const isTruthy = v => v === true || v === 1 || v === '1'
        || (typeof v === 'string' && /^(yes|y|true)$/i.test(v.trim()));
      const grid = rows
        .map(r => {
          const size = String(r.Size || '').trim();
          const qty = Number(r.Quantity) || 0;
          const partNumber = String(r.PartNumber || '').trim()
            || (size && qty ? `STK-${size.toUpperCase()}-${qty}` : '');
          return {
            PartNumber: partNumber,
            Size: size,
            Quantity: qty,
            TotalPrice: Number(r.TotalPrice) || 0,
            PricePerSticker: Number(r.PricePerSticker) || 0,
            IsBestValue: isTruthy(r.IsBestValue),
          };
        })
        .filter(r => r.PartNumber && r.Size && r.Quantity > 0)
        .sort((a, b) => a.Size.localeCompare(b.Size) || a.Quantity - b.Quantity);
      const ready = decorateGrid(computeBestValue(grid));
      // Cache ONLY a verified-complete Caspio read. Never the degraded retry.
      if (!degraded) {
        gridCache.set(GRID_CACHE_KEY, { grid: ready.map(r => ({ ...r })), source: 'caspio' });
      }
      return { grid: ready, source: 'caspio', degraded };
    }
  } catch (err) {
    console.warn('[sticker-pricing] Caspio fetch failed, falling back to inline:', err.message);
  }
  // Clone the inline rows so computeBestValue doesn't mutate the module-level const.
  // Never cached — an inline payload pinned for 15 minutes is a silent stale price.
  return {
    grid: decorateGrid(computeBestValue(INLINE_GRID.map(r => ({ ...r })))),
    source: 'inline',
    degraded: false,
  };
}

router.get('/sticker-pricing', async (req, res) => {
  const { grid, source, degraded } = await loadGrid({ bypassCache: shouldBypass(req) });
  // no-cache (not max-age): there is no CDN in front of this — Heroku serves it
  // direct — so a max-age would be a *browser* cache that neither ?refresh=true
  // nor /api/product-cache/clear can flush. Erik edits a price in Caspio and a
  // warm tab would keep showing the old ladder with no signal. The ETag still
  // gives us 304s, with zero staleness.
  res.set('Cache-Control', 'no-cache');
  res.json({
    grid,
    setupFee: {
      partNumber: SETUP_FEE_PART,
      amount: SETUP_FEE_AMOUNT,
      description: 'Art Setup Fee — one-time charge for new artwork',
    },
    standardSizes: STANDARD_SIZES,
    standardQtys: STANDARD_QTYS,
    source,
    degraded,
  });
});

/**
 * Rush production multiplier — a modifier shared with banners and decals, so it
 * lives in ONE place: the RUSH-25PCT row of Banner_Pricing. Falls back to the
 * documented 1.25 only if that module is unreachable.
 */
async function resolveRushMultiplier() {
  try {
    const { loadBannerRates } = require('./banner-pricing');
    const { rates } = await loadBannerRates();
    const rushRow = rates.find(r => r.PartNumber === 'RUSH-25PCT');
    return rushRow ? Number(rushRow.Rate) : 1.25;
  } catch (e) {
    return 1.25;
  }
}

/**
 * 🔒 THE single sticker pricing engine. Pure — no I/O, no HTTP, no wire format.
 *
 * Both the HTTP route below and the AI's quote_sticker_price tool call this, so
 * a customer, a rep and the bot can never be quoted three different numbers for
 * the same ask. Callers map the returned `kind` to their own response shape
 * (the route 400s on bad input, the AI returns an {error} object, and only the
 * AI emits the useTool/escalation hand-off to the decal tool).
 *
 * Rules applied, both matching the published sheet:
 *   - bounding box: the LARGER dimension rounds UP to the next standard square
 *   - quantity:     rounds UP to the next standard tier (NEVER down — rounding
 *                   down would quote below the published card)
 */
function quoteStickerFromGrid({ width, height, qty, grid, rushMultiplier = null }) {
  const widthRaw = Number(width);
  const heightRaw = Number(height);
  const qtyRaw = Math.trunc(Number(qty));

  if (!Number.isFinite(widthRaw) || widthRaw <= 0
      || !Number.isFinite(heightRaw) || heightRaw <= 0
      || !Number.isFinite(qtyRaw) || qtyRaw <= 0) {
    return { ok: false, kind: 'bad_input', received: { width, height, qty } };
  }

  const requested = { width: widthRaw, height: heightRaw, qty: qtyRaw };

  const maxDim = Math.max(widthRaw, heightRaw);
  const boundingSize = STANDARD_SIZES.find(s => parseInt(s.split('x')[0], 10) >= maxDim);
  if (!boundingSize) {
    return { ok: false, kind: 'oversize_dimension', maxDim, requested };
  }

  const roundedQty = STANDARD_QTYS.find(q => q >= qtyRaw);
  if (!roundedQty) {
    return { ok: false, kind: 'oversize_quantity', requested };
  }

  const match = (grid || []).find(row => row.Size === boundingSize && row.Quantity === roundedQty);
  if (!match) {
    return { ok: false, kind: 'lookup_failed', boundingSize, roundedQty, requested };
  }

  const rushApplied = Number.isFinite(rushMultiplier) && rushMultiplier > 0;
  const totalPrice = rushApplied
    ? Math.round(match.TotalPrice * rushMultiplier * 100) / 100
    : match.TotalPrice;

  return {
    ok: true,
    row: match,
    partNumber: match.PartNumber,
    size: match.Size,
    quantity: match.Quantity,
    totalPrice,
    // Always derived from the (possibly rush-adjusted) total — never the stored
    // PricePerSticker. See deriveUnitPrice.
    unitPrice: match.Quantity > 0 ? totalPrice / match.Quantity : 0,
    isBestValue: !!match.IsBestValue,
    boundingSize,
    roundedQty,
    // True unless the customer asked for exactly this standard square.
    sizeWasRounded: !(widthRaw === heightRaw
      && parseInt(boundingSize.split('x')[0], 10) === widthRaw),
    qtyWasRounded: roundedQty !== qtyRaw,
    rushMultiplier: rushApplied ? rushMultiplier : null,
    requested,
  };
}

// Quote-lookup helper — used by the contract-sticker-ai route to translate a
// customer's free-form ask (e.g. "200 of 2x3 stickers") into a quotable grid row.
// Implements the bounding-box rule + round-up-qty rule from the system prompt.
//
// GET /api/sticker-pricing/quote?width=2&height=3&qty=200
//   → { partNumber: "STK-3X3-200", size: "3x3", quantity: 200,
//       totalPrice: 234.00, pricePerSticker: 1.17, isBestValue: true,
//       appliedRules: { boundingBox: "2x3 → 3x3", quantityRoundUp: null } }
//
// Off-grid (max dim > 6 OR qty > 10000) → { offGrid: true, reason: "..." }.
router.get('/sticker-pricing/quote', async (req, res) => {
  res.set('Cache-Control', 'no-cache');

  const rushRequested = req.query.rush === 'true' || req.query.rush === '1';
  const [{ grid }, rushMultiplier] = await Promise.all([
    loadGrid({ bypassCache: shouldBypass(req) }),
    rushRequested ? resolveRushMultiplier() : Promise.resolve(null),
  ]);

  const q = quoteStickerFromGrid({
    width: parseFloat(req.query.width),
    height: parseFloat(req.query.height),
    qty: parseInt(req.query.qty, 10),
    grid,
    rushMultiplier,
  });

  if (!q.ok) {
    if (q.kind === 'bad_input') {
      return res.status(400).json({
        error: 'bad_request',
        message: 'width, height, qty all required as positive numbers',
      });
    }
    if (q.kind === 'lookup_failed') {
      return res.status(500).json({
        error: 'pricing_lookup_failed',
        message: `No row found for ${q.boundingSize} @ qty ${q.roundedQty}`,
      });
    }
    const detail = q.kind === 'oversize_dimension'
      ? `${q.requested.width}"×${q.requested.height}" exceeds our largest standard size (6×6). Needs manual quote.`
      : `${q.requested.qty} pcs exceeds our largest standard quantity (10,000). Needs manual quote.`;
    return res.json({ offGrid: true, reason: q.kind, detail, requested: q.requested });
  }

  res.json({
    offGrid: false,
    partNumber: q.partNumber,
    size: q.size,
    quantity: q.quantity,
    totalPrice: q.totalPrice,
    unitPrice: q.unitPrice,
    // Kept for backward compatibility with existing consumers, but it now carries
    // the DERIVED unit price, not the truncated Caspio column — so no consumer
    // can multiply it back to a total that disagrees with totalPrice.
    pricePerSticker: Math.round(q.unitPrice * 10000) / 10000,
    isBestValue: q.isBestValue,
    appliedRules: {
      boundingBox: q.sizeWasRounded ? `${q.requested.width}"×${q.requested.height}" → ${q.size}` : null,
      quantityRoundUp: q.qtyWasRounded ? `${q.requested.qty} → ${q.quantity}` : null,
      rush: q.rushMultiplier ? `${q.rushMultiplier}× multiplier applied for rush production (under 5 working days)` : null,
    },
    requested: q.requested,
  });
});

// Expose loadGrid + constants for the contract-sticker-ai route's tool implementations,
// so the AI's quote_sticker_price tool can resolve part numbers without an internal HTTP hop.
module.exports = router;
module.exports.loadGrid = loadGrid;
module.exports.quoteStickerFromGrid = quoteStickerFromGrid;
module.exports.resolveRushMultiplier = resolveRushMultiplier;
module.exports.deriveUnitPrice = deriveUnitPrice;
module.exports.decorateGrid = decorateGrid;
module.exports.computeBestValue = computeBestValue;
module.exports.STANDARD_SIZES = STANDARD_SIZES;
module.exports.STANDARD_QTYS = STANDARD_QTYS;
module.exports.SETUP_FEE_PART = SETUP_FEE_PART;
module.exports.SETUP_FEE_AMOUNT = SETUP_FEE_AMOUNT;
