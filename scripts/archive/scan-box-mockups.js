#!/usr/bin/env node
/**
 * Scan Box Mockups — Find Steve's artwork mockups and create shared links
 *
 * Iterates through all subfolders in "AAA...Steve Art Box 2020" (ID: 73634541055),
 * finds mockup JPG/PNG files (containing "Mock" or "Comp" in filename),
 * creates open shared links on them, and saves a design# → URL mapping.
 *
 * Prerequisites:
 *   - BOX_ACCESS_TOKEN env var (Developer Token from Box dev console, valid 60 min)
 *   - OR run with --token=YOUR_TOKEN_HERE
 *
 * Usage:
 *   node scripts/scan-box-mockups.js --token=YOUR_BOX_TOKEN     # Scan + create links
 *   node scripts/scan-box-mockups.js --token=TOKEN --dry-run     # Scan only, no link creation
 *   node scripts/scan-box-mockups.js --token=TOKEN --resume=500  # Resume from folder offset 500
 *
 * Output: scripts/data/box-steve-mockups.json
 */

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ============================================
// Configuration
// ============================================

const STEVE_ART_FOLDER_ID = '73634541055';
const BOX_API_BASE = 'https://api.box.com/2.0';
const OUTPUT_FILE = path.join(__dirname, 'data', 'box-steve-mockups.json');
const METADATA_FILE = path.join(__dirname, 'data', 'box-steve-folder-meta.json');
const PROGRESS_FILE = path.join(__dirname, 'data', 'box-mockup-scan-progress.json');

// Parse CLI args
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const VERBOSE = args.includes('--verbose');
const METADATA_ONLY = args.includes('--metadata-only');
const tokenArg = args.find(a => a.startsWith('--token='));
const resumeArg = args.find(a => a.startsWith('--resume='));

const BOX_TOKEN = tokenArg ? tokenArg.split('=')[1] : process.env.BOX_ACCESS_TOKEN;
const RESUME_OFFSET = resumeArg ? parseInt(resumeArg.split('=')[1], 10) : 0;

// Rate limiting: Box allows ~10 req/sec, be conservative
const DELAY_BETWEEN_FOLDERS = 350; // ms between folder scans
const DELAY_BETWEEN_LINK_CREATES = 200; // ms between shared link creates
const FOLDER_PAGE_SIZE = 1000;
const FILE_PAGE_SIZE = 100;

// Mockup file detection patterns (broadened based on Steve's actual naming)
// Priority order: Mock > Comp > FP > Thumbnail > any remaining JPG/PNG
const MOCKUP_PATTERNS = [
    /mock/i,          // "Mock1 WF copy.jpg", "Mockup.jpg" — garment mockup
    /comp\b/i,        // "Comp.jpg", "Comp 2.jpg" — composition (but not "Company")
    /\bFP\b/i,        // "FP.jpg", "Adult FB FP.jpg", "Adult LC FP.jpg" — flat print
    /thumbnail/i,     // "Thumbnail.jpg" — small preview
    /\bWF\b.*copy/i,  // "WF copy.jpg", "WF2 copy.png" — web-friendly flattened export
];

// File extensions we want (web-displayable images only)
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png']);

// Extensions to skip entirely
const SKIP_EXTENSIONS = new Set(['psd', 'cdr', 'ai', 'eps', 'svg', 'pdf', 'tiff', 'tif', 'bmp', 'raw', 'indd']);

// ============================================
// Box API Helpers
// ============================================

const boxApi = axios.create({
    baseURL: BOX_API_BASE,
    timeout: 30000,
    headers: {
        Authorization: `Bearer ${BOX_TOKEN}`,
        'Content-Type': 'application/json'
    }
});

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

/**
 * List items in a Box folder with pagination.
 */
async function listFolderItems(folderId, fields = 'id,name,type', limit = FOLDER_PAGE_SIZE, offset = 0) {
    const resp = await boxApi.get(`/folders/${folderId}/items`, {
        params: { fields, limit, offset }
    });
    return resp.data;
}

