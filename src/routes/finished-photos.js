// Finished Photos API — real photos of the decorated product, captured by the factory on a
// phone/iPad, stored in BOX (keeps Caspio Files lean), tracked in the Finished_Photos table,
// and shown to the customer — ONCE APPROVED — next to their design in the portal.
//
//   POST  /api/finished-photos            multipart: file + idCustomer (req) + designNumber/designName/
//                                          idOrder/companyName/caption/uploadedBy → Box + row, Show_To_Customer='No'
//   GET   /api/finished-photos?idCustomer=  all rows for the customer (staff); add &portal=1 → only Show_To_Customer='Yes'
//   PATCH /api/finished-photos/:pkId       { show: true|false } → set Show_To_Customer (staff approve / unpublish)
//
// Mounted requireCrmApiSecret (server.js) — every caller is server-side: the portal reads via
// getPortalData's portalProxyGet, and the staff capture page reads/writes through the APP (SAML) → proxy.
// Box upload = uploadFileToBox (box-client); served back via the existing GET /api/box/thumbnail/:fileId.
const express = require('express');
const router = express.Router();
const axios = require('axios');
const multer = require('multer');
const config = require('../../config');
const { getCaspioAccessToken, fetchAllCaspioPages, makeCaspioRequest } = require('../utils/caspio');
const { uploadFileToBox, boxRequest, BOX_API_BASE } = require('../utils/box-client');

const TABLE = 'Finished_Photos';
const caspioV3BaseUrl = config.caspio.apiV3BaseUrl || `https://${config.caspio.domain}/integrations/rest/v3`;
const PROXY_BASE_URL = process.env.PROXY_BASE_URL || 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';
const BOX_FOLDER = process.env.BOX_FINISHED_PHOTO_FOLDER_ID;

// Phone cameras emit HEIC/HEIF as well as the usual web formats.
const ALLOWED_IMAGE_MIME = [
  'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp',
  'image/heic', 'image/heif', 'image/avif', 'image/bmp'
];
const FIELD_MAX = 255;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // phone photos run large
  fileFilter: (req, file, cb) => cb(null, ALLOWED_IMAGE_MIME.includes((file.mimetype || '').toLowerCase())),
});
function uploadSinglePhoto(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ success: false, error: 'Photo too large (25MB max)', code: 'FILE_TOO_LARGE' });
    }
    return res.status(400).json({ success: false, error: err.message || 'Upload failed', code: 'BAD_UPLOAD' });
  });
}

function sanitizeFilename(name) {
  const base = String(name || '').trim() || 'photo.jpg';
  return base.replace(/[\\/]+/g, '_').replace(/[^\w.\- ]+/g, '_');
}
function truncate(v, n) { const s = String(v == null ? '' : v).trim(); return s.length > n ? s.slice(0, n) : s; }
function isNumericId(v) { return /^\d{1,12}$/.test(String(v == null ? '' : v).trim()); }

// Uniform card/record shape for the manage page + portal.
function toShape(row) {
  return {
    pkId: row.PK_ID,
    idCustomer: row.id_Customer || '',
    designNumber: row.Design_Number || '',
    designName: row.Design_Name || '',
    idOrder: row.ID_Order || '',
    companyName: row.Company_Name || '',
    boxFileId: row.Box_File_Id || '',
    imageUrl: row.Image_URL || '',
    caption: row.Caption || '',
    uploadedBy: row.Uploaded_By || '',
    uploadedDate: row.Uploaded_Date || '',
    showToCustomer: /^yes$/i.test(String(row.Show_To_Customer || '')),
  };
}

