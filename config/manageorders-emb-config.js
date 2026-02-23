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
 * Generate ExtOrderID for embroidery quotes
 *
 * @param {string} quoteId - Quote ID (e.g., 'EMB-2026-177')
 * @param {boolean} isTest - Whether this is a test push
 * @returns {string} ExtOrderID (e.g., 'NWCA-EMB-EMB-2026-177' or 'NWCA-EMB-TEST-EMB-2026-177')
 */
function generateEmbExtOrderID(quoteId, isTest = false) {
  const prefix = isTest ? 'NWCA-EMB-TEST-' : 'NWCA-EMB-';
  return `${prefix}${quoteId}`;
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
  generateEmbExtOrderID,
  getSalesRepName,
  formatDateForAPI,
  // Re-export from shared config
  translateSize,
  SIZE_MAPPING,
  NOTE_TYPES,
};
