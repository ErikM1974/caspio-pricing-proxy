# Git Pre-Commit Hook - Postman Auto-Reminder

## What It Does

Automatically reminds you to update Postman when you commit changes to API route files.

## How It Works

### Normal Commits (No Route Changes)
```bash
$ git commit -m "Update README"
# ✅ Commits normally - no interruption
```

### Commits with Route Changes
```bash
$ git commit -m "Add new production endpoint"

🔍 Detected changes in route files:
   → src/routes/production-schedules.js

⚠️  API routes have changed!
📋 Would you like to update Postman collection now?
[Y/n]: Y

🚀 Running npm run update-postman...
✅ Postman collection updated successfully!
✅ Proceeding with commit...

[main abc1234] Add new production endpoint
```

## Your Options

### Option 1: Update Now (Recommended)
Press **Y** or just press **Enter**
- Runs `npm run update-postman` automatically
- Updates Postman with your changes
- Commits your code
- **Takes 2-3 seconds**

### Option 2: Skip for Now
Press **n**
```bash
[Y/n]: n
⏭️  Skipping Postman update
ℹ️  Reminder: Run 'npm run update-postman' later
```
- Commits normally
- **Remember to run** `npm run update-postman` later

### Option 3: Bypass Hook Completely
Use `--no-verify` flag:
```bash
git commit --no-verify -m "Quick fix"
```
- Skips the hook entirely
- Use only when urgent

## What Files Trigger the Hook?

The hook only activates when you change files in:
```
src/routes/*.js
```

Examples:
- ✅ `src/routes/products.js` → Hook activates
- ✅ `src/routes/orders.js` → Hook activates
- ❌ `server.js` → Hook does NOT activate
- ❌ `docs/README.md` → Hook does NOT activate
- ❌ `scripts/utils.js` → Hook does NOT activate

## Error Handling

### If Postman Update Fails

```bash
❌ Postman update failed!
⚠️  You can still commit with: git commit --no-verify

Continue with commit anyway? [y/N]: n
❌ Commit aborted
ℹ️  Fix the issue and try again
```

**Options:**
1. Fix the error and try again
2. Type `y` to commit anyway (not recommended)
3. Use `git commit --no-verify` to bypass

## Installation

The hook is already installed at:
```
.git/hooks/pre-commit
```

**No setup needed!** It's active now.

## Disable the Hook

### Temporarily (One Commit)
```bash
git commit --no-verify -m "Message"
```

### Permanently
```bash
# Rename the hook file
mv .git/hooks/pre-commit .git/hooks/pre-commit.disabled
```

### Re-enable
```bash
# Rename it back
mv .git/hooks/pre-commit.disabled .git/hooks/pre-commit
```

## Examples

### Example 1: Adding a New Endpoint
```bash
# 1. You add a new endpoint
vim src/routes/production-schedules.js

# 2. Stage your changes
git add src/routes/production-schedules.js

# 3. Commit
git commit -m "Add production schedules endpoint"

# Hook detects route change and asks:
[Y/n]: Y

# ✅ Postman updated automatically!
# ✅ Code committed!
```

### Example 2: Multiple Route Files Changed
```bash
git add src/routes/products.js src/routes/pricing.js
git commit -m "Update product and pricing endpoints"

🔍 Detected changes in route files:
   → src/routes/products.js
   → src/routes/pricing.js

[Y/n]: Y
# ✅ Updates Postman with all changes
```

### Example 3: Quick Fix (Skip Update)
```bash
git commit -m "Fix typo in route comment"

[Y/n]: n
⏭️  Skipping Postman update
# ✅ Commits without updating Postman
# ⚠️  Remember to run 'npm run update-postman' later
```

### Example 4: Urgent Commit (Bypass Hook)
```bash
git commit --no-verify -m "Hotfix: critical bug"
# ✅ Commits immediately, no hook
```

## Troubleshooting

### Hook Doesn't Run

**Check if hook exists:**
```bash
ls -la .git/hooks/pre-commit
```

**Should show:**
```
-rwxr-xr-x 1 user group 2443 ... .git/hooks/pre-commit
```

If missing the `x` (executable), run:
```bash
chmod +x .git/hooks/pre-commit
```

### Hook Runs for Wrong Files

The hook is designed to ONLY run for `src/routes/*.js` files.

If it's running for other files, check the hook code:
```bash
cat .git/hooks/pre-commit | grep "ROUTE_FILES"
```

Should contain:
```bash
ROUTE_FILES=$(git diff --cached --name-only | grep "^src/routes/.*\.js$")
```

### "npm run update-postman" Fails

**Check:**
1. Node.js is installed: `node --version`
2. Dependencies installed: `npm install`
3. Postman API credentials set in `.env`

**Fix:**
```bash
npm install
# Then try commit again
```

## Benefits

✅ **Never forget** to update Postman
✅ **Integrated** into your normal workflow
✅ **Smart** - only asks when routes change
✅ **Fast** - takes 2-3 seconds
✅ **Optional** - you can skip if needed
✅ **Safe** - can bypass with `--no-verify`

## Summary

**Before Hook:**
```
1. Change route file
2. git commit
3. (Oops, forgot to update Postman!)
4. Manually run npm run update-postman
5. Postman is now out of sync with deployed code 😞
```

**After Hook:**
```
1. Change route file
2. git commit
3. Hook: "Update Postman? [Y/n]"
4. Press Enter
5. ✅ Postman updated automatically! 😊
```

**You'll never have out-of-sync Postman documentation again!**
