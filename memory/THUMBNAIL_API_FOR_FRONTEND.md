# Thumbnail Lookup API - Frontend Integration Guide

## Overview

This endpoint retrieves design thumbnail information from the ShopWorks system. Use it to get thumbnail metadata including the file key needed to display design images.

## Endpoint

```
GET /api/thumbnails/by-design/:designId
```

**Base URL**: `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com`

## Parameters

| Parameter | Type | Location | Required | Description |
|-----------|------|----------|----------|-------------|
| `designId` | string | URL path | Yes | The ShopWorks design ID (e.g., "39926") |
| `refresh` | boolean | Query string | No | Set to `true` to bypass cache |

## Request Examples

### Python (requests)

```python
import requests

BASE_URL = "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com"

def get_thumbnail(design_id: str, refresh: bool = False) -> dict:
    """
    Look up a design thumbnail by design ID.

    Args:
        design_id: The ShopWorks design ID
        refresh: Set True to bypass cache

    Returns:
        dict with thumbnail info or not-found message
    """
    url = f"{BASE_URL}/api/thumbnails/by-design/{design_id}"
    params = {"refresh": "true"} if refresh else {}

    response = requests.get(url, params=params)
    response.raise_for_status()
    return response.json()

# Usage
result = get_thumbnail("39926")
if result["found"]:
    print(f"Thumbnail: {result['fileName']}")
    print(f"Design Name: {result['designName']}")
else:
    print(result["message"])
```

### cURL

```bash
# Basic lookup
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/thumbnails/by-design/39926"

# Force cache refresh
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/thumbnails/by-design/39926?refresh=true"
```

## Response Format

### Success (thumbnail found)

```json
{
  "found": true,
  "thumbnailId": 106511,
  "designNumber": "39926",
  "fileName": "qxo.jpg",
  "externalKey": "abc123-def456-ghi789",
  "designName": "QXO"
}
```

### Not Found

```json
{
  "found": false,
  "message": "No thumbnail found for design 39926"
}
```

**Note**: Not found returns HTTP 200 with `found: false`, not HTTP 404.

### Error Response

```json
{
  "error": "Failed to fetch thumbnail",
  "details": "Error message here"
}
```

HTTP Status: 500

## Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `found` | boolean | Whether a thumbnail was found |
| `thumbnailId` | integer | Unique thumbnail ID (from ID_Serial field) |
| `designNumber` | string | The design ID that was queried |
| `fileName` | string | Original filename of the thumbnail image |
| `externalKey` | string | Caspio Files API key for retrieving the image (may be empty) |
| `designName` | string | Human-readable design name |
| `message` | string | Only present when `found: false` |

## Building the Image URL

If `externalKey` is populated, you can retrieve the actual image file:

```
https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/files/{externalKey}
```

**Important**: The `externalKey` field may be empty for some records. In that case, the thumbnail image is not available through the API.

### Python Example - Get Image URL

```python
def get_thumbnail_image_url(design_id: str) -> str | None:
    """
    Get the full image URL for a design thumbnail.

    Returns None if no thumbnail or no externalKey available.
    """
    result = get_thumbnail(design_id)

    if not result.get("found"):
        return None

    external_key = result.get("externalKey")
    if not external_key:
        return None

    return f"{BASE_URL}/api/files/{external_key}"
```

## Caching

- **Cache Duration**: 5 minutes
- **Bypass Cache**: Add `?refresh=true` to force a fresh lookup
- Cache is per design ID

## Error Handling

```python
def safe_get_thumbnail(design_id: str) -> dict:
    """Get thumbnail with proper error handling."""
    try:
        result = get_thumbnail(design_id)
        return result
    except requests.exceptions.HTTPError as e:
        if e.response.status_code == 400:
            return {"found": False, "error": "Invalid design ID format"}
        elif e.response.status_code == 500:
            return {"found": False, "error": "Server error fetching thumbnail"}
        raise
    except requests.exceptions.RequestException as e:
        return {"found": False, "error": f"Network error: {str(e)}"}
```

## Input Validation

The API sanitizes the design ID input:
- Allows: alphanumeric characters, hyphens, underscores
- Maximum length: 50 characters
- Invalid input returns HTTP 400

