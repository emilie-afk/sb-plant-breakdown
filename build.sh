#!/usr/bin/env bash
# Netlify build step:
#   1. Inline genus-data.js + app.js + lz-string into index.html
#   2. Run StatiCrypt on the inlined file using APP_PASSWORD
#   3. Output the encrypted single-file index.html to dist/
set -euo pipefail

if [ -z "${APP_PASSWORD:-}" ]; then
  echo "!!! APP_PASSWORD env var is not set."
  exit 1
fi

echo "[1/2] Inlining JS files into index.html..."
TMP=$(mktemp -d)
npm install lz-string@1.5.0 --no-save 2>&1 | tail -3
node inline.js "$TMP/index.html"

echo "[2/2] Encrypting with StatiCrypt..."
rm -rf dist
mkdir -p dist
npx staticrypt "$TMP/index.html" -p "$APP_PASSWORD" --short -d dist
rm -rf "$TMP"

echo ""
echo "Build complete. Single encrypted file at dist/index.html"
ls -la dist/
