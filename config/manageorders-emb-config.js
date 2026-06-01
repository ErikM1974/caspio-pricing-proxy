/**
 * ManageOrders PUSH API - Embroidery Quote Configuration
 *
 * OnSite integration settings for embroidery quote push.
 * Separate from the 3-Day Tees /onsite integration.
 *
 * OnSite Integration: "Embroidery Quote NWCA"
 * URL: manageordersapi.com/onsite (same base URL as 3-Day Tees; differentiated by ExtSource/id_Customer)
 */

const { translateSize, SIZE_MAPPING, NOTE_TYPES } = require('./manageorders-push-config');

/**
 * Embroidery OnSite Default Values
 * Configured in OnSite at: ManageOrders.com Settings > Embroidery Quote NWCA
 */
const EMB_ONSITE_DEFAULTS = {
  id_Customer: 3739,              // Embroidery quote customer (all quotes go here)
  id_CompanyLocation: 2,          // Company location ID
  id_OrderType: 21,               // 21 = Custom Embroidery
  id_EmpCreatedBy: 2,             // Employee who "creates" the order
  AutoHold: 0,                    // Don't put orders on hold

  id_DesignType: 2,               // Embroidery design type
  id_Artist: 24,                  // Embroidery artist assignment

  id_ProductClass: 1,             // Default product class

  ExtSource: 'NWCA-EMB',          // Source identifier
  ExtCustomerPref: 'NWCA-EMB',    // Customer preference prefix
};

const EMB_BASE_URL = 'https://manageordersapi.com/onsite';

/**
 * Sales rep email → name mapping for CustomerServiceRep field
 */
const SALES_REP_MAP = {
  'taylar@nwcustomapparel.com': 'Taylar Hanson',
  'nika@nwcustomapparel.com': 'Nika Lao',
  'taneisha@nwcustomapparel.com': 'Taneisha Jones',
  'erik@nwcustomapparel.com': 'Erik Mickelson',
  'ruth@nwcustomapparel.com': 'Ruthie Nhoung',
};

/**
 * Fee part numbers that are handled at order level (NOT as LinesOE)
 */
const ORDER_LEVEL_FEES = ['TAX', 'SHIP', 'DISCOUNT'];

/**
 * All recognized fee/service part numbers that should become LinesOE entries.
 * Fee items with PNs NOT in this set are treated as order notes, not line items.
 * (ORDER_LEVEL_FEES are excluded separately — they become order-level fields.)
 *
 * SOURCE OF TRUTH: ShopWorks part numbers (from Erik's screenshots 2026-05-03).
 * Spelling/case matches the OnSite "Services" product type list verbatim so
 * the value sent to ShopWorks (PartNumber) lands on a configured part record.
 *
 * Membership checks should go through `isKnownFeeCode()` (case-insensitive).
 */
const KNOWN_FEE_PNS = new Set([
  // 29 confirmed ShopWorks service codes (Erik's screenshots 2026-05-03).
  // 27 from initial screenshot + 2 from follow-up (Laser Patch, SECC).
  // Spelling/case matches ShopWorks part numbers verbatim.
  'SEG', 'DECG', 'DECC', 'Monogram', 'RUSH', 'Freight',
  'DD', 'DDE', 'DDT', 'AL', 'DT', 'Discount', 'Pallet', 'Art',
  'AS-Garm', 'CDP', 'AS-CAP', 'LTM', 'CTR-Garmt', 'CTR-Cap',
  'AL-CAP', 'DECG-FB', '3D-EMB', 'GRT-50', 'GRT-75',
  'SPRESET', 'SPSU',
  'Laser Patch', 'SECC',
]);

/**
 * Uppercase mirror for case-insensitive lookups. Built once at module load.
 */
const KNOWN_FEE_PNS_UPPER = new Set(
  Array.from(KNOWN_FEE_PNS, (p) => String(p).toUpperCase())
);

/**
 * Case-insensitive membership check for fee/service part numbers.
 * Use this everywhere instead of `KNOWN_FEE_PNS.has(pn)`.
 *
 * @param {string} pn - Part number (any case)
 * @returns {boolean}
 */