## Use Cases

1. **Display design preview** - Show thumbnail when user selects a design
2. **Order confirmation** - Display design images in order summary
3. **Design search results** - Show thumbnails in search/browse interfaces
4. **Production sheets** - Include design images in work orders

## Complete Python Integration Class

```python
import requests
from typing import Optional
from dataclasses import dataclass

@dataclass
class ThumbnailInfo:
    found: bool
    thumbnail_id: Optional[int] = None
    design_number: Optional[str] = None
    file_name: Optional[str] = None
    external_key: Optional[str] = None
    design_name: Optional[str] = None
    message: Optional[str] = None
    image_url: Optional[str] = None

class ThumbnailAPI:
    BASE_URL = "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com"

    def get_thumbnail(self, design_id: str, refresh: bool = False) -> ThumbnailInfo:
        """
        Look up a design thumbnail.

        Args:
            design_id: ShopWorks design ID
            refresh: Bypass cache if True

        Returns:
            ThumbnailInfo with all thumbnail details
        """
        url = f"{self.BASE_URL}/api/thumbnails/by-design/{design_id}"
        params = {"refresh": "true"} if refresh else {}

        try:
            response = requests.get(url, params=params, timeout=10)
            response.raise_for_status()
            data = response.json()

            info = ThumbnailInfo(
                found=data.get("found", False),
                thumbnail_id=data.get("thumbnailId"),
                design_number=data.get("designNumber"),
                file_name=data.get("fileName"),
                external_key=data.get("externalKey"),
                design_name=data.get("designName"),
                message=data.get("message")
            )

            # Build image URL if external key exists
            if info.found and info.external_key:
                info.image_url = f"{self.BASE_URL}/api/files/{info.external_key}"

            return info

        except requests.exceptions.RequestException as e:
            return ThumbnailInfo(
                found=False,
                message=f"API error: {str(e)}"
            )

# Usage
api = ThumbnailAPI()
thumb = api.get_thumbnail("39926")

if thumb.found:
    print(f"Design: {thumb.design_name}")
    print(f"File: {thumb.file_name}")
    if thumb.image_url:
        print(f"Image URL: {thumb.image_url}")
else:
    print(f"Not found: {thumb.message}")
```

---

## Update ExternalKey Endpoint

After uploading an image to Caspio Files, use this endpoint to save the returned externalKey back to the thumbnail record.

### Endpoint

```
PUT /api/thumbnails/:thumbnailId/external-key
```

### Request

```python
def update_thumbnail_external_key(thumbnail_id: int, external_key: str) -> dict:
    """
    Update the ExternalKey for a thumbnail record.

    Args:
        thumbnail_id: The thumbnail ID (ID_Serial)
        external_key: The Caspio Files key from upload

    Returns:
        dict with success status
    """
    url = f"{BASE_URL}/api/thumbnails/{thumbnail_id}/external-key"

    response = requests.put(
        url,
        json={"externalKey": external_key},
        headers={"Content-Type": "application/json"},
        timeout=10
    )
    response.raise_for_status()
    return response.json()

# Usage
result = update_thumbnail_external_key(106511, "ea63d3fc-8957-4d76-a29f-06db8005b8c6")
print(result)  # {"success": true, "thumbnailId": 106511, "message": "ExternalKey updated successfully"}
```

### cURL Example

```bash
curl -X PUT "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/thumbnails/106511/external-key" \
  -H "Content-Type: application/json" \
  -d '{"externalKey": "ea63d3fc-8957-4d76-a29f-06db8005b8c6"}'
```

### Responses

**Success (200)**:
```json
{
  "success": true,
  "thumbnailId": 106511,
  "fileUrl": "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/files/ea63d3fc-8957-4d76-a29f-06db8005b8c6",
  "message": "ExternalKey and FileUrl updated successfully"
}
```

**Not Found (404)**:
```json
{
  "success": false,
  "error": "Thumbnail 999999 not found"
}
```

**Bad Request (400)**:
```json
{
  "success": false,
  "error": "externalKey is required"
}
```

### Input Validation

- `thumbnailId` must be a positive integer
- `externalKey` must be a non-empty string (max 255 characters)

