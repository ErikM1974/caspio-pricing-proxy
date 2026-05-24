// EMB Curated Top-Sellers — embedded in the EMB AI bot prompt for fast
// recall without always calling the recommend_top_sellers_emb tool.
//
// SOURCE: Sourced from 10 years of NWCA embroidery sales history. Erik
// curates this list quarterly (lifetime units sold is reasonably stable
// for embroidery, which has less seasonal churn than DTG).
//
// SCHEMA: Mirrors lib/dtg-curated-products.js exactly so the bot prompt
// can be a near-clone of the DTG one.
//
// 🚧 PLACEHOLDER DATA (2026-05-24): the entries below are minimal stubs
// to validate the plumbing end-to-end. Erik will replace with real
// 10-year sales data when ready. Until then, the bot will recommend
// these stubs — it's correct enough to test the chat flow but not yet
// real recommendations.
//
// Erik: please replace each category's array with your curated list.
// Schema per entry:
//   styleNumber, name, brand, fabric, salesData, quality, salesRank,
//   bestColors: [{ color, name, units }, ...],
//   notes, bestFor
//
// Updated 2026-05-24 — EMB Chat B (Phase 11 unified UX rollout).

const EMB_CURATED_PRODUCTS = {
    tshirts: [
        // TODO Erik — top embroidery t-shirts (PC54, PC61, etc. are common
        // EMB workhorses but ranks differ from DTG due to embroidery thread
        // limitations on lightweight fabrics).
    ],
    polos: [
        // TODO Erik — top EMB polos (K500, K540, L500, etc. — corporate
        // staple).
    ],
    sweatshirts: [
        // TODO Erik — pullovers + crewnecks for EMB (PC78, PC90, F260, etc.).
    ],
    hoodies: [
        // TODO Erik — hooded sweatshirts (PC78H, PC90H, ST254, F170, etc.).
    ],
    jackets: [
        // TODO Erik — soft-shells, fleece, vests for EMB (J317, F230, JST91, etc.).
    ],
    caps: [
        // TODO Erik — caps + structured headwear (C112, NE1000, STC10, etc.).
        // Note: EMB caps have a 24-piece minimum (per the EMB pricing tiers).
    ],
    beanies: [
        // TODO Erik — knit beanies (CP90, NE900, etc.). Flat embroidery, no
        // structured panel — different stitching profile from caps.
    ],
    bags: [
        // TODO Erik — totes, backpacks, duffels for EMB (BG410, BG203, NF0A47PW, etc.).
    ],
};

module.exports = { EMB_CURATED_PRODUCTS };
