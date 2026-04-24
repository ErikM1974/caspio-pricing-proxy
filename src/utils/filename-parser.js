// Steve's Box filename convention parser.
//
// Strict convention (confirmed with Erik 2026-04-24):
//   Transfer: {design#} {customer name} {WxH} {placement} Transfer[ copy].{ext}
//   Mockup:   {design#} {customer name} Mock[ Final][ copy].{ext}
//
// Separators: both spaces and underscores are valid (Steve's Box exports vary).
//   Example A: "39721 Asphalt Patch Systems 13.5x4.1 FF Transfer copy.png"
//   Example B: "39721_Asphalt_Patch_Systems_13.5x4.1_FF_Transfer_copy.png"
//   Example C: "39721 APS Inc Mock Final.jpg"
//
// Returns a normalized result:
//   {
//     ok: true,
//     type: 'transfer' | 'mockup',
//     designNumber: '39721',
//     customer: 'Asphalt Patch Systems',
//     placementCode: 'FF',             // null for mockups
//     placementLabel: 'Full Front',    // null for mockups; raw code if unknown
//     filenameWidth: 13.5,             // null for mockups
//     filenameHeight: 4.1,             // null for mockups
//     originalName: '...'
//   }
// or  { ok: false, reason: '...', originalName: '...' } when unparseable.

// Placement codes → human-readable label. Add to this dict as new codes are
// discovered. Unknown codes surface as raw (parser still succeeds, label = code).
const PLACEMENT_LABELS = {
    FF: 'Full Front',
    FB: 'Full Back',
    LC: 'Left Chest',
    RC: 'Right Chest',
    LS: 'Left Sleeve',
    RS: 'Right Sleeve',
    SL: 'Sleeve',
    BK: 'Back',
    NK: 'Neck',
    NP: 'Nape',
    HD: 'Hood',
    HOOD: 'Hood',
    POCKET: 'Pocket',
    YOKE: 'Yoke',
    CF: 'Center Front'
};

const SIZE_REGEX = /^(\d+(?:\.\d+)?)[xX](\d+(?:\.\d+)?)$/; // matches "13.5x4.1" or "8X10"

function parseFilename(name) {
    if (!name || typeof name !== 'string') {
        return { ok: false, reason: 'empty filename', originalName: name };
    }

    const originalName = name;

    // Strip extension
    const extMatch = name.match(/^(.+?)\.([a-zA-Z0-9]+)$/);
    if (!extMatch) {
        return { ok: false, reason: 'no file extension', originalName };
    }
    let base = extMatch[1];

    // Normalize separators: collapse underscores to spaces, collapse multiple spaces.
    base = base.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

    // Strip trailing " copy" (Box adds this on download/duplicate)
    base = base.replace(/\s+copy\s*$/i, '').trim();

    // First token: design number (leading digits)
    const designMatch = base.match(/^(\d+)\s+(.+)$/);
    if (!designMatch) {
        return { ok: false, reason: 'no leading design number', originalName };
    }
    const designNumber = designMatch[1];
    let rest = designMatch[2];

    // Detect type by suffix: ends in "Transfer" (maybe with trailing words removed already)
    // or contains "Mock" anywhere.
    const transferTailMatch = rest.match(/^(.+?)\s+(?:Transfer|Xfer)\s*$/i);
    if (transferTailMatch) {
        // Transfer file: "<customer> <WxH> <placement>"
        const body = transferTailMatch[1].trim();
        const tokens = body.split(' ');
        if (tokens.length < 3) {
            return { ok: false, reason: 'transfer filename missing size/placement', originalName };
        }

        // Placement code = last token; size = second-to-last
        const placementCode = tokens[tokens.length - 1].toUpperCase();
        const sizeToken = tokens[tokens.length - 2];
        const sizeMatch = sizeToken.match(SIZE_REGEX);
        if (!sizeMatch) {
            return {
                ok: false,
                reason: `expected size (WxH) before placement, got "${sizeToken}"`,
                originalName
            };
        }

        const customer = tokens.slice(0, -2).join(' ');
        if (!customer) {
            return { ok: false, reason: 'no customer name before size', originalName };
        }

        return {
            ok: true,
            type: 'transfer',
            designNumber,
            customer,
            placementCode,
            placementLabel: PLACEMENT_LABELS[placementCode] || placementCode,
            filenameWidth: parseFloat(sizeMatch[1]),
            filenameHeight: parseFloat(sizeMatch[2]),
            originalName
        };
    }

    // Mockup detection: "Mock" anywhere in the remainder
    if (/\bMock\b/i.test(rest)) {
        // "<customer> Mock [Final] [...]" — everything before "Mock" is the customer
        const mockIdx = rest.search(/\bMock\b/i);
        const customer = rest.slice(0, mockIdx).trim();
        if (!customer) {
            return { ok: false, reason: 'no customer name before Mock', originalName };
        }
        return {
            ok: true,
            type: 'mockup',
            designNumber,
            customer,
            placementCode: null,
            placementLabel: null,
            filenameWidth: null,
            filenameHeight: null,
            originalName
        };
    }

    return {
        ok: false,
        reason: 'not a transfer or mockup (missing Transfer/Mock suffix)',
        originalName
    };
}

module.exports = {
    parseFilename,
    PLACEMENT_LABELS
};
