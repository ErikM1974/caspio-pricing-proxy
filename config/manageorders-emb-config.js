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
  'CB', 'CS',  // Cap Back / Cap Side embroidery (legacy/imported; new builder uses AL-CAP) — 2026-06-04
  // WEIGHT — per-person weight embroidery (wrestling singlets). Real SW part: the ShopWorks
  // import parser (frontend shopworks-import-parser.js:1618) classifies WEIGHT lines coming
  // FROM live ShopWorks orders, and the EMB builder's Add Service bar saves StyleNumber
  // 'WEIGHT'. Was missing here, so WEIGHT rows demoted to notes → under-billed. (audit 2026-06-10)
  'WEIGHT',
]);

/**
 * Uppercase mirror for case-insensitive lookups. Built once at module load.
 */
const KNOWN_FEE_PNS_UPPER = new Set(
  Array.from(KNOWN_FEE_PNS, (p) => String(p).toUpperCase())
);

/**
 * Quote-builder fee styles that have NO part of their own in ShopWorks but map
 * 1:1 onto a real configured part. Keys are UPPERCASE (matched after
 * normalization), values are the canonical ShopWorks part number.
 *
 * 'FB' — the builder's standalone Full Back service rows save StyleNumber 'FB',
 * but the ShopWorks part for Full Back Embroidery is 'DECG-FB' (canonical list
 * #22, MANAGEORDERS_COMPLETE_REFERENCE.md). Alias so FB rows bill as a real
 * line instead of demoting to an order note. (audit 2026-06-10)
 */
const FEE_PN_ALIASES = {
  'FB': 'DECG-FB',
  // 'Name/Number' was verified to NOT exist as its own ShopWorks part (hard-deleted from
  // Caspio 2026-05-03 — see MANAGEORDERS_COMPLETE_REFERENCE.md "Removed 2026-05-03"). The
  // builder's Add Service bar still saves StyleNumber 'Name/Number' ($15 default), which
  // demoted to a note → under-billed. Bill it under the real 'Monogram' part ("Dir.
  // Embroider Names on Garments") — the same bucket the SW import parser uses for
  // NAME/NUMBER lines. The line's Description still says "Name & Number". (audit 2026-06-10)
  'NAME/NUMBER': 'Monogram',
  'NAME': 'Monogram',  // legacy saved StyleNumber for the same service (builder SERVICE_STYLE_NUMBERS)
};

/**
 * UPPERCASE → canonical-case map for KNOWN_FEE_PNS. ShopWorks part numbers are
 * case-sensitive on the receiving end ('CTR-Garmt', not 'CTR-GARMT'), so the
 * value SENT must be the canonical spelling even when the saved StyleNumber
 * passed the case-insensitive gate. (audit 2026-06-10)
 */
const KNOWN_FEE_PNS_CANONICAL = new Map(
  Array.from(KNOWN_FEE_PNS, (p) => [String(p).toUpperCase(), p])
);

/**
 * Case-insensitive membership check for fee/service part numbers.
 * Use this everywhere instead of `KNOWN_FEE_PNS.has(pn)`.
 *
 * @param {string} pn - Part number (any case)
 * @returns {boolean}
 */
function isKnownFeeCode(pn) {
  const upper = String(pn || '').trim().toUpperCase();
  return KNOWN_FEE_PNS_UPPER.has(upper) || Object.prototype.hasOwnProperty.call(FEE_PN_ALIASES, upper);
}

/**
 * Resolve a saved fee StyleNumber to the canonical ShopWorks part number:
 * applies FEE_PN_ALIASES first (FB → DECG-FB), then canonical casing from
 * KNOWN_FEE_PNS ('CTR-GARMT' → 'CTR-Garmt'). Returns null when the PN is not
 * a known ShopWorks part (caller demotes it to an explicit UNBILLED note).
 *
 * @param {string} pn - Part number (any case)
 * @returns {string|null} Canonical ShopWorks part number, or null if unknown
 */
