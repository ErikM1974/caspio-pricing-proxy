# Atmos import validation and repeat-import safety

Implemented locally 2026-09-16 across this proxy and `../Python Inksoft`.

## Proxy import contract

`POST /api/creditcard-atmos/upsert` validates the entire input batch before any
Caspio read or write, for both dry runs and actual imports. Invalid rows return
HTTP 400 with `error`, `validationErrors` (row-specific messages), and `errorCount`.
Required checks include text bank references, duplicate canonical references,
calendar-valid dates, finite monetary amounts with at most two decimal places,
required text fields and field lengths, and vendor ID format.

Existing rows are matched across both legacy digits-only and current `R`-prefixed
references. The reference remains deterministic, not regenerated per import.
`Reference_ID` must remain unique Text in Caspio.

- Existing nonblank POs are preserved, even if a new candidate differs.
- Blank incoming POs never clear an existing PO. A new match can fill a blank PO.
- `GL_Account` and existing `Reconciled` values remain untouched.
- `id_Vendor` is a formula and is never submitted to Caspio.
- `preservedPOs` in dry-run and live responses counts existing nonblank PO assignments.
- Duplicate references within an upload block the batch instead of scheduling an
  update before its new insert exists.

This is validation-before-write, not a transactional batch guarantee. External
Caspio failures can still cause partial writes; the response reports errors, and
the stable reference IDs support retrying. PO corrections to already assigned
records should be made explicitly in Caspio.

## Python Inksoft formatter

`web/atmos_formatter.py` accepts the raw BoA preamble, UTF-8 BOM and quoted CSV.
Nonblank malformed rows, invalid amounts/dates, missing or duplicate bank
references, and overlong invoice fields fail conversion with a line number.
Amounts are normalized to two decimal places. Decimal totals reconcile credits
and charges independently against any bank summary supplied; mismatches block
conversion before network lookups. Missing summary rows are allowed and clearly
reported as unavailable for independent comparison.

The conversion response includes `totals`, `bank_totals`, `unique_references`,
and per-row `po_status`. Metadata is excluded from both export formats.

- **Download Caspio CSV:** reference first, excludes formula `id_Vendor` and
  accounting-managed `GL_Account`.
- **Download ShopWorks CSV:** retains the existing 11-column layout.
- Both reflect the reconciliation month selected in the preview.
- Use **Push to Caspio** for repeat imports; the CSV import wizard has its own
  mapping/update settings and does not inherit the proxy's preservation logic.

PO statuses distinguish amount/date matches, approximate matches, no match,
ambiguity, out-of-window matches, duplicate PO claims, card charges, unmatched
vendors, and incomplete lookups. Existing matching tolerances are unchanged.

## Verification

- Proxy: `node node_modules/jest/bin/jest.js --config jest.unit.config.js --runInBand tests/jest/creditcard-atmos-upsert.test.js tests/jest/creditcard-atmos-refkey.test.js`
- Python Inksoft: `python -B -m unittest discover -s tests -v`
- Python Inksoft frontend: `node --test tests/test_atmos_frontend.cjs`
- Local browser test used the actual template, frontend JS and conversion route
  with the previously fetched vendor/PO snapshot. Caspio writes were disabled.
- Raw `stmt.csv`: 101 transactions, 101 vendor matches, 33 PO links, 101 distinct
  references; charges 25,759.85, credits -2.28, net 25,757.57.
- Actual browser CSV download was read back and verified for headers, totals,
  references, PO count and an August month override. Default closing month stays
  September (`26-Sep`) for posting dates through September 8.

Both the proxy and Python Inksoft changes need deployment for the complete flow.
Deploy the proxy first so preservation/validation is in place when the updated
formatter is used. This work does not authorize or perform any financial import.