---

## Automated Upload Workflow

Complete workflow for uploading and linking a design thumbnail:

```python
def upload_and_link_thumbnail(thumbnail_id: int, image_path: str) -> bool:
    """
    Upload an image and link it to a thumbnail record.

    1. Upload image to Caspio Files
    2. Save the externalKey to the thumbnail record
    3. Verify the update

    Args:
        thumbnail_id: The thumbnail ID to update
        image_path: Path to the image file

    Returns:
        True if successful
    """
    # Step 1: Upload image
    with open(image_path, 'rb') as f:
        upload_response = requests.post(
            f"{BASE_URL}/api/files/upload",
            files={"file": f},
            timeout=30
        )
    upload_response.raise_for_status()
    external_key = upload_response.json().get("externalKey")

    if not external_key:
        raise ValueError("Upload did not return externalKey")

    # Step 2: Update thumbnail record
    update_response = requests.put(
        f"{BASE_URL}/api/thumbnails/{thumbnail_id}/external-key",
        json={"externalKey": external_key},
        headers={"Content-Type": "application/json"},
        timeout=10
    )
    update_response.raise_for_status()

    # Step 3: Verify (optional)
    # The next GET request will show the new externalKey

    return True
```

---

## Sync Status Endpoint

Check when thumbnail data was last synced from ShopWorks.

### Endpoint

```
GET /api/thumbnails/sync-status
```

### Response

```json
{
  "success": true,
  "lastSync": "2025-12-20T09:51:42",
  "totalRecords": 47328,
  "recordsWithImages": 369,
  "recordsNeedingImages": 46959
}
```

### Python Example

```python
def get_sync_status(refresh: bool = False) -> dict:
    """Get thumbnail table sync status."""
    url = f"{BASE_URL}/api/thumbnails/sync-status"
    params = {"refresh": "true"} if refresh else {}
    response = requests.get(url, params=params)
    return response.json()

# Usage
status = get_sync_status()
print(f"Last sync: {status['lastSync']}")
print(f"Total designs: {status['totalRecords']}")
print(f"With images: {status['recordsWithImages']}")
```

### Notes
- 5-minute cache (use `?refresh=true` to bypass)
- Use this to show "Last sync: Today" or "Last sync: 3 days ago" in dashboard

---

## Reconcile Files Endpoint

Link orphaned files in Caspio Files with their database records.

### Endpoint

```
POST /api/thumbnails/reconcile-files
```

### What It Does

1. Lists ALL files in Caspio Files "Artwork" folder (with pagination, max 1000 per page)
2. For each file matching `{ThumbnailID}_{description}.ext`:
   - Parses the ThumbnailID from the filename
   - Looks up the record in `Shopworks_Thumbnail_Report`
   - Updates `ExternalKey` and `FileUrl` if found

### Response

```json
{
  "success": true,
  "summary": {
    "filesProcessed": 847,
    "matched": 25,
    "notFoundInTable": 3,
    "alreadyLinked": 12,
    "errors": 807
  },
  "details": [
    { "thumbnailId": "106041", "status": "matched", "externalKey": "abc123..." },
    { "thumbnailId": "99999", "status": "not_found_in_table", "fileName": "99999_test.jpg" },
    { "thumbnailId": "106042", "status": "already_linked", "externalKey": "def456..." },
    { "fileName": "random-artwork.png", "status": "invalid_filename_format" }
  ]
}
```

### Status Values

| Status | Meaning |
|--------|---------|
| `matched` | Successfully linked file to database record |
| `already_linked` | File was already correctly linked |
| `not_found_in_table` | ThumbnailID doesn't exist in database |
| `invalid_filename_format` | Filename doesn't match `{ID}_{name}.ext` pattern |
| `error` | Failed to process (see error field) |

### Python Example

```python
def reconcile_files() -> dict:
    """Run file reconciliation (one-time operation)."""
    response = requests.post(f"{BASE_URL}/api/thumbnails/reconcile-files", timeout=120)
    return response.json()

# Usage
result = reconcile_files()
summary = result.get("summary", {})
print(f"Files processed: {summary.get('filesProcessed')}")
print(f"Matched & linked: {summary.get('matched')}")
print(f"Already linked: {summary.get('alreadyLinked')}")
```