/**
 * Create an open shared link on a Box file.
 * Returns the shared link object with downloadUrl.
 */
async function createSharedLink(fileId) {
    const resp = await boxApi.put(`/files/${fileId}`, {
        shared_link: {
            access: 'open'
        }
    }, {
        params: { fields: 'shared_link' }
    });
    return resp.data.shared_link;
}

/**
 * Get file details including shared_link.
 */
async function getFileDetails(fileId) {
    const resp = await boxApi.get(`/files/${fileId}`, {
        params: { fields: 'id,name,extension,shared_link,size' }
    });
    return resp.data;
}

// ============================================
// Mockup Detection Logic
// ============================================

/**
 * Check if a filename looks like a mockup/comp image.
 */
function isMockupFile(filename, extension) {
    if (!IMAGE_EXTENSIONS.has((extension || '').toLowerCase())) return false;
    return MOCKUP_PATTERNS.some(pattern => pattern.test(filename));
}

/**
 * Score a mockup candidate for priority selection.
 * Higher score = better candidate.
 *
 * Priority: Mock JPG > Comp JPG > FP JPG > Thumbnail JPG > WF copy > generic JPG > PNG
 */
function scoreMockup(file) {
    let score = 0;
    const name = (file.name || '').toLowerCase();
    const ext = (file.extension || '').toLowerCase();

    // Prefer JPG over PNG (much smaller file size for web)
    if (ext === 'jpg' || ext === 'jpeg') score += 100;

    // Type priority: Mock > Comp > FP > Thumbnail > WF copy
    if (/mock/i.test(name)) score += 200;
    else if (/comp\b/i.test(name)) score += 150;
    else if (/\bFP\b/i.test(name)) score += 120;
    else if (/thumbnail/i.test(name)) score += 80;
    else if (/\bwf\b/i.test(name)) score += 60;

    // Prefer "copy" versions (flattened exports, usually smaller)
    if (/copy/i.test(name)) score += 10;

    // Prefer "WF" (web-friendly) versions
    if (/\bwf\b/i.test(name)) score += 10;

    // Prefer "Mock1" (first/primary mockup)
    if (/mock1/i.test(name)) score += 5;

    // Penalize very large files (>5MB probably too big for web thumbnails)
    if (file.size && file.size > 5 * 1024 * 1024) score -= 20;

    // Penalize very large PNGs (>10MB)
    if (ext === 'png' && file.size && file.size > 10 * 1024 * 1024) score -= 50;

    return score;
}

// ============================================
// Main Scanner
// ============================================

