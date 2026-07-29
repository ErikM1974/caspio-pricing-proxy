// 🔒 The HTTP surface of GET /api/sticker-pricing/quote.
//
// HISTORY. This file used to be "sticker-quote-single-path" — the proof that
// sticker pricing had ONE implementation, after the AI tool in
// contract-sticker-ai.js was found carrying a hand-copied duplicate that had
// already drifted (different bounding-box strings, different error shape). Both
// were pointed at the shared quoteStickerFromGrid() on 2026-07-24 and this test
// swept a matrix asserting they agreed on every number reaching a customer.
//
// contract-sticker-ai.js was deleted on 2026-07-29, so the parity half is now
// vacuous — there is only one implementation left to compare against itself.
//
// 🔴 What is NOT vacuous, and is why this file was rewritten rather than deleted
// along with the route: it is the ONLY test in either repo that drives the real
// Express handler for /sticker-pricing/quote. That endpoint is LIVE and
// customer-facing — it backs the public /custom-stickers page.
// sticker-pricing.test.js covers the pure engine (loadGrid / quoteStickerFromGrid
// / deriveUnitPrice) by calling it directly; it never builds a req/res, so it
// cannot see the ROUTE ENVELOPE. Everything under "the wire envelope" below is
// untested anywhere else, and each item is a real rename or shape the engine
// tests cannot catch:
//   · engine says `kind`, the wire says `reason`            (sticker-pricing.js:397)
//   · engine says `bad_input`, the wire 400s `bad_request`  (sticker-pricing.js:383-386)
//   · `pricePerSticker` is a wire-only back-compat field    (sticker-pricing.js:410)
// Delete this file and those three ship untested.

jest.mock('../../src/utils/caspio', () => ({
  fetchAllCaspioPages: jest.fn(async () => { throw new Error('no caspio in test — force inline'); }),
}));

const stickerRouter = require('../../src/routes/sticker-pricing');

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

describe('sticker quote route — every on-grid ask returns a complete, coherent quote', () => {
  test.each(MATRIX)('$label ($width×$height × $qty)', async ({ width, height, qty, rush }) => {
    const { status, body } = await viaRoute({ width, height, qty, rush });

    expect(status).toBe(200);
    expect(body.offGrid).toBe(false);

    // Every field that represents money or identity — what a customer actually
    // sees on a quote, an invoice and a ShopWorks line item.
    for (const k of ['partNumber', 'size', 'quantity', 'totalPrice', 'unitPrice', 'pricePerSticker']) {
      expect(body[k]).toBeDefined();
    }
    expect(typeof body.totalPrice).toBe('number');
    expect(body.totalPrice).toBeGreaterThan(0);

    // The derived unit reconstructs the total — the whole reason we stopped
    // reading the stored PricePerSticker column (26 of 50 rows don't reconcile).
    expect(body.unitPrice * body.quantity).toBeCloseTo(body.totalPrice, 6);

    // pricePerSticker is the wire-only back-compat alias, rounded to 4dp.
    expect(body.pricePerSticker).toBeCloseTo(body.unitPrice, 4);
  });
});

describe('sticker quote route — the wire envelope (untested anywhere else)', () => {
  test('over-6-inch is off-grid, and the wire field is `reason` not `kind`', async () => {
    const { status, body } = await viaRoute({ width: 7, height: 7, qty: 100 });
    expect(status).toBe(200);
    expect(body.offGrid).toBe(true);
    // 🔴 The engine returns `kind`; the route renames it to `reason` on the way
    // out. Only this assertion pins that rename.
    expect(body.reason).toBe('oversize_dimension');
    expect(body.totalPrice).toBeUndefined();
  });

  test('over-10,000 is off-grid with its own reason', async () => {
    const { body } = await viaRoute({ width: 2, height: 2, qty: 10001 });
    expect(body.offGrid).toBe(true);
    expect(body.reason).toBe('oversize_quantity');
    expect(body.totalPrice).toBeUndefined();
  });

  test('bad input 400s with error:bad_request and never a price', async () => {
    const { status, body } = await viaRoute({ width: 0, height: 2, qty: 100 });
    // 🔴 The engine's word is `bad_input`; the wire's is `bad_request`, at a 400.
    // Different layer, different vocabulary — pinned only here.
    expect(status).toBe(400);
    expect(body.error).toBe('bad_request');
    expect(body.totalPrice).toBeUndefined();
  });

  test('the route does NOT emit the AI-only hand-off fields', async () => {
    // contract-sticker-ai's tool used to add useTool/escalation/setupFee on top
    // of this same engine. The route never did, and must not start — a customer
    // hitting /custom-stickers should get a price, not bot-routing metadata.
    const { body } = await viaRoute({ width: 8, height: 8, qty: 100 });
    expect(body.useTool).toBeUndefined();
    expect(body.escalation).toBeUndefined();
    expect(body.setupFee).toBeUndefined();
  });
});
