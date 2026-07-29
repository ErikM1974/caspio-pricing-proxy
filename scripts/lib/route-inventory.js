/**
 * route-inventory.js — the ONE owner of "what endpoints does this app expose?"
 *
 * WHY THIS EXISTS (2026-07-29)
 * Two tools answered that question independently and one was wrong, so the Postman
 * collection shipped with 10 endpoints missing or mis-pathed for months:
 *
 *   - `router.<verb>(` only. Files that name their routers something else are invisible:
 *     policy-comments.js (publicRouter/adminRouter) contributed 0 of its 9 endpoints,
 *     shipstation.js's webhookRouter route (POST /api/webhooks/shipstation) was missed.
 *   - fullPath was a hardcoded '/api' + the in-file path. vision.js therefore claimed
 *     /api/extract-shopworks; it actually mounts at /api/vision/extract-shopworks.
 *     Verified against production: the real path 400s (exists), the claimed one 404s.
 *
 * Both consumers — scripts/generate-routes-map.js and scripts/route-scanner.js (which
 * feeds the Postman collection) — now import this module, so the two can never disagree
 * again. It resolves prefixes from server.js's actual app.use() calls and matches ANY
 * `<name>Router.<verb>(`.
 *
 * It never guesses: a declaration it cannot map to a mount comes back with
 * fullPaths: [] and is surfaced by the caller rather than silently dropped.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

/**
 * Strip comments without eating code. A naive /*…*\/ strip removed three real routes
 * from vision.js while this was being written, so block comments containing `router.`
 * are left intact rather than risk swallowing a declaration.
 */
function stripComments(src) {
  return src
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => (m.includes('router.') ? m : ''));
}

const mountKey = (file, exportName) => `${file}::${exportName || 'default'}`;

/**
 * Parse server.js → which URL prefix(es) each router of each route file is mounted at.
 * Returns { mounts: Map<"file::export", Set<prefix>>, prefixesByFile: Map<file, Set> }.
 */
function buildMountIndex(serverPath = path.join(ROOT, 'server.js')) {
  const server = stripComments(fs.readFileSync(serverPath, 'utf8'));
  const idToRouter = new Map();

  // const NAME = require('./src/routes/FILE')            → default export
  for (const m of server.matchAll(/const\s+(\w+)\s*=\s*require\(['"]\.\/src\/routes\/([\w-]+)['"]\)/g)) {
    idToRouter.set(m[1], { file: `${m[2]}.js`, exportName: null });
  }
  // const { a: alias, b } = require('./src/routes/FILE') → named exports
  for (const m of server.matchAll(/const\s*\{([^}]+)\}\s*=\s*require\(['"]\.\/src\/routes\/([\w-]+)['"]\)/g)) {
    for (const part of m[1].split(',')) {
      const [orig, alias] = part.split(':').map((s) => s.trim());
      if (orig) idToRouter.set(alias || orig, { file: `${m[2]}.js`, exportName: orig });
    }
  }

  const mounts = new Map();
  const prefixesByFile = new Map();
  for (const m of server.matchAll(/app\.use\(\s*['"](\/[^'"]*)['"]\s*,([^;]*?)\)\s*;/g)) {
    const prefix = m[1];
    for (const ref of m[2].matchAll(/\b(\w+)(?:\.(\w+))?\b/g)) {
      const info = idToRouter.get(ref[1]);
      if (!info) continue;
      const exportName = ref[2] || info.exportName;   // shipstationRoutes.webhookRouter
      const k = mountKey(info.file, exportName);
      if (!mounts.has(k)) mounts.set(k, new Set());
      mounts.get(k).add(prefix);
      if (!prefixesByFile.has(info.file)) prefixesByFile.set(info.file, new Set());
      prefixesByFile.get(info.file).add(prefix);
    }
  }
  return { mounts, prefixesByFile };
}

const DECL = /\b(\w*[Rr]outer)\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]*)['"`]/g;

/**
 * All route declarations in one file, with their real mounted URL(s).
 *
 * @returns Array<{ varName, method, routePath, fullPaths: string[], index }>
 *          `index` is the match offset, so callers can still analyse the handler that
 *          follows it (JSDoc, query params, request body).
 */
function extractFileRoutes(fileName, content, mountIndex) {
  const src = stripComments(content);
  const defaultVar = (src.match(/module\.exports\s*=\s*(\w+)\s*;/) || [])[1] || 'router';
  const { mounts, prefixesByFile } = mountIndex;
  const allFilePrefixes = prefixesByFile.get(fileName);

  const out = [];
  for (const m of src.matchAll(DECL)) {
    const [, varName, verb, routePath] = m;
    // The router's own export name, else the file's default export, else every prefix
    // the file is mounted at — the factory case (policies.js exports buildRouter()
    // twice, so the same `router` var genuinely serves at both of its prefixes).
    const prefixes = mounts.get(mountKey(fileName, varName))
                  || (varName === defaultVar ? mounts.get(mountKey(fileName, null)) : null)
                  || allFilePrefixes
                  || new Set();
    const fullPaths = [...prefixes]
      .map((p) => (p + routePath).replace(/\/+$/, '') || p)
      .sort();
    out.push({
      varName,
      method: verb.toUpperCase(),
      routePath,
      fullPaths,               // [] ⇒ declared but never mounted; caller must surface it
      index: m.index,
    });
  }
  return out;
}

module.exports = { buildMountIndex, extractFileRoutes, stripComments };
