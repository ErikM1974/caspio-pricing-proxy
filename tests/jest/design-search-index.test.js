/**
 * Locks the Design Vault index contracts:
 *   - positional row shape (THE client contract — reordering breaks every client)
 *   - source-bit values and union semantics
 *   - image priority chain
 *   - decimal design numbers group under the integer parent, never a second card
 *   - unified-table fields always beat live-overlay fills
 *   - unnumbered rows are excluded (and counted), not given synthetic cards
 *   - dup clusters: exact-normalized company+name only, near-misses stay apart
 *   - completeness gate: a short base stream refuses to replace a good index
 */

jest.mock('../../src/utils/caspio', () => ({ fetchAllCaspioPages: jest.fn() }));

const { fetchAllCaspioPages } = require('../../src/utils/caspio');
const idx = require('../../src/utils/design-search-index');

afterEach(() => {
    idx._resetForTests();
    fetchAllCaspioPages.mockReset();
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('canonicalKey', () => {
    test('decimal variants floor to the integer parent', () => {
        expect(idx.canonicalKey('35439.03')).toBe(35439);
        expect(idx.canonicalKey(35439.03)).toBe(35439);
        expect(idx.canonicalKey('40023.01')).toBe(40023);
    });
    test('plain numbers pass through', () => {
        expect(idx.canonicalKey('31442')).toBe(31442);
        expect(idx.canonicalKey(31442)).toBe(31442);
    });
    test('unresolvable values are null', () => {
        expect(idx.canonicalKey('')).toBeNull();
        expect(idx.canonicalKey(null)).toBeNull();
        expect(idx.canonicalKey(undefined)).toBeNull();
        expect(idx.canonicalKey('N/A')).toBeNull();
        expect(idx.canonicalKey(0)).toBeNull();
        expect(idx.canonicalKey(-5)).toBeNull();
    });
});

describe('encodeImgRef', () => {
    test('Caspio file URLs compress to f:', () => {
        expect(idx.encodeImgRef('https://x.herokuapp.com/api/files/b91133c3-4413')).toBe('f:b91133c3-4413');
    });
    test('Box thumbnail URLs compress to b:', () => {
        expect(idx.encodeImgRef('https://x.herokuapp.com/api/box/thumbnail/400901982283')).toBe('b:400901982283');
    });
    test('other absolute URLs pass through as u:', () => {
        const url = 'https://northwestcustomapparel.box.com/shared/static/abc123.jpg';
        expect(idx.encodeImgRef(url)).toBe('u:' + url);
    });
    test('empty/short values (the length>10 guard) encode to empty', () => {
        expect(idx.encodeImgRef('')).toBe('');
        expect(idx.encodeImgRef(null)).toBe('');
        expect(idx.encodeImgRef('short.jpg')).toBe('');
    });
});

describe('pickImage priority chain', () => {
    const full = () => ({
        thumbnailUrl: 'https://p/api/box/thumbnail/111',
        ruthUrl: 'https://p/api/box/thumbnail/222',
        mockupUrl: 'https://p/api/box/thumbnail/333',
        artworkUrl: 'https://p/api/box/thumbnail/444',
        photoUrl: 'https://p/api/box/thumbnail/555',
        dstPreviewUrl: 'https://p/api/box/thumbnail/666'
    });
    test('production thumbnail first, DST render last', () => {
        const g = full();
        expect(idx.pickImage(g)).toBe('b:111');
        g.thumbnailUrl = '';
        expect(idx.pickImage(g)).toBe('b:222'); // Ruth beats Steve mockup
        g.ruthUrl = '';
        expect(idx.pickImage(g)).toBe('b:333');
        g.mockupUrl = '';
        expect(idx.pickImage(g)).toBe('b:444');
        g.artworkUrl = '';
        expect(idx.pickImage(g)).toBe('b:555'); // finished photo beats DST render
        g.photoUrl = '';
        expect(idx.pickImage(g)).toBe('b:666');
        g.dstPreviewUrl = '';
        expect(idx.pickImage(g)).toBe('');
    });
});

describe('toYYMM', () => {
    test('dates encode as YYMM', () => {
        expect(idx.toYYMM('2025-06-30T00:00:00')).toBe(2506);
        expect(idx.toYYMM('2016-01-05')).toBe(1601);
    });
    test('absent/invalid encode as 0', () => {
        expect(idx.toYYMM(null)).toBe(0);
        expect(idx.toYYMM('')).toBe(0);
        expect(idx.toYYMM('not a date')).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Folding + merging
// ---------------------------------------------------------------------------

describe('foldBaseRow', () => {
    test('rows sharing a design number merge into one group with max-stitch tier', () => {
        const groups = new Map();
        idx.foldBaseRow(groups, {
            Design_Number: '31442', Design_Name: 'Eagle', Company: 'Acme',
            Customer_ID: '12025', Stitch_Count: '5000', Stitch_Tier: 'Standard'
        });
        idx.foldBaseRow(groups, {
            Design_Number: '31442', Stitch_Count: '12000', Stitch_Tier: 'Large',
            Order_Count: '7', Last_Order_Date: '2025-05-01',
            Thumbnail_URL: 'https://p/api/box/thumbnail/999'
        });
        expect(groups.size).toBe(1);
        const g = groups.get(31442);
        expect(g.variantCount).toBe(2);
        expect(g.name).toBe('Eagle');
        expect(g.company).toBe('Acme');
        expect(g.customerId).toBe(12025);
        expect(g.maxStitch).toBe(12000);
        expect(g.tier).toBe('Large');
        expect(g.orderCount).toBe(7);
        expect(g.srcBits & idx.SRC.DIGITIZED).toBeTruthy();
        expect(g.srcBits & idx.SRC.SHOPWORKS).toBeTruthy();
        expect(g.srcBits & idx.SRC.THUMB).toBeTruthy();
    });

    test('unnumbered rows are rejected, not folded', () => {
        const groups = new Map();
        expect(idx.foldBaseRow(groups, { Design_Number: '', Design_Name: 'Orphan' })).toBe(false);
        expect(groups.size).toBe(0);
    });
});

describe('applyOverlayRow', () => {
    test('live rows fill gaps but never overwrite unified fields', () => {
        const groups = new Map();
        idx.foldBaseRow(groups, {
            Design_Number: '31442', Design_Name: 'Eagle', Company: 'Acme', Customer_ID: '12025'
        });
        idx.applyOverlayRow(groups, 'ruth', {
            Design_Number: '31442', Company_Name: 'ACME INCORPORATED (WRONG)',
            Id_Customer: '99999', Box_Mockup_1: 'https://p/api/box/thumbnail/777'
        });
        const g = groups.get(31442);
        expect(g.company).toBe('Acme');       // unified wins
        expect(g.customerId).toBe(12025);     // unified wins
        expect(g.ruthUrl).toContain('777');   // image candidate accepted
        expect(g.srcBits & idx.SRC.RUTH).toBeTruthy();
    });

    test('unseen design numbers create fresh groups (the freshness path)', () => {
        const groups = new Map();
        idx.applyOverlayRow(groups, 'designs2026', {
            ID_Design: 40100.02, DesignName: 'Brand New Logo', ID_Customer: 555
        });
        const g = groups.get(40100);
        expect(g).toBeDefined();
        expect(g.name).toBe('Brand New Logo');
        expect(g.customerId).toBe(555);
        expect(g.variantCount).toBe(1);
        expect(g.srcBits).toBe(idx.SRC.DESIGNS2026);
    });

    test('thumb overlay follows the ExternalKey ? Caspio-file : FileUrl rule', () => {
        const groups = new Map();
        idx.applyOverlayRow(groups, 'thumb', {
            Thumb_DesLocid_Design: '31442', ExternalKey: 'abc12345-key', FileUrl: 'https://ignored'
        });
        expect(groups.get(31442).thumbnailUrl).toBe('/api/files/abc12345-key');
        idx.applyOverlayRow(groups, 'thumb', {
            Thumb_DesLocid_Design: '31443', ExternalKey: '', FileUrl: 'https://p/api/box/thumbnail/321'
        });
        expect(groups.get(31443).thumbnailUrl).toBe('https://p/api/box/thumbnail/321');
    });

    test('art rows key by Design_Num_SW first, then ID_Design', () => {
        const groups = new Map();
        idx.applyOverlayRow(groups, 'art', { Design_Num_SW: '500', ID_Design: '900', CompanyName: 'A' });
        expect(groups.has(500)).toBe(true);
        idx.applyOverlayRow(groups, 'art', { Design_Num_SW: '', ID_Design: '901', CompanyName: 'B' });
        expect(groups.has(901)).toBe(true);
    });
});

describe('encodeRow — THE positional client contract', () => {
    test('exact position order and dict encoding', () => {
        const groups = new Map();
        idx.foldBaseRow(groups, {
            Design_Number: '31442', Design_Name: 'Eagle', Company: 'Acme',
            Customer_ID: '12025', Stitch_Count: '9000', Stitch_Tier: 'Mid',
            Sales_Rep: 'Taneisha', Customer_Type: 'Contract',
            Order_Count: '4', Last_Order_Date: '2025-06-30',
            Thumbnail_URL: 'https://p/api/box/thumbnail/42'
        });
        const dicts = { reps: idx.makeDict(), custTypes: idx.makeDict(), tiers: idx.makeDict() };
        const row = idx.encodeRow(groups.get(31442), dicts);
        expect(row).toEqual([
            31442,          // 0 dn
            'Eagle',        // 1 name
            'Acme',         // 2 company
            12025,          // 3 customerId
            1,              // 4 repIdx  (first non-empty rep → index 1)
            1,              // 5 custTypeIdx
            1,              // 6 tierIdx
            9000,           // 7 maxStitch
            1,              // 8 variantCount
            idx.SRC.DIGITIZED | idx.SRC.SHOPWORKS | idx.SRC.THUMB, // 9 srcBits
            'b:42',         // 10 imgRef
            4,              // 11 orderCount
            2506            // 12 lastOrderYYMM
        ]);
        expect(dicts.reps.values).toEqual(['', 'Taneisha']);
        expect(dicts.tiers.values).toEqual(['', 'Mid']);
    });

    test('empty fields cost index 0 / empty string', () => {
        const dicts = { reps: idx.makeDict(), custTypes: idx.makeDict(), tiers: idx.makeDict() };
        const row = idx.encodeRow(idx.newGroup(7), dicts);
        expect(row).toEqual([7, '', '', 0, 0, 0, 0, 0, 0, 0, '', 0, 0]);
    });
});

describe('findDupClusters', () => {
    function groupWith(dn, company, name) {
        const g = idx.newGroup(dn);
        g.company = company;
        g.name = name;
        return [dn, g];
    }
    test('same normalized company+name across different numbers clusters', () => {
        const groups = new Map([
            groupWith(100, 'Acme, Inc.', 'Eagle Logo'),
            groupWith(200, 'The ACME Co', 'eagle  logo!'),
            groupWith(300, 'Acme Inc', 'Totally Different Design')
        ]);
        expect(idx.findDupClusters(groups)).toEqual([[100, 200]]);
    });
    test('near-miss names do NOT cluster', () => {
        const groups = new Map([
            groupWith(100, 'Acme', 'Eagle Logo'),
            groupWith(200, 'Acme', 'Eagle Logo 2025')
        ]);
        expect(idx.findDupClusters(groups)).toEqual([]);
    });
    test('short names and empty companies are too generic to cluster', () => {
        const groups = new Map([
            groupWith(100, 'Acme', 'FB'),
            groupWith(200, 'Acme', 'FB'),
            groupWith(300, '', 'Eagle Logo'),
            groupWith(400, '', 'Eagle Logo')
        ]);
        expect(idx.findDupClusters(groups)).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Build orchestration + completeness gate
// ---------------------------------------------------------------------------

function mockCaspio({ baseCount, overlays = {} }) {
    fetchAllCaspioPages.mockImplementation(async (table, params, options) => {
        if (table.includes('Design_Lookup')) {
            const rows = [];
            for (let i = 0; i < baseCount; i++) {
                rows.push({ Design_Number: i + 1, Design_Name: `D${i + 1}`, Date_Updated: '2026-08-01' });
            }
            if (options && options.pageCallback) options.pageCallback(rows, 1);
            return [];
        }
        if (table.includes('Designs2026')) return overlays.designs2026 || [];
        if (table.includes('Digitizing_Mockups')) return overlays.ruth || [];
        if (table.includes('Finished_Photos')) return overlays.photo || [];
        if (table.includes('Thumbnail_Report')) return overlays.thumb || [];
        if (table.includes('ArtRequests')) return overlays.art || [];
        throw new Error('unexpected table ' + table);
    });
}

describe('buildIndex completeness gate', () => {
    test('a full base stream builds and serves', async () => {
        mockCaspio({
            baseCount: 38785,   // the REAL production row count — proves the floor accepts live data
            overlays: { designs2026: [{ ID_Design: 999999, DesignName: 'Fresh', ID_Customer: 1 }] }
        });
        await idx.buildIndex();
        const s = idx.getIndexState();
        expect(s.current).not.toBeNull();
        expect(s.current.payload.counts.baseRows).toBe(38785);
        expect(s.current.payload.counts.groups).toBe(38786); // +1 fresh overlay group
        expect(s.current.payload.counts.bySource.designs2026).toBe(1);
        expect(s.current.etag).toBe(`"${s.current.payload.version}"`);
    });

    test('a short base stream refuses to build', async () => {
        mockCaspio({ baseCount: 10 });
        await expect(idx.buildIndex()).rejects.toThrow(/completeness floor/);
        expect(idx.getIndexState().current).toBeNull();
        expect(idx.getIndexState().lastError).toMatch(/completeness floor/);
    });

    test('a failed rebuild keeps the previous index serving', async () => {
        mockCaspio({ baseCount: 38785 });
        await idx.buildIndex();
        const goodVersion = idx.getIndexState().current.version;

        mockCaspio({ baseCount: 10 });
        await expect(idx.buildIndex()).rejects.toThrow(/completeness floor/);

        const s = idx.getIndexState();
        expect(s.current).not.toBeNull();
        expect(s.current.version).toBe(goodVersion);
        expect(s.lastError).toMatch(/completeness floor/);
    });

    test('overlay failure fails the build (never a silently source-less index)', async () => {
        fetchAllCaspioPages.mockImplementation(async (table, params, options) => {
            if (table.includes('Design_Lookup')) {
                const rows = [];
                for (let i = 0; i < 38785; i++) rows.push({ Design_Number: i + 1 });
                if (options && options.pageCallback) options.pageCallback(rows, 1);
                return [];
            }
            throw new Error('Caspio API rate limit exceeded');
        });
        await expect(idx.buildIndex()).rejects.toThrow(/rate limit/);
        expect(idx.getIndexState().current).toBeNull();
    });
});
