// Opening Shopify's "Export report" dialog from either header layout, against a
// local mock page. Skipped where no Playwright browser is installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openExportDialog } from '../collector/src/browser.mjs';

let chromium = null;
try { ({ chromium } = await import('playwright')); } catch { /* not installed here */ }

const MENU = `<button style="width:0;height:0;padding:0;border:0;overflow:hidden;font-size:0">More actions</button>
  <header><button>Enable auto refresh</button><button id=m>More actions</button>
  <div id=menu role=menu hidden><button role=menuitem>Rename</button><button role=menuitem id=x>Export</button><button role=menuitem>Delete</button></div></header>
  <div hidden><button role=menuitem>Export</button><button>Export</button></div><div id=log></div>
  <script>m.onclick=()=>menu.hidden=false;document.querySelectorAll('[role=menuitem]').forEach(e=>e.onclick=()=>log.textContent=e.textContent)</script>`;
const HEADER = `<button id=e>Export</button><button>More actions</button><div id=log></div><script>e.onclick=()=>log.textContent='Export'</script>`;

test('opens Export from "More actions" (Nov 2026 layout) or the header button (older layout)', async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch { t.skip('no Playwright browser here'); return; }
  try {
    const page = await browser.newPage();
    await page.setContent(MENU);
    assert.equal(await openExportDialog(page), 'menu');
    assert.equal(await page.textContent('#log'), 'Export', 'only the Export menu item is clicked');
    await page.setContent(HEADER);
    assert.equal(await openExportDialog(page), 'header');
    await page.setContent('<button>Share</button>');
    await assert.rejects(openExportDialog(page), /Export not found/);
  } finally { await browser.close(); }
});
