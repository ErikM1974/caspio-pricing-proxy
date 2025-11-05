# Image Loading Troubleshooting Guide

**Purpose:** Diagnose slow product image loading and identify whether the issue is with our API or Sanmar's CDN.

---

## 🔍 How Image Loading Works

### The 3-Step Process:

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Frontend → Our API                                       │
│    Request: GET /api/products/search                        │
│    Response: JSON with image URLs (text, not actual images) │
│    Speed: ~1 second (optimized Nov 2025)                    │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ 2. Our API Response Contains URLs:                          │
│    {                                                         │
│      "images": {                                            │
│        "main": "https://cdnm.sanmar.com/.../PC54.jpg",     │
│        "thumbnail": "https://cdnm.sanmar.com/.../PC54TN.jpg"│
│      }                                                       │
│    }                                                         │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ 3. Browser → Sanmar CDN                                     │
│    Request: GET https://cdnm.sanmar.com/.../PC54.jpg        │
│    Response: Actual image file                              │
│    Speed: ~100-300ms (when working normally)                │
└─────────────────────────────────────────────────────────────┘
```

**Key Points:**
- ✅ **Caspio tables** store image URLs as text (not the actual images)
- ✅ **Our API** returns those URLs in JSON responses
- ❌ **Sanmar CDN** (`cdnm.sanmar.com`) hosts the actual image files
- ⚠️ **We cannot control** Sanmar's CDN performance

---

## 🚨 Identifying the Problem

### Scenario A: **Our API is Slow** (We Can Fix)

**Symptoms:**
- Page takes 5-30 seconds before anything appears
- JSON response is delayed
- All API endpoints are slow

**Timeline:**
```
[0s]    → Request to caspio-pricing-proxy.herokuapp.com/api/products/search
[20s]   ← Response with JSON (slow!)
[20.1s] → Browser starts loading images
[20.5s] ← Images load quickly
```

**How to Verify:**
1. Open DevTools → Network tab
2. Look for requests to `caspio-pricing-proxy.herokuapp.com`
3. Check "Time" column - if >5 seconds, API is slow

**Solution:** Contact us - API needs optimization

---

### Scenario B: **Sanmar CDN is Slow** (We Cannot Fix)

**Symptoms:**
- API responds quickly (~1 second)
- Product data appears immediately
- Images take 20-30+ seconds to load or fail entirely

**Timeline:**
```
[0s]    → Request to caspio-pricing-proxy.herokuapp.com/api/products/search
[1s]    ← Response with JSON (fast!)
[1.1s]  → Browser starts loading images from cdnm.sanmar.com
[31s]   ← Images finally load (or timeout)
```

**How to Verify:**
1. Open DevTools → Network tab
2. Look for requests to `cdnm.sanmar.com`
3. Check "Time" column - if >5 seconds, Sanmar CDN is slow

**Solution:** Wait for Sanmar to fix their CDN - we cannot control this

---

## 🛠️ Diagnostic Steps

### Step 1: Open Browser DevTools

**Chrome/Edge:**
- Press `F12` or `Ctrl+Shift+I` (Windows)
- Press `Cmd+Option+I` (Mac)

**Firefox:**
- Press `F12` or `Ctrl+Shift+I`

### Step 2: Clear Cache & Reload

1. Go to DevTools → **Network** tab
2. Check "Disable cache" checkbox
3. Right-click refresh button → "Empty Cache and Hard Reload"
4. Or press `Ctrl+Shift+Delete` → Clear cache

### Step 3: Analyze Request Timing

**Look at the Waterfall column:**

**Good Performance:**
```
caspio-pricing-proxy.herokuapp.com/api/products/search  [1s]     ✅
cdnm.sanmar.com/catalog/images/PC54.jpg                 [0.3s]   ✅
cdnm.sanmar.com/imglib/mresjpg/.../model_front.jpg      [0.2s]   ✅
```

**API Problem:**
```
caspio-pricing-proxy.herokuapp.com/api/products/search  [20s]    ❌ OUR ISSUE
cdnm.sanmar.com/catalog/images/PC54.jpg                 [0.3s]   ✅
```

**CDN Problem:**
```
caspio-pricing-proxy.herokuapp.com/api/products/search  [1s]     ✅
cdnm.sanmar.com/catalog/images/PC54.jpg                 [30s]    ❌ SANMAR ISSUE
cdnm.sanmar.com/imglib/mresjpg/.../model_front.jpg      [timeout] ❌ SANMAR ISSUE
```

### Step 4: Quick CDN Test

**Test Sanmar's CDN directly** by opening these URLs in a new browser tab:

```
https://cdnm.sanmar.com/catalog/images/PC54.jpg
https://cdnm.sanmar.com/catalog/images/DT105.jpg
https://cdnm.sanmar.com/imglib/mresjpg/2021/f11/PC54_model_front.jpg
```

**Expected Results:**
- ✅ **Normal:** Images load in 100-500ms
- ❌ **CDN Issue:** Images timeout, take 20+ seconds, or return errors

---

## 📊 Performance Baselines

### Normal Performance (What to Expect)

| Metric | Expected Time | Notes |
|--------|--------------|-------|
| API Response | 500ms - 2s | `/api/products/search` endpoint |
| Simple Query | 500ms - 1s | Searching for specific style (e.g., "PC54") |
| Category Query | 2s - 5s | Large categories (e.g., "T-Shirts") |
| Image Load (Each) | 100ms - 500ms | From Sanmar CDN (`cdnm.sanmar.com`) |
| Total Page Load | 1s - 3s | API + images (first load) |
| Cached Page Load | <500ms | Subsequent loads with browser cache |

### Red Flags (Performance Issues)

| Metric | Problem Threshold | Likely Cause |
|--------|------------------|--------------|
| API Response | >10 seconds | API issue - contact us |
| Image Load | >5 seconds per image | Sanmar CDN issue |
| Image Load | Timeouts or 404s | Sanmar CDN down or broken URLs |
| Total Page Load | >15 seconds | Check both API and CDN |

---

## 📈 Optimization History

### November 2025: API Performance Optimization (v170)

**Problem Identified:**
- `/api/products/search` was fetching 50,000-100,000+ records for every search
- Loading entire product catalog into memory before filtering/pagination
- Response times: 4-10 seconds (sometimes 30s timeouts)

**Solution Implemented:**
- Two-phase database pagination strategy
- Phase 1: Fetch unique styles with filters at database level (lightweight)
- Phase 2: Fetch full variants only for styles on current page
- Reduces data fetched by 90-99%

**Results:**
- **PC54 search:** 9.5s → 1.0s (89% faster)
- **Memory usage:** 200MB → 2MB per request (99% reduction)
- **Timeout errors:** Eliminated completely
- **Production deployment:** Heroku v170 (Nov 4, 2025)

**Impact:**
When Sanmar's CDN is working normally:
- **Before:** 9.5s (API) + 0.3s (images) = ~10 seconds total
- **After:** 1.0s (API) + 0.3s (images) = ~1.3 seconds total

---

## 🔧 Advanced Diagnostics

### Using Browser Console

**Test 1: Check API Response Times**
```javascript
performance.getEntriesByType('resource')
  .filter(r => r.name.includes('caspio-pricing-proxy'))
  .map(r => ({
    endpoint: r.name.split('?')[0].split('/').slice(-2).join('/'),
    duration: Math.round(r.duration) + 'ms',
    size: Math.round(r.transferSize / 1024) + 'KB'
  }))
