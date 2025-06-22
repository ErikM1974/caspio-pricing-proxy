# Git and Heroku Deployment Guide

## Prerequisites
- Git installed and configured
- Heroku CLI installed and logged in
- GitHub repository access
- Heroku application created and configured

## Common Git Commands

### Branch Management
```bash
# List all branches
git branch

# Show current branch
git branch --show-current

# Create new branch
git checkout -b feature-branch

# Switch to existing branch
git checkout branch-name
```

### Pushing to GitHub

1. Push current branch to GitHub:
```bash
git push origin branch-name
```

2. Push all branches:
```bash
git push --all origin
```

### Merging Branches

1. Switch to target branch (e.g., main):
```bash
git checkout main
```

2. Merge source branch:
```bash
git merge source-branch
```

## Deployment Workflow

### Standard Workflow
1. Develop in feature branch
2. Push feature branch to GitHub
3. Merge into main branch
4. Deploy main to Heroku

### Step-by-Step Guide

1. **Create and Work in Feature Branch**
```bash
# Create and switch to new branch
git checkout -b feature-branch

# Make changes and commit
git add .
git commit -m "Description of changes"

# Push feature branch to GitHub
git push origin feature-branch
```

2. **Merge to Main**
```bash
# Switch to main branch
git checkout main

# Merge feature branch
git merge feature-branch

# Push main to GitHub
git push origin main
```

3. **Deploy to Heroku**
```bash
# Deploy main branch to Heroku
git push heroku main
```

## Heroku-Specific Commands

### Deployment
```bash
# Deploy to Heroku
git push heroku main

# Force push (if needed)
git push heroku main --force
```

### Application Management
```bash
# View Heroku logs
heroku logs --tail

# Restart application
heroku restart

# Open application
heroku open
```

## Troubleshooting

### Common Issues

1. **Push Rejected**
   - Ensure branches are up to date
   - Pull latest changes: `git pull origin branch-name`
   - Force push if necessary (use with caution)

2. **Heroku Deploy Failed**
   - Check logs: `heroku logs --tail`
   - Verify Procfile configuration
   - Check environment variables: `heroku config`

3. **Merge Conflicts**
   - Resolve conflicts in affected files
   - Stage resolved files: `git add .`
   - Complete merge: `git commit`

## Best Practices

1. **Branch Management**
   - Use descriptive branch names
   - Keep branches up to date with main
   - Delete merged branches

2. **Commits**
   - Write clear commit messages
   - Make atomic commits
   - Reference issue numbers if applicable

3. **Deployment**
   - Test locally before deploying
   - Review changes before merging
   - Monitor deployment logs

## Environment Setup

### Git Configuration
```bash
git config --global user.name "Your Name"
git config --global user.email "your.email@example.com"
```

### Heroku Setup
```bash
# Login to Heroku
heroku login

# Add Heroku remote
heroku git:remote -a your-app-name
```

## Security Notes

1. Never commit sensitive data (API keys, passwords)
2. Use environment variables for configuration
3. Review code before pushing to production
4. Keep dependencies updated