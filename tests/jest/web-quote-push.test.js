jest.mock('../../src/utils/caspio', () => ({ fetchAllCaspioPages: jest.fn(), putWithRecordsAffected: jest.fn() }));
jest.mock('../../lib/manageorders-push-auth', () => ({ getTokenForEndpoint: jest.fn(async () => 'synthetic-token') }));
jest.mock('axios', () => ({ post: jest.fn() }));
const { buildPreview } = require('../../lib/web-quote-push');
const { fetchAllCaspioPages, putWithRecordsAffected } = require('../../src/utils/caspio');
const axios = require('axios');
const express = require('express');
const customer = { id_Customer: 123, Company_Name: 'Example Organization' };
function fixture() {
  return { session: { PK_ID: 42, QuoteID: 'WQ-2026-010', Status: 'Open', TotalAmount: 244,
    CreatedAt_Quote: '2026-09-17T12:00:00', CustomerName: 'Example Buyer',
    Notes: JSON.stringify({ channel: 'web-quote-cart', groups: [{ method: 'EMB', groupId: 'emb', options: { logos: { primary: { position: 'Left Chest', stitchCount: 8000 } } } }],
      artworkKeys: [{ groupId: 'emb', url: 'https://example.test/art.png', fileName: 'logo.png' }], customerNotes: 'Use green thread.' }) },
    items: [62.17, 119.16, 62.67].map((price, i) => ({ StyleNumber: ['PC098', 'EB545', 'DT1105'][i], ProductName: 'Example garment', Color: 'Deep Black', ColorCode: 'DeepBlack',
      Quantity: 1, FinalUnitPrice: price, LineTotal: price, SizeBreakdown: JSON.stringify({ S: 1 }), PrintLocationName: 'Left Chest', EmbellishmentType: 'embroidery' })) };
}
test('Bailey-shaped synthetic quote retains three garments and $244 with inventory colors, artwork and hold', () => {
  const { session, items } = fixture(); const p = buildPreview(session, items, customer);
  expect(p.subtotal).toBe(244); expect(p.order.LinesOE).toHaveLength(3);
  expect(p.order).toMatchObject({ ExtOrderID: 'NWCA-WQ-2026-010', APISource: 'ManageOrders', OnHold: 1, TaxTotal: 0, TaxPartNumber: '', id_Customer: 123 });
  expect(p.order.LinesOE[0]).toMatchObject({ Color: 'DeepBlack', Size: 'S', Price: '62.17' });
  expect(p.order.Attachments).toHaveLength(1);
  expect(p.order.ShippingAddresses[0].ShipMethod).toBe('');
  expect(p.order.ShippingAddresses[0].ShipCompany).toBe(customer.Company_Name);
  expect(JSON.stringify(p.order.Notes)).toContain('Use green thread.');
  expect(JSON.stringify(p.order.Notes)).toContain('8000');
});
test('penny allocation preserves each saved line total and size quantities', () => {
  const { session, items } = fixture(); const row = { ...items[0], Quantity: 6, SizeBreakdown: '{"S":2,"2XL":4}', LineTotal: 162.5, FinalUnitPrice: 27.08 };
  session.TotalAmount = 162.5;
  const lines = buildPreview(session, [row], customer).order.LinesOE;
  expect(lines.reduce((s, l) => s + Math.round(Number(l.Price) * 100) * Number(l.Qty), 0)).toBe(16250);
  expect(lines.filter(l => l.Size === '2XL').reduce((s, l) => s + Number(l.Qty), 0)).toBe(4);
  expect(lines.every(l => l.PartNumber === 'PC098')).toBe(true);
});
test('caps and known service fees retain their complete saved totals', () => {
  const { session, items } = fixture();
  const cap = { ...items[0], StyleNumber: 'C112', EmbellishmentType: 'cap', SizeBreakdown: '{"OSFA":1}', LineTotal: 20 };
  const fee = { ...items[0], StyleNumber: 'AS-CAP', EmbellishmentType: 'fee', Quantity: 2, LineTotal: 6, FinalUnitPrice: 3 };
  session.TotalAmount = 26;
  const p = buildPreview(session, [cap, fee], customer);
  expect(p.order.LinesOE).toEqual(expect.arrayContaining([
    expect.objectContaining({ PartNumber: 'C112', Size: 'OSFA', Qty: '1', Price: '20.00' }),
    expect.objectContaining({ PartNumber: 'AS-CAP', Qty: '2', Price: '3.00' })
  ]));
});
test.each([
  ['missing catalog color', (s, i) => { i[0].ColorCode = ''; }],
  ['bad size quantity', (s, i) => { i[0].SizeBreakdown = '{"S":2}'; }],
  ['unknown size', (s, i) => { i[0].SizeBreakdown = '{"oops":1}'; }],
  ['unknown fee', (s, i) => { i[0].EmbellishmentType = 'fee'; }],
  ['changed total', s => { s.TotalAmount = 245; }],
  ['other method', s => { const n = JSON.parse(s.Notes); n.groups[0].method = 'DTG'; s.Notes = JSON.stringify(n); }],
  ['paid quote', s => { const n = JSON.parse(s.Notes); n.payments = [{ kind: 'deposit', amount: 50 }]; s.Notes = JSON.stringify(n); }],
  ['cancelled quote', s => { s.Status = 'Cancelled_in_ShopWorks'; }]
])('blocks %s without silently dropping money or manufacturing defaults', (name, mutate) => {
  const { session, items } = fixture(); mutate(session, items);
  expect(() => buildPreview(session, items, customer)).toThrow();
});

