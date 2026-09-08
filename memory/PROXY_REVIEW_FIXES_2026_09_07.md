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

## Transfer/Supacolor follow-through — 2026-09-08

Read-only caller audit confirmed that transfer-orders, separate transfer-order-notes,
and supacolor-jobs have no authentication before their router mounts. CORS and
query validation do not establish caller identity. Supacolor's three vision
extraction browser callers also need matching staff relays before proxy gates.
This follow-through is covered by the user's existing review/fix/deploy approval.

- [x] Audit browser, vendor, scheduler and Python Inksoft callers without business API probes.
- [ ] Add same-origin staff relays and migrate the six browser controllers; staff-gate Supacolor Job Detail HTML.
- [ ] Preserve vendor session/ownership checks, including the separate notes write; customer mockup approval must not fetch staff transfer data.
- [x] Gate all three resource prefixes and the three related vision extraction paths before router mounts (implemented, not deployed).
- [x] Authenticate both scheduled Supacolor jobs; fail before sending when the credential is absent.
- [x] Verify backend mount order, anonymous/spoofed-origin/wrong-secret denial, real-handler access and cron behavior with mocked upstream calls: 48 focused checks and all 136 backend unit suites / 1,777 tests pass. Frontend relay tests are separate.
- [ ] Verify matching credential configuration without displaying secrets. Deploy frontend callers FIRST, then proxy gates and cron headers together.
- [ ] Verify release identity, anonymous denials and scheduler logs. Do not trigger live sync, recovery, notifications or test-record writes.

The current public customer mockup view does not call these transfer APIs.
Vendor routes already send the CRM secret and enforce job ownership. Python
Inksoft's supacolor-po-index is a distinct, already gated API; no caller change
is needed there. The remaining vision extract-mockup-info boundary is separate.

Existing production CRM_API_SECRET configuration is present and equal on both
apps (including proxy-app scheduler configuration), verified without displaying
or changing values. The backend source remains held from deployment until the
frontend relay/caller release is live. Validation excludes the integration suites
that create production test records; no business writes or notifications were run.
