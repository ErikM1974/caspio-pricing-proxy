# Lessons Learned

A running log of problems solved and gotchas discovered. Add new entries at the top.

---

## Problem: Box mockup images not showing in Art Hub / AE Hub
**Date:** 2026-04
**Symptoms:** Images uploaded to Box weren't displaying in Art Hub or AE Hub
**Root cause:** Direct Box file URLs aren't publicly accessible; they require authentication
**Solution:** Added a shared-image proxy endpoint and updated uploads to use proxy URLs instead of direct Box links (commit 0d2f3e6)
**Prevention:** Always use proxy URLs for Box-hosted images, never direct Box file links

---

## Problem: OGIO brand missing from product list
**Date:** 2025-12
**Symptoms:** API returns products but OGIO brand not included
**Root cause:** `makeCaspioRequest` doesn't handle pagination; OGIO was on page 2
**Solution:** Use `fetchAllCaspioPages` for all multi-record queries
**Prevention:** Added CRITICAL note to CLAUDE.md - Caspio Pagination section

---

## Problem: API usage exceeded 500K monthly limit
**Date:** 2025-12
**Symptoms:** 630K calls/month (26% over limit), Caspio throttling
**Root cause:** No caching, every page load made fresh API calls
**Solution:** Implemented caching: pricing bundle (15min), product search (5min), etc.
**Prevention:** Added API Usage Tracking system, `/api/admin/metrics` endpoint

---

## Problem: WSL can't connect to local server
**Date:** 2025
**Symptoms:** `localhost:3002` not accessible from Windows browser
**Root cause:** WSL uses different network interface than Windows
**Solution:** Use WSL IP address (`hostname -I`) instead of localhost
**Prevention:** Documented in LOCAL_DEVELOPMENT.md

---

## Problem: Incomplete data returned from Caspio
**Date:** 2025
**Symptoms:** Some records missing, data appears truncated
**Root cause:** Caspio paginates at 1000 records, only first page returned
**Solution:** Always use `fetchAllCaspioPages`, never `makeCaspioRequest` for lists
**Prevention:** CRITICAL warning in CLAUDE.md

---

## Template for New Entries

```markdown
## Problem: [Brief description]
**Date:** YYYY-MM
**Symptoms:** What the bug looked like to users/developers
**Root cause:** What was actually wrong
**Solution:** How we fixed it
**Prevention:** How to avoid this in future (rule added, pattern documented, etc.)
```