// Box filenames must be unique in a folder — phone names (IMG_1234.jpg) collide. Retry once with a suffix.
function uniqueName(filename) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
  const dot = filename.lastIndexOf('.');
  return dot <= 0 ? `${filename}_${ts}` : `${filename.slice(0, dot)}_${ts}${filename.slice(dot)}`;
}
async function uploadPhotoToBox(fname, buffer, mime) {
  try {
    return await uploadFileToBox(BOX_FOLDER, fname, buffer, mime);
  } catch (e) {
    if (e.response && e.response.status === 409) {
      return await uploadFileToBox(BOX_FOLDER, uniqueName(fname), buffer, mime);
    }
    throw e;
  }
}
// Best-effort rollback so a failed Caspio insert never strands an orphan Box file.
async function deleteBoxFile(fileId) {
  try { await boxRequest('DELETE', `${BOX_API_BASE}/files/${fileId}`); }
  catch (e) { console.error(`[finished-photos] Box rollback FAILED for file ${fileId}:`, e.message); }
}

/**
 * POST /api/finished-photos — capture a finished-product photo.
 * Uploads bytes to Box, then inserts a Finished_Photos row (hidden until a staffer approves).
 */
router.post('/finished-photos', uploadSinglePhoto, async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No photo provided — send multipart/form-data with a "file" field', code: 'NO_FILE' });
  }
  if (!BOX_FOLDER) {
    return res.status(500).json({ success: false, error: 'BOX_FINISHED_PHOTO_FOLDER_ID not configured', code: 'NO_FOLDER' });
  }
  const b = req.body || {};
  const idCustomer = String(b.idCustomer || b.id_Customer || '').trim();
  if (!isNumericId(idCustomer)) {
    return res.status(400).json({ success: false, error: 'idCustomer (numeric) is required', code: 'BAD_CUSTOMER' });
  }

  let boxFile = null;
  try {
    const fname = sanitizeFilename(req.file.originalname);
    boxFile = await uploadPhotoToBox(fname, req.file.buffer, req.file.mimetype);

    const record = {
      id_Customer: idCustomer,
      Design_Number: truncate(b.designNumber || b.design_number, FIELD_MAX),
      Design_Name: truncate(b.designName || b.design_name, FIELD_MAX),
      ID_Order: truncate(b.idOrder || b.id_Order, FIELD_MAX),
      Company_Name: truncate(b.companyName || b.company_name, FIELD_MAX),
      Box_File_Id: String(boxFile.id),
      Image_URL: `${PROXY_BASE_URL}/api/box/thumbnail/${boxFile.id}`,
      Caption: truncate(b.caption, FIELD_MAX),
      Uploaded_By: truncate(b.uploadedBy || b.uploaded_by, FIELD_MAX),
      Uploaded_Date: new Date().toISOString(),
      Show_To_Customer: 'No', // approve-before-visible: staff publish via PATCH
    };

    const token = await getCaspioAccessToken();
    const ins = await axios.post(
      `${caspioV3BaseUrl}/tables/${TABLE}/records?response=rows`,
      record,
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 30000 }
    );
    const row = ins.data && ins.data.Result && ins.data.Result[0];
    if (!row) throw new Error('Caspio insert returned no row');

    console.log(`[finished-photos] stored PK ${row.PK_ID} (cust ${idCustomer}, design ${record.Design_Number || '-'}, box ${boxFile.id})`);
    return res.status(201).json({ success: true, photo: toShape(row) });
  } catch (error) {
    if (boxFile && boxFile.id) await deleteBoxFile(boxFile.id); // never strand an orphan Box file
    const status = error.response && error.response.status;
    const caspioBody = error.response && error.response.data;
    console.error('[finished-photos] upload failed:', status || '', error.message, caspioBody ? JSON.stringify(caspioBody) : '');
    return res.status(status && status >= 400 && status < 500 ? 400 : 500).json({
      success: false,
      error: 'Failed to store finished photo' + (caspioBody && caspioBody.Message ? `: ${caspioBody.Message}` : ''),
      code: 'PHOTO_UPLOAD_FAILED',
    });
  }
});

/**
 * GET /api/finished-photos?idCustomer=<cid>  — rows for one customer, newest first.
 *   &portal=1  → only Show_To_Customer='Yes' (what the customer portal shows).
 */