async function main() {
    console.log('='.repeat(60));
    console.log('Box Mockup Scanner — Steve Art Box 2020');
    console.log(`Mode: ${DRY_RUN ? '🟢 DRY RUN (scan only)' : '🔵 LIVE (will create shared links)'}`);
    console.log(`Started: ${new Date().toISOString()}`);
    if (RESUME_OFFSET > 0) console.log(`Resuming from offset: ${RESUME_OFFSET}`);
    console.log('='.repeat(60));

    if (!BOX_TOKEN) {
        console.error('FATAL: No Box access token provided.');
        console.error('Usage: node scripts/scan-box-mockups.js --token=YOUR_BOX_DEVELOPER_TOKEN');
        console.error('Get a developer token from: https://northwestcustomapparel.app.box.com/developers/console/app/2512805/configuration');
        process.exit(1);
    }

    // Verify token works
    console.log('\n🔑 Verifying Box token...');
    try {
        const me = await boxApi.get('/users/me', { params: { fields: 'id,name,login' } });
        console.log(`  Authenticated as: ${me.data.name} (${me.data.login})`);
    } catch (err) {
        if (err.response?.status === 401) {
            console.error('FATAL: Box token is invalid or expired. Generate a new developer token.');
        } else {
            console.error('FATAL: Cannot connect to Box API:', err.message);
        }
        process.exit(1);
    }

    // Load existing results if resuming
    let mockupMapping = {};
    if (RESUME_OFFSET > 0 && fs.existsSync(OUTPUT_FILE)) {
        mockupMapping = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
        console.log(`  Loaded ${Object.keys(mockupMapping).length} existing mappings for resume`);
    }

    // -----------------------------------------------
    // Step 1: List all subfolders
    // -----------------------------------------------
    console.log('\n📂 Step 1: Listing subfolders in Steve Art Box...');
    const allFolders = [];
    let offset = 0;
    let totalCount = 0;

    while (true) {
        const result = await listFolderItems(STEVE_ART_FOLDER_ID, 'id,name,type', FOLDER_PAGE_SIZE, offset);
        totalCount = result.total_count;

        const folders = result.entries.filter(e => e.type === 'folder');
        allFolders.push(...folders);

        console.log(`  Page at offset ${offset}: ${folders.length} folders (total items: ${totalCount})`);

        if (result.entries.length < FOLDER_PAGE_SIZE) break;
        offset += FOLDER_PAGE_SIZE;
        await sleep(300);
    }

    // Filter to numbered design folders (skip $RECYCLE.BIN, Art-*, etc.)
    const designFolders = allFolders.filter(f => {
        const firstPart = f.name.split(' ')[0];
        return /^\d{4,5}$/.test(firstPart);
    });

    console.log(`  Total folders: ${allFolders.length}`);
    console.log(`  Design folders (numbered): ${designFolders.length}`);
    console.log(`  Non-design folders skipped: ${allFolders.length - designFolders.length}`);

    // Save folder metadata (design# → company name mapping)
    const folderMeta = {};
    for (const f of designFolders) {
        const parts = f.name.split(' ');
        const dn = parts[0];
        // Company name is everything after the design number
        const company = parts.slice(1).join(' ').replace(/^\s*[-–—]\s*/, '').trim();
        folderMeta[dn] = { company: company || '', folderId: f.id, folderName: f.name };
    }

    // Ensure data directory exists
    const dataDir = path.dirname(METADATA_FILE);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    fs.writeFileSync(METADATA_FILE, JSON.stringify(folderMeta, null, 2));
    console.log(`\n💾 Saved ${Object.keys(folderMeta).length} folder metadata entries to ${METADATA_FILE}`);

    if (METADATA_ONLY) {
        console.log('\n' + '='.repeat(60));
        console.log('METADATA-ONLY MODE — Folder listing saved. No file scanning performed.');
        console.log('='.repeat(60));
        return;
    }

    // -----------------------------------------------
    // Step 2: Scan each subfolder for mockups
    // -----------------------------------------------
    console.log(`\n🔍 Step 2: Scanning ${designFolders.length} design folders for mockups...`);
    const startScan = Date.now();

    let scanned = 0;
    let mockupsFound = 0;
    let sharedLinksCreated = 0;
    let sharedLinksExisting = 0;
    let noMockup = 0;
    let errors = 0;

    // Apply resume offset
    const foldersToScan = RESUME_OFFSET > 0 ? designFolders.slice(RESUME_OFFSET) : designFolders;

    for (let i = 0; i < foldersToScan.length; i++) {
        const folder = foldersToScan[i];
        const designNumber = folder.name.split(' ')[0];

        // Skip if already mapped (from resume)
        if (mockupMapping[designNumber]) {
            scanned++;
            continue;
        }

        try {
            // List files in subfolder
            const filesResult = await listFolderItems(folder.id, 'id,name,extension,shared_link,size', FILE_PAGE_SIZE, 0);
            const files = filesResult.entries.filter(e => e.type === 'file');

            // Find mockup candidates (named patterns first)
            let mockupCandidates = files.filter(f => isMockupFile(f.name, f.extension));

            // Fallback: if no named patterns match, use any JPG/PNG in the folder
            // (skip generic names like "Logo.jpg", "IMG_xxxx.jpg", "Untitled-x.jpg")
            if (mockupCandidates.length === 0) {
                const genericSkip = /^(logo|img_|untitled|backup|1|2|3)\b/i;
                mockupCandidates = files.filter(f => {
                    const ext = (f.extension || '').toLowerCase();
                    if (!IMAGE_EXTENSIONS.has(ext)) return false;
                    if (genericSkip.test(f.name)) return false;
                    return true;
                });
                // Score fallback candidates lower (no pattern bonus)
            }

            if (mockupCandidates.length === 0) {
                noMockup++;
                if (VERBOSE) {
                    console.log(`    #${designNumber}: No web images found (${files.length} files, all PSD/CDR/AI)`);
                }
            } else {
                // Pick best candidate
                mockupCandidates.sort((a, b) => scoreMockup(b) - scoreMockup(a));
                const bestMockup = mockupCandidates[0];

                // Check if shared link exists
                let downloadUrl = null;
                if (bestMockup.shared_link && bestMockup.shared_link.download_url) {
                    downloadUrl = bestMockup.shared_link.download_url;
                    sharedLinksExisting++;
                } else if (bestMockup.shared_link && bestMockup.shared_link.url) {
                    // Has shared link but need to extract download URL
                    // Box download URLs follow pattern: /shared/static/{hash}.{ext}
                    const sharedUrl = bestMockup.shared_link.url;
                    const hashMatch = sharedUrl.match(/\/s\/([a-z0-9]+)$/);
                    if (hashMatch) {
                        downloadUrl = `https://northwestcustomapparel.box.com/shared/static/${hashMatch[1]}.${bestMockup.extension}`;
                    }
                    sharedLinksExisting++;
                } else if (!DRY_RUN) {
                    // Create shared link
                    try {
                        const sharedLink = await createSharedLink(bestMockup.id);
                        if (sharedLink && sharedLink.download_url) {
                            downloadUrl = sharedLink.download_url;
                        } else if (sharedLink && sharedLink.url) {
                            const hashMatch = sharedLink.url.match(/\/s\/([a-z0-9]+)$/);
                            if (hashMatch) {
                                downloadUrl = `https://northwestcustomapparel.box.com/shared/static/${hashMatch[1]}.${bestMockup.extension}`;
                            }
                        }
                        sharedLinksCreated++;
                        await sleep(DELAY_BETWEEN_LINK_CREATES);
                    } catch (linkErr) {
                        if (linkErr.response?.status === 409) {
                            // Conflict = link already exists, fetch it
                            const details = await getFileDetails(bestMockup.id);
                            if (details.shared_link) {
                                const hashMatch = details.shared_link.url.match(/\/s\/([a-z0-9]+)$/);
                                if (hashMatch) {
                                    downloadUrl = `https://northwestcustomapparel.box.com/shared/static/${hashMatch[1]}.${details.extension}`;
                                }
                            }
                            sharedLinksExisting++;
                        } else {
                            console.error(`    ❌ #${designNumber}: Failed to create shared link: ${linkErr.message}`);
                            errors++;
                        }
                    }
                } else {
                    // Dry run — just note it needs a link
                    if (VERBOSE) {
                        console.log(`    #${designNumber}: Would create shared link on "${bestMockup.name}"`);
                    }
                }

                if (downloadUrl) {
                    mockupMapping[designNumber] = downloadUrl;
                    mockupsFound++;
                    if (VERBOSE) {
                        console.log(`    ✓ #${designNumber}: ${bestMockup.name} → ${downloadUrl.substring(0, 60)}...`);
                    }
                } else if (DRY_RUN) {
                    mockupsFound++; // Count as found even in dry run
                }
            }

            scanned++;

            // Progress every 200 folders
            if (scanned % 200 === 0) {
                const elapsed = ((Date.now() - startScan) / 1000).toFixed(0);
                const rate = (scanned / (elapsed || 1)).toFixed(1);
                console.log(`  Progress: ${scanned}/${foldersToScan.length} folders | ${mockupsFound} mockups | ${sharedLinksCreated} links created | ${elapsed}s (${rate}/sec)`);

                // Save progress periodically
                if (!DRY_RUN && Object.keys(mockupMapping).length > 0) {
                    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(mockupMapping, null, 2));
                    fs.writeFileSync(PROGRESS_FILE, JSON.stringify({
                        lastOffset: RESUME_OFFSET + i,
                        timestamp: new Date().toISOString(),
                        mockupsFound: Object.keys(mockupMapping).length
                    }));
                }
            }

            await sleep(DELAY_BETWEEN_FOLDERS);

        } catch (err) {
            errors++;
            if (err.response?.status === 401) {
                console.error('\n❌ FATAL: Box token expired! Use --resume=' + (RESUME_OFFSET + i) + ' to continue after getting a new token.');
                // Save progress before exit
                if (Object.keys(mockupMapping).length > 0) {
                    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(mockupMapping, null, 2));
                    console.log(`  Saved ${Object.keys(mockupMapping).length} mappings before exit.`);
                }
                process.exit(1);
            }
            if (err.response?.status === 429) {
                console.warn(`  ⚠ Rate limited at folder ${scanned}. Waiting 30 seconds...`);
                await sleep(30000);
                i--; // Retry this folder
                continue;
            }
            if (errors <= 20) {
                console.error(`    ❌ #${designNumber}: ${err.response?.status || ''} ${err.message}`);
            }
        }
    }

    // -----------------------------------------------
    // Step 3: Save results
    // -----------------------------------------------
    const scanTime = ((Date.now() - startScan) / 1000).toFixed(1);

    if (!DRY_RUN && Object.keys(mockupMapping).length > 0) {
        // Ensure data directory exists
        const dataDir = path.dirname(OUTPUT_FILE);
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

        fs.writeFileSync(OUTPUT_FILE, JSON.stringify(mockupMapping, null, 2));
        console.log(`\n💾 Saved ${Object.keys(mockupMapping).length} mappings to ${OUTPUT_FILE}`);
    }

    // Clean up progress file
    if (fs.existsSync(PROGRESS_FILE)) {
        fs.unlinkSync(PROGRESS_FILE);
    }

    // -----------------------------------------------
    // Summary
    // -----------------------------------------------
    console.log('\n' + '='.repeat(60));
    console.log('SCAN COMPLETE');
    console.log(`  Folders scanned: ${scanned.toLocaleString()}`);
    console.log(`  Mockups found: ${mockupsFound.toLocaleString()}`);
    console.log(`  Shared links already existed: ${sharedLinksExisting.toLocaleString()}`);
    console.log(`  Shared links created: ${sharedLinksCreated.toLocaleString()}`);
    console.log(`  No mockup pattern: ${noMockup.toLocaleString()}`);
    console.log(`  Errors: ${errors}`);
    console.log(`  Scan time: ${scanTime}s`);
    console.log(`  Output: ${Object.keys(mockupMapping).length} design → URL mappings`);

    if (DRY_RUN) {
        console.log('\nDRY RUN — No shared links created, no file saved.');
        console.log('To create links and save: remove --dry-run flag');
    }

    // Sample entries
    const sample = Object.entries(mockupMapping).slice(0, 5);
    if (sample.length > 0) {
        console.log('\n  Sample mappings:');
        for (const [dn, url] of sample) {
            console.log(`    Design #${dn} → ${url.substring(0, 70)}...`);
        }
    }

    console.log('='.repeat(60));
}

main().catch(err => {
    console.error('\n💥 FATAL ERROR:', err.message);
    if (err.response?.data) console.error('  API response:', JSON.stringify(err.response.data).substring(0, 500));
    process.exit(1);
});
