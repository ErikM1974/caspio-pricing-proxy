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
  "message": "ExternalKey updated successfully"
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

## Related Endpoints

- `GET /api/files/:externalKey` - Retrieve the actual image file using the externalKey
- `POST /api/files/upload` - Upload a new image file to Caspio Files
