# API Creator Skill

**Complete end-to-end API endpoint creation from Caspio to Heroku deployment.**

## What This Skill Does

Automates the entire workflow of creating a new API endpoint:

1. ✅ Parses Caspio Swagger responses
2. ✅ Generates route files with proper code
3. ✅ Updates server configuration
4. ✅ Creates/updates documentation (Postman, API docs)
5. ✅ Generates test files and commands
6. ✅ Provides deployment checklist
7. ✅ Creates rollback plan
8. ✅ Includes troubleshooting guide

## For Non-Programmers

This skill is designed to be user-friendly for people without programming experience:
- Plain English instructions
- Interactive questions (not technical jargon)
- Pre-flight safety checks
- Copy/paste commands
- Step-by-step guidance
- Automatic error recovery

## How to Use

### 1. Trigger the Skill

Say any of these to Claude:
- "create a new api endpoint"
- "create endpoint for {table name}"
- "add caspio endpoint"
- "help me create an api"
- "I have a swagger response"

### 2. Provide Caspio Info

Paste one of these:
- **curl command** from Caspio Swagger (easiest)
- Swagger JSON response
- Just the table name

### 3. Answer Simple Questions

The skill will ask 3-4 questions:
1. What should the endpoint path be? (suggestion provided)
2. Read-only or full CRUD?
3. Which fields should be filterable? (suggestions provided)
4. Any special requirements? (usually "none")

### 4. Review & Test

The skill creates:
- Route file with code
- Updated server.js
- Updated Postman collection
- Updated API documentation
- Test file with commands
- Deployment checklist

### 5. Deploy

Follow the step-by-step deployment guide provided.

## Files in This Directory

| File | Purpose |
|------|---------|
| `SKILL.md` | Main skill instructions (Claude reads this) |
| `caspio-reference.md` | Caspio API v3 quick reference |
| `examples.md` | Real-world examples from existing endpoints |
| `troubleshooting.md` | Error recovery and common issues |
| `templates/simple-route-template.js` | Template for read-only endpoints |
| `templates/crud-route-template.js` | Template for full CRUD endpoints |

## Features

### Safety Checks
- Git status verification
- Environment variable validation
- Duplicate endpoint detection
- Port conflict checking
- Table name validation (optional)

### Smart Generation
- Field type detection (text, number, date, boolean)
- Auto-suggest filters based on field types
- Proper error handling with Caspio Request ID logging
- Pagination handling (Caspio 1000 record limit)
- Query parameter validation

### Documentation
- Auto-updates Postman collection
- Updates API documentation
- Updates endpoint inventory
- Generates query examples
- Creates test files

### Deployment Support
- Local testing guide with WSL IP detection
- Git workflow instructions
- Heroku deployment checklist
- Rollback script generation
- Post-deployment verification

### Error Recovery
- Detailed troubleshooting guide
- Common error patterns and fixes
- Plain-English explanations
- Copy/paste fixes

## Example Workflow

```
You: "Create endpoint for Sanmar_Bulk_251816_Feb2024"

[Paste curl command from Swagger]

Skill: "What should the endpoint path be?"
        Suggested: /api/sanmar-products

You: [Press Enter to accept]

Skill: "Read-only or full CRUD?"
        1. Read-Only (recommended)
        2. Full CRUD

You: "1"

Skill: "I found these fields: STYLE, BRAND_NAME, PRODUCT_STATUS...
        Which should be filterable?"
        1. Use suggested (STYLE, BRAND_NAME, PRODUCT_STATUS, CATEGORY_NAME)
        2. No filters, just generic q.where
        3. Custom

You: "1"

Skill: [Creates all files, shows summary]

        ✅ Created: src/routes/sanmar-products.js
        ✅ Updated: server.js
        ✅ Updated: Postman collection
        ✅ Updated: Documentation

        Test locally:
        node start-test-server.js
        curl 'http://172.20.132.206:3002/api/sanmar-products?limit=10'

        Deploy to Heroku:
        [Shows full checklist]
```

## Success Metrics

**Without this skill:** 30-45 minutes per endpoint
**With this skill:** 5-10 minutes per endpoint

**Automates:**
- Code writing (100%)
- Documentation updates (100%)
- Testing setup (100%)
- Deployment guide (100%)

**You still control:**
- Endpoint design decisions
- When to deploy
- Testing verification

## Troubleshooting

If the skill doesn't work as expected:

1. Check this is a **project skill** (`.claude/skills/api-creator/`)
2. Verify `SKILL.md` exists and has proper YAML frontmatter
3. Make sure you're in the project directory
4. Try restarting Claude Code

Common issues: See `troubleshooting.md`

## Customization

You can customize the templates:
- Edit `templates/simple-route-template.js` for basic endpoints
- Edit `templates/crud-route-template.js` for CRUD endpoints
- Modify `SKILL.md` to change questions or workflow

## Version

**Version:** 1.0.0
**Created:** 2025-01-22
**For:** NWCA Caspio Pricing Proxy
**Tested with:** Claude Code, Caspio API v3, Heroku

## Support

- **Examples:** See `examples.md` for real-world usage
- **Errors:** See `troubleshooting.md` for fixes
- **Caspio API:** See `caspio-reference.md` for reference
- **Project Docs:** See `memory/API_DOCUMENTATION.md`

## License

Part of the NWCA Caspio Pricing Proxy project.
