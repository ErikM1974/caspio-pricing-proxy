const { fetchAllCaspioPages } = require('../src/utils/caspio');
(async () => {
    const rows = await fetchAllCaspioPages('/tables/CreditCard_NWCA_ATMOS/records', { 'q.limit': 2 });
    console.log('FIELDS>>>', JSON.stringify(Object.keys(rows[0] || {})));
    console.log('SAMPLE>>>', JSON.stringify(rows[0] || {}));
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