function isKnownFeeCode(pn) {
  return KNOWN_FEE_PNS_UPPER.has(String(pn || '').toUpperCase());
}

/**
 * Tax Account Lookup — Maps WA tax rate percentages to GL account codes.
 * Mirrors Python InkSoft's TAX_ACCOUNT_LOOKUP (transform.py:79-112).
 * Key = tax rate as percentage (e.g., 10.1), Value = GL account number.
 */
const TAX_ACCOUNT_LOOKUP = {
  7.7: '2200.77',
  7.8: '2200.78',
  7.9: '2200.79',
  8.0: '2200.80',
  8.1: '2200.81',
  8.2: '2200.82',
  8.3: '2200.83',
  8.4: '2200.84',
  8.5: '2200.85',
  8.6: '2200.86',
  8.7: '2200.87',
  8.8: '2200.88',
  8.9: '2200.89',
  9.0: '2200.90',
  9.1: '2200.91',
  9.2: '2200.92',
  9.3: '2200.93',
  9.4: '2200.94',
  9.5: '2200.95',
  9.6: '2200.96',
  9.7: '2200.97',
  9.8: '2200.98',
  9.9: '2200.99',
  10.0: '2200.100',
  10.1: '2200',
  10.2: '2200.102',
  10.25: '2200.302',
  10.3: '2200.103',
  10.35: '2200.303',
  10.4: '2200.104',
  10.5: '2200.105',
  10.6: '2200.106',
};

/**
 * Get GL tax account code from tax rate and ship state.
 * Mirrors Python InkSoft's get_tax_account() (transform.py:361-374).
 *
 * @param {number} taxRate - Tax rate as decimal (e.g., 0.101)
 * @param {string} shipState - Ship-to state code (e.g., 'WA', 'OR')
 * @returns {{ accountCode: string, description: string }}
 */
function getTaxAccount(taxRate, shipState) {
  // Out of state → account 2202
  if (shipState && shipState.toUpperCase() !== 'WA') {
    return { accountCode: '2202', description: 'Out of State Sales' };
  }

  // No tax rate and no state → default to customer pickup (WA 10.1%)
  if (!taxRate && !shipState) {
    return { accountCode: '2200', description: 'Customer Pickup - Milton, WA 10.1%' };
  }

  // Convert decimal to percentage for lookup (0.101 → 10.1)
  const taxPct = Math.round(taxRate * 1000) / 10;

  if (TAX_ACCOUNT_LOOKUP[taxPct]) {
    return {
      accountCode: TAX_ACCOUNT_LOOKUP[taxPct],
      description: `WA Sales Tax ${taxPct}%`,
    };
  }

  // Fallback: if rate is ~10.1% (within 0.1%), use default 2200
  if (Math.abs(taxPct - 10.1) < 0.1) {
    return { accountCode: '2200', description: `WA Sales Tax ${taxPct}% (default)` };
  }

  // Unknown rate — flag for manual review
  return {
    accountCode: '',
    description: `MANUAL REVIEW: Tax rate ${taxPct}% not in lookup table`,
  };
}

/**
 * Extract the sequence number from a QuoteID.
 * "EMB-2026-250" → "250"
 *
 * @param {string} quoteId - Quote ID (e.g., 'EMB-2026-250')
 * @returns {string} Sequence number (e.g., '250')
 */
function extractSequence(quoteId) {
  if (!quoteId) return '0';
  const parts = String(quoteId).split('-');
  return parts[parts.length - 1] || '0';
}

/**
 * Derive the 4-digit year for an ExtOrderID from a quote's STABLE persisted
 * date, so a re-push in a later year doesn't change the ID. Falls back to the
 * current year when no date is available.
 *
 * @param {Object} session - quote_sessions record
 * @returns {string} 4-digit year (e.g., '2026')
 */
function getQuoteYear(session = {}) {
  const raw = session.DateOrderPlaced || session.CreatedAt_Quote || session.CreatedAt || '';
  const m = String(raw).match(/(20\d\d)/);
  return m ? m[1] : String(new Date().getFullYear());
}

