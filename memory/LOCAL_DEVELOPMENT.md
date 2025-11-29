# Local Development Setup

Complete guide for running and testing the Caspio Pricing Proxy locally in WSL (Windows Subsystem for Linux).

## Server Configuration

- **Local Port**: 3002 (dedicated port for caspio-pricing-proxy)
- **Production**: Uses Heroku's assigned port via `process.env.PORT`
- **Architecture**: Routes-based (add new endpoints to `/routes` folder)

## WSL Testing Requirements

When running the server in WSL (Windows Subsystem for Linux), you **cannot** use `localhost` in Postman or browsers on Windows. This is because Windows and WSL have separate network stacks.

### Get Your WSL IP Address

```bash
hostname -I | awk '{print $1}'
```

**Example output**: `172.20.132.206`

### Use WSL IP for All Local Testing

Instead of `http://localhost:3002`, use:

```
http://[YOUR-WSL-IP]:3002/api/order-dashboard
http://[YOUR-WSL-IP]:3002/api/order-odbc
http://[YOUR-WSL-IP]:3002/api/products/search
```

**Example**:
```
http://172.20.132.206:3002/api/order-dashboard
```

**Important**: The WSL IP address changes when Windows restarts, so check it each time!

## Quick Start Testing

### Method 1: Recommended (Helper Script)

```bash
cd /mnt/c/Users/erik/OneDrive\ -\ Northwest\ Custom\ Apparel/2025/caspio-pricing-proxy
node start-test-server.js
```

This helper script will:
- ✅ Force the server to use port 3002 (avoiding port confusion)
- ✅ Display your current WSL IP address
- ✅ Show ready-to-copy Postman URLs
- ✅ Monitor server health
- ✅ Handle graceful shutdown with Ctrl+C

### Method 2: Test Endpoints Script

```bash
node test-endpoints.js
```

This will:
- 🔍 Auto-detect which port the server is actually using
- 🧪 Run health checks on key endpoints
- 📋 Display Postman-ready URLs with your current WSL IP
- ✅ Verify server is working correctly

### Method 3: Quick Health Check

```bash
curl http://localhost:3002/api/health
```

## Running the Server (Manual Method)

```bash
cd /mnt/c/Users/erik/OneDrive\ -\ Northwest\ Custom\ Apparel/2025/caspio-pricing-proxy
PORT=3002 node server.js
```

**Important**: Always explicitly set `PORT=3002` to avoid confusion with other services.

## Common Issues & Solutions

| Issue | Solution |
|-------|----------|
| Server starts on port 3000 instead of 3002 | Use `node start-test-server.js` or set `PORT=3002` explicitly |
| Can't connect from Postman | Check WSL IP with `hostname -I` - it changes on reboot |
| Server won't start | Check if port is in use: `lsof -i :3002` or `netstat -tlnp \| grep 3002` |
| Connection refused errors | Ensure you're using WSL IP, not localhost, from Windows |
| Endpoints return errors | Run `node test-endpoints.js` to diagnose which endpoints are failing |

## Testing Workflow

### 1. Start the Server

```bash
# Navigate to project directory
cd /mnt/c/Users/erik/OneDrive\ -\ Northwest\ Custom\ Apparel/2025/caspio-pricing-proxy

# Start with explicit port
PORT=3002 node server.js
```

**Expected output**:
```
✅ Configuration validated successfully
Port: 3002
Caspio Domain: c3eku948.caspio.com
API Version: v2
✓ Orders routes loaded
✓ Misc routes loaded
✓ Pricing routes loaded
...
========================================
🚀 Caspio Pricing Proxy Server Started
========================================
📡 Port: 3002
🌐 Caspio Domain: c3eku948.caspio.com
```

### 2. Get Your WSL IP

```bash
hostname -I | awk '{print $1}'
```

Copy this IP address (e.g., `172.20.132.206`)

### 3. Test in Postman

Replace `localhost` with your WSL IP in all requests:

```
✅ http://172.20.132.206:3002/api/health
✅ http://172.20.132.206:3002/api/products/search?q=PC54
❌ http://localhost:3002/api/health (won't work from Windows)
```

### 4. Verify Response

**Health Check**:
```bash
curl http://172.20.132.206:3002/api/health
```

**Expected response**:
```json
{
  "status": "healthy",
  "timestamp": "2025-11-29T13:30:00.000Z"
}
```

## Port Management

### Check if Port 3002 is in Use

**Using lsof** (recommended):
```bash
lsof -i :3002
```

**Using netstat**:
```bash
netstat -tlnp | grep 3002
```

### Kill Process on Port 3002

```bash
# Find the process
lsof -i :3002

# Kill it (replace PID with actual process ID)
kill -9 <PID>
```

**Or in one command**:
```bash
kill -9 $(lsof -t -i:3002)
```

## Environment Variables

### Required for Local Development

Create a `.env` file in the project root (if not exists):