### Notes
- **No files are deleted** - only reads file listings and updates database records
- Run after batch uploading to link any orphaned files
- The `errors` count includes files that don't match the naming pattern (random artwork)
- May take a while if there are thousands of files

---

## Uploaded IDs Endpoint (For Sync Scripts)

Get all thumbnail IDs that already have images uploaded, with metadata for change detection.

### Endpoint

```
GET /api/thumbnails/uploaded-ids
```

### Response

```json
{
  "success": true,
  "count": 369,
  "uploaded": [
    {"id": 104112, "size": 245678, "uploadedAt": "2025-01-06T14:30:00"},
    {"id": 104115, "size": 189432, "uploadedAt": "2025-01-05T09:15:00"},
    {"id": 106041, "size": null, "uploadedAt": null}
  ]
}
```

### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | integer | Thumbnail ID (ID_Serial) |
| `size` | integer/null | File size in bytes (null if not tracked) |
| `uploadedAt` | string/null | ISO timestamp of upload (null if not tracked) |

### Python Example

```python
def get_uploaded_ids() -> dict:
    """Get all thumbnail IDs with images and their metadata."""
    response = requests.get(f"{BASE_URL}/api/thumbnails/uploaded-ids")
    return response.json()

# Usage - Build lookup for change detection
result = get_uploaded_ids()
uploaded_map = {item["id"]: item for item in result["uploaded"]}

# Check if file needs re-upload (size changed)
def needs_upload(thumbnail_id: int, local_file_size: int) -> bool:
    if thumbnail_id not in uploaded_map:
        return True  # Not uploaded yet
    existing = uploaded_map[thumbnail_id]
    if existing["size"] is None:
        return False  # Already uploaded but no size tracked
    return existing["size"] != local_file_size  # Size mismatch = re-upload
```

---

## Upload with Stub Endpoint (For Sync Scripts)

Upload a thumbnail file and create/update the database record in one step. Saves file size and upload timestamp for change detection.

### Endpoint

```
POST /api/thumbnails/upload-with-stub
```

### Request

**Content-Type**: `multipart/form-data`

**File naming**: `{ID_Serial}_{description}.ext`

Example: `104385_Northwest_Custom_Logo.jpg`

### Python Example

```python
def upload_thumbnail(file_path: str) -> dict:
    """
    Upload a thumbnail and create/update the database record.

    File must be named: {ID_Serial}_{description}.ext
    """
    with open(file_path, 'rb') as f:
        response = requests.post(
            f"{BASE_URL}/api/thumbnails/upload-with-stub",
            files={"file": f},
            timeout=30
        )
    response.raise_for_status()
    return response.json()

# Usage
result = upload_thumbnail("104385_Northwest_Custom_Logo.jpg")
print(f"Action: {result['action']}")  # "created" or "updated"
print(f"File URL: {result['fileUrl']}")
```

### Response

```json
{
  "success": true,
  "thumbnailId": 104385,
  "externalKey": "abc-123-def-456",
  "fileUrl": "https://caspio-pricing-proxy.../api/files/abc-123-def-456",
  "action": "created"
}
```

### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `thumbnailId` | integer | The ID_Serial parsed from filename |
| `externalKey` | string | Caspio Files key for the uploaded file |
| `fileUrl` | string | Public URL to access the file |
| `action` | string | `"created"` (new record) or `"updated"` (existing record) |

### Error Responses

**409 Conflict** - File already exists in Caspio Files:
```json
{
  "success": false,
  "error": "File already exists in Caspio",
  "code": "FILE_EXISTS"
}
```

**400 Bad Request** - Invalid filename format:
```json
{
  "success": false,
  "error": "Invalid filename format. Expected: {ID}_{description}.ext"
}
```

### Notes

- Saves `FileSizeNumber` and `timestamp_Uploaded` for change detection
- Allows re-uploading to update existing records
- If record exists in database, updates it; otherwise creates a new stub record

---

## Related Endpoints

- `GET /api/files/:externalKey` - Retrieve the actual image file using the externalKey
- `POST /api/files/upload` - Upload a new image file to Caspio Files
