/**
 * Update Embroidery_Costs Table for 2026 Pricing Restructure
 *
 * This script:
 * 1. Updates existing "1-23" tier rows to "1-7"
 * 2. Inserts new "8-23" tier rows
 * 3. Updates EmbroideryCost values for Shirt and Cap tiers
 *
 * Run with: node scripts/update-embroidery-costs-2026.js
 *
 * DRY RUN (preview only): node scripts/update-embroidery-costs-2026.js --dry-run
 */

require('dotenv').config();
const axios = require('axios');

// Configuration
const config = {
    domain: process.env.CASPIO_ACCOUNT_DOMAIN,
    clientId: process.env.CASPIO_CLIENT_ID,
    clientSecret: process.env.CASPIO_CLIENT_SECRET,
    tokenUrl: `https://${process.env.CASPIO_ACCOUNT_DOMAIN}/oauth/token`,
    apiBaseUrl: `https://${process.env.CASPIO_ACCOUNT_DOMAIN}/rest/v2`
};

const DRY_RUN = process.argv.includes('--dry-run');

// Token cache
let accessToken = null;

/**
 * Get Caspio access token
 */
async function getAccessToken() {
    if (accessToken) return accessToken;

    console.log('Getting Caspio access token...');
    const response = await axios.post(config.tokenUrl, new URLSearchParams({
        'grant_type': 'client_credentials',
        'client_id': config.clientId,
        'client_secret': config.clientSecret
    }), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    accessToken = response.data.access_token;
    console.log('Token obtained successfully');
    return accessToken;
}

/**
 * Make authenticated request to Caspio
 */
async function caspioRequest(method, path, data = null) {
    const token = await getAccessToken();
    const url = `${config.apiBaseUrl}${path}`;

    console.log(`${method.toUpperCase()} ${url}`);
    if (data) console.log('Data:', JSON.stringify(data, null, 2));

    if (DRY_RUN && method !== 'get') {
        console.log('[DRY RUN] Would execute this request');
        return { dryRun: true };
    }

    const response = await axios({
        method,
        url,
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        data
    });

    return response.data;
}

/**
 * Get all Embroidery_Costs records
 */
async function getEmbroideryCosts() {
    const result = await caspioRequest('get', '/tables/Embroidery_Costs/records');
    return result.Result || [];
}

/**
 * Update a record by ID
 */
async function updateRecord(id, data) {
    return caspioRequest('put', `/tables/Embroidery_Costs/records?q.where=EmbroideryCostID=${id}`, data);
}

/**
 * Insert a new record
 */
async function insertRecord(data) {
    return caspioRequest('post', '/tables/Embroidery_Costs/records', data);
}

/**
 * Main update logic
 */
async function updateEmbroideryCosts() {
    console.log('\n========================================');
    console.log('EMBROIDERY COSTS 2026 UPDATE SCRIPT');
    console.log('========================================');
    if (DRY_RUN) {
        console.log('>>> DRY RUN MODE - No changes will be made <<<\n');
    }

    // Step 1: Fetch all current records
    console.log('\n--- Step 1: Fetching current Embroidery_Costs records ---');
    const records = await getEmbroideryCosts();
    console.log(`Found ${records.length} records`);

    // Find records that need updating (1-23 tier)
    const recordsToUpdate = records.filter(r => r.TierLabel === '1-23');
    console.log(`Found ${recordsToUpdate.length} records with TierLabel "1-23" to update`);

    // Group by ItemType for reporting
    const byItemType = {};
    recordsToUpdate.forEach(r => {
        byItemType[r.ItemType] = r;
    });
    console.log('Item types to update:', Object.keys(byItemType).join(', '));

    // Step 2: Define the changes
    console.log('\n--- Step 2: Defining changes ---');

    const changes = {
        // Updates to existing 1-23 rows (change to 1-7)
        updates: [
            {
                itemType: 'Shirt',
                oldTier: '1-23',
                newTier: '1-7',
                newEmbroideryCost: 18.00  // Was $16, now $18 ($14 base + $4 surcharge)
            },
            {
                itemType: 'Cap',
                oldTier: '1-23',
                newTier: '1-7',
                newEmbroideryCost: 17.00  // Was $13, now $17 ($13 base + $4 surcharge)
            },
            {
                itemType: 'AL',
                oldTier: '1-23',
                newTier: '1-7',
                newEmbroideryCost: 13.50  // No change
            },
            {
                itemType: 'AL-CAP',
                oldTier: '1-23',
                newTier: '1-7',
                newEmbroideryCost: 6.75   // No change
            }
        ],
        // New 8-23 tier rows to insert
        inserts: [
            {
                ItemType: 'Shirt',
                StitchCount: 8000,
                TierLabel: '8-23',
                EmbroideryCost: 18.00,
                DigitizingFee: 100,
                AdditionalStitchRate: 1.25,
                BaseStitchCount: 8000,
                StitchIncrement: 1000,
                LogoPositions: 'Left Chest,Right Chest,Full Front,Full Back,Left Sleeve,Right Sleeve',
                LTM: 0
            },
            {
                ItemType: 'Cap',
                StitchCount: 8000,
                TierLabel: '8-23',
                EmbroideryCost: 17.00,
                DigitizingFee: 100,
                AdditionalStitchRate: 1,
                BaseStitchCount: 8000,
                StitchIncrement: 1000,
                LogoPositions: 'Cap Front,Cap Back,Cap Side',
                LTM: 0
            },
            {
                ItemType: 'AL',
                StitchCount: 8000,
                TierLabel: '8-23',
                EmbroideryCost: 13.50,
                DigitizingFee: 100,
                AdditionalStitchRate: 1.25,
                BaseStitchCount: 8000,
                StitchIncrement: 1000,
                LogoPositions: 'Left Chest,Right Chest,Full Front,Full Back,Left Sleeve,Right Sleeve',
                LTM: 0
            },
            {
                ItemType: 'AL-CAP',
                StitchCount: 5000,
                TierLabel: '8-23',
                EmbroideryCost: 6.75,
                DigitizingFee: 100,
                AdditionalStitchRate: 1,
                BaseStitchCount: 5000,
                StitchIncrement: 1000,
                LogoPositions: 'Cap Front,Cap Back,Cap Side',
                LTM: 0
            }
        ]
    };

    // Step 3: Execute updates
    console.log('\n--- Step 3: Updating existing 1-23 rows to 1-7 ---');
    for (const change of changes.updates) {
        const record = recordsToUpdate.find(r => r.ItemType === change.itemType);
        if (record) {
            console.log(`\nUpdating ${change.itemType} (ID: ${record.EmbroideryCostID}):`);
            console.log(`  TierLabel: "${change.oldTier}" → "${change.newTier}"`);
            console.log(`  EmbroideryCost: $${record.EmbroideryCost} → $${change.newEmbroideryCost}`);

            await updateRecord(record.EmbroideryCostID, {
                TierLabel: change.newTier,
                EmbroideryCost: change.newEmbroideryCost
            });
            console.log(`  ✅ Updated`);
        } else {
            console.log(`  ⚠️ No record found for ItemType: ${change.itemType}`);
        }
    }

    // Step 4: Insert new 8-23 rows
    console.log('\n--- Step 4: Inserting new 8-23 tier rows ---');
    for (const newRecord of changes.inserts) {
        console.log(`\nInserting ${newRecord.ItemType} 8-23 tier:`);
        console.log(`  EmbroideryCost: $${newRecord.EmbroideryCost}`);
        console.log(`  LTM: $${newRecord.LTM}`);

        await insertRecord(newRecord);
        console.log(`  ✅ Inserted`);
    }

    // Step 5: Summary
    console.log('\n========================================');
    console.log('SUMMARY');
    console.log('========================================');
    console.log(`Updates: ${changes.updates.length} rows (1-23 → 1-7)`);
    console.log(`Inserts: ${changes.inserts.length} rows (new 8-23 tier)`);
    console.log(`Total changes: ${changes.updates.length + changes.inserts.length}`);

    if (DRY_RUN) {
        console.log('\n>>> DRY RUN COMPLETE - No actual changes were made <<<');
        console.log('Run without --dry-run to apply changes');
    } else {
        console.log('\n✅ ALL CHANGES APPLIED SUCCESSFULLY');
    }
}

// Run the script
updateEmbroideryCosts()
    .then(() => {
        console.log('\nScript completed.');
        process.exit(0);
    })
    .catch(err => {
        console.error('\n❌ ERROR:', err.message);
        if (err.response) {
            console.error('Response:', err.response.data);
        }
        process.exit(1);
    });
