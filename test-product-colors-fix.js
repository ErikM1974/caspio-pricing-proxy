// Test script to debug image URL issues in product-colors endpoint

// Sample record with image fields
const sampleRecord = {
    COLOR_NAME: "Aquatic Blue",
    CATALOG_COLOR: "Aquatic Blue",
    COLOR_SQUARE_IMAGE: "https://cdnm.sanmar.com/swatch/gifs/port_aqua.gif",
    FRONT_MODEL: "PC61_aquaticblue_model_front_102016.jpg",
    FRONT_FLAT: "PC61_aquaticblue_flat_front.jpg",
    BACK_MODEL: "PC61_aquaticblue_model_back.jpg",
    SIDE_MODEL: "https://cdnm.sanmar.com/imglib/mresjpg/2016/f17/PC61_aquaticblue_model_side_102016.jpg",
    BACK_FLAT: "PC61_aquaticblue_flat_back.jpg",
    THREE_Q_MODEL: "https://cdnm.sanmar.com/imglib/mresjpg/2016/f17/PC61_aquaticblue_model_3q_102016.jpg"
};

// Current implementation of ensureCompleteUrl
function ensureCompleteUrl_current(url) {
    if (!url) return '';
    if (url.startsWith('http')) return url;
    if (url.includes('/')) return url; // Already has some path structure
    return `https://cdnm.sanmar.com/imglib/mresjpg/${url}`; // Add base URL to filename
}

// Fixed implementation of ensureCompleteUrl
function ensureCompleteUrl_fixed(url) {
    if (!url) return '';
    if (url.startsWith('http')) return url;
    if (url.includes('/')) return url; // Already has some path structure
    
    // For SanMar images, we need to add the full path
    // Most images are in the format: https://cdnm.sanmar.com/imglib/mresjpg/YYYY/fXX/STYLE_COLOR_type_etc.jpg
    // For images without a year/folder prefix, we'll use a default path
    return `https://cdnm.sanmar.com/imglib/mresjpg/2016/f17/${url}`;
}

// Test both implementations
console.log("Testing current implementation:");
Object.keys(sampleRecord).forEach(key => {
    if (key.includes('MODEL') || key.includes('FLAT') || key.includes('IMAGE')) {
        const originalUrl = sampleRecord[key];
        const processedUrl = ensureCompleteUrl_current(originalUrl);
        console.log(`${key}: ${originalUrl} -> ${processedUrl}`);
    }
});

console.log("\nTesting fixed implementation:");
Object.keys(sampleRecord).forEach(key => {
    if (key.includes('MODEL') || key.includes('FLAT') || key.includes('IMAGE')) {
        const originalUrl = sampleRecord[key];
        const processedUrl = ensureCompleteUrl_fixed(originalUrl);
        console.log(`${key}: ${originalUrl} -> ${processedUrl}`);
    }
});

// Create a complete color object with the fixed implementation
const colorObject = {
    COLOR_NAME: sampleRecord.COLOR_NAME,
    CATALOG_COLOR: sampleRecord.CATALOG_COLOR || sampleRecord.COLOR_NAME,
    COLOR_SQUARE_IMAGE: ensureCompleteUrl_fixed(sampleRecord.COLOR_SQUARE_IMAGE || ''),
    MAIN_IMAGE_URL: ensureCompleteUrl_fixed(sampleRecord.FRONT_MODEL || sampleRecord.FRONT_FLAT || ''),
    FRONT_MODEL_IMAGE_URL: ensureCompleteUrl_fixed(sampleRecord.FRONT_MODEL || ''),
    FRONT_MODEL: ensureCompleteUrl_fixed(sampleRecord.FRONT_MODEL || ''),
    FRONT_FLAT: ensureCompleteUrl_fixed(sampleRecord.FRONT_FLAT || ''),
    BACK_MODEL: ensureCompleteUrl_fixed(sampleRecord.BACK_MODEL || ''),
    SIDE_MODEL: ensureCompleteUrl_fixed(sampleRecord.SIDE_MODEL || ''),
    THREE_Q_MODEL: ensureCompleteUrl_fixed(sampleRecord.THREE_Q_MODEL || ''),
    BACK_FLAT: ensureCompleteUrl_fixed(sampleRecord.BACK_FLAT || '')
};

console.log("\nFinal color object:");
console.log(JSON.stringify(colorObject, null, 2));