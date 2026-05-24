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
 * 🚧 TODO before going live (Erik action items):
 *   1. Create new OnSite integration "DTF Quote NWCA"
 *   2. Confirm id_Customer for DTF quote customer (placeholder below)
 *   3. Confirm id_OrderType for DTF orders (placeholder below)
 *   4. Confirm id_DesignType for DTF designs (placeholder = 5 = DTF guess)
 *   5. Get any DTF-specific service part numbers (transfer/labor/freight)
 *      if you want them as separate LinesOE instead of baked into the
 *      garment row price (current implementation: bakes them in + uses
 *      Notes On Order to itemize for the operator).
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
 * DTF OnSite Default Values
 *
 * 🚧 PLACEHOLDERS — confirm with Erik before first live push.
 * Values below copy EMB's defaults so DTF lands in the same integration
 * customer / order type until DTF gets its own. That's intentional —
 * orders won't be lost, just grouped under EMB's customer view.
 * Update id_Customer + id_OrderType + id_DesignType once Erik creates
 * the "DTF Quote NWCA" integration in OnSite.
 */
const DTF_ONSITE_DEFAULTS = {
  // 🚧 TODO: update to dedicated DTF customer once Erik creates it.
  // For now reuses EMB integration customer (orders still land in SW
  // correctly, just visible under EMB's customer view in OnSite).
  id_Customer: 3739,
  id_CompanyLocation: 2,
  // 🚧 TODO: confirm id_OrderType for DTF. EMB uses 21 = Custom Embroidery.
  // DTF might want its own (e.g., 22 = DTF Transfer) OR can share 21.
  id_OrderType: 21,
  id_EmpCreatedBy: 2,
  AutoHold: 0,

  // 🚧 TODO: confirm id_DesignType. Per server.js DESIGN_TYPE_ID guesses:
  // 1=DTG, 2=Embroidery, 3=standard (wrong/missing), 5=DTF (guess).
  // Erik to verify in OnSite Settings.
  id_DesignType: 5,
  id_Artist: 24,                  // Same as EMB

  id_ProductClass: 1,

  ExtSource: 'NWCA-DTF',          // 🆕 DTF source identifier
  ExtCustomerPref: 'NWCA-DTF',
};

const DTF_BASE_URL = 'https://manageordersapi.com/onsite';

/**
 * Generate ExtOrderID for DTF quotes.
 *
 * Format: 'DTF-<seq>' for production, 'DTF-TEST-<seq>' for test pushes.
 *
 * @param {string} quoteId — Quote ID (e.g., 'DTF0521-1')
 * @param {boolean} isTest — Whether this is a test push
 * @returns {string} ExtOrderID
 */
function generateDtfExtOrderID(quoteId, isTest = false) {
  const seq = extractSequence(quoteId);
  return isTest ? `DTF-TEST-${seq}` : `DTF-${seq}`;
}

module.exports = {
  DTF_ONSITE_DEFAULTS,
  DTF_BASE_URL,
  generateDtfExtOrderID,
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
