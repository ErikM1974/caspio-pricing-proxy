// One-off: verify the Box thumbnail archive round-trip.
// 1) list the Box archive folder, 2) fetch each via /api/box/thumbnail serving,
// 3) show a couple archived DB rows (FileUrl -> Box, ExternalKey cleared).
try { require('dotenv').config(); } catch (_) {}
const axios = require('axios');
const { boxRequest, BOX_API_BASE } = require('../src/utils/box-client');
const { makeCaspioRequest } = require('../src/utils/caspio');

const FOLDER = process.env.BOX_THUMBNAIL_ARCHIVE_FOLDER_ID || '400901982283';
const PROXY = 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';

async function main() {
  const list = await boxRequest('GET', `${BOX_API_BASE}/folders/${FOLDER}/items?fields=id,name`);
  const entries = list.data.entries || [];
  console.log(`BOX ARCHIVE FOLDER: ${entries.length} file(s)`);
  for (const e of entries.slice(0, 5)) {
    let serve = 'n/a';
    try {
      const r = await axios.get(`${PROXY}/api/box/thumbnail/${e.id}`, { responseType: 'arraybuffer', timeout: 20000 });
      serve = `${r.status} ${r.headers['content-type']} ${r.data.length}B`;
    } catch (err) { serve = 'SERVE-FAIL ' + (err.response ? err.response.status : err.message); }
    console.log(`  ${e.id}  ${e.name}  -> serve: ${serve}`);
  }
  const rows = await makeCaspioRequest('get', '/tables/Shopworks_Thumbnail_Report/records',
    { 'q.where': "YEAR(timestamp_Added)=2016 AND FileUrl LIKE '%box/thumbnail%'", 'q.select': 'ID_Serial,FileUrl,ExternalKey', 'q.limit': 3 });
  const recs = Array.isArray(rows) ? rows : (rows && rows.Result) || [];
  console.log(`DB rows now pointing at Box (2016): ${recs.length}`);
  recs.forEach(r => console.log(`  ID ${r.ID_Serial}  ExternalKey="${r.ExternalKey}"  ${r.FileUrl}`));
}
main().catch(e => { console.error('FATAL:', e.response ? JSON.stringify(e.response.data) : e.message); process.exit(1); });
