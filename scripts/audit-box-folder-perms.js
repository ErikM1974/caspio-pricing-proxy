#!/usr/bin/env node
/**
 * Audit + downgrade Box folder collaboration roles for the two mockup folders
 * Caspio references. Goal: prevent staff from being able to DELETE files via
 * the Box web UI (which is what produces the "File missing from Box" state on
 * Steve's + Ruth's dashboards).
 *
 * Box collaboration roles, from most to least permissive:
 *   co-owner          — manage settings + invite others + delete files
 *   editor            — upload + download + DELETE files                      ← we downgrade this
 *   viewer uploader   — upload + download, but NO delete                      ← target role
 *   uploader          — upload only (no preview/download)
 *   previewer uploader— preview + upload (no download/delete)
 *   viewer            — read-only
 *   previewer         — preview-only (no download)
 *
 * What this script does:
 *   1. Reads collaborations on BOX_ART_FOLDER_ID + BOX_MOCKUP_FOLDER_ID.
 *   2. Lists each collaborator with their current role.
 *   3. For `editor` and `co-owner` collaborations, downgrades them to
 *      `viewer uploader` — keeps upload/download, removes delete.
 *   4. The folder OWNER is unchanged (Erik retains full control).
 *
 * The Box trash 30-day retention + the daily broken-mockups digest become
 * a real safety net once delete is off the table; today they're patches
 * for an ongoing leak.
 *
 * Usage:
 *   node scripts/audit-box-folder-perms.js              # Dry-run — list only
 *   node scripts/audit-box-folder-perms.js --apply      # Downgrade editors
 *   node scripts/audit-box-folder-perms.js --verbose    # Per-collab detail
 *
 * Env vars:
 *   BOX_CLIENT_ID, BOX_CLIENT_SECRET, BOX_ENTERPRISE_ID
 *   BOX_ART_FOLDER_ID, BOX_MOCKUP_FOLDER_ID
 *
 * Reversibility: any change can be undone via the Box web UI in seconds
 * (Folder Settings → Collaborators → re-set role to Editor).
 */

require('dotenv').config();
const axios = require('axios');

// ─── CLI flags ────────────────────────────────────────────────────────
const APPLY = process.argv.includes('--apply');
const VERBOSE = process.argv.includes('--verbose');

// ─── Config ───────────────────────────────────────────────────────────
const BOX_API_BASE = 'https://api.box.com/2.0';
const TARGET_ROLE = 'viewer uploader';
// Roles that grant delete capability — these get downgraded.
const DOWNGRADE_ROLES = new Set(['editor', 'co-owner']);

// Automation/service accounts use this email domain. We DO NOT downgrade
// them — these are our own backend service accounts (NWCA Art Upload +
// SanMar Inventory Import). Our backend uses them to upload AND to call
// DELETE /api/box/file/:fileId (which is guarded by reference-check).
// Stripping their delete capability would break the legitimate cleanup path.
// The whole point of this audit is to remove HUMAN delete access via the
// Box web UI — humans are the source of accidental deletions.
const AUTOMATION_DOMAIN = '@boxdevedition.com';

const FOLDERS = [
    { name: "Steve's Art Hub",                envVar: 'BOX_ART_FOLDER_ID' },
    { name: "Ruth's Digitizing Mockups",      envVar: 'BOX_MOCKUP_FOLDER_ID' }
];

// ─── Sanity ───────────────────────────────────────────────────────────
const required = {
    BOX_CLIENT_ID: process.env.BOX_CLIENT_ID,
    BOX_CLIENT_SECRET: process.env.BOX_CLIENT_SECRET,
    BOX_ENTERPRISE_ID: process.env.BOX_ENTERPRISE_ID,
    BOX_ART_FOLDER_ID: process.env.BOX_ART_FOLDER_ID,
    BOX_MOCKUP_FOLDER_ID: process.env.BOX_MOCKUP_FOLDER_ID
};
for (const [k, v] of Object.entries(required)) {
    if (!v) {
        console.error(`ERROR: ${k} is not set in env.`);
        process.exit(1);
    }
}

// ─── Box auth ─────────────────────────────────────────────────────────
let boxToken = null;
let boxTokenExpiry = 0;

async function getBoxToken() {
    const now = Math.floor(Date.now() / 1000);
    if (boxToken && now < boxTokenExpiry - 60) return boxToken;
    const resp = await axios.post('https://api.box.com/oauth2/token', new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.BOX_CLIENT_ID,
        client_secret: process.env.BOX_CLIENT_SECRET,
        box_subject_type: 'enterprise',
        box_subject_id: process.env.BOX_ENTERPRISE_ID
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 });
    boxToken = resp.data.access_token;
    boxTokenExpiry = now + resp.data.expires_in;
    return boxToken;
}

