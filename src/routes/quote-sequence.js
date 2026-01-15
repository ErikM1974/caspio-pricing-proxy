const express = require('express');
const router = express.Router();
const { makeCaspioRequest, fetchAllCaspioPages } = require('../utils/caspio');

// GET /api/quote-sequence/:prefix
// Atomic get-and-increment for quote sequence numbers
// Supports prefixes like EMB, DTG, DTF, SPC for quote IDs (e.g., EMB-2026-001)
router.get('/quote-sequence/:prefix', async (req, res) => {
    const { prefix } = req.params;
    const currentYear = new Date().getFullYear();

    console.log(`GET /api/quote-sequence/${prefix} requested (year: ${currentYear})`);

    // Validate prefix (alphanumeric, max 10 chars)
    if (!prefix || !/^[A-Za-z0-9]{1,10}$/.test(prefix)) {
        return res.status(400).json({
            error: 'Invalid prefix. Must be 1-10 alphanumeric characters.'
        });
    }

    const normalizedPrefix = prefix.toUpperCase();

    try {
        // Query for existing record with this prefix and year
        const params = {
            'q.where': `Prefix='${normalizedPrefix}' AND Year=${currentYear}`,
            'q.select': 'PK_ID_Quote,Prefix,Year,NextSequence'
        };

        const records = await fetchAllCaspioPages('/tables/quote_counters/records', params);
        console.log(`Found ${records.length} record(s) for ${normalizedPrefix}/${currentYear}`);

        let sequenceToReturn;

        if (records.length > 0) {
            // Record exists - get current sequence and increment
            const record = records[0];
            sequenceToReturn = record.NextSequence;
            const newSequence = sequenceToReturn + 1;

            // Update the record with incremented sequence
            console.log(`Updating PK_ID_Quote=${record.PK_ID_Quote}: NextSequence ${sequenceToReturn} -> ${newSequence}`);
            await makeCaspioRequest(
                'put',
                `/tables/quote_counters/records?q.where=PK_ID_Quote=${record.PK_ID_Quote}`,
                {},
                { NextSequence: newSequence }
            );

        } else {
            // No record exists - create new one with NextSequence = 2, return 1
            sequenceToReturn = 1;
            console.log(`Creating new record: ${normalizedPrefix}/${currentYear} with NextSequence=2`);

            await makeCaspioRequest(
                'post',
                '/tables/quote_counters/records',
                {},
                {
                    Prefix: normalizedPrefix,
                    Year: currentYear,
                    NextSequence: 2
                }
            );
        }

        console.log(`Returning sequence ${sequenceToReturn} for ${normalizedPrefix}/${currentYear}`);
        res.json({
            prefix: normalizedPrefix,
            year: currentYear,
            sequence: sequenceToReturn
        });

    } catch (error) {
        console.error('Error in quote-sequence:', error.message);
        res.status(500).json({
            error: 'Failed to get quote sequence',
            details: error.message
        });
    }
});

module.exports = router;