function canonicalFeePN(pn) {
  const upper = String(pn || '').trim().toUpperCase();
  if (!upper) return null;
  const aliased = Object.prototype.hasOwnProperty.call(FEE_PN_ALIASES, upper)
    ? String(FEE_PN_ALIASES[upper]).toUpperCase()
    : upper;
  return KNOWN_FEE_PNS_CANONICAL.get(aliased) || null;
}

/**
 * Normalize a tax rate to a decimal fraction. EMB saves TaxRate as a decimal
 * (0.101), but hand-edited / imported / legacy rows can be percent-shaped
 * (10.1) — which blew up downstream as 'Tax Rate: 1010%' + MANUAL REVIEW
 * account. Values > 1 are treated as percentages. Mirrors the DTF/SCP
 * transformers' toRateDecimal. (audit 2026-06-10)
 *
 * @param {*} raw - Saved TaxRate (decimal or percent shaped)
 * @returns {number} Rate as a decimal fraction (0.101)
 */
function toRateDecimal(raw) {
  const n = parseFloat(raw) || 0;
  return n > 1 ? n / 100 : n;
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
  8.0: '2200.8',    // matches the Caspio sales_tax_accounts_2026 table (was 2200.80) — 2026-06-07
  8.1: '2200.81',
  8.2: '2200.82',
  8.3: '2200.83',
  8.4: '2200.84',
  8.5: '2200.85',
  8.6: '2200.86',
  8.7: '2200.87',
  8.8: '2200.88',
  8.9: '2200.89',
  9.0: '2200.9',    // matches the Caspio sales_tax_accounts_2026 table (was 2200.90) — 2026-06-07
  9.1: '2200.91',
  9.2: '2200.92',
  9.3: '2200.93',
  9.4: '2200.94',
  9.5: '2200.95',
  9.6: '2200.96',
  9.7: '2200.97',
  9.8: '2200.98',
  9.9: '2200.99',
  10.0: '2200.1',   // matches the Caspio sales_tax_accounts_2026 table (was 2200.100) — 2026-06-07
  10.1: '2200.101',
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
    return { accountCode: '2202', description: 'Out of State Sales', partNumber: '' };  // out of state → no WA tax line
  }

  // No tax rate and no state → default to customer pickup (WA 10.1%)
  if (!taxRate && !shipState) {
    return { accountCode: '2200.101', description: 'Customer Pickup - Milton, WA 10.1%', partNumber: 'Tax_10.1' };
  }

  // Convert decimal to percentage for lookup, 2-decimal precision (0.101 → 10.1, 0.1025 → 10.25).
  // P1-6 (audit 2026-06-06): 1-decimal rounding made hundredth-place GL accounts (10.25/10.35) unreachable
  // and misrouted true half-percent rates. Existing tenth/integer keys still match.
  const taxPct = Math.round(taxRate * 10000) / 100;

  if (TAX_ACCOUNT_LOOKUP[taxPct]) {
    return {
      accountCode: TAX_ACCOUNT_LOOKUP[taxPct],
      description: `WA Sales Tax ${taxPct}%`,
      partNumber: `Tax_${taxPct}`,  // ShopWorks tax line-item part, e.g. Tax_9.6 — drives the destination rate (2026-06-07)
    };
  }

  // Fallback: if rate is ~10.1% (within 0.1%), use the Milton/WA 10.1% account
  if (Math.abs(taxPct - 10.1) < 0.1) {
    return { accountCode: '2200.101', description: `WA Sales Tax ${taxPct}%`, partNumber: 'Tax_10.1' };
  }

  // Unknown rate — flag for manual review
  return {
    accountCode: '',
    description: `MANUAL REVIEW: Tax rate ${taxPct}% not in lookup table`,
    partNumber: '',  // unknown rate → no part; rep applies tax manually (Notes On Order carries the rate)
  };
}

