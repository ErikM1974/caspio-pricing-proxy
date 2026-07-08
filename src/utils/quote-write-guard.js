/**
 * Quote write-boundary validation (pricing-app roadmap 1.5).
 *
 * POST/PUT /api/quote_sessions and /api/quote_items used to spread raw
 * client bodies straight into Caspio. This guard enforces, BEFORE Caspio:
 *   - body is a plain JSON object (no arrays/scalars)
 *   - every field is a REAL writable column (whitelists below were pulled
 *     from the live tables 2026-07-08; PK_ID is Caspio-managed → rejected)
 *   - string length caps (64KB JSON/notes columns, 2KB everything else —
 *     a 1MB notes payload is rejected, not persisted)
 *   - money/qty fields must be numeric (or null/'' which Caspio accepts) —
 *     "12.5abc" in TotalAmount fails here, not as silent NaN math later
 *
 * validateQuoteWrite(kind) is pure and jest-locked
 * (tests/jest/quote-write-guard.test.js); quoteWriteGuard(kind) is the
 * express middleware wrapper.
 *
 * When Erik adds a column in Caspio: add it here too (a saved quote will
 * 400 with the exact field name until then — loud, not silent).
 */

const QUOTE_SESSION_FIELDS = new Set([
    'ALCapDesc', 'ALCapQty', 'ALCapUnitPrice', 'ALChargeCap', 'ALChargeGarment', 'ALGarmentDesc',
    'ALGarmentQty', 'ALGarmentUnitPrice', 'AdditionalLogoLocation', 'AdditionalStitchCharge',
    'AdditionalStitchCount', 'AdditionalStitchUnitPrice', 'ArtCharge', 'BalanceAmount',
    'CapDesignNumber', 'CapDigitizing', 'CapDigitizingFee', 'CapEmbellishmentType', 'CapPrintLocation',
    'CapStitchCharge', 'CapStitchCount', 'Carrier', 'ColorConfigsJSON', 'CompanyName', 'CreatedAt',
    'CreatedAt_Quote', 'CustomerDataJSON', 'CustomerEmail', 'CustomerName', 'CustomerNumber',
    'DateOrderPlaced', 'DeliveryMethod', 'DesignNumbers', 'DigitizingCodes', 'DigitizingFee',
    'Discount', 'DiscountPercent', 'DiscountReason', 'DropDeadDate', 'ExpiresAt',
    'GarmentDesignNumber', 'GarmentDigitizing', 'GarmentStitchCharge', 'GraphicDesignCharge',
    'GraphicDesignHours', 'ImportNotes', 'IsWholesale', 'LTMFeeTotal', 'LTM_Cap', 'LTM_Display_Mode',
    'LTM_Garment', 'LTM_Waived', 'LabelCost', 'Notes', 'OrderNotes', 'OrderNumber',
    'OrderSettingsJSON', 'OrderTotalsJSON', 'PaidToDate', 'PaymentTerms', 'Phone', 'PriceAuditJSON',
    'PrintLocation', 'ProjectName', 'PurchaseOrderNumber', 'PushedToShopWorks', 'QuoteID',
    'ReqShipDate', 'RevisedAt', 'RevisedBy', 'RevisionNotes', 'RevisionNumber', 'RushFee',
    'SWSubtotal', 'SWTotal', 'SalesRepEmail', 'SalesRepName', 'SampleFee', 'SampleQty', 'SessionID',
    'ShipMethod', 'ShipStation_Last_Synced', 'ShipStation_Order_ID', 'ShipStation_Status',
    'ShipToAddress', 'ShipToCity', 'ShipToState', 'ShipToZip', 'ShippedAt', 'ShippingAddress',
    'ShippingCity', 'ShippingFee', 'ShippingState', 'ShippingZip', 'ShopWorks_Last_Synced',
    'ShopWorks_Order_Number', 'ShopWorks_Snapshot', 'ShopWorks_Status', 'Status', 'StitchCount',
    'SubtotalAmount', 'TaxAmount', 'TaxRate', 'TotalAmount', 'TotalQuantity', 'TrackingCarrier',
    'TrackingNumber', 'TrackingURL', 'UpdatedAt',
]);

