# Logo Upload Feature - Implementation Summary

## Overview
Added logo/artwork file upload capability to the sample request form. Files are uploaded as part of the ManageOrders PUSH API order payload and automatically attached to orders in ShopWorks OnSite.

---

## What Was Implemented

### 1. Frontend Changes (Pricing Index File 2025 Repository)

#### File: `pages/sample-cart.html`

**A. File Input Field** (lines 617-632)
```html
<!-- Logo Upload Section -->
<div class="form-group full-width">
    <label>
        Upload Logo/Artwork
        <span style="color: var(--text-secondary); font-weight: normal;">(Optional - AI, PDF, PNG, JPG)</span>
    </label>
    <input
        type="file"
        id="logoUpload"
        name="logoUpload"
        accept=".ai,.pdf,.png,.jpg,.jpeg,.eps,.psd,.svg"
        style="padding: 0.5rem;">
    <small style="display: block; margin-top: 0.5rem; color: var(--text-secondary);">
        Upload your company logo or artwork design (if available)
    </small>
</div>
```

**B. CSS Styling** (lines 320-340)
```css
/* File Input Styling */
.form-group input[type="file"] {
    width: 100%;
    padding: 0.75rem;
    border: 2px dashed var(--border-color);
    border-radius: 8px;
    background: var(--bg-color);
    cursor: pointer;
    transition: border-color 0.2s, background 0.2s;
}

.form-group input[type="file"]:hover {
    border-color: var(--primary-color);
    background: white;
}

.form-group input[type="file"]:focus {
    outline: none;
    border-color: var(--primary-color);
    border-style: solid;
}
```

**C. JavaScript - File Conversion Helper** (lines 858-869)
```javascript
// Helper function to convert file to base64
async function convertFileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = (error) => {
            console.error('[Sample Cart] File read error:', error);
            reject(error);
        };
        reader.readAsDataURL(file);
    });
}
```

**D. JavaScript - Form Submit Handler** (lines 943-963)
```javascript
// Handle logo file upload (if provided)
let logoFile = null;
const logoInput = document.getElementById('logoUpload');
if (logoInput.files && logoInput.files[0]) {
    const file = logoInput.files[0];
    console.log('[Sample Cart] Processing logo file:', file.name, file.type, file.size);

    try {
        const base64Data = await convertFileToBase64(file);
        logoFile = {
            fileName: file.name,
            fileData: base64Data,
            category: 'artwork',
            description: 'Customer uploaded logo/artwork'
        };
        console.log('[Sample Cart] ✅ Logo file converted to base64');
    } catch (error) {
        console.error('[Sample Cart] ❌ Failed to convert logo file:', error);
        // Continue without logo - don't block order submission
    }
}

// Send to ShopWorks (now includes logoFile as 3rd parameter)
if (window.sampleOrderService) {
    const result = await window.sampleOrderService.submitSampleOrder(
        customerData,
        samplesForService,
        logoFile  // <-- NEW: Logo file parameter
    );
```

#### File: `shared_components/js/sample-order-service.js`

**A. Method Signature Updates** (lines 121-122, 157)
```javascript
// Public method
async submitSampleOrder(customerData, samples, logoFile = null) {
    return this.submitOrder(customerData, samples, logoFile);
}

// Internal method
async submitOrder(formData, samples, logoFile = null) {
    // ... existing code ...
}
```

**B. Files Array Integration** (lines 268-272)
```javascript
// Add files array if logo was uploaded
if (logoFile) {
    order.files = [logoFile];
    console.log('[SampleOrderService] Logo file included:', logoFile.fileName);
}
```

---

### 2. Backend Changes (caspio-pricing-proxy Repository)

#### File: `server.js` (line 23)

**CRITICAL FIX - Body Size Limit**
```javascript
// BEFORE (caused "Failed to fetch" error):
app.use(express.json());  // Default limit: 100kb

// AFTER (allows logo uploads):
app.use(express.json({ limit: '10mb' }));  // Supports files up to ~7.5MB
```

**Why This Was Needed:**
- Default Express JSON body limit: **100 KB**
- Base64-encoded files are **~33% larger** than original
- A 1.3 MB PNG becomes **~1.7 MB** in base64
- Without this fix, requests with logo files were rejected with "Failed to fetch"

---

## File Upload Flow

```
1. User selects file in browser
   ↓
2. File read by FileReader API (convertFileToBase64)
   ↓
3. Converted to base64 data URL (data:image/png;base64,iVBOR...)
   ↓
4. logoFile object created:
   {
     fileName: "logo.png",
     fileData: "data:image/png;base64,...",
     category: "artwork",
     description: "Customer uploaded logo/artwork"
   }
   ↓
5. Added to order payload as "files" array
   ↓
6. Sent to ManageOrders PUSH API (/api/manageorders/orders/create)
   ↓
7. Backend uploads to Caspio Files API
   ↓
8. File URL returned and added to ManageOrders order
   ↓
9. Order imported into ShopWorks OnSite with attachment
```

---

## Testing & Debugging

### Expected Console Output (Success)

When a file is uploaded successfully, you should see these console messages in order:

```javascript
[Sample Cart] Processing logo file: logo.png image/png 145234
[Sample Cart] ✅ Logo file converted to base64
[SampleOrderService] Generated order number: SAMPLE-1029-5-214
[SampleOrderService] Submitting order: SAMPLE-1029-5-214
[SampleOrderService] Logo file included: logo.png
[SampleOrderService] Order payload: { ... files: [...] ... }
[SampleOrderService] API response status: 201
✅ Order created successfully: SAMPLE-1029-5-214
```

### Common Issues & Solutions

