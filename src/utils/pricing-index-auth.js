'use strict';

// Scheduled jobs and tracking callbacks authenticate to the Pricing Index app.
// Resolve at request time so startup/import never captures an empty credential.
function pricingIndexHeaders(headers = {}) {
    const secret = process.env.CRM_API_SECRET;
    if (!secret) throw new Error('CRM_API_SECRET is required for Pricing Index sync');
    return { ...headers, 'X-CRM-API-Secret': secret };
}

module.exports = { pricingIndexHeaders };