```

**Test 2: Check Sanmar CDN Performance**
```javascript
performance.getEntriesByType('resource')
  .filter(r => r.name.includes('cdnm.sanmar.com'))
  .slice(0, 10) // First 10 images
  .map(r => ({
    file: r.name.split('/').pop(),
    duration: Math.round(r.duration) + 'ms',
    status: r.responseStatus || 'pending'
  }))
```

**Test 3: Identify Slowest Resources**
```javascript
performance.getEntriesByType('resource')
  .sort((a, b) => b.duration - a.duration)
  .slice(0, 10)
  .map(r => ({
    url: r.name.split('/').slice(-2).join('/'),
    duration: Math.round(r.duration) + 'ms'
  }))
```

---

## 🚦 Quick Reference: Decision Tree

```
Is the site loading slowly?
│
├─ YES → Open DevTools → Network Tab
│         │
│         ├─ API requests (caspio-pricing-proxy) taking >5s?
│         │  │
│         │  ├─ YES → OUR API ISSUE
│         │  │        Contact us for optimization
│         │  │
│         │  └─ NO → Images (cdnm.sanmar.com) taking >5s?
│         │           │
│         │           ├─ YES → SANMAR CDN ISSUE
│         │           │        Test: Open image URLs directly
│         │           │        Wait for Sanmar to fix
│         │           │
│         │           └─ NO → Other issue
│         │                    Check network, browser, etc.
│
└─ NO → Everything working normally!
          API: ~1s, Images: ~300ms
```

---

## 📞 When to Contact Support

**Contact us if:**
- ✅ API responses (`caspio-pricing-proxy`) consistently take >5 seconds
- ✅ Getting timeout errors (H12) on our API
- ✅ API returning errors (500, 400, etc.)
- ✅ Data is incorrect or missing

**Don't contact us if:**
- ❌ Only images (`cdnm.sanmar.com`) are slow
- ❌ Sanmar's website is also slow
- ❌ Image URLs return 404 or timeout (Sanmar's issue)

**To help us debug:**
1. Take screenshot of DevTools → Network tab showing slow requests
2. Note the specific endpoint URL that's slow
3. Provide timestamp when issue occurred
4. Share browser console errors (if any)

---

## 🔗 Related Documentation

- [API Documentation](API_DOCUMENTATION.md) - Complete endpoint reference
- [Developer Guide](DEVELOPER_GUIDE.md) - Integration best practices
- [API Changelog](API_CHANGELOG.md) - Recent changes and optimizations

---

## 📝 Known Issues & Solutions

### Issue: Browser Cached Old Slow Responses

**Symptoms:** After API optimization, still seeing slow performance

**Solution:**
1. Hard refresh: `Ctrl+Shift+R` (Windows) or `Cmd+Shift+R` (Mac)
2. Clear browser cache completely
3. Disable cache in DevTools during testing

### Issue: Too Many Concurrent Image Requests

**Symptoms:** Some images load, others are "stalled"

**Cause:** Browsers limit concurrent requests to same domain (usually 6-8)

**Solution:**
- This is normal browser behavior
- Images will load in batches
- Consider lazy loading for large product grids

### Issue: Sanmar CDN Regional Issues

**Symptoms:** Images load slowly for some users but not others

**Cause:** Sanmar's CDN may have regional performance variations

**Solution:**
- Not under our control
- Report to Sanmar if persistent for specific regions

---

**Last Updated:** November 2025
**Heroku Release:** v170
**API Version:** 1.4.0
