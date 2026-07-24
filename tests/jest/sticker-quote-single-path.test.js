// 🔒 THE PROOF that sticker pricing has ONE implementation.
//
// Before 2026-07-24 there were two: the HTTP route in sticker-pricing.js and a
// hand-copied duplicate inside contract-sticker-ai.js's quote_sticker_price
// tool. They had already drifted (different bounding-box message strings, a
// different error shape, and the AI carried a decal hand-off the route lacked).
// Two implementations of the same money is exactly what CLAUDE.md Rule 9 exists
// to prevent — a rep, a customer and the bot must never be quoted differently
// for the same ask.
//
// Both now call the shared quoteStickerFromGrid(). This test sweeps a matrix and
// asserts they agree on every number that reaches a customer. It should fail
// loudly the moment anyone re-forks the logic.
//
// It ALSO pins the two intentional differences, so "they agree" can't be
// achieved by accidentally deleting the AI's decal hand-off.

jest.mock('../../src/utils/caspio', () => ({
  fetchAllCaspioPages: jest.fn(async () => { throw new Error('no caspio in test — force inline'); }),
}));

const stickerRouter = require('../../src/routes/sticker-pricing');
const { __testables } = require('../../src/routes/contract-sticker-ai');

// The AI's tool implementation, exposed for test (see contract-sticker-ai.js).
const quoteStickerPrice = __testables.quoteStickerPrice;

// Invoke the real Express handler with a fake req/res rather than pulling in
// supertest — keeps this hermetic and adds no dependency. We deliberately drive
// the SHIPPING handler (not a copy of its body), because a reimplementation
// here would defeat the entire point of the file.
function findHandler(router, path) {
  const layer = router.stack.find(l => l.route && l.route.path === path);
  if (!layer) throw new Error(`route not found: ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
const quoteHandler = findHandler(stickerRouter, '/sticker-pricing/quote');

async function viaRoute({ width, height, qty, rush }) {
  const query = { width: String(width), height: String(height), qty: String(qty) };
  if (rush) query.rush = 'true';

  return new Promise((resolve, reject) => {
    let status = 200;
    const res = {
      set() { return res; },
      status(code) { status = code; return res; },
      json(body) { resolve({ status, body }); return res; },
    };
    Promise.resolve(quoteHandler({ query }, res)).catch(reject);
  });
}

// Every field that represents money or identity — what a customer actually sees
// on a quote, an invoice and a ShopWorks line item.
const MONEY_FIELDS = ['offGrid', 'partNumber', 'size', 'quantity', 'totalPrice', 'unitPrice', 'pricePerSticker', 'isBestValue'];
const pickMoney = o => MONEY_FIELDS.reduce((acc, k) => (k in o ? { ...acc, [k]: o[k] } : acc), {});

const MATRIX = [
  { label: 'exact standard cell',        width: 3,   height: 3,   qty: 100 },
  { label: 'smallest cell',              width: 2,   height: 2,   qty: 50 },
  { label: 'largest cell',               width: 6,   height: 6,   qty: 10000 },
  { label: 'rectangle rounds up',        width: 2,   height: 3,   qty: 200 },
  { label: 'rectangle, axes swapped',    width: 3,   height: 2,   qty: 200 },
  { label: 'fractional size rounds up',  width: 2.5, height: 2.5, qty: 500 },
  { label: 'off-tier qty rounds up',     width: 4,   height: 4,   qty: 250 },
  { label: 'below the 50 minimum',       width: 2,   height: 2,   qty: 10 },
  { label: 'best-value tier',            width: 3,   height: 3,   qty: 100 },
  { label: 'rush applied',               width: 4,   height: 4,   qty: 1000, rush: true },
  { label: 'rush on a rounded cell',     width: 2,   height: 5,   qty: 75,   rush: true },
  { label: 'the penny-gap row',          width: 4,   height: 4,   qty: 10000 },
];

describe('sticker quote — the HTTP route and the AI tool are ONE implementation', () => {
  test.each(MATRIX)('$label ($width×$height × $qty)', async ({ width, height, qty, rush }) => {
    const { status, body } = await viaRoute({ width, height, qty, rush });
    const ai = await quoteStickerPrice({ width, height, qty, rush: !!rush });

    expect(status).toBe(200);
    expect(body.offGrid).toBe(false);
    expect(pickMoney(body)).toEqual(pickMoney(ai));

    // And the derived unit reconstructs the total on both paths — the whole
    // reason we stopped reading the stored PricePerSticker column.
    expect(body.unitPrice * body.quantity).toBeCloseTo(body.totalPrice, 6);
    expect(ai.unitPrice * ai.quantity).toBeCloseTo(ai.totalPrice, 6);
  });

  test('both paths agree that over-6-inch is off-grid', async () => {
    const { body } = await viaRoute({ width: 7, height: 7, qty: 100 });
    const ai = await quoteStickerPrice({ width: 7, height: 7, qty: 100 });
    expect(body.offGrid).toBe(true);
    expect(ai.offGrid).toBe(true);
    expect(body.reason).toBe('oversize_dimension');
    expect(ai.reason).toBe('oversize_dimension');
  });

  test('both paths agree that over-10,000 is off-grid', async () => {
    const { body } = await viaRoute({ width: 2, height: 2, qty: 10001 });
    const ai = await quoteStickerPrice({ width: 2, height: 2, qty: 10001 });
    expect(body.offGrid).toBe(true);
    expect(ai.offGrid).toBe(true);
    expect(body.reason).toBe('oversize_quantity');
    expect(ai.reason).toBe('oversize_quantity');
  });
});

describe('sticker quote — the two INTENTIONAL differences, pinned', () => {
  test('🔴 only the AI emits the decal hand-off on an oversize dimension', async () => {
    // The system prompt routes oversize → quote_custom_decal on exactly these
    // two fields. A refactor that "unifies" the shapes by dropping them would
    // silently break the sticker→decal hand-off and make the bot escalate to a
    // manual quote instead of pricing the job.
    const ai = await quoteStickerPrice({ width: 8, height: 8, qty: 100 });
    expect(ai.useTool).toBe('quote_custom_decal');
    expect(ai.escalation).toMatch(/quote_custom_decal/);

    const { body } = await viaRoute({ width: 8, height: 8, qty: 100 });
    expect(body.useTool).toBeUndefined();
  });

  test('bad input: the route 400s, the AI returns an error object — neither returns a price', async () => {
    const { status, body } = await viaRoute({ width: 0, height: 2, qty: 100 });
    expect(status).toBe(400);
    expect(body.error).toBe('bad_request');
    expect(body.totalPrice).toBeUndefined();

    const ai = await quoteStickerPrice({ width: 0, height: 2, qty: 100 });
    expect(ai.error).toBe('bad_input');
    expect(ai.totalPrice).toBeUndefined();
  });

  test('only the AI attaches the setup-fee note (the route leaves it to the caller)', async () => {
    const ai = await quoteStickerPrice({ width: 3, height: 3, qty: 100 });
    expect(ai.setupFee).toEqual({
      partNumber: 'GRT-50',
      amount: 50,
      note: expect.stringContaining('waived'),
    });
  });
});
