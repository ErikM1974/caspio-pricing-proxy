/**
 * /api/manageorders/inventorylevels stays ANONYMOUS for the customer-facing
 * laser-tumbler calculator — so its responses MUST be projected to the
 * stock-only whitelist. Before 2026-08-27 the raw ManageOrders rows leaked
 * our wholesale cost (UnitCost/TotalCost), the supplier (VendorName), and
 * internal accounting fields (GLAccount, FindCode, id_Vendor, …) to anyone.
 *
 * These tests run the REAL projection the route uses (no network), fed a row
 * shaped like a real upstream response (field list captured live 2026-08-27).
 */
const {
  projectInventoryRows,
  INVENTORY_PUBLIC_FIELDS,
} = require('../../src/utils/manageorders');

// Every field the live upstream returned for LTM752 on 2026-08-27.
const RAW_ROW = {
  Color: 'Black', ColorRange: 'Blacks', FindCode: 'LTM752', GLAccount: '5000',
  ID_InvLevel: 12345, PartDescription: '20oz Polar Camel Tumbler',
  PartNumber: 'LTM752', PreprintGroup: '', ProductType: 'Drinkware',
  SKU: 'LTM752-BLK', Size01: 41, Size02: 0, Size03: 0, Size04: 0,
  Size05: 0, Size06: 0, TotalCost: 123.45, UnitCost: 3.01,
  VendorName: 'JDS Industries, Inc.', date_Creation: '2024-01-01',
  date_Modification: '2026-08-20', id_Vendor: 42,
};

const SENSITIVE = [
  'UnitCost', 'TotalCost', 'VendorName',
  'GLAccount', 'FindCode', 'id_Vendor', 'ID_InvLevel',
  'PreprintGroup', 'date_Creation',
];

describe('inventorylevels anonymous projection', () => {
  const [projected] = projectInventoryRows([RAW_ROW]);

  test.each(SENSITIVE)('strips %s', (field) => {
    expect(projected).not.toHaveProperty(field);
  });

  test('keeps everything the tumbler calculator reads', () => {
    // manageorders-inventory-service.js reads PartNumber/SKU/Color/Size01-06.
    expect(projected.PartNumber).toBe('LTM752');
    expect(projected.SKU).toBe('LTM752-BLK');
    expect(projected.Color).toBe('Black');
    for (const s of ['Size01', 'Size02', 'Size03', 'Size04', 'Size05', 'Size06']) {
      expect(projected).toHaveProperty(s);
    }
    // The route's stale-data warning reads date_Modification.
    expect(projected.date_Modification).toBe('2026-08-20');
  });

  test('projected rows carry ONLY whitelisted fields (no drift)', () => {
    for (const key of Object.keys(projected)) {
      expect(INVENTORY_PUBLIC_FIELDS).toContain(key);
    }
  });

  test('the whitelist itself never re-admits a sensitive field', () => {
    for (const field of SENSITIVE) {
      expect(INVENTORY_PUBLIC_FIELDS).not.toContain(field);
    }
  });

  test('handles null/empty input', () => {
    expect(projectInventoryRows(null)).toEqual([]);
    expect(projectInventoryRows([])).toEqual([]);
  });

  test('the route applies the projection on BOTH response paths (wiring)', () => {
    // Belt-and-braces source check: the functional tests above prove WHAT the
    // projection does; this proves the route actually CALLS it for the cache
    // hit AND the fresh fetch. (Reintroducing raw `result: inventory` or
    // `result: cached.data` turns this red — verified while writing it.)
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../src/routes/manageorders.js'), 'utf8');
    const calls = src.match(/result: projectInventoryRows\((cached\.data|inventory)\)/g) || [];
    expect(calls).toEqual(expect.arrayContaining([
      'result: projectInventoryRows(cached.data)',
      'result: projectInventoryRows(inventory)',
    ]));
  });
});