const QUOTE_ITEM_FIELDS = new Set([
    'AddedAt', 'Address', 'BaseUnitPrice', 'BundleConfiguration', 'City', 'Color', 'ColorCode',
    'Company', 'DeliveryDate', 'DeliveryMethod', 'DesignChoice', 'DesignImageURL', 'Email',
    'EmbellishmentType', 'EmbroideryLocation', 'EmployeeNames', 'FinalUnitPrice', 'First',
    'GiftMessage', 'HasLTM', 'ImageURL', 'Image_Upload', 'LTMPerUnit', 'Last', 'LineNumber',
    'LineTotal', 'LogoSpecs', 'Notes', 'Phone', 'PricingTier', 'PrintLocation', 'PrintLocationName',
    'ProductName', 'Quantity', 'QuoteID', 'RushOrder', 'SalesRep', 'Shipping_Address',
    'Shipping_City', 'Shipping_State', 'Shipping_Zip', 'SizeBreakdown', 'StyleNumber',
    'Thread_Colors', 'TimerData_', 'State', 'Zip',
]);

// Columns holding JSON blobs / long notes — Caspio Text(64000).
const LONG_FIELDS = new Set([
    'Notes', 'OrderNotes', 'ImportNotes', 'RevisionNotes', 'ShopWorks_Snapshot',
    'ColorConfigsJSON', 'CustomerDataJSON', 'OrderSettingsJSON', 'OrderTotalsJSON',
    'PriceAuditJSON', 'SizeBreakdown', 'LogoSpecs', 'BundleConfiguration', 'Thread_Colors',
    'TimerData_', 'EmployeeNames', 'GiftMessage', 'DesignImageURL', 'ImageURL', 'Image_Upload',
]);
const LONG_MAX = 60000;
const DEFAULT_MAX = 2000;

// Money/quantity columns that must parse as numbers when present.
// (Deliberately NOT a suffix heuristic: OrderNumber/TrackingNumber etc. are strings.)
const NUMERIC_FIELDS = new Set([
    'SubtotalAmount', 'TotalAmount', 'TaxAmount', 'TaxRate', 'LTMFeeTotal', 'BalanceAmount',
    'PaidToDate', 'TotalQuantity', 'Quantity', 'FinalUnitPrice', 'BaseUnitPrice', 'LineTotal',
    'LTMPerUnit', 'LineNumber', 'RevisionNumber', 'ShippingFee', 'RushFee', 'SampleFee', 'SampleQty',
]);

const TABLES = {
    quote_sessions: QUOTE_SESSION_FIELDS,
    quote_items: QUOTE_ITEM_FIELDS,
};

/**
 * Pure validation. @param {'quote_sessions'|'quote_items'} kind
 * @returns {{ok: true}|{ok: false, status: number, error: string}}
 */
function validateQuoteWrite(kind, body) {
    const allowed = TABLES[kind];
    if (!allowed) return { ok: false, status: 500, error: `quote-write-guard: unknown kind ${kind}` };
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { ok: false, status: 400, error: 'Body must be a JSON object' };
    }

    const unknown = Object.keys(body).filter((k) => !allowed.has(k));
    if (unknown.length) {
        return {
            ok: false, status: 400,
            error: `Unknown field(s) for ${kind}: ${unknown.join(', ')}. If a new Caspio column was added, whitelist it in src/utils/quote-write-guard.js.`,
        };
    }

    for (const [k, v] of Object.entries(body)) {
        if (typeof v === 'string') {
            const max = LONG_FIELDS.has(k) ? LONG_MAX : DEFAULT_MAX;
            if (v.length > max) {
                return { ok: false, status: 400, error: `${k} exceeds ${max} characters (${v.length})` };
            }
        }
        if (NUMERIC_FIELDS.has(k) && v !== null && v !== '' && v !== undefined) {
            if (!Number.isFinite(Number(v))) {
                return { ok: false, status: 400, error: `${k} must be numeric (got ${JSON.stringify(v)})` };
            }
        }
    }
    return { ok: true };
}

/** Express middleware wrapper. */
function quoteWriteGuard(kind) {
    return (req, res, next) => {
        const verdict = validateQuoteWrite(kind, req.body);
        if (!verdict.ok) {
            console.warn(`[quote-write-guard] REJECTED ${req.method} ${req.originalUrl}: ${verdict.error}`);
            return res.status(verdict.status).json({ error: verdict.error });
        }
        next();
    };
}

module.exports = { validateQuoteWrite, quoteWriteGuard, QUOTE_SESSION_FIELDS, QUOTE_ITEM_FIELDS };
