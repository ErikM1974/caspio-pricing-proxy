// Image metadata extractor — pixel dims + DPI + physical inches.
//
// Uses `image-size` (v2.0.2) for width/height across PNG/JPEG/GIF/WebP/BMP/TIFF.
// Parses DPI from format-specific metadata chunks because `image-size` v2 drops
// density from its return type:
//   PNG  → pHYs chunk (pixels-per-meter → DPI)
//   JPEG → JFIF APP0 marker (Xdensity/Ydensity + unit byte)
//   PDF  → MediaBox (regex on first 16KB; native points → inches)
//
// Returns a consistent object shape regardless of input type:
//   { fileType, pixelWidth, pixelHeight, dpiX, dpiY,
//     physicalWidthIn, physicalHeightIn, confidence, error? }
//
// Usage from analyze-link route:
//   const meta = extractImageMetadata(boxBuffer);
//   if (meta.error) return 400;
//   responseJson.pixelWidth = meta.pixelWidth; ...

const { imageSize } = require('image-size');

const round2 = (n) => (n === null || n === undefined || Number.isNaN(n))
    ? null
    : Math.round(n * 100) / 100;

/**
 * Parse the PNG pHYs chunk to get pixels-per-meter → DPI.
 * Returns null when the chunk is absent (many PNGs omit pHYs entirely).
 *
 * PNG structure: 8-byte signature, then chunks of
 *   [4B length][4B type][<length>B data][4B CRC]
 * pHYs data: [4B X ppu][4B Y ppu][1B unit: 0=aspect-only, 1=meters]
 */
function extractPngDpi(buf) {
    let pos = 8; // skip PNG signature
    while (pos + 12 <= buf.length) {
        const len = buf.readUInt32BE(pos);
        const type = buf.slice(pos + 4, pos + 8).toString('ascii');
        if (type === 'pHYs' && len >= 9) {
            const xPpm = buf.readUInt32BE(pos + 8);
            const yPpm = buf.readUInt32BE(pos + 12);
            const unit = buf[pos + 16];
            if (unit === 1) {
                // 1 inch = 0.0254 meters → DPI = ppm × 0.0254
                return {
                    dpiX: Math.round(xPpm * 0.0254),
                    dpiY: Math.round(yPpm * 0.0254)
                };
            }
            return { dpiX: null, dpiY: null }; // aspect ratio only, no real DPI
        }
        if (type === 'IDAT') break; // image data reached; pHYs (if present) is always before IDAT
        pos += 8 + len + 4; // length + type + data + CRC
    }
    return null;
}

/**
 * Parse JPEG JFIF APP0 marker for density.
 * JFIF layout (after FFD8 SOI): FFE0 <len> "JFIF\0" <v-major> <v-minor> <unit> <Xdensity 2B> <Ydensity 2B> ...
 * unit: 0 = no unit (aspect ratio), 1 = px/inch, 2 = px/cm
 */
function extractJpegDpi(buf) {
    // Scan the first ~2KB for the JFIF marker — it's always in the first APP0 segment
    const scanLen = Math.min(buf.length, 2048);
    for (let pos = 2; pos < scanLen - 20; pos++) {
        if (buf[pos] === 0xFF && buf[pos + 1] === 0xE0) {
            const marker = buf.slice(pos + 4, pos + 9).toString('ascii');
            if (marker === 'JFIF\0' || marker === 'JFIF ') {
                const unit = buf[pos + 11];
                const xDen = buf.readUInt16BE(pos + 12);
                const yDen = buf.readUInt16BE(pos + 14);
                if (unit === 1) return { dpiX: xDen, dpiY: yDen };          // inch
                if (unit === 2) return { dpiX: Math.round(xDen * 2.54), dpiY: Math.round(yDen * 2.54) }; // cm→in
                return { dpiX: null, dpiY: null };                           // unit=0, aspect only
            }
        }
    }
    return null;
}

/**
 * Extract MediaBox from a PDF (tiny regex-based reader — no pdf-lib needed).
 * Scans first 16KB of the file for the first /MediaBox tag; should work for
 * single-page transfer PDFs and typical AI files (which are PDF since CS2).
 */
function extractPdfMediaBox(buf) {
    // PDF is latin1-safe text in the cross-reference/trailer region
    const text = buf.toString('latin1', 0, Math.min(buf.length, 16384));
    const match = text.match(/\/MediaBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]/);
    if (!match) return null;
    const x1 = parseFloat(match[1]), y1 = parseFloat(match[2]);
    const x2 = parseFloat(match[3]), y2 = parseFloat(match[4]);
    const widthPts = x2 - x1;
    const heightPts = y2 - y1;
    if (widthPts <= 0 || heightPts <= 0) return null;
    // PDF points: 1 pt = 1/72 inch
    return {
        widthPts,
        heightPts,
        physicalWidthIn: widthPts / 72,
        physicalHeightIn: heightPts / 72
    };
}

// ── Main entry point ───────────────────────────────────────────────────

/**
 * Extract dimension metadata from file bytes.
 * @param {Buffer} buf - raw file bytes (at least first 16KB is enough for metadata)
 * @returns {object} normalized metadata result (see module header)
 */
function extractImageMetadata(buf) {
    if (!buf || buf.length < 12) {
        return { fileType: null, confidence: 'low', error: 'buffer too small' };
    }

    // Magic-byte detection
    const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
    const isJpeg = buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
    const isPdf = buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46;

    // PDF (includes AI files post-CS2) → regex MediaBox
    if (isPdf) {
        const mb = extractPdfMediaBox(buf);
        if (mb) {
            return {
                fileType: 'PDF',
                pixelWidth: null,
                pixelHeight: null,
                dpiX: null,
                dpiY: null,
                physicalWidthIn: round2(mb.physicalWidthIn),
                physicalHeightIn: round2(mb.physicalHeightIn),
                confidence: 'high'
            };
        }
        return { fileType: 'PDF', confidence: 'low', error: 'MediaBox not found in first 16KB' };
    }

    // Images: use image-size for dims, custom parsers for DPI
    let size;
    try {
        size = imageSize(buf);
    } catch (e) {
        // Return null fileType so callers can fall back to Box-reported extension.
        // Preserve magic-byte detection so we still say "it's a JPG" even when
        // image-size couldn't parse it (usually happens when the Range fetch
        // was truncated before the SOF marker on large JPEGs).
        const fallbackType = isPng ? 'PNG' : isJpeg ? 'JPG' : null;
        return { fileType: fallbackType, confidence: 'low', error: e.message || 'imageSize failed' };
    }

    const dpiInfo = isPng ? extractPngDpi(buf)
                  : isJpeg ? extractJpegDpi(buf)
                  : null;
    const dpiX = dpiInfo && dpiInfo.dpiX;
    const dpiY = dpiInfo && dpiInfo.dpiY;

    return {
        fileType: (size.type || '').toUpperCase(),
        pixelWidth: size.width,
        pixelHeight: size.height,
        dpiX: dpiX || null,
        dpiY: dpiY || null,
        physicalWidthIn: dpiX ? round2(size.width / dpiX) : null,
        physicalHeightIn: dpiY ? round2(size.height / dpiY) : null,
        // "high" when we have DPI, "medium" when we have only pixels,
        // "low" when image-size couldn't parse anything meaningful.
        confidence: dpiX ? 'high' : (size.width ? 'medium' : 'low')
    };
}

module.exports = {
    extractImageMetadata,
    // exposed for unit testing
    _extractPngDpi: extractPngDpi,
    _extractJpegDpi: extractJpegDpi,
    _extractPdfMediaBox: extractPdfMediaBox
};
