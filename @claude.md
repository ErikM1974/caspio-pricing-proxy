# GitHub and Heroku Deployment Guide

## Initial Setup

### GitHub Setup
1. **Create GitHub Account**
   - Go to https://github.com/signup
   - Complete registration process
   - Verify email address

2. **Create Personal Access Token**
   - Go to GitHub Settings > Developer Settings > Personal Access Tokens
   - Click "Generate New Token" (classic)
   - Select scopes:
     - `repo` (all)
     - `workflow`
     - `admin:org`
   - Copy and save the token securely

3. **Configure Git Locally**
```bash
git config --global user.name "Your Name"
git config --global user.email "your.github@email.com"
```

4. **Store GitHub Credentials**
```bash
# Windows
git config --global credential.helper wincred

# Mac
git config --global credential.helper osxkeychain

# Linux
git config --global credential.helper store
```

### Heroku Setup
1. **Create Heroku Account**
   - Go to https://signup.heroku.com
   - Complete registration
   - Verify email address

2. **Install Heroku CLI**
   - Windows: Download installer from Heroku website
   - Mac: `brew install heroku/brew/heroku`
   - Linux: `sudo snap install heroku --classic`

3. **Login to Heroku CLI**
```bash
heroku login
```

4. **Create Heroku App**
```bash
heroku create your-app-name
# or connect to existing app:
heroku git:remote -a your-app-name
```

## Repository Setup

### New Project
1. **Initialize Git Repository**
```bash
git init
git add .
git commit -m "Initial commit"
```

2. **Connect to GitHub**
```bash
git remote add origin https://github.com/username/repository.git
git push -u origin main
```

3. **Connect to Heroku**
```bash
heroku git:remote -a your-app-name
```

### Existing Project
1. **Clone Repository**
```bash
git clone https://github.com/username/repository.git
cd repository
```

2. **Add Heroku Remote**
```bash
heroku git:remote -a your-app-name
```

## Deployment Workflow

### GitHub Deployment
1. **Create Feature Branch**
```bash
git checkout develop
git checkout -b feature/new-feature
```

2. **Make Changes and Commit**
```bash
git add .
git commit -m "feat: description of changes"
```

3. **Push to GitHub**
```bash
# First time pushing branch
git push -u origin feature/new-feature

# Subsequent pushes
git push origin feature/new-feature
```

4. **Merge to Develop**
```bash
git checkout develop
git merge feature/new-feature
git push origin develop
```

### Heroku Deployment
1. **Merge to Main**
```bash
git checkout main
git merge develop
git push origin main
```

2. **Deploy to Heroku**
```bash
git push heroku main
```

3. **Check Deployment**
```bash
# View logs
heroku logs --tail

# Open app
heroku open
```

## Environment Variables

### GitHub Secrets
1. Go to repository Settings > Secrets
2. Add necessary secrets for CI/CD

### Heroku Config Vars
1. **View Current Config**
```bash
heroku config
```

2. **Set Variables**
```bash
heroku config:set KEY=value
```

## Troubleshooting

### GitHub Issues
1. **Authentication Failed**
   - Verify Personal Access Token
   - Reset token if needed
   - Check remote URL: `git remote -v`

2. **Push Rejected**
   - Pull latest changes: `git pull origin branch-name`
   - Resolve conflicts if any
   - Push again

### Heroku Issues
1. **Deploy Failed**
   - Check logs: `heroku logs --tail`
   - Verify Procfile exists
   - Check environment variables
   - Ensure all dependencies are in package.json

2. **Build Failed**
   - Check build logs
   - Verify Node.js version in package.json
   - Check for missing dependencies

## Security Best Practices

1. **Never commit sensitive data**
   - Use .env files locally
   - Use environment variables in Heroku
   - Add sensitive files to .gitignore

2. **Protect Branches**
   - Enable branch protection rules
   - Require pull request reviews
   - Enable status checks

3. **Regular Updates**
   - Keep dependencies updated
   - Monitor GitHub security alerts
   - Update access tokens periodically

## Maintenance

1. **Clean Up Branches**
```bash
# Delete local branch
git branch -d branch-name

# Delete remote branch
git push origin --delete branch-name
```

2. **Update Dependencies**
```bash
npm update
```

3. **Monitor Applications**
   - Check GitHub security tab
   - Monitor Heroku metrics
   - Review logs regularly