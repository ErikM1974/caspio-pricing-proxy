/**
 * SanMar shipment-FIRST sweep (OSN queryType=3) — the completeness guarantee.
 *
 * Every other discovery path in sanmar-orders.js is PO-first: it asks SanMar
 * "what shipped for the POs I know about", which can confirm what we already hold
 * but can never prove we hold everything. PO 113781 (Superheat LLC, WO 142568)
 * shipped 2026-07-24 and appeared on NO inbound day at all, because our order row
 * was frozen on 'confirmed' and none of the three PO-first paths named it again.
 *
 * queryType=3 inverts the question — "everything you shipped since <timestamp>" —
 * which is the same view as the freight manifest (PSST) SanMar emails us. These
 * tests pin the two places that silently lose a carton: flattening the nested
 * response, and deciding whether an error means "empty window" or "call failed".
 */
const {
  flattenShipmentCartons,
  cartonKey,
  isEmptyWindowError,
} = require('../../src/routes/sanmar-orders');

// Shaped exactly like parseShipmentResponse() output for the real 7/24 manifest:
// 113795 shipped TWO cartons from Richmond VA, 113787 one from Irving TX.
const PARSED = [
  {
    purchaseOrderNumber: '113795',
    salesOrders: [{
      salesOrderNumber: '163472846',
      locations: [{
        shipFrom: { city: 'RICHMOND', region: 'VA', postalCode: '23231', address1: '1 WAREHOUSE WAY' },
        shipTo: { address1: '2025 Freeman Rd', city: 'Milton', region: 'WA' },
        packages: [
          { trackingNumber: '1ZGH03410357056814', carrier: 'UPS', shipmentMethod: 'Ground', shipmentDate: '2026-07-24T16:02:11.000-07:00' },
          { trackingNumber: '1ZGH03410357056136', carrier: 'UPS', shipmentMethod: 'Ground', shipmentDate: '2026-07-24T16:04:52.000-07:00' },
        ],
      }],
    }],
  },
  {
    purchaseOrderNumber: '113787',
    salesOrders: [{
      salesOrderNumber: '163464742',
      locations: [{
        shipFrom: { city: 'IRVING', region: 'TX', postalCode: '75038', address1: '4701 NORTHVIEW DR' },
        shipTo: { address1: '2025 Freeman Rd', city: 'Milton', region: 'WA' },
        packages: [{ trackingNumber: '1Z80E15V0307327090', carrier: 'UPS', shipmentMethod: 'Ground', shipmentDate: '2026-07-24T16:09:59.580-07:00' }],
      }],
    }],
  },
];

describe('flattenShipmentCartons — no carton may be lost on the way out of the response', () => {
  test('every package becomes one carton, tagged with its PO', () => {
    const c = flattenShipmentCartons(PARSED);
    expect(c).toHaveLength(3);
    expect(c.map(x => x.po)).toEqual(['113795', '113795', '113787']);
    expect(c.map(x => x.pkg.trackingNumber)).toEqual([
      '1ZGH03410357056814', '1ZGH03410357056136', '1Z80E15V0307327090',
    ]);
  });

  test('ship-from travels with the carton, not the PO (multi-warehouse POs exist)', () => {
    const c = flattenShipmentCartons(PARSED);
    expect(c[0].shipFrom.region).toBe('VA');
    expect(c[2].shipFrom.region).toBe('TX');
    expect(c[2].shipTo.city).toBe('Milton');
  });

  test('a PO shipping from TWO warehouses keeps both locations', () => {
    const split = [{
      purchaseOrderNumber: '113900',
      salesOrders: [{
        locations: [
          { shipFrom: { region: 'NV' }, shipTo: {}, packages: [{ trackingNumber: '1ZNV0001' }] },
          { shipFrom: { region: 'AZ' }, shipTo: {}, packages: [{ trackingNumber: '1ZAZ0001' }] },
        ],
      }],
    }];
    const c = flattenShipmentCartons(split);
    expect(c).toHaveLength(2);
    expect(c.map(x => x.shipFrom.region)).toEqual(['NV', 'AZ']);
  });

  test('a package with no tracking number is not a reconcilable carton', () => {
    const c = flattenShipmentCartons([{
      purchaseOrderNumber: '113800',
      salesOrders: [{ locations: [{ shipFrom: {}, shipTo: {}, packages: [{ trackingNumber: '' }, { trackingNumber: '1ZOK0001' }] }] }],
    }]);
    expect(c).toHaveLength(1);
    expect(c[0].pkg.trackingNumber).toBe('1ZOK0001');
  });

  test('a shipment block with no PO is skipped rather than written under an empty key', () => {
    expect(flattenShipmentCartons([{ salesOrders: [{ locations: [{ packages: [{ trackingNumber: '1ZX' }] }] }] }])).toHaveLength(0);
  });

  test('missing/empty nesting at any level degrades to no cartons, never throws', () => {
    expect(flattenShipmentCartons([])).toEqual([]);
    expect(flattenShipmentCartons(null)).toEqual([]);
    expect(flattenShipmentCartons(undefined)).toEqual([]);
    expect(flattenShipmentCartons([{ purchaseOrderNumber: '1' }])).toEqual([]);
    expect(flattenShipmentCartons([{ purchaseOrderNumber: '1', salesOrders: [{}] }])).toEqual([]);
    expect(flattenShipmentCartons([{ purchaseOrderNumber: '1', salesOrders: [{ locations: [{}] }] }])).toEqual([]);
  });
});

describe('cartonKey — tracking numbers are unique only WITHIN a PO', () => {
  test('same tracking under different POs is two distinct cartons', () => {
    expect(cartonKey('113795', '1ZABC')).not.toBe(cartonKey('113787', '1ZABC'));
  });
  test('case and whitespace do not create a phantom duplicate', () => {
    expect(cartonKey('113795', ' 1zabc ')).toBe(cartonKey('113795', '1ZABC'));
  });
  test('a blank tracking number still yields a stable key', () => {
    expect(cartonKey('113795', null)).toBe(cartonKey('113795', ''));
  });
});

describe('isEmptyWindowError — "nothing shipped" must never be confused with "the call failed"', () => {
  test('160 / Data not found = a genuinely quiet window', () => {
    expect(isEmptyWindowError({ error: true, code: 160, message: 'No results found' })).toBe(true);
    expect(isEmptyWindowError({ error: true, code: 0, message: 'Data not found' })).toBe(true);
  });

  test('no error at all is not an empty window', () => {
    expect(isEmptyWindowError(null)).toBe(false);
  });

  // These MUST propagate. A sweep that swallows an auth failure reports "SanMar shipped
  // nothing" — the exact silent-empty that hid PO 113781 for three days.
  test('auth / unauthorized / stale-timestamp / SOAP faults are REAL failures', () => {
    expect(isEmptyWindowError({ error: true, code: 105, message: 'SanMar authentication failed' })).toBe(false);
    expect(isEmptyWindowError({ error: true, code: 104, message: 'Account unauthorized for this service' })).toBe(false);
    expect(isEmptyWindowError({ error: true, code: 0, message: 'Invalid request' })).toBe(false);
    expect(isEmptyWindowError({ error: true, code: 0, message: 'search date is older than 7 days' })).toBe(false);
    expect(isEmptyWindowError({ error: true, code: 0, message: 'Unknown SOAP fault' })).toBe(false);
  });
});
