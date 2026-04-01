// Garment Tracker Quarter Configuration — SINGLE SOURCE OF TRUTH
//
// This is the ONLY file to edit when swapping products for a new quarter.
// The backend route, sync script, and frontend all read from this config.
//
// Quarter transition checklist:
//   1. Archive previous quarter: POST /api/garment-tracker/archive-from-live
//   2. Update quarter, dateRange, premiumItems, itemGroups, richardsonStyles
//   3. Update excludedCustomerIds if needed
//   4. Commit + deploy caspio-pricing-proxy to Heroku
//   5. Frontend picks up changes automatically (fetches /api/garment-tracker/config)

const GARMENT_TRACKER_CONFIG = {
    // Quarter label (used in archive table and display)
    quarter: '2026-Q2',

    // Date range for this quarter
    dateRange: {
        start: '2026-04-01',
        end: '2026-06-30'
    },

    // Premium items — tracked individually with per-item bonus
    // Flat map for backend part-number matching (getPremiumMatch, calculateBonus)
    premiumItems: {
        // $8.00 Bonus — TravisMathew Outerwear & Vests
        'TM1MW453': { name: 'TravisMathew Cold Bay Vest', bonus: 8 },
        'TM1MU422': { name: 'TravisMathew Surfside Full-Zip Jacket', bonus: 8 },
        'TMA42775': { name: 'TravisMathew Onward 1/4-Zip', bonus: 8 },
        'TMA42778': { name: "TravisMathew Women's Onward 1/2-Zip", bonus: 8 },

        // $5.00 Bonus — TravisMathew Polos & Nike
        'TM1MU410': { name: 'TravisMathew Coto Performance Polo', bonus: 5 },
        'TM1WX001': { name: "TravisMathew Women's Coto Sleeveless Polo", bonus: 5 },
        'NKFQ4794': { name: 'Nike Dri-FIT Smooth Heather Polo', bonus: 5 },
        'NKFQ4793': { name: "Nike Women's Dri-FIT Smooth Heather Polo", bonus: 5 },

        // $3.00 Bonus — OGIO & Sport-Tek Tops
        'OG1003':  { name: 'OGIO Aspect 1/2-Zip Pullover', bonus: 3 },
        'LPST871': { name: "Sport-Tek Women's Circuit Jogger", bonus: 3 },
        'LOG153':  { name: "OGIO Women's Motion 1/4-Zip", bonus: 3 },
        'LOG152':  { name: "OGIO Women's Motion Polo", bonus: 3 },
        'LST856':  { name: "Sport-Tek Women's Sport-Wick Stretch 1/2-Zip Hoodie", bonus: 3 },
        'OG152':   { name: 'OGIO Motion Polo', bonus: 3 },
        'ST941':   { name: 'Sport-Tek Teknical Hybrid Vest', bonus: 3 },

        // $1.50 Bonus — Sport-Tek Bottoms
        'PST485':  { name: 'Sport-Tek Repeat Pant', bonus: 1.5 },
        'LST486':  { name: "Sport-Tek Women's Repeat Skort", bonus: 1.5 },

        // $0.75 Bonus — Golf Towels
        'TW50':    { name: 'Port Authority Grommeted Tri-Fold Golf Towel', bonus: 0.75 },
        'TW530':   { name: 'Port Authority Grommeted Microfiber Golf Towel', bonus: 0.75 },
        'TW51':    { name: 'Port Authority Grommeted Golf Towel', bonus: 0.75 },
        'TW60':    { name: 'Port Authority Waffle Microfiber Golf Towel', bonus: 0.75 },
        'TW52':    { name: 'Port Authority Sport Towel', bonus: 0.75 },

        // $0.50 Bonus — Hemmed Towels
        'PT400':   { name: 'Port Authority Grommeted Hemmed Towel', bonus: 0.50 },
        'PT390':   { name: 'Port Authority Hemmed Towel', bonus: 0.50 }
    },

    // Item groups for UI display — each group shown as one row on the dashboard
    // styles[] must reference keys in premiumItems above
    itemGroups: [
        {
            name: 'TravisMathew Outerwear & Vests',
            bonus: 8,
            styles: ['TM1MW453', 'TM1MU422', 'TMA42775', 'TMA42778']
        },
        {
            name: 'TravisMathew & Nike Polos',
            bonus: 5,
            styles: ['TM1MU410', 'TM1WX001', 'NKFQ4794', 'NKFQ4793']
        },
        {
            name: 'OGIO & Sport-Tek Tops',
            bonus: 3,
            styles: ['OG1003', 'LPST871', 'LOG153', 'LOG152', 'LST856', 'OG152', 'ST941']
        },
        {
            name: 'Sport-Tek Bottoms',
            bonus: 1.5,
            styles: ['PST485', 'LST486']
        },
        {
            name: 'Golf Towels',
            bonus: 0.75,
            styles: ['TW50', 'TW530', 'TW51', 'TW60', 'TW52']
        },
        {
            name: 'Hemmed Towels',
            bonus: 0.50,
            styles: ['PT400', 'PT390']
        }
    ],

    // Richardson SanMar caps — empty for Q2 (no caps tracked)
    richardsonStyles: [],
    richardsonBonus: 0,

    // Sales reps to track
    trackedReps: ['Nika Lao', 'Taneisha Clark'],

    // Exclusions — orders that should NOT count toward commission
    excludedOrderTypeIds: [31],    // 31 = InkSoft webstore orders
    excludedCustomerIds: [13500]   // Rainier Pure Beef
};

module.exports = GARMENT_TRACKER_CONFIG;
