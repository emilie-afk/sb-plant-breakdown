// Sign-in helpers.
//
// Shopify's login page loops for an automated browser, so a person signs in
// in an ORDINARY browser window on the collector's own profile. The collector
// never types credentials and never tries to hide its automation.
//
// Shopify's sign-in cookies are session-only. Chrome keeps session cookies
// across restarts only when "On startup: Continue where you left off" is on,
// so that standard setting is switched on for the collector's own profile.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { localPaths } from './browser.mjs';

export function browserExe(cfg) {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const la = process.env.LOCALAPPDATA || '';
  const list = cfg.browserChannel === 'msedge'
    ? [path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe')]
    : [path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
       path.join(la, 'Google', 'Chrome', 'Application', 'chrome.exe')];
  return list.find(p => fs.existsSync(p)) || null;
}

// Chrome: Settings → On startup → Continue where you left off (value 1).
// Only touches the collector's own profile, and only while no browser has it open.
export function keepSessionsAcrossRestarts(cfg) {
  if (localPaths(cfg).sharedProfile) return false;   // never change another program's profile
  const prefs = path.join(localPaths(cfg).profile, 'Default', 'Preferences');
  if (!fs.existsSync(prefs)) return false;
  try {
    const j = JSON.parse(fs.readFileSync(prefs, 'utf8').replace(/^\uFEFF/, ''));
    if (j.session && j.session.restore_on_startup === 1) return true;
    j.session = Object.assign({}, j.session, { restore_on_startup: 1 });
    fs.writeFileSync(prefs, JSON.stringify(j));
    return true;
  } catch { return false; }
}

// Opens a normal window at the admin and waits until the person closes it
// (or `minutes` pass). Resolves true if the window was closed by the person.
export async function signInWithNormalWindow(cfg, minutes = 30, log = console.log, where = {}) {
  const url = where.url || cfg.adminUrl;
  const label = where.label || 'Shopify';
  const exe = cfg.browserChannel ? browserExe(cfg) : (await import('playwright')).chromium.executablePath();
  if (!exe || !fs.existsSync(exe)) throw new Error('Browser not found for browserChannel ' + cfg.browserChannel);
  const profile = localPaths(cfg).profile;
  fs.mkdirSync(profile, { recursive: true });
  // A window opened on a profile another browser is using would land in that
  // (possibly automated) browser: wait until the profile is free.
  await (await import('./browser.mjs')).waitForProfile(cfg, log);
  keepSessionsAcrossRestarts(cfg);
  log(`${label} needs a person to sign in. A normal ${cfg.browserChannel || 'Chromium'} window is opening: sign in (and 2FA), ` +
      `wait for the ${label} home page, then CLOSE that window.${minutes ? ' Waiting up to ' + minutes + ' min.' : ''}`);
  const child = spawn(exe, [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--new-window', url], { stdio: 'ignore' });
  const closed = await new Promise(res => {
    const t = minutes ? setTimeout(() => res(false), minutes * 60000) : null;
    child.on('exit', () => { if (t) clearTimeout(t); res(true); });
  });
  if (!closed) { try { child.kill(); } catch { /* already gone */ } }
  keepSessionsAcrossRestarts(cfg);
  return closed;
}