#### Issue 1: "Failed to fetch" Error
**Symptom:**
```
[SampleOrderService] Error submitting order: TypeError: Failed to fetch
```

**Cause:**
- File too large for server body limit
- Network connectivity issue
- CORS configuration problem

**Solution:**
1. Check file size (should be under 7.5 MB)
2. Verify server is deployed with updated `server.js` (10mb limit)
3. Check browser network tab for exact error

#### Issue 2: File Not Converting to Base64
**Symptom:**
```
[Sample Cart] ❌ Failed to convert logo file: Error...
```

**Cause:**
- Unsupported file type
- File corrupted
- FileReader API not supported

**Solution:**
1. Check file type matches accept list (AI, PDF, PNG, JPG, etc.)
2. Try different file
3. Check browser compatibility (FileReader API)

#### Issue 3: File Not Appearing in ShopWorks
**Symptom:**
- Order created successfully but no attachment in OnSite

**Cause:**
- File upload to Caspio failed
- ManageOrders didn't process attachment
- OnSite auto-import didn't include file

**Solution:**
1. Check backend logs for Caspio upload errors
2. Verify file was included in API response
3. Check ManageOrders dashboard for file attachment
4. Wait for next OnSite auto-import cycle (hourly)

---

## File Size Limits

| Layer | Limit | Purpose |
|-------|-------|---------|
| **Frontend (Browser)** | No limit | Browser can handle any size |
| **Base64 Encoding** | +33% overhead | File becomes 1.33x larger |
| **Express JSON Parser** | 10 MB | Server request body limit |
| **Caspio Files API** | 20 MB | Maximum file size in Caspio |
| **Recommended Max** | 7.5 MB | Ensures no issues (10MB / 1.33) |

---

## Supported File Types

**Images:**
- PNG (image/png)
- JPG/JPEG (image/jpeg)
- GIF (image/gif)
- SVG (image/svg+xml)
- WebP (image/webp)

**Design Files:**
- AI - Adobe Illustrator (application/postscript, application/illustrator)
- PSD - Photoshop (image/vnd.adobe.photoshop)
- EPS - Encapsulated PostScript (image/x-eps, application/eps)

**Documents:**
- PDF (application/pdf)

---

## API Request Format

### Order Payload with File

```json
{
  "orderNumber": "SAMPLE-1029-5-214",
  "orderDate": "2025-10-29",
  "customer": { ... },
  "billing": { ... },
  "shipping": { ... },
  "lineItems": [ ... ],
  "notes": [ ... ],
  "files": [
    {
      "fileName": "company-logo.png",
      "fileData": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...",
      "category": "artwork",
      "description": "Customer uploaded logo/artwork"
    }
  ]
}
```

### Files Array Structure

Each file object contains:
- **fileName** (string): Original filename (e.g., "logo.png")
- **fileData** (string): Base64 data URL (data:image/png;base64,...)
- **category** (string): File category ("artwork", "document", etc.)
- **description** (string): Human-readable description

---

## Deployment Status

### caspio-pricing-proxy (Backend)
- ✅ **Deployed to Heroku** (develop → main)
- ✅ **Commit:** `eebc030` - "fix: increase JSON body size limit to 10MB"
- ✅ **Change:** `express.json({ limit: '10mb' })`

### Pricing Index File 2025 (Frontend)
- ✅ **Changes committed** (sample-cart.html, sample-order-service.js)
- ⏳ **Awaiting deployment** to production environment

---

## Testing Checklist for Claude Pricing

### ✅ Pre-Deployment Tests (Local)
- [ ] File input appears on form
- [ ] File input accepts correct file types
- [ ] File selection triggers FileReader
- [ ] Base64 conversion completes successfully
- [ ] logoFile object created with correct structure
- [ ] Order payload includes files array

### ✅ Post-Deployment Tests (Production)
- [ ] Upload small file (< 100 KB) - Should work
- [ ] Upload medium file (500 KB - 1 MB) - Should work
- [ ] Upload large file (1-5 MB) - Should work (after backend fix)
- [ ] Upload very large file (> 10 MB) - Should fail gracefully
- [ ] Submit order without file - Should work (optional field)
- [ ] Check console for proper log messages
- [ ] Verify order appears in ShopWorks OnSite
- [ ] Verify file appears as attachment in OnSite

### 🔍 Debug Points

**If order submission fails:**
1. Open browser DevTools (F12)
2. Go to Console tab
3. Look for error messages
4. Check Network tab for API request
5. Verify request body includes `files` array
6. Check response status code (should be 201)

**If file doesn't appear in OnSite:**
1. Check ManageOrders dashboard
2. Verify file upload to Caspio succeeded
3. Check OnSite auto-import logs
4. Wait for next hourly import cycle

---

## Questions for Claude Pricing

1. **Are you seeing the file input on the form?**
   - If NO: Cache issue, hard refresh (Ctrl+Shift+R)

2. **Does the file selection trigger console logs?**
   - If NO: JavaScript not loading, check browser errors

3. **What error message do you see?**
   - "Failed to fetch": File too large OR backend not deployed
   - "File read error": File corrupted or unsupported type
   - Other: Share full error message

4. **What's the file size you're testing with?**
   - < 1 MB: Should work
   - 1-5 MB: Should work (after backend fix)
   - > 10 MB: Will fail (exceeds limit)

---

## Contact

If you encounter any issues during testing:
1. Check this document for troubleshooting steps
2. Review console logs for specific error messages
3. Verify backend deployment status
4. Share error details for further debugging

**Last Updated:** 2025-10-29
**Version:** 1.0.0
**Status:** Deployed to Heroku, awaiting production frontend deployment
