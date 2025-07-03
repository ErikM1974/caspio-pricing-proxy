# Production Schedule API Documentation

## Overview
The Production Schedule API provides real-time access to production availability dates for different decoration methods at Northwest Custom Apparel. This replaces the hard-coded schedule in the staff dashboard with dynamic, API-driven data.

## Table Structure: Production_Schedules

### Primary Fields

| Field Name | Type | Description | Example |
|------------|------|-------------|---------|
| `PK_ID` | Integer | Primary key identifier | 22 |
| `ID_Log` | String | Unique log identifier | "YUAE5SDQ" |
| `Date` | DateTime | When the schedule was updated | "2021-09-01T08:20:36" |
| `Employee` | String | Who updated the schedule | "Ruth" |

### Production Date Fields

| Field Name | Type | Description | Format |
|------------|------|-------------|---------|
| `DTG` | DateTime | Direct-to-Garment availability | "2021-09-10T00:00:00" |
| `Embroidery` | DateTime | Embroidery availability | "2021-09-10T00:00:00" |
| `Cap_Embroidery` | DateTime | Cap embroidery availability | "2021-09-10T00:00:00" |
| `Screenprint` | DateTime | Screen printing availability | "2021-09-10T00:00:00" |
| `Transfers` | DateTime | Transfer printing availability | "2021-09-10T00:00:00" |

### Comment Fields

| Field Name | Type | Description | Example |
|------------|------|-------------|---------|
| `Comment_DTG` | String | DTG-specific notes | "2 weeks out" |
| `Comment_Emb` | String | Embroidery notes | "I can take rush orders" |
| `Comment_Cap` | String | Cap embroidery notes | "I can take any order right now" |
| `Comment_SP` | String | Screen print notes | "3 weeks out" |
| `Comment_Transfers` | String | Transfer notes | "" |

### Additional Fields

| Field Name | Type | Description | Current Usage |
|------------|------|-------------|---------------|
| `ProductionDaysInHouse` | Integer/Null | Days for in-house production | null (not used) |
| `Current_Turnaround` | String/Null | Current turnaround time | null (not used) |
| `DTG_Sneak_In` | String/Null | Rush DTG availability | null (not used) |
| `Drop_Dead_Big_Order_Status` | String | Status for large orders | "" (empty) |

## API Endpoint Structure

### Base URL
```
https://c3eku948.caspio.com/integrations/rest/v3
```

### Get Latest Production Schedule
```
GET /tables/Production_Schedules/records?q.orderBy=Date%20DESC&q.limit=1
```

### Get Production Schedules (with limit)
```
GET /tables/Production_Schedules/records?q.limit=8
```

### Authentication
```
Authorization: Bearer [ACCESS_TOKEN]
```

## Recommended Implementation Strategy

### 1. Frontend Architecture

```javascript
// Production Schedule Service
class ProductionScheduleService {
    constructor() {
        this.baseURL = 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api';
        this.cacheKey = 'production_schedule_cache';
        this.cacheExpiry = 60 * 60 * 1000; // 1 hour cache
    }

    async getLatestSchedule() {
        // Check cache first
        const cached = this.getCachedSchedule();
        if (cached) return cached;

        try {
            const response = await fetch(`${this.baseURL}/production-schedule/latest`);
            const data = await response.json();
            
            // Cache the response
            this.cacheSchedule(data);
            
            return this.formatScheduleData(data);
        } catch (error) {
            console.error('Failed to fetch production schedule:', error);
            return this.getFallbackSchedule();
        }
    }

    formatScheduleData(rawData) {
        const schedule = rawData.Result[0];
        
        return {
            lastUpdated: schedule.Date,
            updatedBy: schedule.Employee,
            production: [
                {
                    method: 'DTG',
                    date: schedule.DTG,
                    comment: schedule.Comment_DTG,
                    isRush: schedule.Comment_DTG?.toLowerCase().includes('rush')
                },
                {
                    method: 'DTG Rush',
                    date: schedule.DTG_Sneak_In || this.calculateRushDate(schedule.DTG),
                    isRush: true
                },
                {
                    method: 'Embroidery',
                    date: schedule.Embroidery,
                    comment: schedule.Comment_Emb
                },
                {
                    method: 'Caps',
                    date: schedule.Cap_Embroidery,
                    comment: schedule.Comment_Cap
                },
                {
                    method: 'Screen Print',
                    date: schedule.Screenprint,
                    comment: schedule.Comment_SP
                },
                {
                    method: 'Transfers',
                    date: schedule.Transfers,
                    comment: schedule.Comment_Transfers
                }
            ],
            capacity: this.extractCapacityInfo(schedule)
        };
    }

    calculateRushDate(standardDate) {
        // Rush is typically 1 week before standard
        const date = new Date(standardDate);
        date.setDate(date.getDate() - 7);
        return date.toISOString();
    }

    extractCapacityInfo(schedule) {
        // Extract capacity from comments or use defaults
        const dtgComment = schedule.Comment_DTG || '';
        const capacity = dtgComment.match(/(\d+)-(\d+)\s*Prints/);
        
        return {
            min: capacity ? parseInt(capacity[1]) : 100,
            max: capacity ? parseInt(capacity[2]) : 200,
            rushAvailable: true,
            notes: 'Ask for rushes'
        };
    }
}
```

