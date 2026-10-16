// inline.js — version 2026-10-16 (adds period engine + read-only shared-storage connection injection)
const fs = require('fs');
const out = process.argv[2];
let html = fs.readFileSync('index.html', 'utf8');
const gd  = fs.readFileSync('genus-data.js', 'utf8');
const exc = fs.readFileSync('exclusions.js', 'utf8');
const rpt = fs.readFileSync('shopify-report.js', 'utf8');
const grp = fs.readFileSync('product-grouping.js', 'utf8');
const svw = fs.readFileSync('shopify-views.js', 'utf8');
const apa = fs.readFileSync('amazon-parse.js', 'utf8');
const arp = fs.readFileSync('amazon-report.js', 'utf8');
const bui = fs.readFileSync('breakdown-ui.js', 'utf8');
const crv = fs.readFileSync('classification-review.js', 'utf8');
const avw = fs.readFileSync('amazon-views.js', 'utf8');
const ssy = fs.readFileSync('shared-sync.js', 'utf8');
const div = fs.readFileSync('data-imports-view.js', 'utf8');
const pen = fs.readFileSync('period-engine.js', 'utf8');
const pvw = fs.readFileSync('period-view.js', 'utf8');
const cgd = fs.readFileSync('channel-guard.js', 'utf8');
const app = fs.readFileSync('app.js', 'utf8');
const lz  = fs.readFileSync('node_modules/lz-string/libs/lz-string.min.js', 'utf8');
html = html.replace(
  '<script src="https://cdn.jsdelivr.net/npm/lz-string@1.5.0/libs/lz-string.min.js"></script>',
  () => '<script>' + lz + '</script>'
);
html = html.replace('<script src="genus-data.js"></script>', () => '<script>' + gd + '</script>');
html = html.replace('<script src="exclusions.js"></script>', () => '<script>' + exc + '</script>');
html = html.replace('<script src="shopify-report.js"></script>', () => '<script>' + rpt + '</script>');
html = html.replace('<script src="product-grouping.js"></script>', () => '<script>' + grp + '</script>');
html = html.replace('<script src="amazon-parse.js"></script>', () => '<script>' + apa + '</script>');
html = html.replace('<script src="amazon-report.js"></script>', () => '<script>' + arp + '</script>');
html = html.replace('<script src="breakdown-ui.js"></script>', () => '<script>' + bui + '</script>');
html = html.replace('<script src="classification-review.js"></script>', () => '<script>' + crv + '</script>');
html = html.replace('<script src="shopify-views.js"></script>', () => '<script>' + svw + '</script>');
html = html.replace('<script src="amazon-views.js"></script>', () => '<script>' + avw + '</script>');
html = html.replace('<script src="shared-sync.js"></script>', () => '<script>' + ssy + '</script>');
html = html.replace('<script src="data-imports-view.js"></script>', () => '<script>' + div + '</script>');
html = html.replace('<script src="period-engine.js"></script>', () => '<script>' + pen + '</script>');
html = html.replace('<script src="period-view.js"></script>', () => '<script>' + pvw + '</script>');
html = html.replace('<script src="channel-guard.js"></script>', () => '<script>' + cgd + '</script>');
html = html.replace('<script src="app.js"></script>', () => '<script>' + app + '</script>');
const mcgPwd = process.env.SB_MCG_PASSWORD || '';
html = html.replace('__SB_MCG_PASSWORD__', () => mcgPwd);
if (html.includes('__SB_MCG_PASSWORD__')) {
  console.error('!!! MCG password placeholder not replaced');
  process.exit(1);
}
// Read-only shared-storage connection (Worker VIEWER_SECRET). Optional: without
// it, each browser enters a key once under Data settings. Only ever the
// READ-ONLY viewer key: the page it lands in is password-encrypted, but a
// viewer key cannot write anything even if it leaked.
const sharedUrl = (process.env.SB_SHARED_URL || '').trim();
const sharedKey = (process.env.SB_SHARED_KEY || '').trim();
const attr = (v) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
// https only; plain http is accepted for a local verification build on this machine.
if (sharedUrl && !/^https:\/\/[^\s"<>]+$/.test(sharedUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(sharedUrl)) {
  console.error('!!! SB_SHARED_URL must be an https:// address'); process.exit(1);
}
if (sharedKey && sharedKey.length < 32) { console.error('!!! SB_SHARED_KEY looks too short'); process.exit(1); }
html = html.replace('__SB_SHARED_URL__', () => attr(sharedUrl));
html = html.replace('__SB_SHARED_KEY__', () => attr(sharedKey));
if (html.includes('__SB_SHARED_URL__') || html.includes('__SB_SHARED_KEY__')) {
  console.error('!!! Shared-storage placeholders not replaced');
  process.exit(1);
}
console.log('  Shared storage:', sharedUrl && sharedKey ? 'read-only connection built in' : 'not built in (each browser connects under Data settings)');
if (html.includes('src="genus-data.js"') || html.includes('src="exclusions.js"') ||
    html.includes('src="app.js"') || html.includes('src="shopify-report.js"') ||
    html.includes('src="product-grouping.js"') || html.includes('src="shopify-views.js"') ||
    html.includes('src="amazon-report.js"') || html.includes('src="amazon-parse.js"') || html.includes('src="breakdown-ui.js"') ||
    html.includes('src="classification-review.js"') || html.includes('src="amazon-views.js"') || html.includes('src="shared-sync.js"') || html.includes('src="data-imports-view.js"') || html.includes('src="period-engine.js"') || html.includes('src="period-view.js"') || html.includes('src="channel-guard.js"') ||
    html.includes('cdn.jsdelivr.net/npm/lz-string')) {
  console.error('!!! Script inlining failed');
  process.exit(1);
}
if (!html.includes('function detectGenus') || !html.includes('manage-btn') || !html.includes('RESTRICTED_ITEMS') ||
    !html.includes('parseShopifyProductReport') || !html.includes('classifyRecord') ||
    !html.includes('SBShopify') || !html.includes('SBAmazon') || !html.includes('amazonNormalizeSnapshot') ||
    !html.includes('SBFlagUI') || !html.includes('paginationBar') || !html.includes('parseAmazonMetricData') || !html.includes('SBDataImports') || !html.includes('sharedPayloadFromSnapshot') || !html.includes('periodAuthoritativeMonths') || !html.includes('SBPeriodView')) {
  console.error('!!! Critical functions missing');
  process.exit(1);
}
fs.writeFileSync(out, html);
console.log('  Inlined size:', html.length, 'bytes (v2026-10-16)');
