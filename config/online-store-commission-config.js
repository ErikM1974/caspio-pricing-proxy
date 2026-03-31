// Online Store Commission Configuration — SINGLE SOURCE OF TRUTH
//
// This file defines commission rates, baselines, and store-to-rep mappings
// for the InkSoft webstore commission program.
//
// When to edit this file:
//   - New store added → add to newStores[] with startDate and type
//   - Baseline changes → update reps[].quarterlyBaseline
//   - Rate changes → update commissionRates
//   - New AMC/Hops location → the ParentCompany formula in Caspio handles grouping
//
// The commission calculation endpoint reads this config and queries
// ManageOrders_Orders (Is_InkSoft=1) to calculate commissions.

const ONLINE_STORE_COMMISSION_CONFIG = {

    // ── Commission Rates ────────────────────────────────────────────────
    commissionRates: {
        maintenance: 0.01,    // 1% — existing stores (requires meeting baseline)
        newCompany: 0.05,     // 5% — brand new customer (first 6 months)
        newLocation: 0.03,    // 3% — new location of existing company (first 6 months)
    },

    // ── Setup Bonuses ───────────────────────────────────────────────────
    // One-time bonus when a new store hits revenue threshold within 12 months
    setupBonuses: {
        newCompany: { amount: 250, threshold: 2500 },   // $250 at $2,500
        newLocation: { amount: 100, threshold: 2500 },   // $100 at $2,500
    },

    // ── Rate Transition ─────────────────────────────────────────────────
    // New store rates (5%/3%) apply for this many months, then drop to 1%
    newStoreRateMonths: 6,

    // ── Sales Rep Configuration ─────────────────────────────────────────
    reps: {
        'Nika Lao': {
            quarterlyBaseline: 45814,    // $45,814/quarter
            annualBaseline: 183255,      // $183,255/year
        },
        'Taneisha Clark': {
            quarterlyBaseline: 51582,    // $51,582/quarter
            annualBaseline: 206328,      // $206,328/year
        },
    },

    // ── New Store Registry ──────────────────────────────────────────────
    // When a new InkSoft store is created, add it here with:
    //   - parentCompany: must match the ParentCompany formula output in Caspio
    //   - rep: "Nika Lao" or "Taneisha Clark"
    //   - type: "newCompany" (5%) or "newLocation" (3%)
    //   - startDate: first invoiced order date (YYYY-MM-DD)
    //   - setupBonusPaid: set to true once the bonus has been paid out
    //
    // After 6 months from startDate, the store automatically drops to 1%.
    // Remove entries from this list once they've fully transitioned to maintenance.
    //
    // Example:
    // {
    //     parentCompany: 'ABC Corp',
    //     rep: 'Nika Lao',
    //     type: 'newCompany',        // 5% rate
    //     startDate: '2026-04-15',   // clock starts here
    //     setupBonusPaid: false,     // $250 bonus not yet paid
    // },
    newStores: [
        {
            parentCompany: 'Shift Innovations',
            rep: 'Taneisha Clark',
            type: 'newCompany',         // 5% rate — brand new customer
            startDate: '2026-01-08',    // First invoiced order
            setupBonusPaid: false,      // $250 bonus at $2,500 revenue (within 12 months)
        },
        {
            parentCompany: 'Stella Jones',
            customerName: 'Stella Jones Western Operations',  // Specific location
            customerId: 2592,
            rep: 'Nika Lao',
            type: 'newLocation',        // 3% rate — new location of existing Stella Jones
            startDate: '2026-01-01',    // First invoiced order in 2026 (no pre-2026 history)
            setupBonusPaid: false,      // $100 bonus at $2,500 revenue (within 12 months)
        },
    ],

    // ── Quarter Date Ranges ─────────────────────────────────────────────
    quarters: {
        'Q1': { start: '01-01', end: '03-31' },
        'Q2': { start: '04-01', end: '06-30' },
        'Q3': { start: '07-01', end: '09-30' },
        'Q4': { start: '10-01', end: '12-31' },
    },

    // ── Revenue Field ───────────────────────────────────────────────────
    // Which Caspio field to use for commission calculation
    revenueField: 'cur_SubTotal',   // Before tax/shipping (confirmed by Erik)
};

module.exports = ONLINE_STORE_COMMISSION_CONFIG;