router.get('/finished-photos', async (req, res) => {
  const idCustomer = String(req.query.idCustomer || req.query.id_Customer || '').trim();
  if (!isNumericId(idCustomer)) {
    return res.status(400).json({ success: false, error: 'idCustomer (numeric) is required', code: 'BAD_CUSTOMER' });
  }
  const portalOnly = ['1', 'true', 'yes'].includes(String(req.query.portal || '').toLowerCase());
  try {
    let where = `id_Customer='${idCustomer}'`; // idCustomer is digits-only → injection-safe
    if (portalOnly) where += ` AND Show_To_Customer='Yes'`;
    const rows = await fetchAllCaspioPages(`/tables/${TABLE}/records`, {
      'q.where': where,
      'q.orderBy': 'PK_ID DESC', // stable column — required for correct pagination
    });
    const photos = (rows || []).map(toShape);
    return res.json({ success: true, count: photos.length, idCustomer, photos });
  } catch (error) {
    console.error('[finished-photos] list failed:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch finished photos', code: 'LIST_FAILED' });
  }
});

/**
 * PATCH /api/finished-photos/:pkId  — set Show_To_Customer (staff approve/unpublish).
 * Body: { show: true|false }  (also accepts { showToCustomer: 'Yes'|'No' }).
 */
router.patch('/finished-photos/:pkId', express.json(), async (req, res) => {
  const pk = String(req.params.pkId || '').trim();
  if (!isNumericId(pk)) {
    return res.status(400).json({ success: false, error: 'Invalid id', code: 'BAD_ID' });
  }
  const body = req.body || {};
  let show;
  if (typeof body.show === 'boolean') show = body.show;
  else if (body.showToCustomer != null) show = /^(yes|true|1)$/i.test(String(body.showToCustomer));
  else return res.status(400).json({ success: false, error: 'Provide show:true|false', code: 'NO_FIELD' });

  try {
    const token = await getCaspioAccessToken();
    const upd = await axios.put(
      `${caspioV3BaseUrl}/tables/${TABLE}/records?q.where=${encodeURIComponent(`PK_ID=${pk}`)}&response=rows`,
      { Show_To_Customer: show ? 'Yes' : 'No' },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 20000 }
    );
    const row = upd.data && upd.data.Result && upd.data.Result[0];
    if (!row) return res.status(404).json({ success: false, error: 'Photo not found', code: 'NOT_FOUND' });
    console.log(`[finished-photos] PK ${pk} → Show_To_Customer=${show ? 'Yes' : 'No'}`);
    return res.json({ success: true, photo: toShape(row) });
  } catch (error) {
    console.error('[finished-photos] patch failed:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to update photo', code: 'PATCH_FAILED' });
  }
});

/**
 * DELETE /api/finished-photos/:pkId — remove a photo entirely (Caspio row + its Box file).
 * Staff action (secret-gated via the mount). Used by the manage view to drop a wrong/bad photo.
 */
router.delete('/finished-photos/:pkId', async (req, res) => {
  const pk = String(req.params.pkId || '').trim();
  if (!isNumericId(pk)) {
    return res.status(400).json({ success: false, error: 'Invalid id', code: 'BAD_ID' });
  }
  try {
    const rows = await fetchAllCaspioPages(`/tables/${TABLE}/records`, { 'q.where': `PK_ID=${pk}` });
    if (!rows || !rows.length) return res.status(404).json({ success: false, error: 'Photo not found', code: 'NOT_FOUND' });
    const boxId = rows[0].Box_File_Id;
    const token = await getCaspioAccessToken();
    await axios.delete(
      `${caspioV3BaseUrl}/tables/${TABLE}/records?q.where=${encodeURIComponent(`PK_ID=${pk}`)}`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 }
    );
    if (boxId) await deleteBoxFile(boxId); // best-effort — a stray Box file is harmless
    console.log(`[finished-photos] deleted PK ${pk} (box ${boxId || '-'})`);
    return res.json({ success: true, deleted: pk });
  } catch (error) {
    console.error('[finished-photos] delete failed:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to delete photo', code: 'DELETE_FAILED' });
  }
});

