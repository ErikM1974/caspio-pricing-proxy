// Garment Tracker Quarter Configuration — SINGLE SOURCE OF TRUTH
//
// This is the ONLY file to edit when swapping products for a new quarter.
// The backend route, sync script, and frontend all read from this config.
//
// Q2 transition checklist:
//   1. Update quarter, dateRange, premiumItems, richardsonStyles
//   2. Update excludedCustomerIds if needed
//   3. Commit + deploy caspio-pricing-proxy to Heroku
//   4. Frontend picks up changes automatically (fetches /api/garment-tracker/config)

const GARMENT_TRACKER_CONFIG = {
    // Quarter label (used in archive table and display)
    quarter: '2026-Q1',

    // Date range for this quarter
    dateRange: {
        start: '2026-01-01',
        end: '2026-03-31'
    },

    // Premium items — tracked individually with per-item bonus
    premiumItems: {
        'CT104670': { name: 'Carhartt Storm Defender Jacket', bonus: 5 },
        'EB550':    { name: 'Eddie Bauer Rain Jacket', bonus: 5 },
        'CT103828': { name: 'Carhartt Duck Detroit Jacket', bonus: 5 },
        'CT102286': { name: 'Carhartt Gilliam Vest', bonus: 3 },
        'NF0A52S7': { name: 'North Face Dyno Backpack', bonus: 2 }
    },

    // Richardson SanMar caps — grouped as one total, $0.50 each
    richardsonStyles: [
        '110', '111', '112', '112FP', '112FPR', '112PFP', '112PL', '112PT',
        '115', '168', '168P', '169', '172', '173', '212', '220', '225', '256', '256P',
        '312', '323FPC', '325', '326', '336', '355', '356',
        '435', '511', '514', '514J', '840', '842', '870'
    ],
    richardsonBonus: 0.50,

    // Sales reps to track
    trackedReps: ['Nika Lao', 'Taneisha Clark'],

    // Exclusions — orders that should NOT count toward commission
    excludedOrderTypeIds: [31],    // 31 = InkSoft webstore orders
    excludedCustomerIds: [13500]   // Q1 2026: Rainier Pure Beef
};

module.exports = GARMENT_TRACKER_CONFIG;
