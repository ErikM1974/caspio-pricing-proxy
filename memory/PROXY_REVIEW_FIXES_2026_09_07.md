# Backend review fixes — 2026-09-07

## Checklist
- [x] Inspect the affected proxy routes and frontend callers.
- [x] Require the CRM secret for legacy cart CRUD, both contact APIs, and ShipStation outbound APIs.
- [x] Validate cart IDs and escape filter literals.
- [x] Reject incomplete strict database reads, including timeouts and upstream errors.
- [x] Observe failed background style-index refreshes while keeping the previous index.
- [x] Apply the payroll body parser before the global parser and preserve 413/400 errors.
- [x] Migrate browser contact lookups and server shipping/contact callers.
- [x] Fix the matching frontend payroll parser order.
- [x] Run backend regression tests: 134 suites / 1,739 tests passed.
- [x] Complete frontend regression verification: 2 suites / 35 tests passed.
- [x] Reconcile with Pricing Index v2026.09.07.24 after its server split.
- [x] Update the frontend route-registration lock: 456 registrations; only the
      payroll parser, contact relay, and fifteen legacy cart gates changed.
- [x] Full frontend unit suite: 190 suites, 4,695 passed, four existing skips.
- [x] Explicit fixture-based pricing parity: two suites, 84 tests passed.
- [x] Browser E2E: 15 passed, three opt-in screenshot tests skipped. This includes
      all five calculator parity checks (screen print, DTG, DTF, embroidery, caps).

## Release order
Deploy the Pricing Index frontend changes FIRST: browser contact requests use an
authenticated same-origin relay; server contact lookups and shipping sync send the
CRM secret. Then deploy the proxy gates. Deploying the proxy alone would break old
direct browser lookups and unauthenticated shipping sync calls.

The legacy cart UI was retired in June. Its remaining proxy endpoints and app
relays are now staff-only; the current sample cart uses a separate API surface.
Anonymous users of fillable forms can continue entering contact details manually;
access to the customer directory requires a staff session.

The user subsequently authorized deployment. Release targets: frontend
`v2026.09.07.25`, followed by proxy `v2026.09.07.3`. Verify each running release
before advancing; no customer-data migration is required.

## Commit handoff
The proxy is a Git checkout on `develop`, with the backend half still pending.
The Pricing Index working tree is based on `v2026.09.07.24`; the server-split
changes are already committed separately. Keep the frontend fixture update
`tests/fixtures/server-route-table.json` in the SAME commit as the hardening.
Explicitly add the new frontend test `tests/unit/proxy-review-relays.test.js`
and the new backend tests `tests/jest/proxy-review-security.test.js` and
`tests/jest/payroll-body-parser.test.js`. `git add -u` alone will omit them.
Unrelated pre-existing untracked files are not part of this change.

## Validation
Deployment gate: full proxy suite passed (143 suites / 1,813 tests), including
the existing live integration tests with uniquely named test records and cleanup.
Frontend deployment gates passed: lint (zero errors, 99 baseline warnings),
typecheck, all 190 unit suites, 88 DOM tests, four accessibility tests, production
asset build, and an HTTP boot probe. The route lock remains at 456 registrations.

Backend tests use mocked upstream services and localhost HTTP. They exercise
the real middleware/route registrations, not production endpoints. Coverage includes
spoofed Origin headers, GET/HEAD reads, contact writes, malicious numeric IDs,
quoted session IDs, strict 500/429/timeout behavior, stale refresh retries, and
11 MB payroll JSON bodies. Existing non-strict pagination behavior is retained.
