# Image Uploads API (Image_Uploads_Data_Base)

**Version**: 1.0.0 · **Created**: 2026-07-10
**Route file**: `src/routes/image-uploads.js` · **Tests**: `tests/jest/image-uploads-route.test.js`

General **image library**: one POST stores the image in Caspio Files AND creates the
`Image_Uploads_Data_Base` record, returning a servable URL. This is the automation path
(Claude sessions, scripts, staff tools); Erik's manual path is the Caspio upload DataPage
(`https://c3eku948.caspio.com/dp/a0e150004df4984fb1ef4d30b01a`) writing the same table.

## Endpoints

| Method | Path | What |
|---|---|---|
| POST | `/api/image-uploads` | multipart `file` (image, 20MB) + `description`, `aiText`, `style`, `vendor`, `url` (all optional) → 201 `{ success, image }` |
| GET | `/api/image-uploads` | list, newest first. Filters: `?vendor=Sanmar`, `?style=PC54`, `?q=text` (Description/AI_Text/Style substring), `?limit=100` (cap 500) |
| GET | `/api/image-uploads/:imageId` | single by `Image_ID` (strict alphanumeric guard) |

Open endpoints (guidelines tier: not PII/BI — same as `/api/files/upload`). POST is
rate-limited (60/15min per IP, method-aware — GETs never throttled) in `server.js`.

```bash
curl -X POST https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/image-uploads \
  -F "file=@logo.png" -F "description=NWCA logo" -F "vendor=NWCA" -F "aiText=green NW logo"
```

Response `image` shape: `{ imageId, pkId, description, style, vendor: ["Sanmar"], aiText,
url, imagePath, date, fileExternalKey, fileName, size, mimeType }`.

## Table facts (probed live 2026-07-10)

| Field | Type | Notes |
|---|---|---|
| `Image_ID` | Random ID (unique) | the public id used by GET `/:imageId` |
| `Image_Database` | File | **v3 INSERT accepts a files-storage path string** (`/Artwork/name.png`) — no attachments API needed |
| `URL` | Text 255 | set to `${PROXY_BASE_URL}/api/files/{externalKey}` (see CDN note) |
| `AI_Text` | Text 64000 | AI-written description of the image |
| `Description` / `Style` | Text 255 | |
| `Date` | Timestamp | **auto-stamps on insert — never write it** |
| `Vendor` | List-String | options 2026-07-10: Marketing / NWCA / Richardson / Sanmar / JDS. **Insert/update accept a JSON array** `["Sanmar"]`, matched case-insensitively; v2 reads return `{"4":"Sanmar"}` (route normalizes to array). Unknown values pass through so a grown Caspio list needs no proxy deploy. |

## Design decisions / gotchas

- **Files land in the Artwork folder** (same as `/api/files/upload`) — override with env pair
  `CASPIO_IMAGE_UPLOADS_FOLDER_KEY` + `CASPIO_IMAGE_UPLOADS_FOLDER_PATH` (key targets the
  upload; path is what the File field stores — must describe the SAME folder).
- **cdn.caspio.com does NOT serve the Artwork folder** (403 with either `A0E15000` or
  domain-prefix account forms) — that CDN works only for specially-exposed folders like
  `Safety Stripes`. Hence URL = the proxy's `GET /api/files/:externalKey` streamer
  (production-verified: files uploaded via this route serve 200 image/png immediately).
- **Rollback**: if the record insert fails after the file stored, the route deletes the
  file — no orphan files, error surfaced visibly (Erik's #1 rule).
- **409 duplicate filename** → one retry with a timestamp suffix (same as files-simple.js).
- **List filtering is in JS**, not `q.where` — LIST-STRING where-clauses are a known 500
  trap and the library is small.
- Images only (PNG/JPG/GIF/WebP/SVG/BMP/AVIF); PDFs/EPS belong to `/api/files/upload`.

## First content

8 SanMar-purchasing training screenshots (from Bradley's guide, account # redacted)
uploaded 2026-07-10 with `vendor=Sanmar` — the same images served by the training page
`/training/sanmar-purchasing-guide.html` (which uses repo-local copies, not these URLs).
