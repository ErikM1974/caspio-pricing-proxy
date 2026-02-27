// Script to populate House_Accounts from ManageOrders data
// Fetches orders from Jan 1, 2026 to today and adds unique customers
// that are NOT already in Taneisha or Nika's account lists

require('dotenv').config();
const { fetchAllCaspioPages, getCaspioAccessToken } = require('../src/utils/caspio');
const { authenticateManageOrders, fetchOrders } = require('../src/utils/manageorders');
const axios = require('axios');
const config = require('../config');

const TANEISHA_TABLE = 'Taneisha_All_Accounts_Caspio';
const NIKA_TABLE = 'Nika_All_Accounts_Caspio';
const HOUSE_TABLE = 'House_Accounts';

async function populateHouseAccounts() {
    console.log('=== Populating House Accounts from ManageOrders ===\n');

    const startDate = '2026-01-01';
    const today = new Date().toISOString().split('T')[0];
    console.log(`Date range: ${startDate} to ${today}\n`);

    try {
        // Step 1: Fetch all existing account lists
        console.log('Step 1: Fetching existing account lists...');

        const [taneishaAccounts, nikaAccounts, existingHouse] = await Promise.all([
            fetchAllCaspioPages(`/tables/${TANEISHA_TABLE}/records`, {
                'q.select': 'ID_Customer'
            }),
            fetchAllCaspioPages(`/tables/${NIKA_TABLE}/records`, {
                'q.select': 'ID_Customer'
            }),
            fetchAllCaspioPages(`/tables/${HOUSE_TABLE}/records`, {
                'q.select': 'ID_Customer'
            }).catch(() => [])
        ]);

        const taneishaIds = new Set(taneishaAccounts.map(a => a.ID_Customer));
        const nikaIds = new Set(nikaAccounts.map(a => a.ID_Customer));
        const existingHouseIds = new Set(existingHouse.map(a => a.ID_Customer));

        console.log(`  - Taneisha accounts: ${taneishaIds.size}`);
        console.log(`  - Nika accounts: ${nikaIds.size}`);
        console.log(`  - Existing house accounts: ${existingHouseIds.size}\n`);

        // Step 2: Fetch orders from ManageOrders
        console.log('Step 2: Fetching orders from ManageOrders...');

        // Fetch in chunks to avoid timeout
        let allOrders = [];
        const chunkSize = 7; // 7 days per chunk
        let currentStart = new Date(startDate);
        const endDate = new Date(today);

        while (currentStart <= endDate) {
            let chunkEnd = new Date(currentStart);
            chunkEnd.setDate(chunkEnd.getDate() + chunkSize - 1);
            if (chunkEnd > endDate) chunkEnd = endDate;

            const chunkStartStr = currentStart.toISOString().split('T')[0];
            const chunkEndStr = chunkEnd.toISOString().split('T')[0];

            console.log(`  Fetching ${chunkStartStr} to ${chunkEndStr}...`);

            try {
                const chunkOrders = await fetchOrders({
                    date_Invoiced_start: chunkStartStr,
                    date_Invoiced_end: chunkEndStr
                });
                allOrders = allOrders.concat(chunkOrders);
                console.log(`    Found ${chunkOrders.length} orders`);
            } catch (e) {
                console.warn(`    Warning: chunk failed - ${e.message}`);
            }

            currentStart.setDate(currentStart.getDate() + chunkSize);
        }

        console.log(`\n  Total orders fetched: ${allOrders.length}\n`);

        // Step 3: Extract unique customers not in Taneisha or Nika lists
        console.log('Step 3: Extracting unique house customers...');

        const houseCustomers = new Map(); // id_Customer -> { name, rep, lastOrder }

        allOrders.forEach(order => {
            const customerId = order.id_Customer;
            const customerName = order.CustomerName;
            const rep = order.CustomerServiceRep;
            const orderDate = order.date_Invoiced;

            // Skip if in Taneisha or Nika's list
            if (taneishaIds.has(customerId) || nikaIds.has(customerId)) {
                return;
            }

            // Skip if already in house accounts
            if (existingHouseIds.has(customerId)) {
                return;
            }

            // Add or update customer entry
            const existing = houseCustomers.get(customerId);
            if (!existing || new Date(orderDate) > new Date(existing.lastOrder)) {
                houseCustomers.set(customerId, {
                    ID_Customer: customerId,
                    CompanyName: customerName,
                    rep: rep,
                    lastOrder: orderDate
                });
            }
        });

        console.log(`  Found ${houseCustomers.size} new house customers\n`);

        if (houseCustomers.size === 0) {
            console.log('No new customers to add. Done!');
            return;
        }

        // Step 4: Determine Assigned_To based on rep
        console.log('Step 4: Assigning customers to house handlers...');

        const accountsToAdd = [];
        const repCounts = {};

        houseCustomers.forEach((customer) => {
            // Determine Assigned_To based on rep pattern
            let assignedTo = 'House'; // default
            const rep = customer.rep || '';

            if (rep.toLowerCase().includes('ruthie') || rep.toLowerCase().includes('ruth')) {
                assignedTo = 'Ruthie';
            } else if (rep.toLowerCase().includes('erik')) {
                assignedTo = 'Erik';
            } else if (rep.toLowerCase().includes('jim')) {
                assignedTo = 'Jim';
            } else if (rep.toLowerCase().includes('web') || rep === '' || !rep) {
                assignedTo = 'Web';
            }

            repCounts[assignedTo] = (repCounts[assignedTo] || 0) + 1;

            accountsToAdd.push({
                ID_Customer: customer.ID_Customer,
                CompanyName: customer.CompanyName,
                Assigned_To: assignedTo,
                Notes: `Added from ManageOrders. Last order: ${customer.lastOrder?.split('T')[0] || 'unknown'}. Original rep: ${customer.rep || 'none'}`
            });
        });

        console.log('  Assignment breakdown:');
        Object.entries(repCounts).sort((a, b) => b[1] - a[1]).forEach(([rep, count]) => {
            console.log(`    - ${rep}: ${count}`);
        });
        console.log('');

        // Step 5: Add to House_Accounts table
        console.log('Step 5: Adding to House_Accounts table...');

        const token = await getCaspioAccessToken();
        const url = `${config.caspio.apiBaseUrl}/tables/${HOUSE_TABLE}/records`;
        const today2 = new Date().toISOString().split('T')[0];

        let added = 0;
        let errors = [];

        // Add in batches of 50
        const batchSize = 50;
        for (let i = 0; i < accountsToAdd.length; i += batchSize) {
            const batch = accountsToAdd.slice(i, i + batchSize);
            console.log(`  Processing batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(accountsToAdd.length / batchSize)}...`);

            for (const account of batch) {
                try {
                    await axios({
                        method: 'post',
                        url: url,
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json'
                        },
                        data: {
                            ID_Customer: account.ID_Customer,
                            CompanyName: account.CompanyName,
                            Assigned_To: account.Assigned_To,
                            Notes: account.Notes,
                            Date_Added: today2,
                            Reviewed: false
                        },
                        timeout: 10000
                    });
                    added++;
                } catch (e) {
                    errors.push({ ID_Customer: account.ID_Customer, error: e.message });
                }
            }
        }

        console.log(`\n=== COMPLETE ===`);
        console.log(`  Added: ${added}`);
        console.log(`  Errors: ${errors.length}`);

        if (errors.length > 0 && errors.length <= 10) {
            console.log('\nErrors:');
            errors.forEach(e => console.log(`  - ${e.ID_Customer}: ${e.error}`));
        }

    } catch (error) {
        console.error('\nFATAL ERROR:', error.message);
        process.exit(1);
    }
}

// Run it
populateHouseAccounts().then(() => {
    console.log('\nDone!');
    process.exit(0);
}).catch(err => {
    console.error('Script failed:', err);
    process.exit(1);
});
