// DTG Curated Top-Sellers — single source of truth for the
// recommend_top_sellers tool on the DTG AI bot.
//
// Extracted from shared_components/js/dtg-product-recommendations.js on
// 2026-05-17. Sales numbers reflect lifetime units sold to NWCA's customer
// base; relative ranking is stable (PC54 has been #1 for years). Update
// quarterly if rankings shift.

const DTG_CURATED_PRODUCTS = {
    tshirts: [
        {
            styleNumber: 'PC54',
            name: 'Core Cotton Tee',
            brand: 'Port & Company',
            fabric: '100% Cotton',
            salesData: '18,753+ units sold',
            quality: 'excellent',
            salesRank: 1,
            bestColors: [
                { color: '#000000', name: 'Jet Black', units: '5,154' },
                { color: '#4a4a4a', name: 'Dk Hthr Grey', units: '2,364' },
                { color: '#000080', name: 'Navy', units: '2,139' },
                { color: '#ffffff', name: 'White', units: '1,997' },
            ],
            notes: 'Our #1 seller with consistent quality. Best default pick for any DTG order.',
            bestFor: 'Reliable, affordable workhorse t-shirt — large corporate orders, schools, casual events.',
        },
        {
            styleNumber: 'PC61',
            name: 'Essential Tee',
            brand: 'Port & Company',
            fabric: '100% Cotton',
            salesData: '15,621+ units sold',
            quality: 'excellent',
            salesRank: 2,
            bestColors: [
                { color: '#000000', name: 'Jet Black', units: '4,387' },
                { color: '#000080', name: 'Navy', units: '2,065' },
                { color: '#b0b0b0', name: 'Athletic Heather', units: '1,618' },
            ],
            warnings: ['Avoid PC61 Red color — causes fixation stains, needs 24hr+ drying'],
            notes: 'Slightly rougher texture than PC54 but prints crisply. Budget-friendly.',
            bestFor: 'Cost-sensitive orders, fundraisers, where budget matters more than premium feel.',
        },
        {
            styleNumber: 'PC450',
            name: 'Fan Favorite Tee',
            brand: 'Port & Company',
            fabric: 'Soft Cotton Blend',
            salesData: '10,006+ units sold',
            quality: 'excellent',
            salesRank: 3,
            bestColors: [
                { color: '#000000', name: 'Jet Black', units: '3,810' },
                { color: '#b0b0b0', name: 'Athletic Heather' },
                { color: '#4a4a4a', name: 'Dark Heather Grey' },
            ],
            notes: 'Softer texture than PC54/PC61, customer favorite for retail-style feel.',
            bestFor: 'Step-up from PC54 when the customer wants softer, more retail-feel without going to BC3001.',
        },
        {
            styleNumber: 'PC55',
            name: 'Core Blend Tee',
            brand: 'Port & Company',
            fabric: 'Cotton/Poly Blend',
            salesData: '6,932+ units sold',
            quality: 'excellent',
            salesRank: 4,
            bestColors: [
                { color: '#4a4a4a', name: 'Dark Heather Grey', units: '2,196' },
                { color: '#000000', name: 'Jet Black', units: '1,587' },
            ],
            notes: 'Cotton/poly blend — prints great despite the poly content. Less shrinkage than 100% cotton.',
            bestFor: 'Customers worried about shrinkage; athletic teams; uniform programs.',
        },
        {
            styleNumber: 'BC3001',
            name: 'Unisex Jersey Tee',
            brand: 'BELLA+CANVAS',
            fabric: '100% Cotton',
            salesData: 'Premium soft feel — fashion-forward',
            quality: 'excellent',
            salesRank: 5,
            bestColors: [
                { color: '#000000', name: 'Black' },
            ],
            notes: 'Premium tee. Smooth fabric face = sharper print. More expensive but customers love the fit.',
            bestFor: 'Premium / fashion-conscious orders, retail brands, when budget allows the upgrade.',
        },
        {
            styleNumber: 'DT6000',
            name: 'Very Important Tee',
            brand: 'District',
            fabric: 'Light weight cotton',
            salesData: '1,770+ units sold',
            quality: 'excellent',
            salesRank: 6,
            bestColors: [
                { color: '#000000', name: 'Black' },
                { color: '#ffffff', name: 'White' },
                { color: '#36454f', name: 'Charcoal' },
            ],
            notes: 'Lightweight, holds print well, tested and proven over many orders.',
            bestFor: 'Hot-climate orders, summer events, when customer wants something lighter than PC54.',
        },
    ],

    sweatshirts: [
        {
            styleNumber: 'DT1101',
            name: 'Perfect Weight Fleece',
            brand: 'District',
            fabric: 'Soft interior fleece',
            quality: 'excellent',
            salesRank: 1,
            bestColors: [
                { color: '#36454f', name: 'Charcoal' },
            ],
            notes: 'Holds prints very well on the soft brushed interior. Mid-weight, not too bulky.',
            bestFor: 'Year-round hoodie or crewneck orders — corporate gifts, school spirit, retail.',
        },
        {
            styleNumber: 'PC850H',
            name: 'Fan Favorite Fleece',
            brand: 'Port & Company',
            fabric: '80% Cotton / 20% Poly',
            quality: 'excellent',
            salesRank: 2,
            bestColors: [
                { color: '#000000', name: 'Jet Black' },
                { color: '#4169e1', name: 'True Royal' },
            ],
            notes: 'Smoother face than DT1101, fitted feel. Customers consistently rate it highly.',
            bestFor: 'When the customer wants a more athletic, fitted hoodie cut.',
        },
    ],

    // Products to AVOID for DTG — known issues
    avoid: [
        {
            product: 'PC78H — White color only',
            reason: 'Completely unprintable — washes out or stains. Other PC78H colors are fine, just not white.',
        },
        {
            product: 'PC61 — Red color only',
            reason: 'Creates fixation stains, needs 24hr+ drying. Other PC61 colors are great.',
        },
        {
            product: 'Any Gildan product',
            reason: 'Special fabric coating makes DTG prints dull and lifeless. Recommend Port & Company or BELLA+CANVAS equivalents instead.',
        },
    ],
};

