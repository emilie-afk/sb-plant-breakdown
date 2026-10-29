// index.html structure: every tab panel and modal must sit directly in <body>.
// A missing </div> once nested the data panel and the snapshot modal inside
// the hidden Cross-channel panel, so they rendered blank.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './load.mjs';

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/<script[\s\S]*?<\/script>/gi, '')
  .replace(/<style[\s\S]*?<\/style>/gi, '');
const body = html.slice(html.search(/<body[^>]*>/i));

function topLevelDivs(src) {
  const out = []; let depth = 0;
  const re = /<(\/?)div\b([^>]*)>/gi; let m;
  while ((m = re.exec(src))) {
    if (m[1]) { depth--; assert.ok(depth >= 0, 'extra </div> near offset ' + m.index); continue; }
    if (depth === 0) out.push(m[2]);
    depth++;
  }
  return { out, depth };
}

test('div tags in <body> are balanced', () => {
  assert.equal(topLevelDivs(body).depth, 0);
});

test('every tab panel and modal is a direct child of <body>', () => {
  const tops = topLevelDivs(body).out.join('\n');
  const ids = [...body.matchAll(/<div[^>]*class="[^"]*\b(?:tab-panel|modal)\b[^"]*"[^>]*id="([^"]+)"|<div[^>]*id="([^"]+)"[^>]*class="[^"]*\b(?:tab-panel|modal)\b/g)]
    .map(m => m[1] || m[2]);
  assert.ok(ids.includes('data-settings-modal') && ids.includes('tab-cross') && ids.includes('manage-modal'));
  for (const id of ids) assert.match(tops, new RegExp('id="' + id + '"'), id + ' is nested inside another element');
});

test('Data settings is a panel, not a navigation tab', () => {
  assert.doesNotMatch(body, /data-tab="data"/, 'no Data & imports tab in the main navigation');
  assert.doesNotMatch(body, /id="tab-data"/);
  assert.match(body, /id="data-settings-btn"/);
  // Manual upload, snapshot management and troubleshooting live inside the panel.
  const panel = body.slice(body.indexOf('id="data-settings-modal"'), body.indexOf('id="manage-modal"'));
  for (const id of ['di-root', 'shopify-dropzone', 'amazon-dropzone', 'shopify-file-input', 'amazon-file-input', 'manage-btn', 'ds-trouble', 'ds-catalog']) {
    assert.match(panel, new RegExp('id="' + id + '"'), id + ' is inside Data settings');
  }
});

test('status and period selector sit above the analysis on Shopify and Vendors', () => {
  for (const [tab, ids] of [['tab-shopify', ['sb-data-status', 'sb-period']], ['tab-vendors', ['vn-data-status', 'vn-period']]]) {
    const start = body.indexOf('id="' + tab + '"');
    const content = body.indexOf('-content"', start);
    for (const id of ids) {
      const at = body.indexOf('id="' + id + '"', start);
      assert.ok(at > start && at < content, id + ' is above the analysis in ' + tab);
    }
  }
});

test('no file input is needed on the analysis tabs during normal use', () => {
  for (const tab of ['tab-shopify', 'tab-vendors']) {
    const start = body.indexOf('id="' + tab + '"');
    const rest = body.slice(start + 10);
    const next = rest.search(/class="tab-panel\b|class="modal\b/);
    assert.doesNotMatch(rest.slice(0, next < 0 ? undefined : next), /type="file"/, tab + ' has no file input');
  }
});

test('the page has a sign-in form and a sign-out button, and no key or storage address field', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(raw, /id="sb-login-form"/); assert.match(raw, /type="password"[^>]*autocomplete="current-password"/);
  assert.match(raw, /id="sb-logout"/);
  const js = fs.readFileSync(path.join(ROOT, 'data-imports-view.js'), 'utf8');
  assert.doesNotMatch(js, /id="di-key"|id="di-url"|sb-shared-store-v1|authorization:\s*"Bearer/);
  assert.match(js, /SBAuth\.fetchJson\("\/api" \+ path/);
});

test('Data settings has three sections; technical details sit in a collapsed Advanced settings', () => {
  const panel = body.slice(body.indexOf('id="data-settings-modal"'), body.indexOf('id="manage-modal"'));
  assert.match(panel, /<details class="panel" id="ds-advanced">/, 'Advanced settings is a collapsible section, closed by default');
  assert.doesNotMatch(panel, /<details[^>]*\bopen\b/, 'collapsed by default');
  const adv = panel.slice(panel.indexOf('id="ds-advanced"'));
  for (const id of ['di-advanced', 'amazon-dropzone', 'shopify-dropzone', 'manage-btn', 'ds-trouble']) assert.match(adv, new RegExp('id="' + id + '"'));
  assert.doesNotMatch(panel, /href="#ds-connection"|href="#ds-reports"|href="#ds-upload"/, 'no row of navigation links');
  assert.equal((body.match(/id="data-settings-btn"/g) || []).length, 1, 'one Data settings button, in the header');
  const js = fs.readFileSync(path.join(ROOT, 'data-imports-view.js'), 'utf8');
  assert.doesNotMatch(js, /data-ds-open>⚙ Data settings/, 'the status strip has no second Data settings button');
  assert.match(js, /Shopify connected<\/b> · Updates automatically/);
  assert.match(js, /No Amazon reports yet/);
  assert.match(js, /expect: \["shopify"\]/, 'a missing Amazon report is not an alert');
  // The connection form is rendered into Advanced settings, not the main view.
  const render = js.slice(js.indexOf('function render()'), js.indexOf('function sourcesPanel'));
  assert.ok(render.indexOf('id="ds-connection"') > render.indexOf('var parts = [];'), 'connection form goes to the advanced list');
  assert.match(render, /advRoot\.innerHTML = parts\.join/);
});
