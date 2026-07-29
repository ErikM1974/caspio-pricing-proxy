---
name: Deploy to Production
description: Deploy current develop branch of caspio-pricing-proxy to production. Use when user says /deploy, "deploy to production", "push to heroku", "release to production", "deploy changes", "ship it", or "release changes". No interactive prompts — pre-flight gates (auth, freshness, tests, memory) guard the deploy. --no-ff release merge with changelog of actual commits, real release-status verification, /api/health liveness check, auto-restart on stale slug, optional Slack notification.
---

# Deploy to Production Skill (caspio-pricing-proxy)

Automates the deploy pipeline for the Caspio Pricing Proxy API server: `develop` → `main` → Heroku app `caspio-pricing-proxy`. Fast, non-interactive, traceable.

**Sibling skill**: A parallel deploy skill exists in the Pricing Index repo (`../Pricing Index File 2025/.claude/skills/deploy/SKILL.md`). Both follow the same structure; only constants and verification path differ.

## What This Skill Does

1. **Pre-flight gates** (Step 0.1–0.6) refuse to deploy bad state
2. **Precise staging** — `git add -u`, never `-A`
3. **Release-marker merge** — `--no-ff` so `git log --first-parent main` is a clean release log
4. **CHANGELOG of actual commits** — captures develop's commits BEFORE the merge
5. **Real Heroku release verification** via `heroku releases --json`, not blind sleep
6. **`/api/health` liveness check** with `ps:restart` → `ps:scale` escalation
7. **Optional Slack notification** (silent skip if webhook unset)
8. **Copy-pasteable rollback** procedure at end of skill