/**
 * Return top-seller recommendations for the DTG bot.
 * @param {Object} opts
 * @param {string} [opts.category='any'] - 'tshirts' | 'sweatshirts' | 'hoodies' | 'any'
 * @param {number} [opts.limit=3] - max products to return
 * @returns {Array<Object>} flat list of products with category tag added
 */
function recommendTopSellers({ category = 'any', limit = 3 } = {}) {
    const requestedLimit = Math.max(1, Math.min(10, Number(limit) || 3));
    const cat = String(category || 'any').toLowerCase();
    const buckets = [];

    if (cat === 'tshirts' || cat === 't-shirts' || cat === 'tee' || cat === 'tees') {
        buckets.push(...DTG_CURATED_PRODUCTS.tshirts.map(p => ({ ...p, category: 'tshirt' })));
    } else if (cat === 'sweatshirts' || cat === 'hoodies' || cat === 'fleece') {
        buckets.push(...DTG_CURATED_PRODUCTS.sweatshirts.map(p => ({ ...p, category: 'sweatshirt' })));
    } else {
        // any — mix top tees first then sweatshirts
        buckets.push(...DTG_CURATED_PRODUCTS.tshirts.map(p => ({ ...p, category: 'tshirt' })));
        buckets.push(...DTG_CURATED_PRODUCTS.sweatshirts.map(p => ({ ...p, category: 'sweatshirt' })));
    }

    const ranked = buckets
        .sort((a, b) => (a.salesRank || 99) - (b.salesRank || 99))
        .slice(0, requestedLimit);

    return {
        category: cat,
        count: ranked.length,
        products: ranked,
        // Always surface avoid-list so bot can warn proactively
        avoidProducts: DTG_CURATED_PRODUCTS.avoid,
    };
}

module.exports = {
    DTG_CURATED_PRODUCTS,
    recommendTopSellers,
};
