// api-tracker: Caspio calls are attributed to the Express ROUTE that made them
// (2026-09-06). Before this the meter could say "Embroidery_Costs = 2,209" but
// never which route drove it. The request travels through AsyncLocalStorage from
// the middleware down to the axios interceptor, so every await in between keeps
// the attribution; crons label themselves with runWithLabel().

process.env.CASPIO_ACCOUNT_DOMAIN = process.env.CASPIO_ACCOUNT_DOMAIN || 'c3eku948.caspio.com';
const express = require('express');
const tracker = require('../../src/utils/api-tracker');
const CASPIO = 'https://c3eku948.caspio.com';

// Minimal axios-shaped stub so the interceptor can be driven without a network.
let stub;
beforeEach(() => {
  tracker.reset();
  const handlers = [];
  stub = {
    interceptors: { response: { use: (ok, err) => handlers.push({ ok, err }) } },
    respond: cfg => handlers.forEach(h => h.ok && h.ok({ config: cfg, status: 200 })),
  };
  tracker.installOn(stub);
});

// Simulate a route handler that awaits twice and then makes two Caspio calls.
async function handlerWork(table) {
  await new Promise(r => setTimeout(r, 2));
  stub.respond({ url: `${CASPIO}/integrations/rest/v3/tables/${table}/records`, method: 'get' });
  await Promise.resolve();
  stub.respond({ url: `${CASPIO}/integrations/rest/v3/tables/${table}/records`, method: 'get' });
}

async function requestThrough(router, path) {
  const app = express();
  app.use(tracker.routeContextMiddleware());
  app.use('/api', router);
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return res.status;
  } finally {
    server.close();
  }
}

test('calls made while handling a request are counted under its route PATTERN, and under route × table', async () => {
  const router = express.Router();
  router.get('/sanmar-orders/status/:po', async (req, res) => { await handlerWork('SanMar_Orders'); res.json({ ok: true }); });
  router.get('/dtg/top-sellers', async (req, res) => { await handlerWork('DTG_Top_Sellers_2026'); res.json({ ok: true }); });

  expect(await requestThrough(router, '/api/sanmar-orders/status/113795')).toBe(200);
  expect(await requestThrough(router, '/api/sanmar-orders/status/113787')).toBe(200);
  expect(await requestThrough(router, '/api/dtg/top-sellers?limit=5')).toBe(200);

  const full = tracker.getSummary({ full: true });
  expect(full.callsByRoute).toEqual([
    { route: 'GET /api/sanmar-orders/status/:po', count: 4 },   // pattern, not the two concrete POs
    { route: 'GET /api/dtg/top-sellers', count: 2 },
  ]);
  expect(full.routeTableCrosstab).toEqual([
    { route: 'GET /api/sanmar-orders/status/:po', table: 'SanMar_Orders', count: 4 },
    { route: 'GET /api/dtg/top-sellers', table: 'DTG_Top_Sellers_2026', count: 2 },
  ]);
  // The per-table view is unchanged by attribution.
  expect(tracker.getTopTables(5)).toEqual([{ table: 'SanMar_Orders', count: 4 }, { table: 'DTG_Top_Sellers_2026', count: 2 }]);
});

test('outside any request a call is __background__; runWithLabel names a cron', async () => {
  stub.respond({ url: `${CASPIO}/integrations/rest/v3/tables/Sync_Heartbeats/records`, method: 'put' });
  await tracker.runWithLabel('cron:sync-crm-dashboards', async () => {
    await new Promise(r => setTimeout(r, 1));
    stub.respond({ url: `${CASPIO}/integrations/rest/v3/tables/Taneisha_All_Accounts_Caspio/records`, method: 'put' });
  });
  const full = tracker.getSummary({ full: true });
  expect(full.callsByRoute).toEqual([
    { route: '__background__', count: 1 },
    { route: 'cron:sync-crm-dashboards', count: 1 },
  ]);
  expect(tracker.currentRouteLabel()).toBe('__background__');
});

test('the route maps are bounded like the others and cleared by reset()', () => {
  for (let i = 0; i < 600; i++) {
    tracker.runWithLabel(`label-${i}`, () => stub.respond({ url: `${CASPIO}/integrations/rest/v3/tables/T/records`, method: 'get' }));
  }
  expect(tracker.stats.callsByRoute.size).toBe(600);
  tracker.cleanup();
  expect(tracker.stats.callsByRoute.size).toBe(500);
  tracker.reset();
  expect(tracker.stats.callsByRoute.size).toBe(0);
  expect(tracker.stats.callsByRouteTable.size).toBe(0);
});