```bash
# Caspio API Configuration
CASPIO_ACCOUNT_ID=your_account_id
CASPIO_CLIENT_ID=your_client_id
CASPIO_CLIENT_SECRET=your_client_secret

# Server Configuration
PORT=3002
NODE_ENV=development

# ManageOrders API (optional)
MANAGEORDERS_USERNAME=your_username
MANAGEORDERS_PASSWORD=your_password
```

**Verify environment variables loaded**:
```bash
# In server logs, you should see:
✅ Configuration validated successfully
Port: 3002
Caspio Domain: c3eku948.caspio.com
```

## Testing Specific Endpoints

### Pricing Bundle

```bash
# Get WSL IP
WSL_IP=$(hostname -I | awk '{print $1}')

# Test pricing bundle for DTG method
curl "http://${WSL_IP}:3002/api/pricing-bundle?method=DTG&styleNumber=PC54"
```

### Product Search

```bash
# Search for products
curl "http://${WSL_IP}:3002/api/products/search?q=PC54&limit=5"
```

### Order Dashboard

```bash
# Get 7-day dashboard
curl "http://${WSL_IP}:3002/api/order-dashboard"

# Get 30-day dashboard with details
curl "http://${WSL_IP}:3002/api/order-dashboard?days=30&includeDetails=true"
```

### Admin Metrics

```bash
# Check API usage metrics
curl "http://${WSL_IP}:3002/api/admin/metrics"
```

## Debugging Tips

### Enable Debug Logging

Set environment variable:
```bash
DEBUG=* PORT=3002 node server.js
```

### Watch Server Logs

```bash
# Run server with verbose output
PORT=3002 node server.js | tee server.log
```

### Test with curl -v (verbose)

```bash
# See full request/response
curl -v "http://172.20.132.206:3002/api/health"
```

### Check Caspio API Connectivity

```bash
# Test if server can reach Caspio
curl "http://172.20.132.206:3002/api/pricing-tiers"
```

## Development Workflow

### 1. Make Code Changes

Edit files in your preferred IDE (VSCode, etc.)

### 2. Restart Server

Stop server (Ctrl+C) and restart:
```bash
PORT=3002 node server.js
```

**Or use nodemon for auto-restart**:
```bash
npm install -g nodemon
PORT=3002 nodemon server.js
```

### 3. Test Changes

```bash
# Run endpoint tests
node test-endpoints.js

# Or manually test with curl/Postman
curl "http://$(hostname -I | awk '{print $1}'):3002/api/your-endpoint"
```

### 4. Check Logs

Look for errors in server output:
```
✓ Orders routes loaded
✓ Pricing routes loaded
[API TRACKER] GET Sanmar_Bulk_251816_Feb2024 - Total today: 5
[CACHE MISS] pricing-bundle - DTG PC54
```

## Performance Testing

### Load Testing with curl

```bash
# Sequential requests
for i in {1..10}; do
  curl -s "http://172.20.132.206:3002/api/pricing-bundle?method=DTG&styleNumber=PC54" > /dev/null
  echo "Request $i completed"
done

# Check cache effectiveness
curl "http://172.20.132.206:3002/api/admin/metrics"
```

### Measure Response Time

```bash
# Using curl's timing
curl -w "@curl-format.txt" -o /dev/null -s "http://172.20.132.206:3002/api/products/search?q=PC54"

# curl-format.txt contains:
# time_total: %{time_total}\n
```

## Integration with Postman

### Import Collection

The project auto-generates Postman collections:

1. Open Postman
2. Import → File → Select `docs/NWCA-API.postman_collection.json`
3. Edit collection variables:
   - `baseUrl`: `http://172.20.132.206:3002` (your WSL IP)

### Use Environment Variables

Create Postman environment with:
- `wsl_ip`: Your WSL IP (e.g., `172.20.132.206`)
- `port`: `3002`
- `baseUrl`: `http://{{wsl_ip}}:{{port}}`

Update `wsl_ip` after each Windows reboot!

## Troubleshooting Checklist

Before asking for help, verify:

- [ ] Server is actually running (`ps aux | grep node`)
- [ ] Server is on port 3002 (`lsof -i :3002`)
- [ ] Using WSL IP, not localhost, from Windows
- [ ] WSL IP is current (changes on reboot)
- [ ] Environment variables are loaded (`.env` file exists)
- [ ] No firewall blocking port 3002
- [ ] Caspio credentials are valid

## Next Steps

- See [API Usage Tracking](API_USAGE_TRACKING.md) for monitoring API calls
- See [Endpoint Creation Guide](ENDPOINT_CREATION_GUIDE.md) for adding new endpoints
- See project [CLAUDE.md](../CLAUDE.md) for full documentation index

## Quick Reference Commands

```bash
# Start server
PORT=3002 node server.js

# Get WSL IP
hostname -I | awk '{print $1}'

# Test health
curl "http://$(hostname -I | awk '{print $1}'):3002/api/health"

# Check what's on port 3002
lsof -i :3002

# Kill process on port 3002
kill -9 $(lsof -t -i:3002)

# View metrics
curl "http://$(hostname -I | awk '{print $1}'):3002/api/admin/metrics"
```
