#!/usr/bin/env bash
# Netlify build step:
#   1. If a shared-storage connection is configured (SB_SHARED_URL /
#      SB_SHARED_KEY), confirm the key is the Worker's READ-ONLY viewer key
#   2. Inline the JS files (and that connection) into index.html
#   3. Run StatiCrypt on the inlined file using APP_PASSWORD
#   4. Check the output: encrypted, and the key does not appear in plain text
# The unencrypted intermediate file lives only in a temp folder and is deleted.
set -euo pipefail

if [ -z "${APP_PASSWORD:-}" ]; then
  echo "!!! APP_PASSWORD env var is not set."
  exit 1
fi

echo "[1/4] Checking the built-in shared-storage key (must be read-only)..."
node tools/check-viewer-key.mjs

echo "[2/4] Inlining JS files into index.html..."
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
npm install lz-string@1.5.0 --no-save 2>&1 | tail -3
node inline.js "$TMP/index.html"

echo "[3/4] Encrypting with StatiCrypt..."
rm -rf dist
mkdir -p dist
npx staticrypt "$TMP/index.html" -p "$APP_PASSWORD" --short -d dist
rm -rf "$TMP"

echo "[4/4] Checking the encrypted output..."
if ! grep -qi "staticrypt" dist/index.html; then
  echo "!!! dist/index.html does not look like a StatiCrypt page."; exit 1
fi
if [ -n "${SB_SHARED_KEY:-}" ] && grep -qF "$SB_SHARED_KEY" dist/index.html; then
  echo "!!! The shared-storage key appears in plain text in dist/index.html."; exit 1
fi
if grep -qF "parseShopifyProductReport" dist/index.html; then
  echo "!!! dist/index.html contains unencrypted app code."; exit 1
fi
echo "    encrypted; no plain-text key or app code"

echo ""
echo "Build complete. Single encrypted file at dist/index.html"
ls -la dist/
