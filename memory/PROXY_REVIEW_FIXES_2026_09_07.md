# Backend review fixes — 2026-09-07

## Coordinated transfer authentication LIVE — 2026-09-08

Frontend v2026.09.08.7 / Heroku 2066 / c20d424b142c3e5e275cab891c8ad13e0be22fc2 was deployed FIRST and verified against the actual slug, live /api/version and six changed source assets. Five staff page gates and six safe anonymous GET API boundaries passed; the two public inquiry/reference pages still load. Exact-source CI 34250102640 passed, including the new real-server authentication checks and live-engine pricing parity. Release-branch CI is tracked separately.

Backend v2026.09.08.1 / Heroku 1130 / d06aee3e4d25c5e1410241ea8007cdc8339aa3fa followed only after that verification. Actual slug identity matches, /api/health returns healthy, eight anonymous API checks return 401, and a credentialed image request without a URL reaches the expected 400 validation without contacting a vendor. All 136 backend unit suites / 1,777 tests passed on unchanged implementation code. Both scheduled Supacolor scripts carry the existing secret; no scheduler log lines newer than release were present at the first check, so no natural post-release run is yet claimed. No business writes, syncs, notifications or test records were triggered.

The earlier pause and pending-deployment paragraphs below are history. The boot probe passed unchanged on resume; its earlier timeout was not reproduced and the cause is unconfirmed. Backend dependency/runtime findings remain a separate backlog; this release did not upgrade them. Continue CSS work using the plan in ../Pricing Index File 2025/memory/CSS_UNIFICATION_2026-09.md.

## Resumed — 2026-09-08

Erik explicitly resumed from the checkpoint and reiterated permission to continue. The historical pause below is superseded. The unchanged saved frontend passed the actual HTTP boot probe on port 3113 with status 200; the earlier timeout did not recur and its cause is unconfirmed. All previously completed local checks remain recorded below. Continue the exact-source CI/release process, frontend callers FIRST and backend gates second, then the remaining CSS families.

## User-requested stopping point — 2026-09-08

Final boot probe FAILED: the local server did not answer /api/version on port 3113 within 45 seconds. The preceding build/lint/types/unit/DOM/axe/parity/CSS/browser checks passed, but the overall gate exited 1. Startup was not investigated because Erik requested a stop. Diagnose and rerun the boot probe before preparing a release; do not claim all release gates passed.

PAUSED at Erik's request so he can shut down his laptop and resume later. Current live proxy remains v2026.09.07.4 / Heroku 1129 / actual slug cc8eda5c72160e65ec7f38791d4d4a6d0ac045f7. Implementation d5fd4f242f17926da88ac5e881106fb89135466f is saved on develop and NOT deployed; 136 suites / 1,777 unit tests pass, including 48 focused auth/vision checks.

The frontend's 28 relays, six browser caller migrations, authenticated vision parser and staff detail HTML gate are implemented and tested: 4,961 unit tests and 66 browser tests pass. Credential equality was verified without displaying or changing values. The coordinated change MUST deploy the frontend callers FIRST, then this proxy's gates and both scheduler scripts. Neither half is live yet. No further deployment was begun for this pause. Preserve the preexisting untracked .agents/ and AGENTS.md.

The authoritative cross-project resume checklist is ../Pricing Index File 2025/memory/HANDOVER_FOLLOWUPS_2026-09.md, first section. It contains live release references, release preparation steps, verification and the remaining application-wide CSS scope. Exact saved commit IDs and final boot outcome are in C:/Users/erik/.codex/visualizations/2026/09/07/01a07d90-9a4c-7e70-9e4e-c196377b7c6b/pause-checkpoint-2026-09-08.json. Resume only when Erik returns.

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
