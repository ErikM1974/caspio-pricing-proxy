const fs = require('fs');
const { fetchAllCaspioPages } = require('../src/utils/caspio');
const OUT = 'C:/Users/erik/Downloads/_ccfields.json';
(async () => {
    const rows = await fetchAllCaspioPages('/tables/CreditCard_NWCA_ATMOS/records', { 'q.limit': 2 });
    fs.writeFileSync(OUT, JSON.stringify({ fields: Object.keys(rows[0] || {}), sample: rows[0] || {} }, null, 2));
})().catch(e => { fs.writeFileSync(OUT, 'ERR ' + (e.response ? JSON.stringify(e.response.data) : e.message)); });
