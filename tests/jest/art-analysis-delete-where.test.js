// DELETE /api/art-requests/:designId/analysis/:mockupSlot — two where-clause DELETEs
// (2026-09-06). It used to read the analyses, read the print locations, then DELETE
// each row by PK_ID: 2 + N + M calls. Caspio deletes by where-clause and answers
// RecordsAffected, so it is now 1 read + 2 deletes with exact counts.

const mockFetchAllCaspioPages = jest.fn();
const mockMakeCaspioRequest = jest.fn();
jest.mock('../../src/utils/caspio', () => ({
  fetchAllCaspioPages: (...a) => mockFetchAllCaspioPages(...a),
  makeCaspioRequest: (...a) => mockMakeCaspioRequest(...a),
  getCaspioAccessToken: jest.fn(async () => 'tok'),
  putWithRecordsAffected: jest.fn(),
  postBulk: jest.fn(),
}));

const express = require('express');
const router = require('../../src/routes/art');

async function del(path) {
  const app = express();
  app.use('/api', router);
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'DELETE' });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}
const deletes = () => mockMakeCaspioRequest.mock.calls.filter(([m]) => m === 'delete');

beforeEach(() => {
  mockFetchAllCaspioPages.mockReset();
  mockMakeCaspioRequest.mockReset();
});

test('three analyses with children: one read, one locations DELETE (by parent ids OR design+slot), one analyses DELETE', async () => {
  mockFetchAllCaspioPages.mockResolvedValue([{ PK_ID: 11 }, { PK_ID: 12 }, { PK_ID: 13 }]);
  mockMakeCaspioRequest.mockImplementation(async (m, resource) =>
    resource.includes('Print_Locations') ? { RecordsAffected: 7 } : { RecordsAffected: 3 });

  const r = await del('/api/art-requests/9001/analysis/Mockup_1');
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ deleted: 3, deletedLocations: 7 });

  expect(mockFetchAllCaspioPages).toHaveBeenCalledTimes(1);
  expect(deletes()).toHaveLength(2);
  const [locDel, anaDel] = deletes();
  expect(locDel[1]).toBe('/tables/Mockup_Print_Locations/records');
  expect(locDel[2]['q.where']).toBe("(Design_ID='9001' AND Mockup_Slot='Mockup_1') OR Analysis_ID IN ('11','12','13')");
  expect(anaDel[1]).toBe('/tables/Mockup_AI_Analysis/records');
  expect(anaDel[2]['q.where']).toBe("Design_ID='9001' AND Mockup_Slot='Mockup_1'");
});

test('nothing to delete: one read, zero writes', async () => {
  mockFetchAllCaspioPages.mockResolvedValue([]);
  const r = await del('/api/art-requests/9001/analysis/Mockup_2');
  expect(r.status).toBe(200);
  expect(r.body.deleted).toBe(0);
  expect(deletes()).toHaveLength(0);
});

test('a quote in the slot name is escaped, not injected', async () => {
  mockFetchAllCaspioPages.mockResolvedValue([{ PK_ID: 5 }]);
  mockMakeCaspioRequest.mockResolvedValue({ RecordsAffected: 1 });
  await del("/api/art-requests/9001/analysis/Mock'up");
  expect(deletes()[1][2]['q.where']).toBe("Design_ID='9001' AND Mockup_Slot='Mock''up'");
});