/**
 * Parse a quote session's per-order Wholesale flag (Quote_Sessions.IsWholesale).
 * A missing/blank/No value is NEVER wholesale (never auto-wholesale a taxable order).
 * @param {Object} session
 * @returns {boolean}
 */
function isWholesaleSession(session) {
  const v = session && session.IsWholesale;
  return v === true || v === 'Yes' || v === 1 || v === '1' || String(v).toLowerCase() === 'true';
}

/**
 * Resolve the ShopWorks GL tax account for an order. Wholesale/reseller (per-order IsWholesale checkbox)
 * → 0 tax routed to the Wholesale Sales account 2203, regardless of destination rate (short-circuits the
 * rate lookup). Otherwise defers to getTaxAccount (out-of-state 2202 / WA rate accounts / Milton pickup).
 * Shared by the EMB, DTF, and SCP push transformers so the 2203 routing lives in ONE place (2026-06-08).
 * @param {{ taxRate:number, shipState:string, isWholesale:boolean }} opts
 * @returns {{ accountCode:string, description:string, partNumber:string }}
 */
function resolveTaxAccount({ taxRate, shipState, isWholesale }) {
  if (isWholesale) {
    return { accountCode: '2203', description: 'Wholesale Sales (WA reseller permit — no tax)', partNumber: '' };
  }
  return getTaxAccount(taxRate, shipState);
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

/**
 * Build the Notes-On-Order sales-tax block, one fact per line, mirroring the
 * order-form/DTG style Erik prefers. Returns an ARRAY of strings (each becomes
 * its own row in ShopWorks's Notes On Order tab). Shared by EMB/SCP/DTF so all
 * four push paths read identically. Added 2026-06-02.
 *
 * @param {Object} p
 * @param {number} p.subtotal   pre-tax subtotal (products + fees, EXCLUDES shipping)
 * @param {number} p.shipping   shipping fee (WA taxes it with the goods → folded into the taxable base + total)
 * @param {number} p.taxRate    rate as a DECIMAL (0.101)
 * @param {number} p.taxAmount  computed tax amount
 * @param {string} p.accountCode  GL account from getTaxAccount (e.g. '2200.101')
 * @param {string} p.accountDesc  account description
 * @param {string} p.shipState    ship-to state (out-of-state → no tax / 2202)
 * @param {string} p.shipMethod   ship method (pickup → flat Milton rate)
 * @returns {string[]}
 */
function buildSalesTaxNote({ subtotal = 0, shipping = 0, taxRate = 0, taxAmount = 0, accountCode = '', accountDesc = '', shipState = '', shipMethod = '' } = {}) {
  const sub = Number(subtotal) || 0;
  const ship = Number(shipping) || 0;
  const rate = Number(taxRate) || 0;
  const amt = Number(taxAmount) || 0;
  const ratePct = rate > 0 ? (rate * 100).toFixed(2) : null;
  const isPickup = /pickup|will[\s-]?call/i.test(String(shipMethod || ''));
  const st = String(shipState || '').toUpperCase();
  const isOutOfState = st && st !== 'WA' && !isPickup;
  const isWholesale = String(accountCode) === '2203';
  const preTax = sub + ship; // WA taxes shipping with the goods → the taxable base AND the total include it

  const lines = [`Subtotal: $${sub.toFixed(2)}`];
  if (ship > 0) lines.push(`Shipping: $${ship.toFixed(2)}`);

  if (isWholesale) {
    lines.push('Tax: NONE — Wholesale / Reseller (WA reseller permit on file)');
    lines.push('Tax Account: 2203 — Wholesale Sales');
    lines.push(`Total: $${preTax.toFixed(2)} (no tax)`);
    return lines;
  }
  if (isOutOfState) {
    lines.push('Tax: DO NOT APPLY (out of state)');
    lines.push(`State: ${st}`);
    lines.push('Tax Account: 2202 — Out of State Sales');
    lines.push(`Total: $${preTax.toFixed(2)} (no tax)`);
    return lines;
  }
  if (ratePct && accountCode) {
    lines.push(`Tax Rate: ${ratePct}% (${isPickup ? 'Milton pickup — flat' : 'WA destination'})`);
    if (ship > 0) lines.push(`Taxable: $${preTax.toFixed(2)} (subtotal + shipping)`);
    lines.push(`Tax Amount: $${amt.toFixed(2)}`);
    lines.push(`Total with Tax: $${(preTax + amt).toFixed(2)}`);  // [2026-06-07] now includes shipping (was sub + tax only)
    lines.push(`Tax Account: ${accountCode} — ${accountDesc || ratePct + '%'}`);
    lines.push('Apply Tax: Manually in ShopWorks');
  } else {
    lines.push('Tax: NEEDS REVIEW');
    lines.push('Rep: Confirm destination + apply correct WA rate before invoicing');
  }
  return lines;
}

/**
 * Build the "Notes To Accounting" sales-tax verification note (single multi-line string) so the
 * accountant can confirm the tax rate / account / total ShopWorks shows after the rep selects the tax
 * line at invoicing. Mirrors buildSalesTaxNote's figures. Added 2026-06-07 (Erik — for Bradley).
 */
function buildAccountingTaxNote({ subtotal = 0, shipping = 0, taxRate = 0, taxAmount = 0, accountCode = '', accountDesc = '', shipState = '', shipMethod = '' } = {}) {
  const sub = Number(subtotal) || 0;
  const ship = Number(shipping) || 0;
  const rate = Number(taxRate) || 0;
  const amt = Number(taxAmount) || 0;
  const ratePct = rate > 0 ? (rate * 100).toFixed(2) : null;
  const isPickup = /pickup|will[\s-]?call/i.test(String(shipMethod || ''));
  const st = String(shipState || '').toUpperCase();
  const isOutOfState = st && st !== 'WA' && !isPickup;
  const isWholesale = String(accountCode) === '2203';
  const preTax = sub + ship;
  const lines = ['SALES TAX — please verify (Accounting):'];

  if (isWholesale) {
    lines.push('WHOLESALE / RESELLER — NO TAX (WA reseller permit on file)');
    lines.push('Tax Account: 2203 — Wholesale Sales');
    lines.push(`Order Total (no tax): $${preTax.toFixed(2)}`);
  } else if (isOutOfState) {
    lines.push(`OUT OF STATE (${st}) — NO TAX`);
    lines.push('Tax Account: 2202 — Out of State Sales');
    lines.push(`Order Total (no tax): $${preTax.toFixed(2)}`);
  } else if (ratePct && accountCode) {
    lines.push(`Tax Account: ${accountCode} — ${accountDesc || ratePct + '%'}`);
    lines.push(`Tax Rate: ${ratePct}% (${isPickup ? 'Milton pickup — flat' : 'WA destination'})`);
    lines.push(`Taxable: $${preTax.toFixed(2)} (subtotal $${sub.toFixed(2)}${ship > 0 ? ` + shipping $${ship.toFixed(2)}` : ''})`);
    lines.push(`Tax Amount: $${amt.toFixed(2)}`);
    lines.push(`Order Total w/ Tax: $${(preTax + amt).toFixed(2)}`);
    lines.push(`→ Confirm ShopWorks Tax line = ${accountCode} (${ratePct}%) and the total matches.`);
  } else {
    lines.push('Tax: NEEDS REVIEW — confirm destination + correct WA rate before invoicing.');
  }
  return lines.join('\n');
}

module.exports = {
  isWholesaleSession,
  resolveTaxAccount,
  EMB_ONSITE_DEFAULTS,
  buildSalesTaxNote,
  buildAccountingTaxNote,
  EMB_BASE_URL,
  SALES_REP_MAP,
  ORDER_LEVEL_FEES,
  KNOWN_FEE_PNS,
  FEE_PN_ALIASES,
  isKnownFeeCode,
  canonicalFeePN,
  toRateDecimal,
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