### 2. Dashboard Integration

```javascript
// In staff-dashboard.html
async function updateProductionSchedule() {
    const scheduleService = new ProductionScheduleService();
    const schedule = await scheduleService.getLatestSchedule();
    
    // Update the production widget
    const container = document.querySelector('.production-list');
    container.innerHTML = '';
    
    schedule.production.forEach(item => {
        const element = createProductionItem(item);
        container.appendChild(element);
    });
    
    // Update capacity status
    updateCapacityStatus(schedule.capacity);
    
    // Update last updated time
    updateLastUpdatedTime(schedule.lastUpdated, schedule.updatedBy);
}

function createProductionItem(item) {
    const div = document.createElement('div');
    div.className = `production-item ${item.isRush ? 'rush' : ''}`;
    
    div.innerHTML = `
        <span class="production-method">${item.method}</span>
        <span class="production-date">${formatAvailabilityDate(item.date)}</span>
    `;
    
    if (item.comment) {
        div.title = item.comment;
    }
    
    return div;
}

function formatAvailabilityDate(dateString) {
    const date = new Date(dateString);
    const today = new Date();
    const daysUntil = Math.ceil((date - today) / (1000 * 60 * 60 * 24));
    
    if (daysUntil <= 0) {
        return 'Available Now';
    } else if (daysUntil === 1) {
        return 'Available Tomorrow';
    } else if (daysUntil <= 7) {
        return `Available in ${daysUntil} days`;
    } else {
        return `Available ${date.toLocaleDateString('en-US', { 
            month: 'short', 
            day: 'numeric' 
        })}`;
    }
}
```

### 3. Backend Proxy Endpoint

The production schedules endpoint has been implemented in the caspio-pricing-proxy server:

#### Endpoint: GET /api/production-schedules

**Description**: Retrieves production schedule records from the Production_Schedules table.

**Query Parameters**:
- `q.where` - Filter records using SQL-like conditions (e.g., `Date>'2021-08-01'`, `Employee='ruth'`)
- `q.orderBy` - Sort results by field(s) (e.g., `Date DESC`, `PK_ID ASC`)
- `q.limit` - Maximum number of records to return (default: 100, max: 1000)

**Examples**:

```bash
# Get all production schedules (limited to 100)
GET /api/production-schedules

# Get latest 5 schedules
GET /api/production-schedules?q.orderBy=Date DESC&q.limit=5

# Get schedules after a specific date
GET /api/production-schedules?q.where=Date>'2021-08-20'&q.orderBy=Date ASC

# Get schedules by specific employee
GET /api/production-schedules?q.where=Employee='Ruth'&q.limit=10

# Complex query with multiple conditions
GET /api/production-schedules?q.where=Date>'2021-08-01' AND Employee='Ruth'&q.orderBy=Date DESC&q.limit=20
```

