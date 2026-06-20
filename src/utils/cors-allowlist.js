// CORS origin allowlist for the proxy — pure + dependency-free so it unit-tests.
// Generous on purpose: any *.caspio.com (DataPages), any *.herokuapp.com (the
// NWCA apps), teamnwca.com (+ www), and localhost/127.0.0.1. A missing Origin
// (server-to-server: crons, curl, health checks) is always allowed. Anything
// else gets no Access-Control-Allow-Origin header → the browser blocks it.
'use strict';

const ALLOWED_ORIGIN_PATTERNS = [
    'https://www.teamnwca.com',
    'https://teamnwca.com',
    /\.caspio\.com$/,
    /\.herokuapp\.com$/,
    /^https?:\/\/localhost(:\d+)?$/,
    /^https?:\/\/127\.0\.0\.1(:\d+)?$/
];

// origin: the request Origin header (string | undefined)
// extra:  optional array of exact extra origins (e.g. from EXTRA_CORS_ORIGINS env)
function isOriginAllowed(origin, extra) {
    if (!origin) return true; // same-origin / server-to-server
    if (Array.isArray(extra) && extra.indexOf(origin) > -1) return true;
    return ALLOWED_ORIGIN_PATTERNS.some(function (p) {
        return p instanceof RegExp ? p.test(origin) : origin === p;
    });
}

module.exports = { ALLOWED_ORIGIN_PATTERNS, isOriginAllowed };
