/**
 * Update Embroidery_Costs Table - February 2026
 *
 * This script:
 * 1. Updates AL (Additional Logo) pricing to new tier rates
 * 2. Inserts CTR-Garmt records (Contract Garment labor-only pricing)
 * 3. Inserts CTR-Cap records (Contract Cap labor-only pricing)
 * 4. Inserts CTR-FB records (Contract Full Back per-1K rate)
 *
 * Run with: node scripts/update-embroidery-feb-2026.js
 *
 * DRY RUN (preview only): node scripts/update-embroidery-feb-2026.js --dry-run
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

// Counters for summary
let updateCount = 0;
let insertCount = 0;

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
    const result = await caspioRequest('put', `/tables/Embroidery_Costs/records?q.where=EmbroideryCostID=${id}`, data);
    updateCount++;
    return result;
}

/**
 * Insert a new record
 */
async function insertRecord(data) {
    const result = await caspioRequest('post', '/tables/Embroidery_Costs/records', data);
    insertCount++;
    return result;
}

// ============================================
// PRICING DATA
// ============================================

// AL Updates (by Caspio record ID)
const AL_UPDATES = [
    // AL (Garment) - 8K base
    { id: 17, tier: '1-7',   newCost: 10.00, itemType: 'AL' },
    { id: 35, tier: '8-23',  newCost: 9.00,  itemType: 'AL' },
    { id: 18, tier: '24-47', newCost: 8.00,  itemType: 'AL' },
    { id: 19, tier: '48-71', newCost: 7.50,  itemType: 'AL' },
    { id: 20, tier: '72+',   newCost: 7.00,  itemType: 'AL' },
    // AL-CAP - 5K base
    { id: 21, tier: '1-7',   newCost: 6.50,  itemType: 'AL-CAP' },
    { id: 36, tier: '8-23',  newCost: 6.00,  itemType: 'AL-CAP' }
];

// Contract Garment pricing - 9 stitch counts × 5 tiers = 45 records
const CTR_GARMENT_PRICING = {
    5000:  { '1-7': 13.00, '8-23': 8.00,  '24-47': 6.25,  '48-71': 5.50,  '72+': 5.25 },
    6000:  { '1-7': 14.00, '8-23': 9.00,  '24-47': 6.75,  '48-71': 6.00,  '72+': 5.75 },
    7000:  { '1-7': 14.50, '8-23': 9.50,  '24-47': 7.25,  '48-71': 6.50,  '72+': 6.00 },
    8000:  { '1-7': 15.00, '8-23': 10.00, '24-47': 7.75,  '48-71': 6.75,  '72+': 6.50 },
    9000:  { '1-7': 16.00, '8-23': 10.50, '24-47': 8.00,  '48-71': 7.25,  '72+': 7.00 },
    10000: { '1-7': 17.00, '8-23': 11.00, '24-47': 8.50,  '48-71': 7.50,  '72+': 7.25 },
    11000: { '1-7': 17.50, '8-23': 12.00, '24-47': 9.00,  '48-71': 8.00,  '72+': 7.75 },
    12000: { '1-7': 18.00, '8-23': 14.00, '24-47': 9.50,  '48-71': 8.50,  '72+': 8.00 },
    15000: { '1-7': 22.00, '8-23': 15.00, '24-47': 10.75, '48-71': 10.00, '72+': 9.50 }
};

// Contract Cap pricing - 9 stitch counts × 5 tiers = 45 records
const CTR_CAP_PRICING = {
    5000:  { '1-7': 7.00,  '8-23': 5.50, '24-47': 4.75, '48-71': 4.25, '72+': 4.00 },
    6000:  { '1-7': 7.50,  '8-23': 5.75, '24-47': 5.00, '48-71': 4.50, '72+': 4.25 },
    7000:  { '1-7': 8.00,  '8-23': 6.00, '24-47': 5.50, '48-71': 4.75, '72+': 4.50 },
    8000:  { '1-7': 8.50,  '8-23': 6.25, '24-47': 6.00, '48-71': 5.00, '72+': 4.75 },
    9000:  { '1-7': 9.00,  '8-23': 6.50, '24-47': 6.25, '48-71': 5.25, '72+': 5.00 },
    10000: { '1-7': 9.50,  '8-23': 7.00, '24-47': 6.50, '48-71': 5.50, '72+': 5.25 },
    11000: { '1-7': 10.00, '8-23': 7.25, '24-47': 6.75, '48-71': 5.75, '72+': 5.50 },
    12000: { '1-7': 10.50, '8-23': 7.50, '24-47': 7.00, '48-71': 6.00, '72+': 5.75 },
    15000: { '1-7': 12.00, '8-23': 8.50, '24-47': 7.75, '48-71': 7.00, '72+': 6.75 }
};

// Contract Full Back pricing - rate per 1K stitches × 5 tiers = 5 records
const CTR_FB_PRICING = {
    '1-7':   1.20,
    '8-23':  1.00,
    '24-47': 0.90,
    '48-71': 0.85,
    '72+':   0.80
};

const TIERS = ['1-7', '8-23', '24-47', '48-71', '72+'];
const STITCH_COUNTS = [5000, 6000, 7000, 8000, 9000, 10000, 11000, 12000, 15000];

/**
 * Generate CTR-Garmt record
 */
