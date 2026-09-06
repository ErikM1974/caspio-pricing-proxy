// POST /api/quote_change_log — an array body is ONE v4 bulk insert, not a POST
// per item (2026-09-06). This endpoint already accepted arrays and fanned them
// out one call each; the response contract (201 / 207, created, errorCount,
// errors[]) is unchanged.

const mockPostBulk = jest.fn();
jest.mock('../../src/utils/caspio', () => ({
  makeCaspioRequest: jest.fn(),
  fetchAllCaspioPages: jest.fn(),
  postBulk: (...a) => mockPostBulk(...a),
}));

const express = require('express');
const router = require('../../src/routes/quote-change-log');
const { makeCaspioRequest } = require('../../src/utils/caspio');

async function post(body) {
  const app = express();
  app.use('/api', router);
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/quote_change_log`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

beforeEach(() => {
  mockPostBulk.mockReset();
  mockPostBulk.mockImplementation(async (table, rows) => ({ table, calls: 1, inserted: rows.length, failed: 0, failures: [], pkIds: rows.map((_, i) => String(i + 1)) }));
});

test('three changes → one bulk call, PK_ID stripped, 201 with created=3', async () => {
  const r = await post([
    { QuoteID: 'Q1', FieldName: 'Status', ChangedAt: '2026-09-06T10:00:00', PK_ID: 99 },
    { QuoteID: 'Q1', FieldName: 'Total', ChangedAt: '2026-09-06T10:00:01' },
    { QuoteID: 'Q2', FieldName: 'Status', ChangedAt: '2026-09-06T10:00:02' },
  ]);
  expect(r.status).toBe(201);
  expect(r.body).toEqual({ success: true, created: 3, errorCount: 0 });
  expect(mockPostBulk).toHaveBeenCalledTimes(1);
  const [table, rows] = mockPostBulk.mock.calls[0];
  expect(table).toBe('Quote_Change_Log');
  expect(rows).toHaveLength(3);
  expect(rows[0]).toEqual({ QuoteID: 'Q1', FieldName: 'Status', ChangedAt: '2026-09-06T10:00:00' }); // PK_ID gone
  expect(makeCaspioRequest).not.toHaveBeenCalled();
});

test('a single object body still works (one-row bulk)', async () => {
  const r = await post({ QuoteID: 'Q1', FieldName: 'Status', ChangedAt: 'now' });
  expect(r.status).toBe(201);
  expect(r.body.created).toBe(1);
  expect(mockPostBulk.mock.calls[0][1]).toHaveLength(1);
});

test('invalid items are rejected before the call; valid ones still go in one bulk', async () => {
  const r = await post([{ QuoteID: 'Q1' }, { QuoteID: 'Q2', FieldName: 'F', ChangedAt: 'now' }]);
  expect(r.status).toBe(207);
  expect(r.body).toMatchObject({ success: false, created: 1, errorCount: 1 });
  expect(r.body.errors[0].error).toMatch(/required/);
  expect(mockPostBulk.mock.calls[0][1]).toHaveLength(1);
});

test('a 207 from Caspio maps each failed row into errors[]', async () => {
  mockPostBulk.mockResolvedValue({ calls: 1, inserted: 1, failed: 1, pkIds: ['1'], failures: [{ index: 1, status: 400, error: 'bad field', row: { QuoteID: 'Q2' } }] });
  const r = await post([{ QuoteID: 'Q1', FieldName: 'F', ChangedAt: 'now' }, { QuoteID: 'Q2', FieldName: 'F', ChangedAt: 'now' }]);
  expect(r.status).toBe(207);
  expect(r.body).toMatchObject({ success: false, created: 1, errorCount: 1 });
  expect(r.body.errors[0]).toEqual({ item: { QuoteID: 'Q2' }, error: 'bad field' });
});

test('a whole-request failure reports every row as an error, still a 207 with created=0', async () => {
  mockPostBulk.mockRejectedValue(new Error('postBulk Quote_Change_Log rows 0-1: 401 expired'));
  const r = await post([{ QuoteID: 'Q1', FieldName: 'F', ChangedAt: 'now' }, { QuoteID: 'Q2', FieldName: 'F', ChangedAt: 'now' }]);
  expect(r.status).toBe(207);
  expect(r.body).toMatchObject({ success: false, created: 0, errorCount: 2 });
  expect(r.body.errors[1].error).toMatch(/401 expired/);
});

test('nothing valid → no Caspio call at all', async () => {
  const r = await post([{ FieldName: 'F' }]);
  expect(r.status).toBe(207);
  expect(mockPostBulk).not.toHaveBeenCalled();
});
