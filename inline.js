const fs = require('fs');
const out = process.argv[2];
let html = fs.readFileSync('index.html', 'utf8');
const gd  = fs.readFileSync('genus-data.js', 'utf8');
const exc = fs.readFileSync('exclusions.js', 'utf8');
const app = fs.readFileSync('app.js', 'utf8');
const lz  = fs.readFileSync('node_modules/lz-string/libs/lz-string.min.js', 'utf8');
html = html.replace(
  '<script src="https://cdn.jsdelivr.net/npm/lz-string@1.5.0/libs/lz-string.min.js"></script>',
  () => '<script>' + lz + '</script>'
);
html = html.replace('<script src="genus-data.js"></script>', () => '<script>' + gd + '</script>');
html = html.replace('<script src="exclusions.js"></script>', () => '<script>' + exc + '</script>');
html = html.replace('<script src="app.js"></script>', () => '<script>' + app + '</script>');
if (html.includes('src="genus-data.js"') || html.includes('src="exclusions.js"') ||
    html.includes('src="app.js"') || html.includes('cdn.jsdelivr.net/npm/lz-string')) {
  console.error('!!! Script inlining failed');
  process.exit(1);
}
if (!html.includes('function detectGenus') || !html.includes('manage-btn') || !html.includes('RESTRICTED_ITEMS')) {
  console.error('!!! Critical functions missing');
  process.exit(1);
}
fs.writeFileSync(out, html);
console.log('  Inlined size:', html.length, 'bytes (verified)');
