# Auto-Generated Postman Collections

## What Changed?

Your Postman collection is now **auto-generated from Express routes**! No more manual JSON editing.

## Quick Start

### Add or Update an Endpoint

```bash
# 1. Write your route (as usual)
# src/routes/your-file.js
router.get('/new-endpoint', async (req, res) => { ... });

# 2. Run auto-sync
npm run update-postman

# 3. Done! ✅
```

## How It Works

```
Express Routes (src/routes/*.js)
        ↓
   Route Scanner (detects 129 endpoints)
        ↓
   Postman Generator (auto-creates collection)
        ↓
   Intelligent Merger (preserves customizations)
        ↓
   API Sync (updates Postman automatically)
```

## Benefits

**Before:**
- ❌ Manual JSON (50+ lines per endpoint)
- ❌ Risk of drift between code & docs
- ❌ Time-consuming

**After:**
- ✅ Add route → Run sync → Done
- ✅ 129 endpoints auto-detected
- ✅ Zero manual JSON
- ✅ CRUD-like experience

## Results

- **129 endpoints** scanned from code
- **163 total endpoints** (includes manual additions)
- **60 new endpoints** discovered
- **14 categories** auto-organized

## Documentation

See [POSTMAN_SYNC_GUIDE.md](./POSTMAN_SYNC_GUIDE.md) for complete documentation.

## Files Created

| File | Purpose |
|------|---------|
| `scripts/route-scanner.js` | Scans Express routes |
| `scripts/postman-generator.js` | Generates Postman collection |
| `scripts/collection-differ.js` | Intelligent merging |
| `scripts/update-postman-collection.js` | Orchestrates pipeline |

## Example Output

```
🚀 NWCA API - Auto-Generate Postman Collection
============================================================

📝 Step 1: Scanning Express routes...
✅ Scanned 16 route files
📊 Found 129 total endpoints

📝 Step 2: Generating Postman collection...
✅ Generated collection with 129 endpoints

📝 Step 3: Merging with existing collection...
✨ New endpoints: 60
🔄 Updated endpoints: 49
📤 Merged collection: 163 endpoints

📝 Step 4: Syncing with Postman API...
✅ Successfully synced collection with Postman API!
🎉 No manual JSON editing needed!
```

## Credits

Implemented in response to the architectural question: "Wouldn't we want a CRUD?"

**Answer:** Yes! Now you have it. Add/update/remove routes in code, and Postman syncs automatically.
