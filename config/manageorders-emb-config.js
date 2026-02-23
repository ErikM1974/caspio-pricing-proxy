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
  id_OrderType: 6,                // Order type for API orders
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
  'ruthie@nwcustomapparel.com': 'Ruthie Mickelson',
};

/**
 * Fee part numbers that are handled at order level (NOT as LinesOE)
 */
const ORDER_LEVEL_FEES = ['TAX', 'SHIP', 'DISCOUNT'];

/**
 * All recognized fee/service part numbers that should become LinesOE entries.
 * Fee items with PNs NOT in this set are treated as order notes, not line items.
 * (ORDER_LEVEL_FEES are excluded separately — they become order-level fields.)
 */
const KNOWN_FEE_PNS = new Set([
  'AS-GARM', 'AS-CAP', 'DD', 'DDE', 'DDT', 'GRT-50', 'GRT-75',
  'RUSH', 'SAMPLE', '3D-EMB', 'LASER PATCH', 'MONOGRAM', 'NAME',
  'WEIGHT', 'SEG', 'SECC', 'DT', 'CTR-GARMT', 'CTR-CAP',
  'AL', 'AL-CAP', 'CB', 'CS', 'DECG', 'DECG-FB', 'DECC',
  'DGT-001', 'DGT-002', 'DGT-003',
]);

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
 * Generate ExtOrderID for embroidery quotes
 *
 * @param {string} quoteId - Quote ID (e.g., 'EMB-2026-177')
 * @param {boolean} isTest - Whether this is a test push
 * @returns {string} ExtOrderID (e.g., 'EMB-177' or 'EMB-TEST-177')
 */
function generateEmbExtOrderID(quoteId, isTest = false) {
  const seq = extractSequence(quoteId);
  return isTest ? `EMB-TEST-${seq}` : `EMB-${seq}`;
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
  TAX_ACCOUNT_LOOKUP,
  getTaxAccount,
  extractSequence,
  generateEmbExtOrderID,
  getSalesRepName,
  formatDateForAPI,
  // Re-export from shared config
  translateSize,
  SIZE_MAPPING,
  NOTE_TYPES,
};
