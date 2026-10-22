// One-time (or after Shopify signs the collector out) manual sign-in.
//   npm run login
// Opens an ORDINARY browser window on the collector's own profile; a person
// signs in to Shopify (and 2FA), waits for the admin home page, closes it.
import fs from 'node:fs';
import { validateConfig, EXIT } from './lib.mjs';
import { signInWithNormalWindow } from './signin.mjs';
import { reportUrl as shipstationUrl, clearSignInBlock } from './shipstation.mjs';
import { localPaths } from './browser.mjs';

const cfgPath = process.argv[process.argv.indexOf('--config') + 1] || 'config.local.json';
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^﻿/, ''));
const errs = validateConfig(cfg);

async function main() {
  if (errs.length) { console.error(errs.join('\n')); return EXIT.CONFIG; }
  if (process.argv.includes('--shipstation')) {
    // ShipStation refuses automated browsers at sign-in, so a person signs in
    // here, in a normal window on the collector's profile. Closing the window
    // lets the next run try the automated window once more.
    await signInWithNormalWindow(cfg, 0, console.log, { url: shipstationUrl(cfg), label: 'ShipStation' });
    clearSignInBlock(localPaths(cfg).base);
    console.log('Window closed. The next collector run will use this ShipStation sign-in.');
    return EXIT.OK;
  }
  await signInWithNormalWindow(cfg, 0);
  console.log('Window closed. Check the sign-in with: npm run dry-run');
  return EXIT.OK;
}
main().then(c => { process.exitCode = c; }, e => { console.error(String(e && e.message || e).split('\n')[0]); process.exitCode = EXIT.CONFIG; });
