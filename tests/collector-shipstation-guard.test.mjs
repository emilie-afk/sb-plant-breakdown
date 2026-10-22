// Collector: an automated ShipStation window that did not sign in is not
// opened again until a person signs in through the normal window.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './load.mjs';
import * as SS from '../collector/src/shipstation.mjs';

// ── ShipStation: an automated window that did not work is not reopened ──
test('ShipStation sign-in block: written on failure, kept across runs, cleared after a person signs in', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssblock-'));
  assert.equal(SS.readSignInBlock(dir), null);
  const first = SS.writeSignInBlock(dir, 'ShipStation login_required', new Date('2026-10-19T09:00:00Z'));
  const again = SS.writeSignInBlock(dir, 'ShipStation login_required', new Date('2026-10-20T09:00:00Z'));
  assert.equal(again.since, first.since, 'the first failure date is kept');
  assert.ok(SS.readSignInBlock(dir).blocked);
  SS.clearSignInBlock(dir);
  assert.equal(SS.readSignInBlock(dir), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
test('collector: a blocked run skips the automated ShipStation window and says how to sign in', () => {
  const src = fs.readFileSync(path.join(ROOT, 'collector/src/collect.mjs'), 'utf8');
  const blockAt = src.indexOf('readSignInBlock(paths.base)'), openAt = src.indexOf('ss = ss || await openShipStation');
  assert.ok(blockAt > 0 && openAt > blockAt, 'the block is checked before any window opens');
  assert.match(src, /automated window not reopened; run npm run login:shipstation/);
  assert.match(src, /SS\.writeSignInBlock\(base/);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'collector/package.json'), 'utf8'));
  assert.match(pkg.scripts['login:shipstation'], /--shipstation/);
});

// ── a shared browser profile (e.g. the GP collector's signed-in Edge profile) ──
test('collector: profileDir shares an existing profile, never edits its settings, and waits while it is busy', async () => {
  const B = await import('../collector/src/browser.mjs');
  const S = await import('../collector/src/signin.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-profile-'));
  try {
    const cfg = { browserChannel: 'msedge', profileDir: dir, profileWaitMinutes: 0 };
    const p = B.localPaths(cfg);
    assert.equal(p.profile, path.resolve(dir)); assert.equal(p.sharedProfile, true);
    assert.throws(() => B.localPaths({ profileDir: 'relative/profile' }), /absolute/);
    fs.mkdirSync(path.join(dir, 'Default'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Default', 'Preferences'), JSON.stringify({ session: { restore_on_startup: 5 } }));
    assert.equal(S.keepSessionsAcrossRestarts(cfg), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'Default', 'Preferences'), 'utf8')).session.restore_on_startup, 5, 'untouched');
    assert.equal(B.profileInUse(dir), false, 'no lockfile: free');
    fs.writeFileSync(path.join(dir, 'lockfile'), '');
    assert.equal(B.profileInUse(dir), false, 'a stale lockfile nobody holds is free');
    await B.waitForProfile(cfg);   // free: returns at once
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const L = await import('../collector/src/lib.mjs');
  assert.equal(L.failureCodeFor(L.EXIT.PROFILE_BUSY), 'profile_in_use');
  const src = fs.readFileSync(path.join(ROOT, 'collector/src/collect.mjs'), 'utf8');
  assert.match(src, /openBrowser\(cfg\)\.catch\(profileBusy\)/);
  assert.match(src, /openShipStation\(cfg, browser\)\.catch\(profileBusy\)/);
});
