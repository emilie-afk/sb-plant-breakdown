// index.html structure: every tab panel and modal must sit directly in <body>.
// A missing </div> once nested the Data & imports tab and the snapshot modal
// inside the hidden Cross-channel panel, so they rendered blank.
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
  assert.ok(ids.includes('tab-data') && ids.includes('tab-cross') && ids.includes('manage-modal'));
  for (const id of ids) assert.match(tops, new RegExp('id="' + id + '"'), id + ' is nested inside another element');
});
