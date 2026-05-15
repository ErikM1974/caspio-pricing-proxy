// Contract DTG pricing — lean print-cost feed for /calculators/dtg-contract/.
//
// Reads the Contract_DTG_Costs Caspio table (5 locations × 4 tiers = 20 rows)
// and returns a shape the frontend can consume directly. Parallel to the
// corporate /api/dtg/product-bundle endpoint but stripped to JUST the
// per-location print costs — no garment, no margin, no sizes. Contract
// partners supply their own blanks, so those fields don't apply.

const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages } = require('../utils/caspio');

// Friendly display names for the 5 location codes. Caspio stores codes
// only; the frontend's LOC_META has the same mapping, but we send it on
// the response too so any downstream consumer (AI assistant, future
// reports) doesn't have to hardcode it. Codes match the contract page's
// existing location grid + the parts-row chips below the pricing table.
const LOCATION_NAMES = {
    LC: 'Left Chest',
    FF: 'Full Front',
    FB: 'Full Back',
    JF: 'Jumbo Front',
    JB: 'Jumbo Back',
};

// Static contract-page policy values. Not in Caspio because they're
// page-level rules, not per-row data — and the frontend already
// hardcodes them. Including them in the response means the frontend
// can read everything from one fetch and we have one place to flip
// if the policy ever changes.
const POLICY = {
    ltm: { fee: 50, threshold: 23 },        // $50 flat fee on qty ≤ 23
    heavyweight: { upcharge: 1.00 },        // +$1/pc for hoodies / fleece
};

// Canonical tier order for the contract page. The Caspio table SHOULD
// only contain these 4 labels (per the seed CSV), but we sort/filter
// defensively in case someone adds a stray row.
const CANONICAL_TIERS = ['1-23', '24-47', '48-71', '72+'];

// GET /api/contract-dtg/print-costs
// Returns { tiers, locations, costs, ltm, heavyweight }.
router.get('/print-costs', async (req, res) => {
    console.log('GET /api/contract-dtg/print-costs requested');

    try {
        const rows = await fetchAllCaspioPages('/tables/Contract_DTG_Costs/records', {
            'q.select': 'PrintLocationCode,TierLabel,PrintCost',
            'q.limit': 200,
        });

        // Defensive shape — Caspio may return PrintCost as a string.
        const costs = (rows || [])
            .filter(r => r && r.PrintLocationCode && r.TierLabel && r.PrintCost != null)
            .map(r => ({
                PrintLocationCode: String(r.PrintLocationCode).trim(),
                TierLabel: String(r.TierLabel).trim(),
                PrintCost: Number(r.PrintCost),
            }))
            .filter(r => !isNaN(r.PrintCost) && CANONICAL_TIERS.includes(r.TierLabel));

        if (costs.length === 0) {
            return res.status(500).json({
                error: 'Contract_DTG_Costs returned no usable rows. Verify the table is populated.',
            });
        }

        // Derive unique location list from the data, then enrich with
        // friendly names. Anything we don't have a name for falls back to
        // the code so the response stays well-formed.
        const locationCodes = [...new Set(costs.map(c => c.PrintLocationCode))];
        const locations = locationCodes
            .sort((a, b) => {
                // Preserve the contract page's grid order: LC, FF, FB, JF, JB.
                const order = ['LC', 'FF', 'FB', 'JF', 'JB'];
                const ai = order.indexOf(a);
                const bi = order.indexOf(b);
                if (ai === -1 && bi === -1) return a.localeCompare(b);
                if (ai === -1) return 1;
                if (bi === -1) return -1;
                return ai - bi;
            })
            .map(code => ({ code, name: LOCATION_NAMES[code] || code }));

        res.json({
            tiers: CANONICAL_TIERS,
            locations,
            costs,
            ltm: POLICY.ltm,
            heavyweight: POLICY.heavyweight,
        });
    } catch (err) {
        console.error('[contract-dtg-pricing] error:', err.message);
        res.status(500).json({ error: 'Failed to load contract DTG pricing: ' + err.message });
    }
});

module.exports = router;
