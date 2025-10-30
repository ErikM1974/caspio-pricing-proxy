/**
 * ManageOrders PUSH API - Configuration
 *
 * Contains OnSite default values and size translation mappings
 * based on the configuration in OnSite's ManageOrders integration settings.
 */

/**
 * OnSite Default Values
 * These values are configured in OnSite at:
 * Utilities > Company Setup > ManageOrders.com Settings > Supplemental Settings
 */
const ONSITE_DEFAULTS = {
  // Order defaults
  id_Customer: 2791,              // Default customer (all webstore orders)
  id_CompanyLocation: 2,          // Company location ID
  id_OrderType: 6,                // Order type for API orders
  id_EmpCreatedBy: 2,             // Employee who "creates" the order
  AutoHold: 0,                    // Don't put orders on hold (0 = No, 1 = Yes)

  // Design defaults
  id_DesignType: 3,               // Default design type
  id_Artist: 224,                 // Default artist assignment

  // Line item defaults
  id_ProductClass: 1,             // Default product class

  // Source identification
  ExtSource: 'NWCA',              // Source identifier for this API
  ExtCustomerPref: 'NWCA',        // Prefix for external customer IDs
};

/**
 * Size Translation Mapping
 *
 * Maps webstore/external size values to OnSite size values.
 * Based on the Size Translation Table configured in OnSite.
 *
 * OnSite Size Columns: Adult, S, M, LG, XL, XXL, XXXL, Other XXXL
 *
 * Standard sizes (S, M, L, XL) map to specific columns
 * Extended sizes (3XL+, XS, OSFA) map to "Other XXXL" with modifiers
 */
const SIZE_MAPPING = {
  // Small variations
  'S': 'S',
  'SM': 'S',
  'Small': 'S',
  'SMALL': 'S',

  // Medium variations
  'M': 'M',
  'MD': 'M',
  'Medium': 'M',
  'MEDIUM': 'M',

  // Large variations
  'L': 'L',
  'LG': 'L',
  'Large': 'L',
  'LARGE': 'L',

  // Extra Large variations
  'XL': 'XL',
  'X-Large': 'XL',
  'X-LARGE': 'XL',
  'XLarge': 'XL',
  '1XL': 'XL',

  // 2XL variations (both 2XL and XXL are supported in OnSite)
  '2XL': '2XL',
  '2X': '2XL',
  'XX-Large': '2XL',
  'XX-LARGE': '2XL',

  // XXL as separate size (OnSite has both 2XL and XXL configured)
  'XXL': 'XXL',

  // 3XL variations (uses _3XL modifier in OnSite)
  '3XL': '3XL',
  'XXXL': '3XL',
  '3X': '3XL',
  'XXX-Large': '3XL',
  'XXX-LARGE': '3XL',

  // 4XL variations (uses _4XL modifier in OnSite)
  '4XL': '4XL',
  'XXXXL': '4XL',
  '4X': '4XL',
  'XXXX-Large': '4XL',

  // 5XL variations (uses _5XL modifier in OnSite)
  '5XL': '5XL',
  'XXXXXL': '5XL',
  '5X': '5XL',
  'XXXXX-Large': '5XL',

  // 6XL variations (uses _6XL modifier in OnSite)
  '6XL': '6XL',
  'XXXXXXL': '6XL',
  '6X': '6XL',
  'XXXXXX-Large': '6XL',

  // Extra Small (uses _XS modifier in OnSite)
  'XS': 'XS',
  'X-Small': 'XS',
  'X-SMALL': 'XS',
  'Extra Small': 'XS',
  'EXTRA SMALL': 'XS',

  // One Size Fits All
  'OSFA': 'OSFA',
  'OS': 'OSFA',
  'One Size': 'OSFA',
  'ONE SIZE': 'OSFA',
  'One Size Fits All': 'OSFA',
  'ONE SIZE FITS ALL': 'OSFA',

  // Flex-fit cap sizes (from OnSite Size Translation Table)
  'S/M': 'S/M',       // OnSite modifier: _S/M (e.g., C865 → C865_S/M)
  'L/XL': 'L/XL',     // OnSite modifier: _L/XL (e.g., C865 → C865_L/XL)

  // Tall sizes (Nike and other athletic brands)
  'LT': 'LT',         // Large Tall - OnSite modifier: _LT (e.g., NKDC1963 → NKDC1963_LT)
  'XLT': 'XLT',       // XL Tall - OnSite modifier: _XLT
  '2XLT': '2XLT',     // 2XL Tall - OnSite modifier: _2XLT
  '3XLT': '3XLT',     // 3XL Tall - OnSite modifier: _3XLT
  '4XLT': '4XLT',     // 4XL Tall - OnSite modifier: _4XLT
};

/**
 * Valid Note Types for ManageOrders API
 * These correspond to different note categories in OnSite
 */
const NOTE_TYPES = {
  ORDER: 'Notes On Order',
  ART: 'Notes To Art',
  PURCHASING: 'Notes To Purchasing',
  SUBCONTRACT: 'Notes To Subcontract',
  PRODUCTION: 'Notes To Production',
  RECEIVING: 'Notes To Receiving',
  SHIPPING: 'Notes To Shipping',
  ACCOUNTING: 'Notes To Accounting',
  CUSTOMER: 'Notes On Customer',  // Only valid during new customer creation
};

/**
 * Payment Status Values
 * Only "success" status will create actual payment records in OnSite
 */
const PAYMENT_STATUS = {
  SUCCESS: 'success',
  FAILED: 'failed',
  PENDING: 'pending',
  REFUNDED: 'refunded',
};

/**
 * ExtOrderID prefix for test orders
 * Orders with this prefix are for testing only
 */
const TEST_ORDER_PREFIX = 'NWCA-TEST-';

/**
 * Translate external size to OnSite size
 *
 * @param {string} externalSize - Size from webstore/external system
 * @returns {string} OnSite size value
 * @throws {Error} If size is empty/null (required field)
 */
function translateSize(externalSize) {
  if (!externalSize) {
    throw new Error('Size is required');
  }

  const normalizedSize = externalSize.trim();
  const onsiteSize = SIZE_MAPPING[normalizedSize];

  if (!onsiteSize) {
    // FALLBACK: Pass through unmapped sizes (ShopWorks will handle via "All Other Sizes")
    // This mirrors ShopWorks' "Other XXXL" fallback column behavior
    console.warn(
      `[Size Translation] Unmapped size "${externalSize}" - passing through as-is ` +
      `(will use "Other XXXL" column in ShopWorks)`
    );

    // Return normalized size as-is (ShopWorks will map to "Other XXXL")
    return normalizedSize;
  }

  return onsiteSize;
}

/**
 * Generate ExtOrderID from order number
 *
 * @param {string|number} orderNumber - Order number
 * @param {boolean} isTest - Whether this is a test order
 * @returns {string} Formatted ExtOrderID
 */
function generateExtOrderID(orderNumber, isTest = false) {
  const prefix = isTest ? TEST_ORDER_PREFIX : 'NWCA-';
  return `${prefix}${orderNumber}`;
}

/**
 * Validate note type
 *
 * @param {string} noteType - Note type to validate
 * @returns {boolean} True if valid
 */
function isValidNoteType(noteType) {
  return Object.values(NOTE_TYPES).includes(noteType);
}

module.exports = {
  ONSITE_DEFAULTS,
  SIZE_MAPPING,
  NOTE_TYPES,
  PAYMENT_STATUS,
  TEST_ORDER_PREFIX,
  translateSize,
  generateExtOrderID,
  isValidNoteType,
};
