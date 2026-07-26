/**
 * Cadence guard on POST /api/supacolor-jobs/sync/all (src/routes/supacolor-jobs.js),
 * added 2026-07-26 for Caspio quota reduction.
 *
 * Heroku Scheduler fires this every 10 min (144x/day) and each run does a FULL
 * paginated scan of Supacolor_Jobs — 1,035 rows = 2 Caspio pages — before it can
 * diff anything. Heroku Scheduler offers only 10-min / hourly / daily, and hourly
 * was too coarse for status mirroring, so the 30-min cadence is enforced in-route.
 *
 * Fully mocked: no Supacolor API, no Caspio, no writes.
 */

jest.mock('../../src/utils/caspio', () => ({
  getCaspioAccessToken: jest.fn().mockResolvedValue('test-token'),
  makeCaspioRequest: jest.fn(),
  fetchAllCaspioPages: jest.fn().mockResolvedValue([])
}));

jest.mock('../../src/utils/supacolor-api', () => ({
  fetchAllActiveJobs: jest.fn().mockResolvedValue([])
}));

jest.mock('../../src/utils/transfer-status-mirror', () => ({
  mirrorShippedToTransfer: jest.fn().mockResolvedValue({})
}));

jest.mock('../../src/utils/transfer-auto-link', () => ({
  linkPendingSteveSubmissions: jest.fn().mockResolvedValue({})
}));

jest.mock('../../src/utils/slack-supacolor-health-notify', () => ({
  notifySupacolorHealth: jest.fn().mockResolvedValue({})
}));

const express = require('express');
const axios = require('axios');
const supacolorApi = require('../../src/utils/supacolor-api');
const supacolorRouter = require('../../src/routes/supacolor-jobs');

let server;
let baseUrl;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api', supacolorRouter);
  server = app.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

afterAll(() => new Promise((resolve) => {
  if (server.closeAllConnections) server.closeAllConnections();
  server.close(() => resolve());
}));

const syncAll = (qs = '') =>
  axios.post(`${baseUrl}/api/supacolor-jobs/sync/all${qs}`, {}, { validateStatus: () => true });

describe('POST /api/supacolor-jobs/sync/all — cadence guard', () => {
  test('the first run after boot performs a real sync', async () => {
    const res = await syncAll('?includeClosed=true');
    expect(res.status).toBe(200);
    expect(res.data.skipped).toBeUndefined();
    expect(supacolorApi.fetchAllActiveJobs).toHaveBeenCalled();
  });

  test('a second run inside the window is skipped without touching Caspio', async () => {
    supacolorApi.fetchAllActiveJobs.mockClear();

    const res = await syncAll('?includeClosed=true');
    expect(res.status).toBe(200);
    expect(res.data.skipped).toBe('cadence');
    expect(res.data.minIntervalMin).toBe(30);
    expect(typeof res.data.nextDueInMin).toBe('number');
    // The whole point: no upstream fetch and no Caspio scan.
    expect(supacolorApi.fetchAllActiveJobs).not.toHaveBeenCalled();
  });

  test('?bypassCadence=true forces a real sync', async () => {
    supacolorApi.fetchAllActiveJobs.mockClear();

    const res = await syncAll('?includeClosed=true&bypassCadence=true');
    expect(res.status).toBe(200);
    expect(res.data.skipped).toBeUndefined();
    expect(supacolorApi.fetchAllActiveJobs).toHaveBeenCalled();
  });

  // ?force= already means "overwrite existing Caspio fields with API values" on
  // this route. Overloading it for the cadence bypass would silently change write
  // behaviour for anyone trying to trigger an off-schedule sync.
  test('?force=true does NOT bypass the cadence', async () => {
    supacolorApi.fetchAllActiveJobs.mockClear();

    const res = await syncAll('?includeClosed=true&force=true');
    expect(res.data.skipped).toBe('cadence');
    expect(supacolorApi.fetchAllActiveJobs).not.toHaveBeenCalled();
  });
});

describe('GET /api/supacolor-jobs/stats — response cache', () => {
  test('a repeat read inside the TTL makes no Caspio call', async () => {
    const { fetchAllCaspioPages } = require('../../src/utils/caspio');

    await axios.get(`${baseUrl}/api/supacolor-jobs/stats?refresh=true`); // prime
    const primed = fetchAllCaspioPages.mock.calls.length;

    await axios.get(`${baseUrl}/api/supacolor-jobs/stats`);
    expect(fetchAllCaspioPages.mock.calls.length).toBe(primed);
  });

  test('?refresh=true bypasses the cache', async () => {
    const { fetchAllCaspioPages } = require('../../src/utils/caspio');

    await axios.get(`${baseUrl}/api/supacolor-jobs/stats`);
    const before = fetchAllCaspioPages.mock.calls.length;

    await axios.get(`${baseUrl}/api/supacolor-jobs/stats?refresh=true`);
    expect(fetchAllCaspioPages.mock.calls.length).toBeGreaterThan(before);
  });
});
