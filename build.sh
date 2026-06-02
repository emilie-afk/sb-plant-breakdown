#!/usr/bin/env bash
# Netlify build step:
#   1. Inline genus-data.js + app.js into index.html (so they're encrypted too)
#   2. Run StatiCrypt on the inlined file using APP_PASSWORD
#   3. Output the encrypted single-file index.html to dist/
set -euo pipefail

if [ -z "${APP_PASSWORD:-}" ]; then
  echo "!!! APP_PASSWORD env var is not set."
  echo "    In Netlify: Site settings > Environment variables > Add APP_PASSWORD"
  exit 1
fi

echo "[1/2] Inlining JS files into index.html..."
TMP=$(mktemp -d)
node -e "
const fs = require('fs');
let html = fs.readFileSync('index.html','utf8');
const gd  = fs.readFileSync('genus-data.js','utf8');
const app = fs.readFileSync('app.js','utf8');
// IMPORTANT: pass a function as the second arg to .replace() so the file
// contents aren't interpreted as regex backreferences (\$&, \$1, etc.).
html = html.replace('<script src=\"genus-data.js\"></script>', () => '<script>' + gd + '</script>');
html = html.replace('<script src=\"app.js\"></script>',        () => '<script>' + app + '</script>');
fs.writeFileSync('$TMP/index.html', html);
console.log('  Inlined size:', html.length, 'bytes');
"

echo "[2/2] Encrypting with StatiCrypt..."
rm -rf dist
mkdir -p dist
npx staticrypt "$TMP/index.html" \
  -p "$APP_PASSWORD" \
  --short \
  -d dist
rm -rf "$TMP"

echo ""
echo "Build complete. Single encrypted file at dist/index.html"
ls -la dist/
