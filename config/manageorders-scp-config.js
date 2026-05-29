/**
 * ManageOrders PUSH API - Screen Print Quote Configuration
 *
 * OnSite integration settings for SCP quote push.
 * URL: manageordersapi.com/onsite (shared base; differentiated by ExtSource)
 *
 * Created 2026-05-23 — Phase 8 SCP push.
 * Order/design type IDs corrected to verified values 2026-05-29.
 *
 * ✅ Order type + design type now use the VERIFIED ShopWorks IDs (13 / 1) the
 *    Order Form push already uses — orders post as "Screen Print Subcontract" to
 *    revenue account 4200 Subcontract Screenprinted Sales (NOT the embroidery
 *    account 4050 the old placeholder 21 produced). Real quotes carry the actual
 *    customer via session.CustomerNumber; service codes SPSU/SPRESET/LTM/Art/
 *    GRT-75/RUSH are shared with EMB's KNOWN_FEE_PNS.
 *
 * 🚧 Remaining (OnSite-side, optional/refinement — NOT correctness blockers):
 *   1. Confirm the OnSite integration that handles ExtSource 'NWCA-SCP' leaves
 *      "Order Type ID" / "DesignType ID" BLANK in its Supplemental Settings so the
 *      payload's 13 / 1 are honored (mirrors the "Order Form" integration setup).
 *      If those settings are hardcoded, the integration value overrides the payload.
 *   2. (Optional) Create a dedicated "Screen Print Quote NWCA" integration to GROUP
 *      SCP orders separately from EMB, and a dedicated no-customer fallback
 *      id_Customer (today 3739 = EMB quote customer; only hit when a quote has no
 *      customer # entered).
 */

const { translateSize, SIZE_MAPPING, NOTE_TYPES } = require('./manageorders-push-config');
const {
  TAX_ACCOUNT_LOOKUP,
  getTaxAccount,
  SALES_REP_MAP,
  getSalesRepName,
  formatDateForAPI,
  extractSequence,
  ORDER_LEVEL_FEES,
} = require('./manageorders-emb-config');

/**
 * SCP OnSite Default Values
 *
 * 🚧 PLACEHOLDERS — confirm with Erik before first live push.
 * Values below reuse EMB's defaults so orders land somewhere visible
 * (under EMB integration customer) until Erik creates dedicated SCP
 * integration in OnSite.
 */
const SCP_ONSITE_DEFAULTS = {
  // FALLBACK ONLY — real quotes attach to their actual ShopWorks customer via
  // session.CustomerNumber (see transformer). 3739 is the shared EMB quote
  // customer, used only when a quote was saved with no customer # entered.
  id_Customer: 3739,
  id_CompanyLocation: 2,
  // 13 = "Screen Print Subcontract" → revenue acct 4200 Subcontract Screenprinted
  // Sales. VERIFIED against the live ShopWorks Order Types list 2026-05-02 (OF-0027)
  // and already used by the Order Form push. (Was 21 = Custom Embroidery, which
  // mislabeled SCP orders AND posted them to the embroidery revenue account 4050.)
  // Source: memory/MANAGEORDERS_COMPLETE_REFERENCE.md "idOrderType per method".
  id_OrderType: 13,
  id_EmpCreatedBy: 2,
  AutoHold: 0,

  // 1 = Screenprint design type (VERIFIED 2026-05-02, same source). Was a guess (4).
  id_DesignType: 1,
  id_Artist: 24,

  id_ProductClass: 1,

  ExtSource: 'NWCA-SCP',
  ExtCustomerPref: 'NWCA-SCP',
};

const SCP_BASE_URL = 'https://manageordersapi.com/onsite';

/**
 * Generate ExtOrderID for SCP quotes.
 * Format: 'SCP-<seq>' for production, 'SCP-TEST-<seq>' for test pushes.
 *
 * @param {string} quoteId — Quote ID (e.g., 'SPC-1748022123456' or 'SPC-2026-001')
 * @param {boolean} isTest — Whether this is a test push
 * @returns {string} ExtOrderID
 */
function generateScpExtOrderID(quoteId, isTest = false) {
  const seq = extractSequence(quoteId);
  return isTest ? `SCP-TEST-${seq}` : `SCP-${seq}`;
}

module.exports = {
  SCP_ONSITE_DEFAULTS,
  SCP_BASE_URL,
  generateScpExtOrderID,
  // Re-export shared utilities
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
