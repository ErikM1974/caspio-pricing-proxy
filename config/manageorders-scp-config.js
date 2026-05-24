/**
 * ManageOrders PUSH API - Screen Print Quote Configuration
 *
 * OnSite integration settings for SCP quote push.
 *
 * OnSite Integration: "Screen Print Quote NWCA" (TBD — Erik to create in OnSite)
 * URL: manageordersapi.com/onsite (shared base; differentiated by ExtSource)
 *
 * Created 2026-05-23 — Phase 8 SCP push.
 *
 * 🚧 TODO before going live (Erik action items):
 *   1. Create new OnSite integration "Screen Print Quote NWCA"
 *   2. Confirm id_Customer for SCP quote customer (placeholder = EMB's 3739)
 *   3. Confirm id_OrderType for SCP orders (placeholder = 21 = Custom Embroidery)
 *      Note: SCP probably wants its own (e.g., 23 = Screen Print).
 *   4. Confirm id_DesignType for SCP designs (placeholder = 4 = Screen Print guess)
 *   5. Confirm SCP service codes — SPSU (new screen) and SPRESET (reused screen)
 *      already exist in EMB's KNOWN_FEE_PNS, so they're shared. Good.
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
  // 🚧 TODO: update to dedicated SCP customer once Erik creates it.
  id_Customer: 3739,
  id_CompanyLocation: 2,
  // 🚧 TODO: confirm id_OrderType for SCP. Probably 23 = Screen Print.
  id_OrderType: 21,
  id_EmpCreatedBy: 2,
  AutoHold: 0,

  // 🚧 TODO: confirm id_DesignType for SCP (guess = 4).
  id_DesignType: 4,
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
