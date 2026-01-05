# Postman Auto-Update - Quick Reference

## For Non-Programmers

### What Happens Now?

Every time you **commit code that changes API routes**, Git will ask:

```
⚠️  API routes have changed!
📋 Would you like to update Postman collection now?
[Y/n]:
```

### What Should You Do?

**99% of the time: Press Enter** (or type `Y`)

That's it! The system will:
1. ✅ Scan all your API endpoints (129+ endpoints)
2. ✅ Update Postman automatically
3. ✅ Sync to Postman cloud
4. ✅ Commit your code

**Takes 2-3 seconds.**

### When to Press "n" (Skip)

Only skip if:
- You're making multiple commits and will update later
- You're just fixing a comment or typo
- You're in a rush (but remember to update later!)

### When to Use `--no-verify`

Only use `git commit --no-verify` if:
- It's an emergency hotfix
- You absolutely can't wait 2 seconds

**But this is rare!** Most of the time, just press Enter.

## Simple Rules

1. **Change API routes** → Git asks → **Press Enter** → Done ✅
2. **Change other files** → Git commits normally (no questions) ✅
3. **Forgot to update?** → Run `npm run update-postman` manually

## That's It!

You don't need to:
- ❌ Manually edit Postman
- ❌ Write JSON code
- ❌ Remember to update Postman
- ❌ Use any special skills

**The system handles everything automatically!**

## Questions?

- **"What if I forget?"** → Git reminds you automatically
- **"What if I press 'n' by mistake?"** → Run `npm run update-postman` manually
- **"Does this create duplicates?"** → No! Updates the same collection
- **"Is this safe?"** → Yes! It preserves your custom descriptions

## Files to Know

- **Route files**: `src/routes/*.js` (trigger the hook)
- **Hook file**: `.git/hooks/pre-commit` (does the magic)
- **Update command**: `npm run update-postman` (manual update)

## Summary

**Old Way (Manual):**
1. Change API code
2. Remember to update Postman (often forgot!)
3. Manually write 50+ lines of JSON
4. Upload to Postman
5. Hope you didn't make mistakes

**New Way (Automatic):**
1. Change API code
2. Git asks: "Update Postman?"
3. Press Enter
4. Done!

**It's that simple!** 🎉
