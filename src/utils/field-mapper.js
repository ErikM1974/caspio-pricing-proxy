// Field mapping utility to maintain backward compatibility
// Maps new Caspio field names to original API response field names

/**
 * Maps new Caspio field names to the original field names expected by existing applications
 */
function mapFieldsForBackwardCompatibility(record) {
  // If no record, return null
  if (!record) return null;
  
  // Create a new object with mapped fields
  const mapped = { ...record };
  
  // Image field mappings
  // The original API used FRONT_MODEL, FRONT_FLAT, etc.
  // The actual Caspio fields might be FRONT_MODEL_IMAGE_URL, etc.
  if (record.FRONT_MODEL_IMAGE_URL !== undefined) {
    mapped.FRONT_MODEL = record.FRONT_MODEL_IMAGE_URL;
  }
  if (record.BACK_MODEL_IMAGE !== undefined) {
    mapped.BACK_MODEL = record.BACK_MODEL_IMAGE;
  }
  if (record.FRONT_FLAT_IMAGE !== undefined) {
    mapped.FRONT_FLAT = record.FRONT_FLAT_IMAGE;
  }
  if (record.BACK_FLAT_IMAGE !== undefined) {
    mapped.BACK_FLAT = record.BACK_FLAT_IMAGE;
  }
  
  // Price field mappings - Original API didn't use size-specific prices
  // Keep the original PIECE_PRICE, DOZEN_PRICE, CASE_PRICE as is
  
  // Status field mapping
  if (record.PRODUCT_STATUS !== undefined) {
    mapped.ProductStatus = record.PRODUCT_STATUS;
  }
  
  // Make sure we have MAIN_IMAGE_URL for backward compatibility
  if (!mapped.MAIN_IMAGE_URL) {
    // Fallback chain: FRONT_MODEL → FRONT_FLAT → PRODUCT_IMAGE
    mapped.MAIN_IMAGE_URL = mapped.FRONT_MODEL || mapped.FRONT_FLAT || record.PRODUCT_IMAGE || null;
  }
  
  return mapped;
}

/**
 * Creates the original product-colors response format
 */
function createProductColorsResponse(records, styleNumber) {
  if (!records || records.length === 0) {
    return null;
  }
  
  // Get product info from first record
  const firstRecord = records[0];
  
  // Build unique colors array
  const colorsMap = new Map();
  
  records.forEach(record => {
    const colorName = record.COLOR_NAME;
    if (colorName && !colorsMap.has(colorName)) {
      const colorData = {
        COLOR_NAME: colorName,
        CATALOG_COLOR: record.CATALOG_COLOR || colorName,
        COLOR_SQUARE_IMAGE: record.COLOR_SQUARE_IMAGE || record.COLOR_SWATCH_IMAGE || null
      };
      
      // Determine MAIN_IMAGE_URL with fallback logic (MAIN_IMAGE_URL doesn't exist in the table)
      colorData.MAIN_IMAGE_URL = record.FRONT_MODEL || 
                                 record.FRONT_FLAT || 
                                 record.PRODUCT_IMAGE ||
                                 null;
      
      // Optionally add FRONT_MODEL and FRONT_FLAT if they exist
      if (record.FRONT_MODEL || record.FRONT_MODEL_IMAGE_URL) {
        colorData.FRONT_MODEL = record.FRONT_MODEL || record.FRONT_MODEL_IMAGE_URL;
      }
      if (record.FRONT_FLAT || record.FRONT_FLAT_IMAGE) {
        colorData.FRONT_FLAT = record.FRONT_FLAT || record.FRONT_FLAT_IMAGE;
      }
      
      colorsMap.set(colorName, colorData);
    }
  });
  
  return {
    productTitle: firstRecord.PRODUCT_TITLE || '',
    PRODUCT_DESCRIPTION: firstRecord.PRODUCT_DESCRIPTION || '',
    colors: Array.from(colorsMap.values())
  };
}

/**
 * Creates the original color-swatches response format
 */
function createColorSwatchesResponse(records) {
  const swatchesMap = new Map();
  
  records.forEach(record => {
    const colorName = record.COLOR_NAME;
    const catalogColor = record.CATALOG_COLOR || colorName;
    const swatchImage = record.COLOR_SQUARE_IMAGE || record.COLOR_SWATCH_IMAGE;
    
    // Original API required all three fields to be present
    if (colorName && catalogColor && swatchImage && !swatchesMap.has(colorName)) {
      swatchesMap.set(colorName, {
        COLOR_NAME: colorName,
        CATALOG_COLOR: catalogColor,
        COLOR_SQUARE_IMAGE: swatchImage
      });
    }
  });
  
  return Array.from(swatchesMap.values());
}

module.exports = {
  mapFieldsForBackwardCompatibility,
  createProductColorsResponse,
  createColorSwatchesResponse
};