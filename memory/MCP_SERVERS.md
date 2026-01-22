# MCP Servers for Claude Desktop

**Version**: 1.1.0
**Created**: 2026-01-22
**Updated**: 2026-01-22
**Purpose**: Enable Claude Desktop to interact with NWCA APIs via tools

---

## What is MCP?

MCP (Model Context Protocol) allows Claude Desktop to call external tools. Instead of just chatting, Claude can actually execute actions like querying databases, updating records, or running audits.

---

## Configuration File Location

```
C:\Users\erik\AppData\Roaming\Claude\claude_desktop_config.json
```

**Important:** Restart Claude Desktop after any config changes.

---

## Current MCP Servers

### 1. nwca-accounts (LOCAL DEV)

**Purpose:** Manage Taneisha, Nika, and House customer account lists

**Location:** `caspio-pricing-proxy/mcp-server/index.js`

**Rep Account Tools:**

| Tool | Description |
|------|-------------|
| `list_accounts` | List accounts with filters (tier, at-risk, unclassified, search, etc.) |
| `get_account` | Get full details for a single customer |
| `update_crm` | Log calls, set follow-ups, update contact status |
| `update_account` | Update any field (tier, at-risk, company name, etc.) |
| `move_account` | Move customer from one rep's list to another |
| `reconcile_accounts` | Find customers with orders not in rep's list |
| `sync_sales` | Update YTD sales from ManageOrders |
| `rep_audit` | Check for account/order mismatches (includes House check) |
| `create_account` | Add customer to rep's list |
| `delete_account` | Remove customer from rep's list |

**House Account Tools:**

| Tool | Description |
|------|-------------|
| `list_house_accounts` | List house accounts with filters (assignee, reviewed, search) |
| `get_house_account` | Get details for a single house account |
| `add_house_account` | Add customer to house accounts |
| `update_house_account` | Update house account (assignee, notes, reviewed) |
| `delete_house_account` | Remove customer from house accounts |
| `move_to_house` | Move customer from rep's list to house accounts |
| `house_stats` | Get house account statistics by assignee |

**Example prompts - Rep Accounts:**
- "Show me Taneisha's at-risk accounts"
- "Show me Nika's unclassified accounts" (accounts with no tier)
- "Run the rep audit for 2026"
- "Find missing customers for Nika"
- "Log a call for customer 12345 - left voicemail"
- "What's Nika's YTD total?"
- "Change customer 12345 to GOLD tier"
- "Move customer 12345 from Nika's list to Taneisha's list"
- "Mark customer 12345 as at-risk"

**Example prompts - House Accounts:**
- "Show me all house accounts assigned to Ruthie"
- "Show unreviewed house accounts"
- "Add customer 12345 to house accounts, assigned to Erik"
- "Move customer 12345 from Nika's list to house accounts, assigned to Web"
- "Mark house account 12345 as reviewed"
- "Show me house account statistics"
- "Who has the most house accounts?"

---

### 2. Zapier (CUSTOM/REMOTE)

**Purpose:** Connect to Zapier automations

**URL:** `https://mcp.zapier.com/api/mcp/a/253710/mcp`

**Use cases:**
- Trigger Zaps from Claude
- Automate workflows across apps
- Connect to 5000+ apps via Zapier

---

### 3. Claude in Chrome (INCLUDED)

**Purpose:** Built-in browser integration

**Status:** Included by default with Claude Desktop

---

### 4. mcp-registry (LOCAL DEV)

**Purpose:** Registry of available MCP servers

**Status:** Local development server

---

### 5. Jotform (REMOTE)

**Purpose:** Form integrations

**Status:** Currently disconnected

---

## Current Config File

```json
{
  "mcpServers": {
    "nwca-accounts": {
      "command": "node",
      "args": ["C:/Users/erik/OneDrive - Northwest Custom Apparel/2025/caspio-pricing-proxy/mcp-server/index.js"]
    }
  }
}
```

---

## How to Add a New MCP Server

### Step 1: Create the Server

MCP servers can be written in Node.js, Python, or other languages. The server communicates via stdio (standard input/output).

**Node.js example structure:**
```javascript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new Server({ name: "my-server", version: "1.0.0" }, {
  capabilities: { tools: {} }
});

// Define tools with ListToolsRequestSchema
// Handle calls with CallToolRequestSchema

const transport = new StdioServerTransport();
await server.connect(transport);
```

### Step 2: Add to Config

Edit `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "nwca-accounts": {
      "command": "node",
      "args": ["C:/path/to/mcp-server/index.js"]
    },
    "new-server": {
      "command": "node",
      "args": ["C:/path/to/new-server/index.js"]
    }
  }
}
```

### Step 3: Restart Claude Desktop

Close completely (check system tray) and reopen.

### Step 4: Verify

Look for the 🔨 hammer icon. Click it to see available tools.

---

## How to Remove an MCP Server

1. Edit `claude_desktop_config.json`
2. Delete the server's entry from `mcpServers`
3. Restart Claude Desktop

---

## Troubleshooting

### Tools not showing up?

1. **Check Node.js:** Run `node --version` in Command Prompt
2. **Check path:** Make sure the path in config matches exactly
3. **Check JSON syntax:** No trailing commas, proper quotes
4. **Check logs:** Look in `%APPDATA%\Claude\logs\` for errors

### Server crashes?

Test the server manually:
```bash
cd C:\Users\erik\OneDrive - Northwest Custom Apparel\2025\caspio-pricing-proxy\mcp-server
node index.js
```

If it exits immediately without error, that's normal (it's waiting for stdio input).

### API errors?

The MCP server calls the Heroku API. Check:
- Is the Heroku app running?
- Test endpoint directly: `curl https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/taneisha-accounts?search=test`

---

## Common MCP Server Types

| Type | Command | Args Example |
|------|---------|--------------|
| Local Node.js | `node` | `["C:/path/to/index.js"]` |
| Local Python | `python` | `["C:/path/to/server.py"]` |
| NPX package | `npx` | `["-y", "@anthropic/mcp-server-filesystem"]` |
| UV (Python) | `uvx` | `["mcp-server-sqlite", "--db-path", "test.db"]` |

---

## Ideas for Future MCP Servers

| Server | Purpose |
|--------|---------|
| `nwca-orders` | Query ManageOrders, create orders |
| `nwca-pricing` | Look up pricing, calculate quotes |
| `nwca-inventory` | Check SanMar/supplier inventory |
| `nwca-production` | View/update production schedules |

---

## Files

| File | Purpose |
|------|---------|
| `mcp-server/package.json` | Node.js package definition |
| `mcp-server/index.js` | MCP server implementation |
| `claude_desktop_config.json` | Claude Desktop configuration |

---

## See Also

- [Rep Account Management](REP_ACCOUNT_MANAGEMENT.md) - Backend API documentation
- [Taneisha Accounts API](TANEISHA_ACCOUNTS_API.md) - Endpoint details
- [Nika Accounts API](NIKA_ACCOUNTS_API.md) - Endpoint details
- [House Accounts API](HOUSE_ACCOUNTS_API.md) - House accounts endpoint details
- [MCP Documentation](https://modelcontextprotocol.io/) - Official MCP docs
