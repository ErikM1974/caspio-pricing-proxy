# Thread Colors API

**Version**: 1.0.0
**Added**: 2026-01-08
**Purpose**: Thread color lookup for monogram form multi-select dropdown

## Endpoints

### Get All Thread Colors
```
GET /api/thread-colors
```
Returns all 233 thread colors sorted alphabetically.

### Get In-Stock Colors Only
```
GET /api/thread-colors?instock=true
```
Returns only in-stock colors (~160 records).

## Response Format

```json
[
  {
    "Thead_ID": "J5TYTP0H",
    "Thread_Color": "Almond 2479",
    "Thread_Number": 2479,
    "Instock": true
  },
  {
    "Thead_ID": "JT6IDLNG",
    "Thread_Color": "Aquamarine 2307",
    "Thread_Number": 2307,
    "Instock": true
  }
]
```

## Field Descriptions

| Field | Type | Description |
|-------|------|-------------|
| `Thead_ID` | String | Unique identifier |
| `Thread_Color` | String | Display name (e.g., "Midnight Navy 2387") |
| `Thread_Number` | Number | Thread number for ordering |
| `Instock` | Boolean | `true` = in stock, `false` = out of stock |

## Caspio Table

- **Table Name**: `ThreadColors`
- **Yes/No Field**: Uses `1`/`0` for filtering (not `-1` or `'Yes'`)

## Frontend Integration

```javascript
// Fetch in-stock colors for dropdown
const response = await fetch('https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/thread-colors?instock=true');
const colors = await response.json();

// Populate dropdown
colors.forEach(color => {
  // color.Thread_Color = "Midnight Navy 2387" (display)
  // color.Thread_Number = 2387 (value)
});
```

## Route File

`src/routes/thread-colors.js`
