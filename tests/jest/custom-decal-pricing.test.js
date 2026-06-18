// Locks the custom / oversize decal square-foot rate ladder + per-tier cliff
// floors so the rate card, the AI bot's quote_custom_decal tool, and the
// frontend calculator can never silently drift apart — or reintroduce a price
// cliff (a bigger order costing less than a smaller one). Caspio is mocked to
// throw, forcing the inline fallback ladder (the source of truth in the route).
//
// Test cases mirror Erik's spec (Codex Instructions §16) exactly.

jest.mock('../../src/utils/caspio', () => ({
  fetchAllCaspioPages: jest.fn(async () => { throw new Error('no caspio in test — force inline'); }),
}));

const {
  computeDecalQuote,
  loadDecalRates,
  SETUP_FEE_PART,
  SETUP_FEE_AMOUNT,
} = require('../../src/routes/custom-decal-pricing');

// total = (material + $50 setup) × (1 + tax)
const withSetupAndTax = (material, tax = 0.101) => Math.round((material + 50) * (1 + tax) * 100) / 100;

describe('custom-decal-pricing — locked ladder', () => {
  test('inline ladder loads the locked tiers + $90 minimum', async () => {
    const { tiers, minMaterial, source } = await loadDecalRates();
    expect(source).toBe('inline');
    expect(minMaterial).toBe(90);
    expect(tiers.map(t => [t.MaxSqFt, t.RatePerSqFt])).toEqual([
      [50, 12.0], [125, 9.5], [250, 7.5], [500, 6.0], [1000, 5.25], [999999, 4.8],
    ]);
  });

  test('setup fee constant is the shared GRT-50 $50', () => {
    expect(SETUP_FEE_PART).toBe('GRT-50');
    expect(SETUP_FEE_AMOUNT).toBe(50);
  });
});

describe('custom-decal-pricing — Erik spec test cases', () => {
  test('Test 1 — minimum charge: 6×6 × 5 → $90 material, $154.14 total', async () => {
    const q = await computeDecalQuote({ widthIn: 6, heightIn: 6, qty: 5 });
    expect(q.totalSqFt).toBe(1.25);
    expect(q.totalPrice).toBe(90);                 // 1.25 × $12 = $15 → $90 floor
    expect(withSetupAndTax(q.totalPrice)).toBe(154.14);
  });

  test('Test 2 — VCT whole-order: 6×6×6 + 12×12×10 + 18×18×10 → 34 sqft → $408, $504.26 total', async () => {
    const q = await computeDecalQuote({ items: [
      { widthIn: 6,  heightIn: 6,  qty: 6 },
      { widthIn: 12, heightIn: 12, qty: 10 },
      { widthIn: 18, heightIn: 18, qty: 10 },
    ]});
    expect(q.totalSqFt).toBe(34);
    expect(q.ratePerSqFt).toBe(12);
    expect(q.totalPrice).toBe(408);                // 34 × $12 (whole-order, no per-line min)
    expect(withSetupAndTax(q.totalPrice)).toBe(504.26);
    // per-line split sums back to the order total
    expect(q.lineItems.reduce((s, l) => s + l.totalPrice, 0)).toBeCloseTo(408, 2);
    expect(q.lineItems.map(l => l.partNumber)).toEqual(['DECAL-6X6', 'DECAL-12X12', 'DECAL-18X18']);
  });

  test('Test 3 — cliff at 50→51 sqft is protected at $600', async () => {
    const q = await computeDecalQuote({ widthIn: 1, heightIn: 144, qty: 51 }); // 51 sqft
    expect(q.totalSqFt).toBe(51);
    expect(q.totalPrice).toBe(600);                // 51 × $9.50 = $484.50 → floored to $600
    expect(q.appliedRules.tierFloor).toMatch(/600/);
  });

  test('Test 4 — 72 sqft clears the floor at $684', async () => {
    const q = await computeDecalQuote({ widthIn: 1, heightIn: 144, qty: 72 });
    expect(q.totalSqFt).toBe(72);
    expect(q.totalPrice).toBe(684);                // 72 × $9.50, above the $600 floor
    expect(q.appliedRules.tierFloor).toBeNull();
  });

  test('Test 5 — cliff at 125→126 sqft is protected at $1,187.50', async () => {
    const q = await computeDecalQuote({ widthIn: 1, heightIn: 144, qty: 126 });
    expect(q.totalSqFt).toBe(126);
    expect(q.totalPrice).toBe(1187.5);             // 126 × $7.50 = $945 → floored
  });

  test('Test 6 — large order 1,001 sqft protected at $5,250', async () => {
    const q = await computeDecalQuote({ widthIn: 1, heightIn: 144, qty: 1001 });
    expect(q.totalSqFt).toBe(1001);
    expect(q.totalPrice).toBe(5250);               // 1001 × $4.80 = $4,804.80 → floored
  });
});

describe('custom-decal-pricing — properties', () => {
  test('NO price cliff anywhere: total never decreases as sq ft rises 1→2000', async () => {
    let prev = 0;
    for (let sqft = 1; sqft <= 2000; sqft += 1) {
      // 1"×144" piece = 1 sqft each → qty == sqft
      const q = await computeDecalQuote({ widthIn: 1, heightIn: 144, qty: sqft });
      expect(q.totalPrice).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = q.totalPrice;
    }
  });

  test('rush applies a 1.25× multiplier', async () => {
    const q = await computeDecalQuote({ widthIn: 12, heightIn: 12, qty: 10, rush: true });
    expect(q.totalPrice).toBe(150);                // 10 sqft × $12 = $120 × 1.25
    expect(q.appliedRules.rush).toMatch(/1\.25/);
  });

  test('bounding box uses W×H area', async () => {
    const q = await computeDecalQuote({ widthIn: 24, heightIn: 12, qty: 10 }); // 2 sqft ea × 10 = 20 sqft
    expect(q.totalSqFt).toBe(20);
    expect(q.totalPrice).toBe(240);                // 20 × $12
  });

  test('bad input returns an error, not a price', async () => {
    expect((await computeDecalQuote({ widthIn: 0, heightIn: 6, qty: 10 })).error).toBe('bad_input');
    expect((await computeDecalQuote({ items: [{ widthIn: 6, heightIn: 6, qty: 0 }] })).error).toBe('bad_input');
  });
});
