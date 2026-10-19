// One-time (or after Shopify signs the collector out) manual sign-in.
//   npm run login
// Opens an ORDINARY browser window on the collector's own profile; a person
// signs in to Shopify (and 2FA), waits for the admin home page, closes it.
import fs from 'node:fs';
import { validateConfig, EXIT } from './lib.mjs';
import { signInWithNormalWindow } from './signin.mjs';

const cfgPath = process.argv[process.argv.indexOf('--config') + 1] || 'config.local.json';
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^﻿/, ''));
const errs = validateConfig(cfg);

async function main() {
  if (errs.length) { console.error(errs.join('\n')); return EXIT.CONFIG; }
  await signInWithNormalWindow(cfg, 0);
  console.log('Window closed. Check the sign-in with: npm run dry-run');
  return EXIT.OK;
}
main().then(c => { process.exitCode = c; }, e => { console.error(String(e && e.message || e).split('\n')[0]); process.exitCode = EXIT.CONFIG; });