let server, base, current;
const previousSecret = process.env.CRM_API_SECRET;
beforeAll(done => {
  process.env.CRM_API_SECRET = 'synthetic-secret';
  const app = express(); app.use(express.json()); app.use('/api/web-quote-push', require('../../src/routes/web-quote-push'));
  server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}/api/web-quote-push`; done(); });
});
afterAll(done => { if (previousSecret === undefined) delete process.env.CRM_API_SECRET; else process.env.CRM_API_SECRET = previousSecret; server.closeAllConnections(); server.close(done); });
beforeEach(() => {
  jest.clearAllMocks(); current = fixture();
  fetchAllCaspioPages.mockImplementation(async path => path.includes('Quote_Sessions') ? [current.session] : path.includes('Quote_Items') ? current.items : [customer]);
  putWithRecordsAffected.mockImplementation(async (path, where, values) => {
    if (where.includes('IS NULL') && current.session.PushedToShopWorks) return { RecordsAffected: 0 };
    Object.assign(current.session, values); return { RecordsAffected: 1 };
  });
  axios.post.mockResolvedValue({ status: 200, data: { success: true } });
});
async function call(path, body = {}, secret = true) {
  const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(secret ? { 'x-crm-api-secret': 'synthetic-secret' } : {}) }, body: JSON.stringify({ quoteId: 'WQ-2026-010', customerNumber: 123, ...body }) });
  return { status: response.status, data: await response.json() };
}
test('preview and push reject anonymous requests', async () => {
  expect((await call('/preview', {}, false)).status).toBe(401);
  expect((await call('/push-quote', {}, false)).status).toBe(401);
  expect(fetchAllCaspioPages).not.toHaveBeenCalled(); expect(axios.post).not.toHaveBeenCalled();
});
test('preview has no writes; success stamps once; retry cannot push twice', async () => {
  const preview = await call('/preview'); expect(preview.status).toBe(200);
  expect(putWithRecordsAffected).not.toHaveBeenCalled(); expect(axios.post).not.toHaveBeenCalled();
  const result = await call('/push-quote', { previewToken: preview.data.previewToken });
  expect(result.status).toBe(200); expect(current.session.PushedToShopWorks).toMatch(/^20/);
  expect((await call('/push-quote', { previewToken: preview.data.previewToken })).status).toBe(409);
  expect(axios.post).toHaveBeenCalledTimes(1);
});
test('simultaneous confirmations create one outbound request', async () => {
  const { data } = await call('/preview');
  const results = await Promise.all([call('/push-quote', { previewToken: data.previewToken }), call('/push-quote', { previewToken: data.previewToken })]);
  expect(results.map(r => r.status).sort()).toEqual([200, 409]); expect(axios.post).toHaveBeenCalledTimes(1);
});
test('stale preview is rejected before reserving or sending', async () => {
  const { data } = await call('/preview'); current.items[0].PrintLocationName = 'Right Chest';
  expect((await call('/push-quote', { previewToken: data.previewToken })).data.code).toBe('PREVIEW_CHANGED');
  expect(axios.post).not.toHaveBeenCalled(); expect(putWithRecordsAffected).not.toHaveBeenCalled();
});
test('uncertain network result keeps durable guard and prevents a second push', async () => {
  const { data } = await call('/preview'); axios.post.mockRejectedValueOnce(new Error('timeout'));
  expect((await call('/push-quote', { previewToken: data.previewToken })).data.code).toBe('SUBMISSION_UNCERTAIN');
  expect(current.session.PushedToShopWorks).toMatch(/^WQ-REVIEW:/);
  expect((await call('/push-quote', { previewToken: data.previewToken })).status).toBe(409);
  expect(axios.post).toHaveBeenCalledTimes(1);
});
test('failed final status write never reports success and keeps the guard', async () => {
  const { data } = await call('/preview'); const implementation = putWithRecordsAffected.getMockImplementation();
  putWithRecordsAffected.mockImplementation((path, where, values) => where.includes('IS NULL') ? implementation(path, where, values) : Promise.reject(new Error('unavailable')));
  expect((await call('/push-quote', { previewToken: data.previewToken })).data.code).toBe('SUBMISSION_UNCERTAIN');
  expect(current.session.PushedToShopWorks).toMatch(/^WQ-REVIEW:/);
});
test('unknown atomic update result fails closed', async () => {
  const { data } = await call('/preview'); putWithRecordsAffected.mockResolvedValueOnce({ Result: [] });
  expect((await call('/push-quote', { previewToken: data.previewToken })).status).toBe(409); expect(axios.post).not.toHaveBeenCalled();
});
test('legacy imported status or snapshot blocks a duplicate even without the timestamp column', async () => {
  current.session.ShopWorks_Status = 'Imported';
  expect((await call('/preview')).status).toBe(409);
  current.session.ShopWorks_Status = '';
  current.session.ShopWorks_Snapshot = JSON.stringify({ order: { id_Order: 12345 } });
  expect((await call('/preview')).status).toBe(409);
  expect(axios.post).not.toHaveBeenCalled();
});
test('inactive customer and explicit ManageOrders rejection never report success', async () => {
  const { data } = await call('/preview');
  axios.post.mockResolvedValueOnce({ status: 200, data: { success: false, error: 'Rejected' } });
  expect((await call('/push-quote', { previewToken: data.previewToken })).data.code).toBe('SUBMISSION_UNCERTAIN');
  current = fixture(); fetchAllCaspioPages.mockImplementation(async path => path.includes('Quote_Sessions') ? [current.session] : []);
  expect((await call('/preview')).status).toBe(422);
});