**Differences from the Pricing Index skill:**
- No cache-bust step (proxy serves JSON, not HTML — no `?v=` versioned assets)
- Verification uses `/api/health` (proxy's existing endpoint) instead of frontend `?v=` check
- Heroku app: `caspio-pricing-proxy` instead of `sanmar-inventory-app`
- Test runner: `npm test` (full Jest suite) instead of `npm run test:parser`

## Triggers

`/deploy` · "deploy to production" · "push to heroku" · "release to production" · "deploy changes" · "ship it" · "release changes"

Flags: `--skip-tests` (emergency bypass for Step 0.6)

## Implementation

Execute these steps in order. **Stop immediately if any pre-flight gate fails — nothing has been modified yet.**

---

### Step 0.1 — Fetch latest remote state

```bash
git fetch origin --prune --tags
```

If this fails (network down, auth issue), abort.

### Step 0.2 — Verify on develop branch

```bash
git branch --show-current
```

If not on `develop`, report and abort.

### Step 0.3 — Verify develop not behind origin

```bash
git rev-list --count HEAD..origin/develop
```

If non-zero, abort with:
> Local develop is N commits behind origin. Run `git pull --ff-only origin develop` first.

### Step 0.4 — Heroku auth + remote check

```bash
heroku auth:whoami
git remote get-url heroku
```

If `auth:whoami` fails → abort: "Run `heroku login` first."
If `git remote get-url heroku` fails → abort: "No heroku remote — run `heroku git:remote -a caspio-pricing-proxy`."

### Step 0.5 — MEMORY.md size gate

```bash
MEMFILE="$HOME/.claude/projects/c--Users-erik-OneDrive---Northwest-Custom-Apparel-2025-caspio-pricing-proxy/memory/MEMORY.md"
LINES=$(wc -l < "$MEMFILE" 2>/dev/null || echo 0)

if [ "$LINES" -gt 180 ]; then
  echo "✗ MEMORY.md is $LINES lines (hard limit 180). Condense before deploying."
  exit 1
elif [ "$LINES" -gt 150 ]; then
  echo "⚠ MEMORY.md is $LINES lines (warning ≥150, target ≤130). Condense soon."
elif [ "$LINES" -gt 0 ]; then
  echo "MEMORY.md: $LINES lines"
fi
```

Note: memory dir path uses lowercase `c--` prefix (project-specific naming convention).

### Step 0.6 — Smoke tests (skippable)

If `--skip-tests` was NOT specified:

```bash
npm test
```

If tests fail → abort. Tell user: "Tests failed. Fix or re-run with `/deploy --skip-tests` for emergencies."

Note: full Jest suite (21 test files). Typical runtime 30–60s. Cost vs. shipping a regression: tests win.

### Step 1 — Compute single deploy version

```bash
SHORT_SHA=$(git rev-parse --short HEAD)
TODAY=$(date +%Y.%m.%d)
N=$(( $(git tag -l "v${TODAY}.*" | wc -l) + 1 ))
DEPLOY_TAG="v${TODAY}.${N}"
echo "Deploy tag: $DEPLOY_TAG"
```

### Step 2 — Stage changes precisely

```bash
git add -u
```

**Never `git add -A`** — would catch `.env`, log files, downloaded CSVs, anything stray in the working tree.

(No cache-bust step — proxy serves JSON, not versioned HTML assets.)

### Step 3 — Commit

```bash
N_FILES=$(git diff --cached --name-only | wc -l)
TOP3=$(git diff --cached --name-only | head -3 | xargs -n1 basename | tr '\n' ', ' | sed 's/, $//')
git commit -m "Deploy ${DEPLOY_TAG}: ${N_FILES} files (${TOP3}...)"
```

If `N_FILES` is 0 (nothing staged), there are no changes to deploy. Tell user: "No changes since last commit. Did you mean to commit something first?" and abort.

### Step 4 — Push develop to GitHub

```bash
git push origin develop
```

### Step 5 — Switch to main, hard pull

```bash
git checkout main
git pull --ff-only origin main
```

If `--ff-only` fails (main diverged), abort:
1. `git checkout develop`
2. Tell user: "main has diverged from origin. Investigate — somebody pushed a hotfix directly?"

### Step 6 — Capture release commits (BEFORE merge)

```bash
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || git rev-list --max-parents=0 HEAD)
RELEASE_COMMITS=$(git log "${LAST_TAG}..develop" --pretty="- %s" --reverse)
echo "$RELEASE_COMMITS"
```

**Critical**: captures develop's commits BEFORE the merge muddies the topology. Used in both Step 8 (CHANGELOG) and Step 9 (tag).

### Step 7 — Merge develop with `--no-ff`

```bash
git merge --no-ff develop -m "Release ${DEPLOY_TAG}"
```

Creates an explicit release-marker commit on main. After: `git log main --first-parent --oneline` is your clean release history.

**Conflict handling:**
1. `git merge --abort`
2. `git checkout develop`
3. Tell user:
   ```
   DEPLOY ABORTED: Merge conflict on main.

   Resolve manually:
     git checkout main
     git merge develop
     [resolve in editor]
     git add . && git commit
     /deploy

   You are back on develop branch.
   ```
4. STOP.

### Step 8 — Generate CHANGELOG entry

```bash
{
  echo "## ${DEPLOY_TAG} (${TODAY})"
  echo ""
  echo "${RELEASE_COMMITS}"
  echo ""
  [ -f CHANGELOG.md ] && cat CHANGELOG.md
} > CHANGELOG.md.new && mv CHANGELOG.md.new CHANGELOG.md

git add CHANGELOG.md
git commit -m "Changelog ${DEPLOY_TAG}"
```

Uses `$RELEASE_COMMITS` from Step 6. On first run, creates CHANGELOG.md (doesn't exist yet in this repo). On subsequent runs, prepends new release at top.

### Step 9 — Create annotated tag with real commit list

```bash
git tag -a "${DEPLOY_TAG}" -m "Release ${DEPLOY_TAG}

${RELEASE_COMMITS}"
```

### Step 10 — Push main + specific tag (NOT `--tags`)

```bash
git push origin main
git push origin "${DEPLOY_TAG}"
```

### Step 11 — Push to Heroku

```bash
git push heroku main
```

### Step 12 — Wait for Heroku release `status=succeeded`

```bash
parse_release_status() {
  if command -v jq >/dev/null 2>&1; then
    jq -r '.[0].status'
  elif command -v python >/dev/null 2>&1; then
    python -c "import sys,json; print(json.load(sys.stdin)[0]['status'])"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c "import sys,json; print(json.load(sys.stdin)[0]['status'])"
  else
    echo "PARSER_MISSING"
  fi
}

for i in $(seq 1 60); do
  STATUS=$(heroku releases --json --app caspio-pricing-proxy 2>/dev/null | parse_release_status)
  case "$STATUS" in
    succeeded)      echo "  ✓ Release succeeded"; break ;;
    failed)         echo "  ✗ Heroku release FAILED — check 'heroku releases:output --app caspio-pricing-proxy'"; exit 1 ;;
    PARSER_MISSING) echo "  ✗ No JSON parser available. Install jq or python."; exit 1 ;;
    *)              sleep 2 ;;
  esac
done
```

### Step 13 — Liveness verification

The proxy doesn't ship a `/api/version` endpoint yet (on the follow-up list), so we use the existing `/api/health` endpoint as a basic liveness signal. This doesn't verify the slug *content* matches what we just pushed, but it confirms the new release is responding.

**13a. `/api/health` liveness check:**

```bash
sleep 3   # let the new dyno warm up
LIVE_URL="https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/health"
HEALTH=$(curl -s -m 10 "${LIVE_URL}?_=$(date +%s)")

if echo "$HEALTH" | grep -q '"status":"healthy"'; then
  VERIFIED=1
  VERIFY_REPORT="/api/health → healthy"
  echo "  ✓ /api/health responding"
fi
```

**13b. Stale-slug recovery** (if 13a failed):

```bash
# Poll up to 25s for natural propagation
for i in $(seq 1 5); do
  sleep 5
  HEALTH=$(curl -s -m 10 "${LIVE_URL}?_=$(date +%s)")
  echo "$HEALTH" | grep -q '"status":"healthy"' && { VERIFIED=1; VERIFY_REPORT="/api/health → healthy"; break; }
done

# Still down? Auto-restart
if [ "$VERIFIED" != "1" ]; then
  echo "  ⚠ /api/health not responding — auto-restarting dyno"
  heroku ps:restart --app caspio-pricing-proxy
  for i in $(seq 1 18); do
    sleep 5
    HEALTH=$(curl -s -m 10 "${LIVE_URL}?_=$(date +%s)")
    echo "$HEALTH" | grep -q '"status":"healthy"' && {
      echo "  ✓ Dyno restarted; /api/health responding"
      VERIFY_REPORT="/api/health → healthy (after restart)"
      VERIFIED=1
      break
    }
  done
fi

# Still down? Scale cycle
if [ "$VERIFIED" != "1" ]; then
  echo "  ⚠ Restart didn't help — cycling dyno scale"
  heroku ps:scale web=0 --app caspio-pricing-proxy
  sleep 5
  heroku ps:scale web=1 --app caspio-pricing-proxy
  for i in $(seq 1 12); do
    sleep 5
    HEALTH=$(curl -s -m 10 "${LIVE_URL}?_=$(date +%s)")
    echo "$HEALTH" | grep -q '"status":"healthy"' && {
      VERIFY_REPORT="/api/health → healthy (after scale cycle)"
      VERIFIED=1
      break
    }
  done
fi

# Manual escalation
if [ "$VERIFIED" != "1" ]; then
  echo "  ⚠ /api/health STILL not responding. Investigate."
  echo "  Check: heroku logs --tail --app caspio-pricing-proxy"
  VERIFY_REPORT="/api/health UNREACHABLE — manual investigation required"
fi
```

### Step 14 — Slack deploy notification (silent)

```bash
if [ -n "$SLACK_DEPLOY_WEBHOOK_URL" ]; then
  curl -s -X POST "$SLACK_DEPLOY_WEBHOOK_URL" \
    -H 'Content-Type: application/json' \
    -d "{\"text\":\"🚀 Proxy deployed ${DEPLOY_TAG} — ${N_FILES} files: ${TOP3}\"}" \
    > /dev/null 2>&1
fi
```

If env var unset, skip silently.

### Step 15 — Return to develop, keep in sync

```bash
git checkout develop
git merge --ff-only main
git push origin develop
```

`--ff-only` is safe because main just got the release-merge commit + changelog commit.

### Step 16 — Success message

```
✅ DEPLOY SUCCESSFUL — ${DEPLOY_TAG}

  Repo:        caspio-pricing-proxy
  Files:       ${N_FILES} (${TOP3}...)
  Tag:         ${DEPLOY_TAG}
  Live:        https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/
  Health:      ${VERIFY_REPORT:-not checked}

  Rollback if needed (see Rollback Procedure below):
    Fast:  heroku releases:rollback --app caspio-pricing-proxy
    Full:  git checkout main && git revert -m 1 HEAD && git push origin main && git push heroku main
```

`$VERIFY_REPORT` is set in Step 13. Possible values:
- `/api/health → healthy` — Step 13a succeeded
- `/api/health → healthy (after restart)` — Step 13b first escalation worked
- `/api/health → healthy (after scale cycle)` — Step 13b second escalation worked
- `/api/health UNREACHABLE — manual investigation required` — all verification failed

---

## Rollback Procedure

Two steps, in order. Step 1 stops the bleeding in seconds and touches no git; Step 2 is how the
revert actually lands. **Step 2 is not optional** — after a slug rollback, `main` still contains
the bad code, so the next `/deploy` would ship it straight back out.

### Step 1 — Stop the bleeding: Heroku slug rollback

Instant, git history untouched. Use the moment the API is broken; investigate after.

```bash
# See recent releases
heroku releases --app caspio-pricing-proxy

# Roll back one release
heroku releases:rollback --app caspio-pricing-proxy

# …or to a specific known-good one
heroku releases:rollback v<NNN> --app caspio-pricing-proxy
```

Also the right and *only* tool when the bug is in the **slug, not the code** — a bad config var,
a platform glitch, a crashed dyno. In that case there is nothing to revert in git; fix the config
and redeploy.

### Step 2 — Land the revert in git: revert on develop, then `/deploy`

Revert on **develop** and ship it through the normal gated path. One revert commit, flowing
develop → main the way every other change does, with a tag and a CHANGELOG entry.

```bash
# Find the release merge commit you're undoing
git log main --first-parent --oneline | head -3      # look for "Release vYYYY.MM.DD.N"

git checkout develop
git pull --ff-only origin develop
git revert -m 1 <release-merge-sha> --no-edit        # -m 1: it's a merge commit
```

Then:

```
/deploy
```

**Do NOT revert on `main` and push by hand.** It produces a second, duplicate revert commit that
the next develop → main merge has to reconcile, and it skips every gate — which is how the bad
release got out in the first place. Prefer fixing forward if the fix is small and obvious;
`/deploy` runs the same gates either way.

### Last resort — hand revert on main

Only when the Heroku CLI is unavailable AND you cannot wait for `/deploy`'s gates.

```bash
git checkout main
git pull --ff-only origin main
git revert -m 1 HEAD --no-edit

git push --no-verify origin main
git push --no-verify heroku main
```

⚠️ **`--no-verify` is REQUIRED here, and it is easy to lose ten minutes to.** `.git/hooks/pre-push`
only lets a push to `main` through when the tip commit's subject starts `Release v` or
`Changelog v` (see `scripts/git-hooks/pre-push` and `memory/GIT_WORKFLOW.md`). A revert's subject
is `Revert "Release v2026.07.29.3"` — it does not match, so the push is refused. Mid-incident that
reads like git itself is broken.

Afterwards, resync and let the tooling catch up:

```bash
git checkout develop
git merge --ff-only main
git push origin develop
```

Then run `/deploy` on the next real change so the tag and CHANGELOG stop lagging main.

---

## Error Handling Quick Reference

| Failure | Auto-action | Manual step needed |
|---|---|---|
| Not on develop | Abort | `git checkout develop` |
| develop behind origin | Abort | `git pull --ff-only origin develop` |
| Not heroku-authed | Abort | `heroku login` |
| MEMORY.md > 180 lines | Abort | Condense to topic files |
| Tests fail | Abort | Fix tests, or `--skip-tests` for emergency |
| Nothing to commit | Abort | Make a change first; don't deploy empty |
| Merge conflict on main | Auto `merge --abort`, return to develop | Resolve manually, re-run |
| `--ff-only` pull fails | Abort | Investigate divergent main |
| Heroku release `failed` | Abort | `heroku releases:output --app caspio-pricing-proxy` |
| No `jq` / `python` for status parsing | Abort | Install jq (`scoop install jq` or `brew install jq`) |
| `/api/health` not responding | Auto `ps:restart` → `ps:scale` cycle | Manual `heroku logs --tail` if both fail |
| `✗ Push to main blocked` from pre-push hook | Abort — by design | You pushed to `main` by hand. Use `/deploy`. The one legitimate `--no-verify` case is the hand rollback (see Rollback Procedure) — a `Revert "Release v…"` subject never matches the allowlist |
| Push to Heroku hangs | None | `Ctrl-C`, check `heroku status`, retry |

---

## Environment Variables

| Var | Required? | Purpose |
|---|---|---|
| `SLACK_DEPLOY_WEBHOOK_URL` | Optional | Posts deploy summary to a Slack channel. Skill skips silently if unset. |

## Known cosmetic noise

Heroku CLI v9.x prints `Warning: heroku update available from 9.0.0 to 11.3.0.` on every call (to stderr). Harmless — it leaks to the terminal but doesn't pollute captured stdout. To eliminate: run `heroku update`.

## Follow-up tasks (not part of this skill)

1. **Add `/api/version` endpoint** — returns `{sha: process.env.HEROKU_SLUG_COMMIT}`. Heroku auto-sets `HEROKU_SLUG_COMMIT` if the `runtime-dyno-metadata` lab is enabled (`heroku labs:enable runtime-dyno-metadata --app caspio-pricing-proxy`). Once shipped, Step 13 should add a check that compares `LIVE_SHA` to `SHORT_SHA` — stronger guarantee than `/api/health` alone (health checks could pass on an old slug). This same endpoint is needed in the Pricing Index repo too; one PR satisfies both.
2. **Wire `SLACK_DEPLOY_WEBHOOK_URL`** — separate from the Pricing Index webhook if you want a different channel for proxy deploys, or share the same `#deploys` channel.

---

## What Changed From The Previous Version

The previous proxy skill was the legacy "ask everything, run `git add -A`, no CHANGELOG" version. This rewrite imports the same hardening as the Pricing Index deploy skill, adapted for a backend API.

| Old behavior | New behavior |
|---|---|
| `git add -A` | `git add -u` (no .env risk) |
| No remote freshness check | Step 0.3 refuses if local develop is behind origin |
| Confirmation gate (AskUserQuestion) | Removed — pre-flight gates are sufficient |
| Session-doc prompt | Removed |
| `--no-edit` fast-forward merge | `--no-ff` with release-marker commit |
| Tag message: "Production deploy" | Tag message: actual commit list from `git log` |
| `git push origin main --tags` | `git push origin main && git push origin <tag>` |
| No CHANGELOG | Auto-generated CHANGELOG.md from `git log` |
| No release-status verification | Polls `heroku releases --json` until `succeeded` |
| No liveness check | Curls `/api/health` with `ps:restart` → `ps:scale` escalation |
| No rollback docs | Two-playbook Rollback Procedure |
| No deploy notification | Optional Slack webhook |
