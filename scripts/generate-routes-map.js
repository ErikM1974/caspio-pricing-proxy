#!/usr/bin/env node
/**
 * Generate memory/ROUTES_MAP.md — the complete route-file → endpoint inventory.
 *
 * WHY THIS EXISTS (2026-07-29)
 * The map was hand-maintained and said "All 44 route files" while src/routes/ held 121.
 * Two thirds of the API was missing from the doc that exists to answer "which file has
 * this endpoint?" — and a hand-written list of 121 files would have drifted again within
 * a month. So it is generated from source instead.
 *
 * SHARED WITH THE POSTMAN SCANNER
 * Discovery lives in scripts/lib/route-inventory.js, which scripts/route-scanner.js (the
 * Postman collection's source) also uses — so the map and the collection cannot disagree
 * about what exists. That module was written because the scanner had been wrong three
 * ways: it matched only `router.<verb>(` (missing policy-comments.js's 9 endpoints on
 * publicRouter/adminRouter and shipstation.js's webhookRouter route) and pasted a
 * hardcoded '/api' prefix (recording vision.js at /api/extract-* when it mounts at
 * /api/vision/*). Both are fixed as of 2026-07-29.
 *
 * It never guesses: anything it cannot resolve is listed under "Unresolved" in the
 * output and printed to stderr, so a gap is visible rather than silently dropped.
 *
 * Usage:  npm run routes-map
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ROUTES_DIR = path.join(ROOT, 'src', 'routes');
const OUT = path.join(ROOT, 'memory', 'ROUTES_MAP.md');

const read = (p) => fs.readFileSync(p, 'utf8');

// Discovery + mount resolution are shared with scripts/route-scanner.js (which feeds the
// Postman collection) so the map and the collection can never disagree about what exists.
const { buildMountIndex, extractFileRoutes } = require('./lib/route-inventory');
const mountIndex = buildMountIndex();

const files = fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.js')).sort();
const result = [];
const unresolved = [];
let totalEndpoints = 0;

for (const file of files) {
  const declarations = extractFileRoutes(file, read(path.join(ROUTES_DIR, file)), mountIndex);
  const endpoints = [];
  const seen = new Set();
  for (const d of declarations) {
    if (d.fullPaths.length === 0) {
      unresolved.push(`${file}  ${d.method} ${d.routePath}  (router var: ${d.varName} — no app.use() found)`);
      endpoints.push({ verb: d.method, full: `(unmounted) ${d.routePath}` });
      continue;
    }
    for (const full of d.fullPaths) {
      const sig = `${d.method} ${full}`;
      if (seen.has(sig)) continue;   // same path declared in both factory branches
      seen.add(sig);
      endpoints.push({ verb: d.method, full });
    }
  }
  endpoints.sort((a, b) => a.full.localeCompare(b.full) || a.verb.localeCompare(b.verb));
  totalEndpoints += endpoints.length;
  result.push({ file, endpoints });
}

// ── 4. Write ───────────────────────────────────────────────────────────────────
const withEps = result.filter((r) => r.endpoints.length);
const noEps = result.filter((r) => !r.endpoints.length);
const stamp = new Date().toISOString().slice(0, 10);

let md = `# Route File → Endpoint Map (generated)

> **GENERATED — do not hand-edit.** Regenerate with \`npm run routes-map\` after adding or
> moving a route; the previous hand-maintained version drifted to 44 of 121 files.
> Paths are resolved from \`server.js\`'s actual \`app.use()\` mounts, so they are the real
> URLs, not the in-file relative paths.
>
> Generated ${stamp} · **${files.length} route files · ${totalEndpoints} endpoints**

`;

if (unresolved.length) {
  md += `## ⚠ Unresolved (declared but no \`app.use()\` mount found — dead code, or mounted dynamically)\n\n`;
  for (const u of unresolved) md += `- \`${u}\`\n`;
  md += `\n`;
}

md += `## Endpoints by file\n\n`;
let letter = '';
for (const { file, endpoints } of withEps) {
  const l = file[0].toUpperCase();
  if (l !== letter) { letter = l; md += `### ${letter}\n\n`; }
  md += `**${file}** — ${endpoints.length} endpoint${endpoints.length === 1 ? '' : 's'}\n\n`;
  for (const e of endpoints) md += `- \`${e.verb.padEnd(6)} ${e.full}\`\n`;
  md += `\n`;
}

if (noEps.length) {
  md += `## Route files with no endpoints (helpers / re-exports)\n\n`;
  for (const { file } of noEps) md += `- ${file}\n`;
  md += `\n`;
}

fs.writeFileSync(OUT, md);
console.log(`Wrote ${path.relative(ROOT, OUT)}: ${files.length} files, ${totalEndpoints} endpoints`);
if (unresolved.length) {
  console.warn(`\n⚠ ${unresolved.length} unresolved route(s) — listed at the top of the map:`);
  for (const u of unresolved) console.warn(`   ${u}`);
}
