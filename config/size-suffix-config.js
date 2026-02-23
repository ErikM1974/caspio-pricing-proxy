/**
 * Size-to-Suffix Mapping for ShopWorks Part Numbers (Backend)
 *
 * Mirrors frontend: shared_components/js/extended-sizes-config.js
 * Used by: embroidery-push-transformer.js (and future push integrations)
 *
 * SYNC RULE: If SIZE_TO_SUFFIX changes in the frontend extended-sizes-config.js,
 * update this file to match. Both must stay in sync.
 *
 * Verified against SanMar-ShopWorks CSV (15,151 SKUs, Feb 2026).
 */

/**
 * Standard sizes that use the base part number (no suffix).
 * S, M, L, XL go into Size01-Size04 columns on the base SKU.
 */
const STANDARD_SIZES = ['S', 'M', 'L', 'XL'];

/**
 * Size to Part Number Suffix Mapping
 *
 * Example: Style PC61 + Size 3XL = PC61_3XL
 *
 * CRITICAL: 2XL and XXL are DISTINCT in ShopWorks (zero overlap):
 * - 2XL (_2X): Standard plus size (2,123 products)
 * - XXL (_XXL): Ladies/Womens plus size (589 products)
 * Both use Size05 field but have different suffixes.
 */
const SIZE_TO_SUFFIX = {
  // Standard sizes (no suffix - use base style)
  'S': '',
  'M': '',
  'L': '',
  'XL': '',

  // Plus sizes — _2X per ShopWorks pricelist; _3XL/_4XL are full-form
  '2XL': '_2X',
  'XXL': '_XXL',     // DISTINCT from 2XL — ladies/womens products
  '3XL': '_3XL',
  'XXXL': '_XXXL',
  '4XL': '_4XL',
  '5XL': '_5XL',
  '6XL': '_6XL',
  '7XL': '_7XL',
  '8XL': '_8XL',
  '9XL': '_9XL',
  '10XL': '_10XL',

  // Extra small sizes
  'XS': '_XS',
  'XXS': '_XXS',
  '2XS': '_2XS',

  // One size fits all
  'OSFA': '_OSFA',
  'OSFM': '_OSFM',

  // Combo sizes (with slashes per ShopWorks pricelist)
  'S/M': '_S/M',
  'M/L': '_M/L',
  'L/XL': '_L/XL',
  'XS/S': '_XS/S',
  'X/2X': '_X/2X',
  'S/XL': '_S/XL',
  '2/3X': '_2/3X',
  '3/4X': '_3/4X',
  '4/5X': '_4/5X',
  '2-5X': '_2-5X',
  'C/Y': '_C/Y',
  'T/C': '_T/C',
  'SM': '_SM',

  // Tall sizes
  'ST': '_ST',
  'MT': '_MT',
  'XST': '_XST',
  'LT': '_LT',
  'XLT': '_XLT',
  '2XLT': '_2XLT',
  '3XLT': '_3XLT',
  '4XLT': '_4XLT',
  '5XLT': '_5XLT',
  '6XLT': '_6XLT',

  // Regular fit (e.g., CS10, CS20, SP14, SP24)
  'SR': '_SR',
  'MR': '_MR',
  'LR': '_LR',
  'XLR': '_XLR',
  '2XLR': '_2XLR',
  '3XLR': '_3XLR',
  '4XLR': '_4XLR',
  '5XLR': '_5XLR',
  '6XLR': '_6XLR',

  // Long inseam
  'ML': '_ML',
  'LL': '_LL',
  'XLL': '_XLL',
  '2XLL': '_2XLL',
  '3XLL': '_3XLL',

  // Short inseam
  'SS': '_SS',
  'MS': '_MS',
  'LS': '_LS',
  'XLS': '_XLS',
  '2XLS': '_2XLS',
  '3XLS': '_3XLS',

  // Petite
  'SP': '_SP',
  'MP': '_MP',
  'LP': '_LP',
  'XLP': '_XLP',
  '2XLP': '_2XLP',
  'XSP': '_XSP',
  '2XSP': '_2XSP',

  // Big sizes
  'LB': '_LB',
  'XLB': '_XLB',
  '2XLB': '_2XLB',

  // Youth sizes
  'YXS': '_YXS',
  'YS': '_YS',
  'YM': '_YM',
  'YL': '_YL',
  'YXL': '_YXL',

  // Toddler sizes
  '2T': '_2T',
  '3T': '_3T',
  '4T': '_4T',
  '5T': '_5T',
  '5/6T': '_5/6T',
  '6T': '_6T',

  // Infant sizes
  'NB': '_NB',
  '06M': '_06M',
  '12M': '_12M',
  '18M': '_18M',
  '24M': '_24M',
  '0306': '_0306',
  '0612': '_0612',
  '1218': '_1218',
  '1824': '_1824',
};

/**
 * Normalize ShopWorks "R" (Regular fit) size variants to their base size.
 * XLR→XL, 2XLR→2XL, SR→S, MR→M, LR→L
 *
 * @param {string} size - The size to normalize
 * @returns {string} Normalized size
 */
function normalizeRegularFitSize(size) {
  if (!size) return size;
  const match = size.match(/^(\d*X?L)R$/i);
  if (match) return match[1].toUpperCase();
  const simpleMatch = size.match(/^([SML])R$/i);
  if (simpleMatch) return simpleMatch[1].toUpperCase();
  return size;
}

/**
 * Get the part number suffix for a size.
 *
 * @param {string} size - The size (e.g., '3XL')
 * @returns {string} The suffix (e.g., '_3XL') or empty string for standard sizes
 */
function getSizeSuffix(size) {
  const normalized = normalizeRegularFitSize(size);
  // Use !== undefined (not ||) because '' is a valid suffix for standard sizes
  const normalizedSuffix = SIZE_TO_SUFFIX[normalized];
  if (normalizedSuffix !== undefined) return normalizedSuffix;
  return SIZE_TO_SUFFIX[size] ?? '';
}

/**
 * Get the full part number for a style + size combination.
 *
 * @param {string} baseStyle - The base style number (e.g., 'PC61')
 * @param {string} size - The size (e.g., '3XL')
 * @returns {string} The full part number (e.g., 'PC61_3XL')
 */
function getPartNumber(baseStyle, size) {
  const suffix = getSizeSuffix(size);
  return suffix ? `${baseStyle}${suffix}` : baseStyle;
}

/**
 * Check if a size is a standard size (S, M, L, XL).
 *
 * @param {string} size - The size to check
 * @returns {boolean} True if standard size
 */
function isStandardSize(size) {
  const normalized = normalizeRegularFitSize(size);
  return STANDARD_SIZES.includes(normalized);
}

module.exports = {
  STANDARD_SIZES,
  SIZE_TO_SUFFIX,
  normalizeRegularFitSize,
  getSizeSuffix,
  getPartNumber,
  isStandardSize,
};