/**
 * Build a year-safe ExtOrderID from a quote ID. Single source of truth for all
 * three push methods so they can't drift.
 *
 * Quote IDs come in two shapes:
 *   - EMB:     `EMB-2026-177`            (Prefix-YEAR-seq — year already embedded)
 *   - SCP/DTF: `SP0601-1` / `DTF0601-1`  (Prefix+MMDD-seq — NO year, DAILY reset)
 *
 * Using only the trailing sequence (the old extractSequence approach) is unsafe:
 * it collides DAILY for SCP/DTF (`SP0601-1` and `SP0602-1` both reduce to `-1`)
 * and annually for EMB. This keeps the full distinguishing tail and guarantees a
 * 20xx year leads it, so ExtOrderIDs stay globally unique.
 *
 * @param {string} outPrefix - ExtOrderID prefix ('EMB' | 'SCP' | 'DTF')
 * @param {string} quoteId   - Source quote ID
 * @param {boolean} isTest   - Prefix the core with TEST-
 * @param {string|number} [year] - 4-digit year (from getQuoteYear); only used
 *                                  when the quote ID has no embedded 20xx year
 * @returns {string} ExtOrderID
 */
function buildExtOrderID(outPrefix, quoteId, isTest = false, year) {
  const raw = String(quoteId || '').trim();
  // Strip the leading alpha prefix (+ an optional following hyphen):
  //   'EMB-2026-177' → '2026-177' · 'SP0601-1' → '0601-1' · 'DTF0601-1' → '0601-1'
  let tail = raw.replace(/^[A-Za-z]+-?/, '') || '0';
  // Ensure a real 20xx year leads the tail. EMB tails already do (2026-…);
  // SCP/DTF MMDD tails (0601-…) do not — prepend the quote's year so a daily
  // sequence like `0601-1` can't collide with another day's `0602-1` → `-1`.
  if (!/^20\d\d(\D|$)/.test(tail)) {
    tail = `${year || new Date().getFullYear()}-${tail}`;
  }
  const core = isTest ? `TEST-${tail}` : tail;
  return `${outPrefix}-${core}`;
}

/**
 * Generate ExtOrderID for embroidery quotes. Delegates to the shared
 * buildExtOrderID; EMB quote IDs already embed the year (`EMB-2026-177`), so the
 * output is unchanged.
 *
 * @param {string} quoteId - Quote ID (e.g., 'EMB-2026-177')
 * @param {boolean} isTest - Whether this is a test push
 * @returns {string} ExtOrderID (e.g., 'EMB-2026-177')
 */
function generateEmbExtOrderID(quoteId, isTest = false) {
  return buildExtOrderID('EMB', quoteId, isTest);
}

/**
 * Look up sales rep name from email
 *
 * @param {string} email - Sales rep email address
 * @returns {string} Sales rep full name (or email if not found)
 */
function getSalesRepName(email) {
  if (!email) return '';
  const normalized = email.trim().toLowerCase();
  return SALES_REP_MAP[normalized] || email;
}

/**
 * Format date from ISO/various formats to MM/DD/YYYY for ManageOrders API
 *
 * @param {string} dateStr - Date string (ISO, M/D/YYYY, etc.)
 * @returns {string} Formatted date as MM/DD/YYYY, or empty string if invalid
 */
function formatDateForAPI(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '';
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const year = d.getFullYear();
    return `${month}/${day}/${year}`;
  } catch {
    return '';
  }
}

module.exports = {
  EMB_ONSITE_DEFAULTS,
  EMB_BASE_URL,
  SALES_REP_MAP,
  ORDER_LEVEL_FEES,
  KNOWN_FEE_PNS,
  isKnownFeeCode,
  TAX_ACCOUNT_LOOKUP,
  getTaxAccount,
  extractSequence,
  buildExtOrderID,
  getQuoteYear,
  generateEmbExtOrderID,
  getSalesRepName,
  formatDateForAPI,
  // Re-export from shared config
  translateSize,
  SIZE_MAPPING,
  NOTE_TYPES,
};
