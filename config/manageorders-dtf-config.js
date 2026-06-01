/**
 * ManageOrders PUSH API - DTF Quote Configuration
 *
 * OnSite integration settings for DTF quote push.
 *
 * OnSite Integration: "DTF Quote NWCA" (TBD — Erik to create in OnSite)
 * URL: manageordersapi.com/onsite (same base URL as EMB + 3-Day Tees;
 * differentiated by ExtSource/id_Customer)
 *
 * Created 2026-05-23 — Phase 8 DTF push scaffolding.
 *
 * ✅ The push is functional. Quotes carry the REAL ShopWorks customer (from
 *    the quote's customer #), shipping, discount, rush/art/graphic-design
 *    charges, ship-to address, dates, and PO. id_Customer below is only a
 *    FALLBACK for quotes saved with no customer # entered.
 *
 * ✅ Order type (18 = Transfers → revenue acct 4005) + design type (8) corrected
 *    2026-05-29 to the VERIFIED ShopWorks IDs the Order Form push uses (were the
 *    EMB-copied placeholders 21 / 5).
 *
 * 🚧 Remaining (OnSite-side, optional/refinement — NOT correctness blockers):
 *   1. Confirm the OnSite integration handling ExtSource 'NWCA-DTF' leaves
 *      "Order Type ID" / "DesignType ID" BLANK in its Supplemental Settings so the
 *      payload's 18 / 8 are honored (mirrors the "Order Form" integration setup).
 *   2. Graphic-design service code — currently billed on the 'Art' part. If
 *      ShopWorks has a dedicated graphic-design code, swap it in the transformer.
 *   3. (Optional) Create a dedicated "DTF Quote NWCA" integration to group DTF
 *      orders separately from EMB.
 */

const { translateSize, SIZE_MAPPING, NOTE_TYPES } = require('./manageorders-push-config');
const {
  TAX_ACCOUNT_LOOKUP,
  getTaxAccount,
  SALES_REP_MAP,
  getSalesRepName,
  formatDateForAPI,
  extractSequence,
  buildExtOrderID,
  getQuoteYear,
  ORDER_LEVEL_FEES,
} = require('./manageorders-emb-config');

/**
 * DTF OnSite Default Values
 *
 * Order type + design type use the VERIFIED ShopWorks IDs (18 / 8) the Order Form
 * push already uses (corrected 2026-05-29 from the EMB-copied placeholders 21 / 5).
 * id_Customer 3739 is a FALLBACK only — real quotes attach to their actual
 * ShopWorks customer via session.CustomerNumber.
 */
const DTF_ONSITE_DEFAULTS = {
  // FALLBACK ONLY — used when a quote has no customer # entered. Real quotes
  // attach to their actual ShopWorks customer (session.CustomerNumber).
  // 3739 is the EMB integration customer.
  id_Customer: 3739,
  id_CompanyLocation: 2,
  // 18 = "Transfers" → revenue acct 4005 Transfer Sales. VERIFIED against the live
  // ShopWorks Order Types list 2026-05-02 (OF-0027) and already used by the Order
  // Form push. (Was 21 = Custom Embroidery, which posted DTF orders to the
  // embroidery revenue account 4050.) Source: memory/MANAGEORDERS_COMPLETE_REFERENCE.md.
  id_OrderType: 18,
  id_EmpCreatedBy: 2,
  AutoHold: 0,

  // 8 = Transfer design type (VERIFIED 2026-05-02, same source). Was a guess (5).
  id_DesignType: 8,
  id_Artist: 24,                  // Same as EMB

  id_ProductClass: 1,

  ExtSource: 'NWCA-DTF',          // 🆕 DTF source identifier
  ExtCustomerPref: 'NWCA-DTF',
};

const DTF_BASE_URL = 'https://manageordersapi.com/onsite';

/**
 * Generate ExtOrderID for DTF quotes. Delegates to the shared, year-safe
 * buildExtOrderID. DTF quote IDs are `DTF{MMDD}-{seq}` (daily reset, no year),
 * so the year is injected from the quote's persisted date:
 *   'DTF0521-1' (2026) → 'DTF-2026-0521-1'  ·  test → 'DTF-TEST-2026-0521-1'
 *
 * @param {string} quoteId — Quote ID (e.g., 'DTF0521-1')
 * @param {boolean} isTest — Whether this is a test push
 * @param {string|number} [year] — 4-digit year from getQuoteYear(session)
 * @returns {string} ExtOrderID
 */
function generateDtfExtOrderID(quoteId, isTest = false, year) {
  return buildExtOrderID('DTF', quoteId, isTest, year);
}

module.exports = {
  DTF_ONSITE_DEFAULTS,
  DTF_BASE_URL,
  generateDtfExtOrderID,
  getQuoteYear,
  // Re-export shared utilities so the transformer + route only need this file
  translateSize,
  SIZE_MAPPING,
  NOTE_TYPES,
  TAX_ACCOUNT_LOOKUP,
  getTaxAccount,
  SALES_REP_MAP,
  getSalesRepName,
  formatDateForAPI,
  extractSequence,
  ORDER_LEVEL_FEES,
};
