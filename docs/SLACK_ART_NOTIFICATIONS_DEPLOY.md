# Slack Art Notifications — Deployment Notes

Phased rollout of expanded Slack coverage for AE / Steve / Ruth dashboards. All
notifications are backend-driven (Caspio TA doesn't fire on REST). Each new
module gracefully no-ops if its webhook env var is unset.

## Webhook env vars

| Env var | Channel | Used by | Required? |
|---|---|---|---|
| `SLACK_ART_NOTIFICATIONS_WEBHOOK_URL` | `#art-notifications` | art submission, rush, revision, reopen, **status transitions (Awaiting Approval / Customer Approved / Completed / On Hold), reminder-sent** | already set |
| `SLACK_MOCKUP_NOTIFICATIONS_WEBHOOK_URL` | `#mockup-notifications` | mockup submission, rush, revision, **status transitions (Awaiting Approval / Approved / Completed)** | already set |
| `SLACK_BROKEN_MOCKUP_WEBHOOK_URL` | `#mockup-alerts` | broken-mockup detector | already set |

No new env vars are required for this rollout — Steve and Ruth are already
members of `#art-notifications` and `#mockup-notifications`, so channel pings
reach them directly. (Personal-DM webhooks were considered but dropped after
verifying both are in both channels.)

## Zaps already deactivated by Erik

- **"RUSH STEVE"** — was watching `Is_Rush=Yes` on `ArtRequests` via Caspio
  Datasheet event_source. Replaced by the channel ping fired in
  `slack-rush-art-notify.js`.
- **"RUSH RUTH"** — same pattern on `Digitizing_Mockups`. Replaced by
  `slack-rush-mockup-notify.js`.

Both are now off. The other Zaps Erik replaced in earlier migration phases
(mockup submission/revision Slack, art submission/revision Slack, etc.) were
already deactivated.

## What lights up (per channel)

### `#art-notifications`
- 🎨 New art request (garment / sticker / banner / JDS — Item_Type-aware label)
- 🔥 Rush art request (with Item_Type label and spec card)
- 🔄 Revision requested (Revision_Count++)
- 🔁 Art reopened (closed-like → In Progress)
- 📤 **NEW** — Mockup sent to customer for approval (Status → Awaiting Approval)
- ✅ **NEW** — Customer Approved
- 🎯 **NEW** — Artwork Completed
- ⏸️ **NEW** — Art On Hold (Is_On_Hold flipped false→true) — surfaces On_Hold_Note
- 🔔 **NEW** — Approval reminder sent (Send Reminder button)

### `#mockup-notifications`
- 🎨 New mockup submission
- 🔥 Rush mockup
- 🔄 Mockup revision requested
- 📤 **NEW** — Mockup ready for approval (Awaiting Approval)
- ✅ **NEW** — Mockup approved
- 🎯 **NEW** — Mockup completed

## Verification (per the plan)

```bash
# From caspio-pricing-proxy root
npx jest tests/jest/slack-*.test.js
```

End-to-end (live):
1. Submit one of each Item_Type (Garment / Sticker / Banner / JDS) via the
   AE intake forms. Confirm `#art-notifications` shows 4 distinct messages
   with correct emoji, fields, and detail link.
2. Take an existing art request through every status transition. Confirm
   one Slack ping per transition with the right emoji.
3. Same for mockups (Awaiting Approval / Approved / Completed).
4. Click Send Reminder on an Awaiting Approval request — confirm 🔔 lands.
5. Rush-flag a request — confirm 🔥 ping in the right channel and that Steve /
   Ruth see it (they're members of both channels).

## Rollback

To silence the new pings without a code deploy:
- **Reminder pings only** → revert the 4-line frontend addition in
  `art-actions-shared.js::sendMockupReminder` (the backend route stays).
- **Everything in #art-notifications** → unset
  `SLACK_ART_NOTIFICATIONS_WEBHOOK_URL` (nuclear — also silences submission /
  rush / revision; prefer code rollback).

For full rollback, revert the commits introducing the three new modules:
- `src/utils/slack-art-status-notify.js`
- `src/utils/slack-mockup-status-notify.js`
- `src/utils/slack-art-reminder-notify.js`
- (plus the Item_Type branches in `slack-art-request-submission-notify.js` and `slack-rush-art-notify.js`)