// ─── Box folder + collaborations ─────────────────────────────────────
async function getFolderInfo(folderId) {
    const token = await getBoxToken();
    const resp = await axios.get(`${BOX_API_BASE}/folders/${folderId}`, {
        params: { fields: 'id,name,owned_by' },
        headers: { 'Authorization': `Bearer ${token}` },
        timeout: 15000
    });
    return resp.data;
}

async function listCollaborations(folderId) {
    const token = await getBoxToken();
    const resp = await axios.get(`${BOX_API_BASE}/folders/${folderId}/collaborations`, {
        params: { fields: 'id,role,accessible_by,status,created_at' },
        headers: { 'Authorization': `Bearer ${token}` },
        timeout: 15000
    });
    return resp.data.entries || [];
}

async function updateCollaboration(collabId, newRole) {
    const token = await getBoxToken();
    await axios.put(`${BOX_API_BASE}/collaborations/${collabId}`, {
        role: newRole
    }, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        timeout: 15000
    });
}

// ─── Main ─────────────────────────────────────────────────────────────
async function main() {
    console.log('='.repeat(78));
    console.log('Box folder permissions audit');
    console.log('Mode:', APPLY ? 'APPLY (downgrading editors → viewer uploader)' : 'DRY-RUN (no changes)');
    console.log('Target role for editors/co-owners:', TARGET_ROLE);
    console.log('='.repeat(78));

    let totalDowngraded = 0;
    let totalSkipped = 0;
    let totalEditorsFound = 0;

    for (const f of FOLDERS) {
        const folderId = process.env[f.envVar];
        console.log(`\n┌─ ${f.name}`);
        console.log(`│  Env: ${f.envVar} = ${folderId}`);

        let info;
        try {
            info = await getFolderInfo(folderId);
            console.log(`│  Folder name: "${info.name}"`);
            const owner = info.owned_by || {};
            console.log(`│  Owner:       ${owner.name || owner.login || '(unknown)'} <${owner.login || ''}>`);
        } catch (err) {
            console.log(`│  ✗ Failed to fetch folder info: ${err.response?.status || ''} ${err.message}`);
            continue;
        }

        let collabs;
        try {
            collabs = await listCollaborations(folderId);
        } catch (err) {
            console.log(`│  ✗ Failed to list collaborations: ${err.response?.status || ''} ${err.message}`);
            continue;
        }
        console.log(`│  Collaborators: ${collabs.length}\n│`);

        if (collabs.length === 0) {
            console.log(`│  (No collaborators — only the owner has access)`);
            console.log(`└─\n`);
            continue;
        }

        for (const c of collabs) {
            const target = c.accessible_by || {};
            const login = String(target.login || '');
            const who = `${target.name || '(unknown)'} <${login || target.id || '?'}>`;
            const role = c.role;
            const status = c.status;
            const hasDeletePower = DOWNGRADE_ROLES.has(role);
            const isAutomation = login.endsWith(AUTOMATION_DOMAIN);
            const isDowngradable = hasDeletePower && !isAutomation;

            if (isDowngradable) totalEditorsFound++;

            let indicator = '·';
            if (hasDeletePower && isAutomation) indicator = '🔧';   // automation, skipped
            else if (isDowngradable) indicator = '⚠';

            console.log(`│  ${indicator}  [${role.padEnd(16)}] ${status.padEnd(8)} ${who}`);

            if (VERBOSE && c.created_at) {
                console.log(`│      collab id ${c.id} · created ${c.created_at}`);
            }

            if (hasDeletePower && isAutomation) {
                console.log(`│      → automation account, leaving editor role intact`);
            } else if (isDowngradable) {
                if (!APPLY) {
                    console.log(`│      → would downgrade to "${TARGET_ROLE}" (dry-run)`);
                } else {
                    try {
                        await updateCollaboration(c.id, TARGET_ROLE);
                        console.log(`│      ✓ downgraded to "${TARGET_ROLE}"`);
                        totalDowngraded++;
                    } catch (err) {
                        console.log(`│      ✗ FAILED to downgrade: ${err.response?.status || ''} ${err.message}`);
                        if (err.response?.data) {
                            console.log(`│        ${JSON.stringify(err.response.data)}`);
                        }
                        totalSkipped++;
                    }
                }
            }
        }

        console.log(`└─\n`);
    }

    console.log('='.repeat(78));
    if (APPLY) {
        console.log(`Done. Downgraded ${totalDowngraded} editors → "${TARGET_ROLE}".`);
        if (totalSkipped > 0) console.log(`${totalSkipped} downgrades failed (see errors above).`);
    } else {
        console.log(`Dry-run complete. ${totalEditorsFound} editor/co-owner collaboration(s) would be downgraded.`);
        if (totalEditorsFound > 0) {
            console.log(`Pass --apply to downgrade them to "${TARGET_ROLE}".`);
        }
    }
    console.log('='.repeat(78));
}

main().catch(err => {
    console.error('\nFATAL:', err.response?.data || err.message);
    process.exit(1);
});
