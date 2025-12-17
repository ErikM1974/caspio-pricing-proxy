# Git Workflow

## Branch Strategy

| Branch | Purpose | Deploys To |
|--------|---------|------------|
| **develop** | Active development | GitHub only |
| **main** | Production-ready code | GitHub + Heroku |

## Standard Workflow

### 1. Start Work (always on develop)
```bash
git checkout develop
```

### 2. Make Changes & Commit
```bash
git add .
git commit -m "description of changes"
```

### 3. Push develop to GitHub
```bash
git push origin develop
```

### 4. When Ready to Deploy
```bash
git checkout main
git merge develop --no-edit
git push origin main
git push heroku main
```

### 5. Return to develop
```bash
git checkout develop
```

## Quick Commands

### One-liner: Deploy to Production
```bash
git checkout main && git merge develop --no-edit && git push origin main && git push heroku main && git checkout develop
```

### Check Current Branch
```bash
git branch
```

### See Branch Differences
```bash
git log develop..main --oneline  # commits in main not in develop
git log main..develop --oneline  # commits in develop not in main
```

## When to Use Each Branch

| Task | Branch |
|------|--------|
| New feature | develop |
| Bug fix | develop |
| Documentation | develop |
| Ready to deploy | merge to main |
| Hotfix in production | main (then merge back to develop) |

## Heroku Deployment

Heroku is configured to deploy from `main` branch:
```bash
git push heroku main
```

To deploy develop code to Heroku:
```bash
git push heroku develop:main  # pushes develop as main to Heroku
```

## Tips

1. **Always start on develop** - Run `git checkout develop` before starting work
2. **Commit often** - Small commits are easier to review and revert
3. **Push develop frequently** - Keeps GitHub backup current
4. **Test before merging to main** - main should always be deployable
5. **Keep branches in sync** - After deploying, both branches should match
