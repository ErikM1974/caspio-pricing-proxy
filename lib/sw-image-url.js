/**
 * lib/sw-image-url.js — ShopWorks-ingestible artwork URLs (P2 fix, 2026-07-10).
 *
 * OnSite's ManageOrders import SILENTLY drops design/attachment images that
 * exceed 2 MB (documented: Pricing Index memory/MANAGEORDERS_COMPLETE_REFERENCE
 * §13 "Image Attachment Limits"), and extension-less URLs give FileMaker
 * nothing to derive a filename/type from. Erik's 2.12 MB PNG reproduced the
 * silent drop on order 142409 (design 40655 landed with metadata but no image).
 *
 * Fix: our own /api/files/<key> URLs are rewritten to the /sw.jpg variant —
 * served by files-simple.js as a ≤2 MB JPEG with a real extension. Any other
 * URL (external hosts, empty) passes through untouched, so callers can wrap
 * unconditionally.
 */

// our file endpoint: any host, path exactly /api/files/<uuid-ish key>
const OWN_FILES_URL_RE = /^(https?:\/\/[^/]+\/api\/files\/[A-Za-z0-9-]{8,})$/;

function swImageUrl(url) {
  const m = OWN_FILES_URL_RE.exec(String(url || '').trim());
  return m ? `${m[1]}/sw.jpg` : (url || '');
}

/**
 * Order-level Attachments entries for uploaded artwork files — makes every
 * uploaded file visible in ShopWorks' Attachments tab even when no new Design
 * record is created (e.g. rep picked an existing design #).
 * @param {Array<{hostedUrl?: string, fileName?: string, placement?: string}>} files
 */
function artworkAttachments(files) {
  return (Array.isArray(files) ? files : [])
    .filter((f) => f && f.hostedUrl)
    .map((f) => ({
      MediaURL: swImageUrl(f.hostedUrl),
      MediaName: f.fileName || 'artwork',
      LinkURL: '',
      LinkNote: f.placement ? `Placement: ${f.placement}` : '',
      Link: 0,
    }));
}

module.exports = { swImageUrl, artworkAttachments };
