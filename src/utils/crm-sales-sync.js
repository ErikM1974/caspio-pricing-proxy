// Diff-before-write for the CRM sales syncs (2026-09-06 Caspio quota reduction).
//
// /api/{taneisha,nika}-accounts/sync-sales recompute every account's true YTD
// (archived days + fresh ManageOrders days) each morning and used to PUT every
// account that has any 2026 sales — 892 + 474 rows — whether or not a number
// changed. Most accounts did not order yesterday, so most of those PUTs wrote
// back exactly what was stored.
//
// Now an account is PUT only when YTD_Sales_2026 / Order_Count_2026 /
// Last_Order_Date differ from the stored row. The unchanged accounts still get
// their Last_Sync_Date refreshed — the dashboards read it as "last synced" —
// but in ONE bulk PUT per 200 accounts (`ID_Customer IN (...)`, same value for
// every row), which is what a where-clause PUT is for. Net: a quiet day costs
// ~7 calls for both reps instead of ~1,366.
//
// The daily archive step (days 55–60, before ManageOrders drops them) used to
// GET "is this customer-day archived?" once per customer-day. One range read of
// the archive table per run answers all of them.

const { fetchAllCaspioPages, makeCaspioRequest } = require('./caspio');

// Caspio DATE/TIME comes back as '2026-08-14T00:00:00'; the sync writes
// '2026-08-14'. Compare on the calendar day.
function ymd(v) {
  if (v === null || v === undefined || v === '') return '';
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

// NUMBER columns hold decimals; the sync sums floats. Compare in cents.
function cents(v) {
  return Math.round((parseFloat(v) || 0) * 100);
}

// Has anything the sync writes (other than Last_Sync_Date) changed?
// `update.Last_Order_Date` is only present when the run saw a fresh order for
// the account; when absent the stored date is left alone, so it is not compared.
function accountChanged(stored, update) {
  if (!stored) return true;
  if (cents(stored.YTD_Sales_2026) !== cents(update.YTD_Sales_2026)) return true;
  if ((parseInt(stored.Order_Count_2026, 10) || 0) !== (parseInt(update.Order_Count_2026, 10) || 0)) return true;
  if (update.Last_Order_Date !== undefined && ymd(stored.Last_Order_Date) !== ymd(update.Last_Order_Date)) return true;
  return false;
}

// One PUT per chunk of ids: `{ Last_Sync_Date: timestamp }` where `key IN (...)`.
// Ids are coerced to integers (the account keys are INTEGER columns) so nothing
// but digits ever reaches the where-clause.
async function stampLastSync(table, key, ids, timestamp, { chunkSize = 200 } = {}) {
  const clean = [...new Set(ids.map(v => parseInt(v, 10)).filter(Number.isInteger))];
  let calls = 0;
  let recordsAffected = 0;
  for (let i = 0; i < clean.length; i += chunkSize) {
    const chunk = clean.slice(i, i + chunkSize);
    const result = await makeCaspioRequest('put', `/tables/${table}/records`,
      { 'q.where': `${key} IN (${chunk.join(',')})` },
      { Last_Sync_Date: timestamp });
    calls++;
    if (result && typeof result.RecordsAffected === 'number') recordsAffected += result.RecordsAffected;
  }
  return { calls, ids: clean.length, recordsAffected };
}

function archiveKey(date, customerId) {
  return `${ymd(date)}|${String(customerId)}`;
}

// Every (SalesDate, CustomerID) already in the archive table for the date range,
// as one read. SalesDate is DATE/TIME and the sync writes it as 'YYYY-MM-DD'
// (midnight), so an inclusive range of day literals covers it.
async function loadArchivedKeys(archiveTable, fromDate, toDate) {
  const rows = await fetchAllCaspioPages(`/tables/${archiveTable}/records`, {
    'q.where': `SalesDate>='${ymd(fromDate)}' AND SalesDate<='${ymd(toDate)}'`,
    'q.select': 'SalesDate,CustomerID',
    'q.orderBy': 'PK_ID',
    'q.limit': 1000
  });
  const keys = new Set();
  for (const r of (rows || [])) keys.add(archiveKey(r.SalesDate, r.CustomerID));
  return keys;
}

module.exports = { accountChanged, stampLastSync, loadArchivedKeys, archiveKey, ymd, cents };
