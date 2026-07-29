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
 * WHY NOT REUSE THE POSTMAN SCANNER (scripts/update-postman-collection.js)
 * It only matches `router.<verb>(`, and it derives full paths loosely. Verified against
 * source on 2026-07-29, it was wrong three ways:
 *   - policy-comments.js declares publicRouter/adminRouter → scanner found 0 of its 9
 *   - shipstation.js's webhookRouter route → missed (8 of 9)
 *   - vision.js paths recorded as /api/extract-* when they mount under /api/vision/*
 * Those 10 endpoints are therefore also missing from / wrong in the Postman collection.
 * This script matches ANY `<name>Router.<verb>(` and resolves prefixes from server.js's
 * actual app.use() calls, so the map is right by construction.
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

// Comments only — never touch string contents (a naive /*…*/ strip ate 3 real routes
// out of vision.js while this was being written).
function stripComments(src) {
  return src
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => (m.includes('router.') ? m : ''));
}

// ── 1. server.js: local identifier → { file, exportName } ──────────────────────
const server = stripComments(read(path.join(ROOT, 'server.js')));
const idToRouter = new Map();

// const NAME = require('./src/routes/FILE')
for (const m of server.matchAll(/const\s+(\w+)\s*=\s*require\(['"]\.\/src\/routes\/([\w-]+)['"]\)/g)) {
  idToRouter.set(m[1], { file: `${m[2]}.js`, exportName: null });   // null = default export
}
// const { a: alias, b } = require('./src/routes/FILE')
for (const m of server.matchAll(/const\s*\{([^}]+)\}\s*=\s*require\(['"]\.\/src\/routes\/([\w-]+)['"]\)/g)) {
  for (const part of m[1].split(',')) {
    const [orig, alias] = part.split(':').map((s) => s.trim());
    if (orig) idToRouter.set(alias || orig, { file: `${m[2]}.js`, exportName: orig });
  }
}

// ── 2. server.js: app.use('<prefix>', …identifier…) → mounts per (file, exportName) ──
const mounts = new Map();          // "file::exportName" → Set(prefix)
const key = (f, e) => `${f}::${e || 'default'}`;
for (const m of server.matchAll(/app\.use\(\s*['"](\/[^'"]*)['"]\s*,([^;]*?)\)\s*;/g)) {
  const prefix = m[1];
  for (const ref of m[2].matchAll(/\b(\w+)(?:\.(\w+))?\b/g)) {
    const info = idToRouter.get(ref[1]);
    if (!info) continue;
    // shipstationRoutes.webhookRouter → exportName webhookRouter; bare id → its own
    const exportName = ref[2] || info.exportName;
    const k = key(info.file, exportName);
    if (!mounts.has(k)) mounts.set(k, new Set());
    mounts.get(k).add(prefix);
  }
}

// ── 3. Each route file: which router variable declares which paths ─────────────
const DECL = /\b(\w*[Rr]outer)\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]*)['"`]/g;
const files = fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.js')).sort();

const result = [];
const unresolved = [];
let totalEndpoints = 0;

for (const file of files) {
  const src = stripComments(read(path.join(ROUTES_DIR, file)));
  const defaultVar = (src.match(/module\.exports\s*=\s*(\w+)\s*;/) || [])[1] || 'router';
  const byVar = new Map();
  for (const d of src.matchAll(DECL)) {
    const [, varName, verb, routePath] = d;
    if (!byVar.has(varName)) byVar.set(varName, []);
    byVar.get(varName).push({ verb: verb.toUpperCase(), routePath });
  }
  // Every prefix this file is mounted at, whatever the export name — the fallback for
  // factory-built routers (policies.js exports buildRouter() twice as publicRouter and
  // adminRouter, so the SAME `router` var really is served at both prefixes).
  const allFilePrefixes = new Set();
  for (const [k, set] of mounts) {
    if (k.startsWith(`${file}::`)) for (const p of set) allFilePrefixes.add(p);
  }

  const endpoints = [];
  const seen = new Set();
  for (const [varName, list] of byVar) {
    // Prefer the router's own export name, then the file's default export, then every
    // mount the file has (factory pattern). Never guess beyond that.
    const prefixes = mounts.get(key(file, varName))
                  || (varName === defaultVar ? mounts.get(key(file, null)) : null)
                  || (allFilePrefixes.size ? allFilePrefixes : null);
    for (const { verb, routePath } of list) {
      if (!prefixes || prefixes.size === 0) {
        unresolved.push(`${file}  ${verb} ${routePath}  (router var: ${varName} — no app.use() found)`);
        endpoints.push({ verb, full: `(unmounted) ${routePath}` });
        continue;
      }
      for (const p of prefixes) {
        const full = (p + routePath).replace(/\/+$/, '') || p;
        const sig = `${verb} ${full}`;
        if (seen.has(sig)) continue;   // same path declared in both factory branches
        seen.add(sig);
        endpoints.push({ verb, full });
      }
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
