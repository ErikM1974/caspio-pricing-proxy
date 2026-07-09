# Caspio Schema Introspection API (v1.0.0 — 2026-07-10)

Read-only endpoints that expose the **Caspio account's schema** (tables/views/apps/webhooks + any table's fields) so tooling — and Claude in any session — can enumerate objects **without a per-session Caspio bearer token**. The proxy's own standing OAuth credential does the auth server-side.

- **Route file:** `src/routes/caspio-schema.js` (mounted OPEN at `/api` in `server.js`).
- **OPEN by design** (Erik, 2026-07-09): no auth gate. Returns schema **STRUCTURE only** (object + field names/types) — **never row data** — so open exposure stays low.
- **Backed by Caspio REST v4** (`/v4/schemas/*` + `/v4/tables/*`). The v3 OAuth token from `getCaspioAccessToken()` works on v4 (same account OAuth — verified 2026-07-09).
- **15-minute in-memory cache** per key (schema rarely changes; stays well under the rate limit).
- Errors are surfaced (never a silent fallback — a wrong/empty schema is worse than an error).

## Endpoints

| Method · Path | Returns |
|---|---|
| `GET /api/caspio-schema/tables` | `{count, tables:[{name, tableId, fieldCount, description}]}` (163 today) |
| `GET /api/caspio-schema/tables/:name/fields` | `{table, tableId, fields:[{name, dataType, editable, unique, isFormula}]}` (case-insensitive name; 404 if unknown) |
| `GET /api/caspio-schema/views` | `{count, views:[name]}` (19) |
| `GET /api/caspio-schema/webhooks` | `{count, webhooks:[{name, status, events:[{object, type, sources}]}]}` (24 — all Zapier, `Datasheet` source) |
| `GET /api/caspio-schema/apps` | `{bridge:[name], flex:[name]}` (14 bridge / 1 flex) |
| `GET /api/caspio-schema/full` | one-call data dictionary: `{count, tables:[{name, tableId, fields:[{name, dataType, editable}]}]}` |

## Examples
```bash
BASE=https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/caspio-schema
curl -s "$BASE/tables" | jq '.count'                          # 163
curl -s "$BASE/tables/Quote_Sessions/fields" | jq '.fields|length'  # 100
curl -s "$BASE/full" | jq '.tables[]|select(.name=="Service_Codes").fields[].name'
```

## Notes
- **v4 data types (tokens):** `TEXT255 · TEXT64K · NUMBER · INTEGER · CURRENCY · DATE/TIME · YES/NO · ATTACHMENT · LIST-* · PASSWORD` (editable) · `PK_ID · AUTONUMBER · SEQUENCE · RANDOM_ID · GUID · TIMESTAMP · FORMULA` (auto, `editable=false`).
- Adding a table/field in Caspio is reflected within the 15-min cache TTL (or restart the dyno).
- Full Caspio v4 platform capability map + the live account inventory snapshot live in the Pricing Index repo: `../Pricing Index File 2025/memory/CASPIO_REST_API_V4_REFERENCE.md` + `../Pricing Index File 2025/memory/caspio-v4-live-inventory-2026-07-09.md`.
- Shipped: proxy release **v890**, commit `e5e13a4`.