**Response Format**:
Returns an array of production schedule records:

```json
[
  {
    "PK_ID": 22,
    "ID_Log": "YUAE5SDQ",
    "Date": "2021-09-01T08:20:36",
    "ProductionDaysInHouse": null,
    "Current_Turnaround": null,
    "Employee": "Ruth",
    "DTG": "2021-09-10T00:00:00",
    "Embroidery": "2021-09-10T00:00:00",
    "Cap_Embroidery": "2021-09-10T00:00:00",
    "Screenprint": "2021-09-10T00:00:00",
    "Transfers": "2021-09-10T00:00:00",
    "Comment_DTG": "2 weeks out",
    "Comment_Emb": "",
    "Comment_Cap": "",
    "Comment_SP": "3 weeks out",
    "Comment_Transfers": "",
    "DTG_Sneak_In": null,
    "Drop_Dead_Big_Order_Status": ""
  }
]
```

**Error Responses**:
- `400 Bad Request` - Invalid query parameters (e.g., limit > 1000 or negative)
- `500 Internal Server Error` - Failed to fetch from Caspio API

**Implementation Notes**:
- Uses Caspio API v2 for consistency with other endpoints
- Handles pagination automatically via `fetchAllCaspioPages`
- Public endpoint with no authentication required
- Returns array directly without Caspio's "Result" wrapper

#### Helper Function: Get Latest Schedule

To get only the most recent production schedule:

```javascript
// Frontend example
async function getLatestProductionSchedule() {
    const response = await fetch('/api/production-schedules?q.orderBy=Date DESC&q.limit=1');
    const schedules = await response.json();
    return schedules[0]; // Most recent schedule
}
```

## Data Flow

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│ Staff Dashboard │────▶│  Proxy Server   │────▶│   Caspio API    │
│                 │◀────│                 │◀────│                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
        │                        │
        ▼                        ▼
┌─────────────────┐     ┌─────────────────┐
│   Local Cache   │     │  Server Cache   │
└─────────────────┘     └─────────────────┘
```

## Features to Implement

### 1. Real-time Updates
- Poll API every hour for updates
- Show "Last updated" timestamp
- Visual indicator when data is fresh vs cached

### 2. Rush Order Logic
- If no `DTG_Sneak_In` date, calculate as DTG date minus 7 days
- Highlight rush options with different styling
- Show rush availability in comments

### 3. Capacity Indicators
- Parse capacity from comments
- Show visual capacity meter
- Alert when approaching capacity limits

### 4. Smart Date Display
- "Available Now" for past/today dates
- "Available Tomorrow" for next day
- "Available in X days" for within a week
- "Available Month DD" for future dates

### 5. Error Handling
- Fallback to last known good data
- Show connection error message
- Retry mechanism with exponential backoff

## Sample Response Transformation

### API Response:
```json
{
  "PK_ID": 22,
  "Date": "2021-09-01T08:20:36",
  "Employee": "Ruth",
  "DTG": "2021-09-10T00:00:00",
  "Comment_DTG": "2 weeks out",
  ...
}
```

### Transformed for UI:
```json
{
  "lastUpdated": "September 1, 2021",
  "updatedBy": "Ruth",
  "production": [
    {
      "method": "DTG",
      "displayDate": "Available Sept 10",
      "daysOut": 9,
      "isRush": false,
      "tooltip": "2 weeks out"
    }
  ],
  "capacity": {
    "current": "100-200 Prints",
    "rushAvailable": true
  }
}
```

## Migration Plan

1. **Phase 1**: Create proxy endpoint and test API access
2. **Phase 2**: Build ProductionScheduleService class
3. **Phase 3**: Update dashboard to use API data with fallback
4. **Phase 4**: Remove hard-coded dates
5. **Phase 5**: Add caching and error handling
6. **Phase 6**: Implement real-time updates

## Benefits

- **Always Current**: Production dates update automatically
- **Reduced Maintenance**: No manual HTML updates needed
- **Better UX**: Shows days until availability
- **Scalable**: Easy to add new production methods
- **Reliable**: Caching prevents API failures from breaking the dashboard