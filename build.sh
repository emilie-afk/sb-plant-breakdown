#!/usr/bin/env bash
# Netlify build step.
#   1. Inline the app scripts into one page (inline.js). Nothing secret is
#      built in: data is reached only through the signed-in same-origin
#      endpoints (netlify/functions -> server/), which hold the Worker keys.
#   2. Write dist/_headers: a Content-Security-Policy that allows exactly the
#      page's own inline scripts (by hash) plus the pinned CDN libraries, and
#      the usual hardening headers.
#   3. Check the output: no server secret value, no placeholder, no sheet or
#      storage location in the static files.
set -euo pipefail

echo "[1/4] Inlining JS files into index.html..."
rm -rf dist
mkdir -p dist
npm install lz-string@1.5.0 --no-save 2>&1 | tail -3
node inline.js dist/index.html

echo "[2/4] Verifying and copying vendored libraries (SheetJS)..."
node tools/verify-vendor.mjs --copy dist

echo "[3/4] Writing security headers..."
node tools/write-headers.mjs dist

echo "[4/4] Checking the static output for secrets and script sources..."
node tools/check-static-output.mjs dist

echo ""
echo "Build complete:"
ls -la dist/
