#!/usr/bin/env node

/**
 * NWCA Rep Account Management MCP Server
 *
 * Enables Claude Desktop to interact with Taneisha and Nika's account lists.
 *
 * Tools available:
 * - list_accounts: List accounts with filters (tier, at-risk, etc.)
 * - get_account: Get single account details
 * - update_crm: Log contact, set follow-up dates
 * - reconcile_accounts: Find missing customers
 * - sync_sales: Update YTD sales from ManageOrders
 * - rep_audit: Check for account/order mismatches
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const API_BASE = "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com";

// Helper to make API calls
async function apiCall(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  return response.json();
}

// Create server
const server = new Server(
  {
    name: "nwca-accounts",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Define available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "list_accounts",
        description: "List accounts for a sales rep with optional filters. Can filter by tier, at-risk status, contact status, product preferences, and more.",
        inputSchema: {
          type: "object",
          properties: {
            rep: {
              type: "string",
              enum: ["taneisha", "nika"],
              description: "Which sales rep's accounts to list"
            },
            accountTier: {
              type: "string",
              description: "Filter by tier (e.g., 'GOLD \\'26-TANEISHA', 'SILVER \\'26-NIKA')"
            },
            priorityTier: {
              type: "string",
              description: "Filter by priority (A, B, C, D, E)"
            },
            unclassified: {
              type: "integer",
              enum: [0, 1],
              description: "Filter accounts with NO tier assigned (1 = unclassified/blank tier)"
            },
            atRisk: {
              type: "integer",
              enum: [0, 1],
              description: "Filter at-risk accounts (1 = at risk)"
            },
            overdueForOrder: {
              type: "integer",
              enum: [0, 1],
              description: "Filter accounts overdue for orders (1 = overdue)"
            },
            contactStatus: {
              type: "string",
              description: "Filter by contact status (Called, Emailed, Left Voicemail, No Response, Won Back, Not Interested)"
            },
            search: {
              type: "string",
              description: "Search company name"
            },
            orderBy: {
              type: "string",
              description: "Field to sort by (default: CompanyName)"
            },
            orderDir: {
              type: "string",
              enum: ["ASC", "DESC"],
              description: "Sort direction"
            }
          },
          required: ["rep"]
        }
      },
      {
        name: "get_account",
        description: "Get detailed information for a single customer account",
        inputSchema: {
          type: "object",
          properties: {
            rep: {
              type: "string",
              enum: ["taneisha", "nika"],
              description: "Which sales rep's account list to check"
            },
            customerId: {
              type: "integer",
              description: "The customer ID (ID_Customer from ShopWorks)"
            }
          },
          required: ["rep", "customerId"]
        }
      },
      {
        name: "update_crm",
        description: "Update CRM fields for an account - log calls, set follow-ups, update contact status",
        inputSchema: {
          type: "object",
          properties: {
            rep: {
              type: "string",
              enum: ["taneisha", "nika"],
              description: "Which sales rep's account to update"
            },
            customerId: {
              type: "integer",
              description: "The customer ID"
            },
            Last_Contact_Date: {
              type: "string",
              description: "Date of contact (YYYY-MM-DD)"
            },
            Contact_Status: {
              type: "string",
              enum: ["Called", "Emailed", "Left Voicemail", "No Response", "Won Back", "Not Interested"],
              description: "Status of the contact attempt"
            },
            Contact_Notes: {
              type: "string",
              description: "Notes about the contact"
            },
            Next_Follow_Up: {
              type: "string",
              description: "Next follow-up date (YYYY-MM-DD)"
            },
            Follow_Up_Type: {
              type: "string",
              enum: ["Call", "Email", "Visit", "Quote"],
              description: "Type of follow-up needed"
            },
            Won_Back_Date: {
              type: "string",
              description: "Date account was won back (YYYY-MM-DD)"
            }
          },
          required: ["rep", "customerId"]
        }
      },
      {
        name: "reconcile_accounts",
        description: "Find customers with orders but not in the rep's account list. Can auto-add missing customers.",
        inputSchema: {
          type: "object",
          properties: {
            rep: {
              type: "string",
              enum: ["taneisha", "nika"],
              description: "Which sales rep to reconcile"
            },
            autoAdd: {
              type: "boolean",
              description: "Set to true to automatically add missing customers to the list"
            }
          },
          required: ["rep"]
        }
      },
      {
        name: "sync_sales",
        description: "Sync YTD sales data from ManageOrders. Updates sales totals and order counts for all accounts.",
        inputSchema: {
          type: "object",
          properties: {
            rep: {
              type: "string",
              enum: ["taneisha", "nika"],
              description: "Which sales rep's accounts to sync"
            }
          },
          required: ["rep"]
        }
      },
      {
        name: "rep_audit",
        description: "Run audit to find orders where rep doesn't match account assignment. Detects mismatches and unassigned customers.",
        inputSchema: {
          type: "object",
          properties: {
            year: {
              type: "integer",
              description: "Year to audit (default: current year)"
            },
            summaryOnly: {
              type: "boolean",
              description: "Set to true for quick counts only, false for full details"
            }
          }
        }
      },
      {
        name: "create_account",
        description: "Add a new customer to a rep's account list",
        inputSchema: {
          type: "object",
          properties: {
            rep: {
              type: "string",
              enum: ["taneisha", "nika"],
              description: "Which sales rep's list to add to"
            },
            ID_Customer: {
              type: "integer",
              description: "ShopWorks customer ID"
            },
            CompanyName: {
              type: "string",
              description: "Company/account name"
            },
            Account_Tier: {
              type: "string",
              description: "Account tier (e.g., 'GOLD \\'26-TANEISHA')"
            }
          },
          required: ["rep", "ID_Customer", "CompanyName"]
        }
      },
      {
        name: "delete_account",
        description: "Remove a customer from a rep's account list",
        inputSchema: {
          type: "object",
          properties: {
            rep: {
              type: "string",
              enum: ["taneisha", "nika"],
              description: "Which sales rep's list to remove from"
            },
            customerId: {
              type: "integer",
              description: "The customer ID to remove"
            }
          },
          required: ["rep", "customerId"]
        }
      },
      {
        name: "update_account",
        description: "Update any field on a customer account (tier, at-risk status, company name, etc.)",
        inputSchema: {
          type: "object",
          properties: {
            rep: {
              type: "string",
              enum: ["taneisha", "nika"],
              description: "Which sales rep's account to update"
            },
            customerId: {
              type: "integer",
              description: "The customer ID to update"
            },
            Account_Tier: {
              type: "string",
              description: "Account tier (e.g., 'GOLD \\'26-TANEISHA', 'SILVER \\'26-NIKA', 'Win Back \\'26 TANEISHA')"
            },
            Priority_Tier: {
              type: "string",
              description: "Priority tier (A, B, C, D, E)"
            },
            At_Risk: {
              type: "integer",
              enum: [0, 1],
              description: "At risk flag (1 = at risk)"
            },
            CompanyName: {
              type: "string",
              description: "Company/account name"
            },
            Is_Active: {
              type: "integer",
              enum: [0, 1],
              description: "Active flag (1 = active)"
            }
          },
          required: ["rep", "customerId"]
        }
      },
      {
        name: "move_account",
        description: "Move a customer from one rep's list to another (copies all data, then deletes from original)",
        inputSchema: {
          type: "object",
          properties: {
            customerId: {
              type: "integer",
              description: "The customer ID to move"
            },
            fromRep: {
              type: "string",
              enum: ["taneisha", "nika"],
              description: "Source rep (where the account currently is)"
            },
            toRep: {
              type: "string",
              enum: ["taneisha", "nika"],
              description: "Destination rep (where to move the account)"
            },
            newTier: {
              type: "string",
              description: "Optional: New tier for destination (e.g., 'GOLD \\'26-NIKA'). If not provided, tier will be cleared."
            }
          },
          required: ["customerId", "fromRep", "toRep"]
        }
      }
    ]
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "list_accounts": {
        const { rep, ...filters } = args;
        const params = new URLSearchParams();
        Object.entries(filters).forEach(([key, value]) => {
          if (value !== undefined) params.append(key, value);
        });
        const queryString = params.toString();
        const endpoint = `/api/${rep}-accounts${queryString ? `?${queryString}` : ""}`;
        const result = await apiCall(endpoint);

        // Summarize for readability
        if (result.success && result.accounts) {
          const summary = {
            success: true,
            count: result.count,
            accounts: result.accounts.slice(0, 20).map(a => ({
              ID_Customer: a.ID_Customer,
              CompanyName: a.CompanyName,
              Account_Tier: a.Account_Tier,
              YTD_Sales_2026: a.YTD_Sales_2026,
              Last_Order_Date: a.Last_Order_Date,
              Contact_Status: a.Contact_Status,
              At_Risk: a.At_Risk
            })),
            note: result.count > 20 ? `Showing 20 of ${result.count} accounts. Use filters to narrow results.` : undefined
          };
          return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "get_account": {
        const { rep, customerId } = args;
        const result = await apiCall(`/api/${rep}-accounts/${customerId}`);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "update_crm": {
        const { rep, customerId, ...crmFields } = args;
        const result = await apiCall(`/api/${rep}-accounts/${customerId}/crm`, {
          method: "PUT",
          body: JSON.stringify(crmFields)
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "reconcile_accounts": {
        const { rep, autoAdd } = args;
        const endpoint = `/api/${rep}-accounts/reconcile${autoAdd ? "?autoAdd=true" : ""}`;
        const result = await apiCall(endpoint);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "sync_sales": {
        const { rep } = args;
        const result = await apiCall(`/api/${rep}-accounts/sync-sales`, {
          method: "POST"
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "rep_audit": {
        const { year, summaryOnly } = args;
        const endpoint = summaryOnly
          ? `/api/rep-audit/summary${year ? `?year=${year}` : ""}`
          : `/api/rep-audit${year ? `?year=${year}` : ""}`;
        const result = await apiCall(endpoint);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "create_account": {
        const { rep, ...accountData } = args;
        const result = await apiCall(`/api/${rep}-accounts`, {
          method: "POST",
          body: JSON.stringify(accountData)
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "delete_account": {
        const { rep, customerId } = args;
        const result = await apiCall(`/api/${rep}-accounts/${customerId}`, {
          method: "DELETE"
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "update_account": {
        const { rep, customerId, ...updateFields } = args;
        const result = await apiCall(`/api/${rep}-accounts/${customerId}`, {
          method: "PUT",
          body: JSON.stringify(updateFields)
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "move_account": {
        const { customerId, fromRep, toRep, newTier } = args;

        // Step 1: Get the account from source
        const sourceAccount = await apiCall(`/api/${fromRep}-accounts/${customerId}`);
        if (!sourceAccount.success) {
          return { content: [{ type: "text", text: JSON.stringify({
            success: false,
            error: `Account ${customerId} not found in ${fromRep}'s list`
          }, null, 2) }] };
        }

        // Step 2: Prepare data for destination (copy relevant fields)
        const accountData = sourceAccount.account;
        const newAccountData = {
          ID_Customer: accountData.ID_Customer,
          CompanyName: accountData.CompanyName,
          Account_Tier: newTier || "", // Use new tier or clear it
          Priority_Tier: accountData.Priority_Tier,
          // Copy other important fields
          Contact_Status: accountData.Contact_Status,
          Contact_Notes: accountData.Contact_Notes,
          Last_Contact_Date: accountData.Last_Contact_Date,
          Next_Follow_Up: accountData.Next_Follow_Up,
          Follow_Up_Type: accountData.Follow_Up_Type
        };

        // Step 3: Create in destination
        const createResult = await apiCall(`/api/${toRep}-accounts`, {
          method: "POST",
          body: JSON.stringify(newAccountData)
        });

        if (!createResult.success) {
          return { content: [{ type: "text", text: JSON.stringify({
            success: false,
            error: `Failed to create account in ${toRep}'s list`,
            details: createResult
          }, null, 2) }] };
        }

        // Step 4: Delete from source
        const deleteResult = await apiCall(`/api/${fromRep}-accounts/${customerId}`, {
          method: "DELETE"
        });

        return { content: [{ type: "text", text: JSON.stringify({
          success: true,
          message: `Moved ${accountData.CompanyName} (${customerId}) from ${fromRep} to ${toRep}`,
          newTier: newTier || "(no tier assigned)",
          fromRep,
          toRep,
          deleteResult
        }, null, 2) }] };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true
        };
    }
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("NWCA Accounts MCP server running");
}

main().catch(console.error);
