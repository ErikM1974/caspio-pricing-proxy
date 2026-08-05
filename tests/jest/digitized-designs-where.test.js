/**
 * Locks buildSearchWhere — the search-all WHERE builder — and the gate
 * boundary on the digitized-designs routes.
 *
 * Default mode must stay byte-for-byte compatible with the pre-extraction
 * inline logic (behavior-preserving refactor); `deep` mode adds the four
 * server-only columns the Design Vault index deliberately excludes.
 */

const fs = require('fs');
const path = require('path');
const { buildSearchWhere } = require('../../src/routes/digitized-designs');

describe('buildSearchWhere — default mode (behavior parity)', () => {
    test('numeric term: exact + prefix on Design_Number only', () => {
        const { whereClause, isNumeric } = buildSearchWhere('31442', {});
        expect(isNumeric).toBe(true);
        expect(whereClause).toBe("((Design_Number='31442' OR Design_Number LIKE '31442%')) AND Is_Active='true'");
    });

    test('short text term: plain substring on Company/Design_Name', () => {
        const { whereClause, useFuzzy } = buildSearchWhere('acme', {});
        expect(useFuzzy).toBe(false);
        expect(whereClause).toBe("(Company LIKE '%acme%' OR Design_Name LIKE '%acme%') AND Is_Active='true'");
    });

    test('fuzzy multi-word: AND of words plus 4-char-prefix broadening', () => {
        const { whereClause, useFuzzy } = buildSearchWhere('eagle logo', {});
        expect(useFuzzy).toBe(true);
        expect(whereClause).toContain("Company LIKE '%eagle%' AND Company LIKE '%logo%'");
        expect(whereClause).toContain("Company LIKE '%eagl%' AND Company LIKE '%logo%'");
        expect(whereClause).toContain("Design_Name LIKE '%eagle%'");
        expect(whereClause).toMatch(/AND Is_Active='true'$/);
    });

    test('quotes are doubled for Caspio, never passed raw', () => {
        const { whereClause } = buildSearchWhere("o'brien", {});
        expect(whereClause).toContain("o''brien");
        expect(whereClause).not.toContain("o'brien%' OR"); // no un-doubled survivor
    });

    test('customerId broadens text searches only', () => {
        const text = buildSearchWhere('acme', { customerId: '12025' });
        expect(text.whereClause).toContain("OR (Customer_ID='12025')");
        const numeric = buildSearchWhere('31442', { customerId: '12025' });
        expect(numeric.whereClause).not.toContain('Customer_ID');
    });

    test('default mode NEVER touches the deep columns', () => {
        for (const q of ['31442', 'acme', 'eagle logo scenic']) {
            const { whereClause } = buildSearchWhere(q, { customerId: '5' });
            expect(whereClause).not.toMatch(/DST_Filename|Thread_Colors|Art_Notes|Placement/);
        }
    });

    test('unsanitizable numeric returns null whereClause (route 400s)', () => {
        const longRun = '1'.repeat(11); // > 10 digits fails sanitizeDesignNumber
        expect(buildSearchWhere(longRun, {}).whereClause).toBeNull();
    });
});

describe('buildSearchWhere — deep mode', () => {
    test('text query adds all four deep columns', () => {
        const { whereClause } = buildSearchWhere('metallic gold', { deep: true });
        expect(whereClause).toContain("DST_Filename LIKE '%metallic gold%'");
        expect(whereClause).toContain("Thread_Colors LIKE '%metallic gold%'");
        expect(whereClause).toContain("Art_Notes LIKE '%metallic gold%'");
        expect(whereClause).toContain("Placement LIKE '%metallic gold%'");
        expect(whereClause).toMatch(/AND Is_Active='true'$/);
    });

    test('numeric query adds DST_Filename (filenames embed design numbers)', () => {
        const { whereClause } = buildSearchWhere('31442', { deep: true });
        expect(whereClause).toContain("DST_Filename LIKE '%31442%'");
        expect(whereClause).not.toMatch(/Thread_Colors|Art_Notes|Placement/);
    });

    test('deep + customerId compose (customer wrap is outermost before active)', () => {
        const { whereClause } = buildSearchWhere('gold', { deep: true, customerId: '7' });
        expect(whereClause).toContain("Thread_Colors LIKE '%gold%'");
        expect(whereClause).toContain("OR (Customer_ID='7')");
    });

    test('deep escaping covers the deep columns too', () => {
        const { whereClause } = buildSearchWhere("d'or", { deep: true });
        expect(whereClause).toContain("Thread_Colors LIKE '%d''or%'");
    });
});

describe('route gate boundary (source lock)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/routes/digitized-designs.js'), 'utf8');

    test.each(['search-all', 'by-customer', 'fallback'])('%s carries requireCrmSecretOrBrowserOrigin', (route) => {
        const re = new RegExp(`router\\.get\\('/digitized-designs/${route}',\\s*requireCrmSecretOrBrowserOrigin,`);
        expect(src).toMatch(re);
    });

    test('lookup stays OPEN — it backs the public /design/:n share page', () => {
        expect(src).toMatch(/router\.get\('\/digitized-designs\/lookup',\s*async/);
    });
});
