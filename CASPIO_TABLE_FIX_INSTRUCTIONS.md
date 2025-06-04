# Caspio Table Fix Instructions - Quote_Analytics

## Problem Identified

Your `Quote_Analytics` table has **TWO autonumber fields**, which is causing the POST API endpoint to fail with 500 errors:

1. `AnalyticsID` (Autonumber) ← **THIS IS THE PROBLEM**
2. `PK_ID` (Autonumber) ← This one is fine, it's your primary key

## Solution: Remove the AnalyticsID Autonumber Field

### Step-by-Step Instructions:

1. **Go to your Caspio account**
2. **Navigate to**: Tables → Quote_Analytics → Table design
3. **Find the `AnalyticsID` row** (first row in your table)
4. **Click the red "Delete" button** for the AnalyticsID field
5. **Save the table design**

### Why This Fixes the Problem:

- **Caspio best practice**: Only ONE autonumber field per table
- **Multiple autonumbers cause conflicts** during record insertion
- **Your server code** already uses `PK_ID` as the primary identifier
- **You don't need AnalyticsID** - `PK_ID` serves the same purpose

### After Making the Change:

Your table structure will look like this:

| Field Name     | DataType    | Notes                    |
|----------------|-------------|--------------------------|
| ~~AnalyticsID~~| ~~Autonumber~~ | **DELETE THIS FIELD** |
| SessionID      | Text (255)  | Keep as-is               |
| QuoteID        | Text (255)  | Keep as-is               |
| EventType      | Text (255)  | Keep as-is               |
| StyleNumber    | Text (255)  | Keep as-is               |
| Color          | Text (255)  | Keep as-is               |
| PrintLocation  | Text (255)  | Keep as-is               |
| Quantity       | Integer     | Keep as-is               |
| HasLTM         | Text (255)  | Keep as-is               |
| PriceShown     | Number      | Keep as-is               |
| UserAgent      | Text (255)  | Keep as-is               |
| IPAddress      | Text (255)  | Keep as-is               |
| Timestamp      | Date/Time   | Keep as-is               |
| NoName         | Text (255)  | Keep as-is               |

### Test After Making Changes:

Run this command to verify the fix worked:

```bash
node test-heroku-quote-diagnostic.js
```

You should see:
- ✅ Quote Analytics POST operations working
- ✅ All CRUD operations functional

## Alternative Solution (Not Recommended):

If you absolutely must keep the `AnalyticsID` field:

1. **Change `AnalyticsID` DataType** from "Autonumber" to "Integer"
2. **Uncheck the "Unique" checkbox** for AnalyticsID
3. **Update server code** to manually generate AnalyticsID values

**But we recommend deletion** - it's cleaner and follows Caspio best practices.

## Expected Results:

After removing the `AnalyticsID` autonumber field:

- ✅ POST /api/quote_analytics will work
- ✅ All existing data remains intact
- ✅ PK_ID continues to serve as the unique identifier
- ✅ Your API will be fully functional

The fix is simple but critical for proper API functionality.
