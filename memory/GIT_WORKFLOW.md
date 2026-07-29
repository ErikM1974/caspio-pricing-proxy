# Git Workflow

**Production ships through `/deploy`. Nothing else.** A pre-push hook enforces it — a hand
`git push heroku main` is blocked, not merely discouraged. See [The pre-push guard](#the-pre-push-guard).

## Branch Strategy

| Branch | Purpose | Deploys To |
|--------|---------|------------|
| **develop** | Active development. All work lands here. | GitHub only |
| **main** | Release history. Written *only* by `/deploy`. | GitHub + Heroku |

Heroku app: `caspio-pricing-proxy` · live at `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com`

## Day-to-day

### 1. Start work (always on develop)
```bash
git checkout develop
```

### 2. Commit
```bash
git add <specific files>
git commit -m "description of changes"
```

Committing anything under `src/routes/*.js` triggers the **pre-commit hook**, which regenerates
the Postman collection (`npm run update-postman`) and syncs it to the Postman API before the
commit completes. Expect ~15 s and a wall of scan output — that's normal, not an error.

### 3. Push develop to GitHub
```bash
git push origin develop
```

Always allowed. `develop` is where work belongs.

### 4. Deploy
```
/deploy
```

That's the whole procedure. Do not merge to `main` by hand — see below for what `/deploy` does
that a hand merge doesn't, and why the hook exists.

---

## The pre-push guard

`.git/hooks/pre-push` blocks any push whose **remote ref is `refs/heads/main`** unless the tip
commit is a deploy-skill release commit — subject starting `Release v…` or `Changelog v…`.

It catches all three hand-deploy shapes, because each one pushes to `main`:

```bash
git push origin main                 # blocked
git push heroku main                 # blocked
git push heroku develop:main         # blocked — remote ref is still main
```

Pushing `develop` is never blocked.

**Why it exists (2026-07-27).** The `/deploy` skill stopped being used on this repo. Tagging
lapsed after `v2026.07.01.1` and **181 commits went straight onto main and out to Heroku
untagged** — including a SanMar inbound fix pushed by hand on 2026-07-27 that skipped the
889-test gate entirely. Nothing objected, because nothing could. Documentation didn't hold the
line, so the hook does. The workflow was never wrong; it just wasn't enforced.

**Escape hatch** — deliberately loud rather than locked:

```bash
git push --no-verify origin main
```

Genuine emergencies only (prod is down, fix verified another way). Run `/deploy` afterwards so
the tag and CHANGELOG catch up.

**Install per clone.** `.git/hooks/` is not version-controlled. The canonical copy lives at
`scripts/git-hooks/pre-push`; a fresh clone has **no** hook until you install it:

```bash
cp scripts/git-hooks/pre-push .git/hooks/pre-push && chmod +x .git/hooks/pre-push
```

Check whether yours is live: `ls -l .git/hooks/pre-push`. If it's missing, the guard is off and
a hand push to main will succeed silently.

---

## What `/deploy` actually does

Far more than "merge develop into main and push". Full spec:
[`.claude/skills/deploy/SKILL.md`](../.claude/skills/deploy/SKILL.md).

**Pre-flight gates** — abort before anything is modified:

| Gate | Refuses when |
|---|---|
| Branch | not on `develop` |
| Freshness | local `develop` is behind `origin/develop` |
| Heroku | not logged in, or no `heroku` remote |
| Memory | `MEMORY.md` over 180 lines |
| Tests | `npm test` fails (full Jest suite — 78 files, ~904 tests, ~2 min) |

**Then, in order:** `git add -u` (never `-A`, so `.env` and stray CSVs can't ride along) →
push `develop` → `checkout main` + `pull --ff-only` → capture the release commit list **before**
merging → `merge --no-ff` with a `Release vX` marker → prepend a CHANGELOG entry of the real
commit subjects → annotated tag carrying that same list → push `main` + that one tag → push
Heroku → poll `heroku releases --json` until `status=succeeded` → hit `/api/health`, escalating
`ps:restart` → `ps:scale` if it doesn't answer → optional Slack post → back to `develop`,
fast-forwarded and pushed.

Net effect: `git log main --first-parent --oneline` is a clean release log, every release is
tagged, and `CHANGELOG.md` is accurate without anyone maintaining it.

Flag: `/deploy --skip-tests` bypasses the test gate. Emergency lever, not a way past a red test.

---

## Useful commands

```bash
git log main..develop --oneline    # what would ship on the next deploy
git log develop..main --oneline    # on main but not develop (should be empty between deploys)
git log main --first-parent --oneline | head    # release history
git tag -l "v$(date +%Y.%m.%d).*"  # today's release tags
```

## Rollback

**Fast — Heroku slug rollback** (bad config, platform glitch, need it reverted now):

```bash
heroku releases --app caspio-pricing-proxy
heroku releases:rollback --app caspio-pricing-proxy
```

Git history untouched, so a later re-deploy without a code change would ship the same bad slug —
this is a stopgap, not a fix.

**Full — git revert + redeploy** (the bug is in the code):

```bash
git checkout main && git pull --ff-only origin main
git revert -m 1 HEAD --no-edit          # -m 1 keeps main's history, drops develop's changes
git push origin main && git push heroku main
```

Note the revert commit's subject won't start `Release v…`, so the pre-push guard will block it —
this is the intended `--no-verify` case. Then fix forward on `develop` and `/deploy`.

## Tips

1. **Always start on develop** — `git checkout develop` before any work.
2. **Never merge to main by hand** — `/deploy` owns that branch.
3. **Push develop often** — it's the only backup of in-progress work.
4. **Deploying two repos that depend on each other?** Ship the proxy first, then the app —
   an enriched API in front of an older frontend is harmless; the reverse can render blanks.
   (Both halves of a paired change should go out the same session; see MEMORY.md.)