function makeCtrGarmentRecord(stitchCount, tierLabel, price) {
    return {
        ItemType: 'CTR-Garmt',
        StitchCount: stitchCount,
        TierLabel: tierLabel,
        EmbroideryCost: price,
        DigitizingFee: 100,
        AdditionalStitchRate: 1.25,
        BaseStitchCount: stitchCount,
        StitchIncrement: 1000,
        LogoPositions: 'Left Chest,Right Chest,Full Front,Full Back,Left Sleeve,Right Sleeve',
        LTM: tierLabel === '1-7' ? 50 : 0
    };
}

/**
 * Generate CTR-Cap record
 */
function makeCtrCapRecord(stitchCount, tierLabel, price) {
    return {
        ItemType: 'CTR-Cap',
        StitchCount: stitchCount,
        TierLabel: tierLabel,
        EmbroideryCost: price,
        DigitizingFee: 100,
        AdditionalStitchRate: 1.00,
        BaseStitchCount: stitchCount,
        StitchIncrement: 1000,
        LogoPositions: 'Cap Front,Cap Back,Cap Side',
        LTM: tierLabel === '1-7' ? 50 : 0
    };
}

/**
 * Generate CTR-FB record (Full Back - per 1K rate)
 */
function makeCtrFbRecord(tierLabel, ratePerThousand) {
    return {
        ItemType: 'CTR-FB',
        StitchCount: 25000, // Minimum stitch count for full back
        TierLabel: tierLabel,
        EmbroideryCost: ratePerThousand, // This is the per-1K rate
        DigitizingFee: 100,
        AdditionalStitchRate: ratePerThousand, // Same as base rate for FB
        BaseStitchCount: 25000,
        StitchIncrement: 1000,
        LogoPositions: 'Full Back',
        LTM: tierLabel === '1-7' ? 50 : 0
    };
}

/**
 * Main update logic
 */
async function updateEmbroideryCosts() {
    console.log('\n========================================');
    console.log('EMBROIDERY COSTS FEB 2026 UPDATE SCRIPT');
    console.log('========================================');
    if (DRY_RUN) {
        console.log('>>> DRY RUN MODE - No changes will be made <<<\n');
    }

    // Step 1: Fetch all current records to verify IDs
    console.log('\n--- Step 1: Fetching current Embroidery_Costs records ---');
    const records = await getEmbroideryCosts();
    console.log(`Found ${records.length} records in table`);

    // Check for existing CTR records
    const existingCtr = records.filter(r => r.ItemType && r.ItemType.startsWith('CTR-'));
    if (existingCtr.length > 0) {
        console.log(`\n⚠️  WARNING: Found ${existingCtr.length} existing CTR- records!`);
        console.log('   ItemTypes:', [...new Set(existingCtr.map(r => r.ItemType))].join(', '));
        console.log('   This script may create duplicates. Review before proceeding.\n');
    }

    // Step 2: Update AL records
    console.log('\n--- Step 2: Updating AL records (7 updates) ---');
    for (const update of AL_UPDATES) {
        const record = records.find(r => r.EmbroideryCostID === update.id);
        if (record) {
            console.log(`\nUpdating ${update.itemType} tier ${update.tier} (ID: ${update.id}):`);
            console.log(`  Current: $${record.EmbroideryCost} → New: $${update.newCost}`);
            await updateRecord(update.id, { EmbroideryCost: update.newCost });
            console.log(`  ✅ Updated`);
        } else {
            console.log(`\n⚠️  Record ID ${update.id} not found for ${update.itemType} ${update.tier}`);
        }
    }

    // Step 3: Insert CTR-Garmt records
    console.log('\n--- Step 3: Inserting CTR-Garmt records (45 inserts) ---');
    for (const stitchCount of STITCH_COUNTS) {
        for (const tier of TIERS) {
            const price = CTR_GARMENT_PRICING[stitchCount][tier];
            const record = makeCtrGarmentRecord(stitchCount, tier, price);
            console.log(`\nInserting CTR-Garmt ${stitchCount}st ${tier}: $${price}`);
            await insertRecord(record);
            console.log(`  ✅ Inserted`);
        }
    }

    // Step 4: Insert CTR-Cap records
    console.log('\n--- Step 4: Inserting CTR-Cap records (45 inserts) ---');
    for (const stitchCount of STITCH_COUNTS) {
        for (const tier of TIERS) {
            const price = CTR_CAP_PRICING[stitchCount][tier];
            const record = makeCtrCapRecord(stitchCount, tier, price);
            console.log(`\nInserting CTR-Cap ${stitchCount}st ${tier}: $${price}`);
            await insertRecord(record);
            console.log(`  ✅ Inserted`);
        }
    }

    // Step 5: Insert CTR-FB records
    console.log('\n--- Step 5: Inserting CTR-FB records (5 inserts) ---');
    for (const tier of TIERS) {
        const rate = CTR_FB_PRICING[tier];
        const record = makeCtrFbRecord(tier, rate);
        console.log(`\nInserting CTR-FB ${tier}: $${rate}/1K`);
        await insertRecord(record);
        console.log(`  ✅ Inserted`);
    }

    // Step 6: Summary
    console.log('\n========================================');
    console.log('SUMMARY');
    console.log('========================================');
    console.log(`AL Updates:     ${AL_UPDATES.length} records`);
    console.log(`CTR-Garmt:      ${STITCH_COUNTS.length * TIERS.length} records`);
    console.log(`CTR-Cap:        ${STITCH_COUNTS.length * TIERS.length} records`);
    console.log(`CTR-FB:         ${TIERS.length} records`);
    console.log(`---`);
    console.log(`Total Updates:  ${updateCount}`);
    console.log(`Total Inserts:  ${insertCount}`);
    console.log(`Total Changes:  ${updateCount + insertCount}`);

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