/**
 * GET /api/finished-photos/lookup?code=<scan-or-typed>
 * Resolves a scanned work-order barcode to the customer, so the capture page can skip the
 * company search. Accepts three shapes (all from the printed ShopWorks work order):
 *   "142476"     — footer barcode / Order Number  → ORDER_ODBC → { customer }
 *   "40121Loc1"  — design-sheet barcode           → Designs2026 → { customer + design }
 *   plain digits that miss as an order # are retried as a design # (order #s and design #s
 *   don't overlap in practice, but a floor scan should never dead-end on the wrong table).
 * Secret-gated by the mount (every non-POST /api/finished-photos/* requires the CRM secret);
 * the capture page reaches it through the APP's SAML-gated /api/staff/finished-photos/lookup.
 */
const ORDERS_TABLE = 'ORDER_ODBC';
const DESIGNS_TABLE = 'Designs2026';

// "*40121LOC1*" (Code 39 sentinels, any case) → { num: '40121', isDesign: true };
// "142476" → { num: '142476', isDesign: false }; anything non-numeric → null.
function parseScanCode(raw) {
  const s = String(raw == null ? '' : raw).replace(/[\s*]+/g, '');
  const m = /^(\d{1,10})(?:loc\d{0,4})?$/i.exec(s);
  if (!m) return null;
  return { num: m[1], isDesign: /loc/i.test(s) };
}

async function firstRow(resource, params) {
  const response = await makeCaspioRequest('get', resource, params);
  const records = Array.isArray(response) ? response : (response && response.Result) || [];
  return records.length ? records[0] : null;
}

async function lookupOrder(num) {
  const row = await firstRow(`/tables/${ORDERS_TABLE}/records`, {
    'q.where': `ID_Order=${num}`,
    'q.limit': 1,
  });
  if (!row) return null;
  return {
    type: 'order',
    orderNumber: String(num),
    idCustomer: row.id_Customer != null ? String(row.id_Customer) : '',
    companyName: row.CompanyName || '',
    datePlaced: row.date_OrderPlaced || '',
  };
}

async function lookupDesign(num) {
  const row = await firstRow(`/tables/${DESIGNS_TABLE}/records`, {
    'q.where': `ID_Design=${num}`,
    'q.limit': 1,
  });
  if (!row) return null;
  const idCustomer = row.ID_Customer != null ? String(row.ID_Customer) : '';
  let companyName = '';
  if (idCustomer) {
    // Newest order carries the current company name (Designs2026 has no name column).
    const o = await firstRow(`/tables/${ORDERS_TABLE}/records`, {
      'q.where': `id_Customer=${idCustomer}`,
      'q.orderBy': 'ID_Order DESC',
      'q.limit': 1,
    });
    if (o) companyName = o.CompanyName || '';
  }
  return {
    type: 'design',
    designNumber: String(num),
    designName: row.DesignName || '',
    idCustomer,
    companyName,
  };
}

router.get('/finished-photos/lookup', async (req, res) => {
  const parsed = parseScanCode(req.query.code);
  if (!parsed) {
    return res.status(400).json({ success: false, error: 'Scan or type an order # or design # (digits only)', code: 'BAD_CODE' });
  }
  try {
    let match = null;
    if (parsed.isDesign) {
      match = await lookupDesign(parsed.num);
    } else {
      match = await lookupOrder(parsed.num);
      if (!match) match = await lookupDesign(parsed.num); // digits that miss as an order # → try design #
    }
    // "No match" is a normal floor outcome (old order not in the ODBC mirror) — 200, not 404.
    return res.json({ success: true, code: parsed.num, match });
  } catch (error) {
    console.error('[finished-photos] lookup failed:', error.message);
    return res.status(500).json({ success: false, error: 'Lookup failed — try the company search', code: 'LOOKUP_FAILED' });
  }
});

module.exports = router;
// Helpers exported for jest.
module.exports.toShape = toShape;
module.exports.sanitizeFilename = sanitizeFilename;
module.exports.uniqueName = uniqueName;
module.exports.parseScanCode = parseScanCode;
