# Active file additions

- `lib/web-quote-push.js` — frozen embroidery web-quote preview and exact-cent ShopWorks mapping; reuses existing size/fee conventions.
- `src/routes/web-quote-push.js` — secret-protected preview and confirmed submission; atomic persistent reservation prevents retries after uncertain results.
- `tests/jest/web-quote-push.test.js` — offline price/size/artwork validation, authentication, stale previews, concurrency and timeout coverage.
- `ACTIVE_FILES.md` — registry for new backend files; existing backend files remain documented in the repository's existing reference files.
