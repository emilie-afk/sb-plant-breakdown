// Reads a secret from Windows Credential Manager (generic credential), the same
// way sb-gross-profit does: PowerShell + the CredentialManager module. The
// secret never appears on a command line and is registered for redaction.
import { execFileSync } from 'node:child_process';
import { registerSecret } from './redact.mjs';

export function readWindowsCredential(target) {
  if (!/^[\w.-]{1,128}$/.test(target)) throw new Error('Bad credential target name.');
  if (process.platform !== 'win32') throw new Error('Windows Credential Manager is only available on Windows.');
  const script = [
    "$ErrorActionPreference='Stop'",
    'Import-Module CredentialManager',
    `$c = Get-StoredCredential -Target '${target}'`,
    "if (-not $c) { exit 3 }",
    '$p = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto([System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($c.Password))',
    '[Console]::Out.Write((@{ user = $c.UserName; secret = $p } | ConvertTo-Json -Compress))'
  ].join('; ');
  let out;
  try {
    out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (e.status === 3) throw new Error(`No credential named "${target}" in Windows Credential Manager.`);
    throw new Error(`Could not read credential "${target}" (is the CredentialManager PowerShell module installed?).`);
  }
  const v = JSON.parse(out);
  registerSecret(v.secret);
  return v;
}

// Ingest secret: Credential Manager. For a local test Worker only
// (http://127.0.0.1), an environment variable may be used instead.
export function ingestSecret(cfg) {
  const u = new URL(cfg.workerUrl);
  const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  if (local && process.env.SB_PB_LOCAL_INGEST_SECRET) {
    registerSecret(process.env.SB_PB_LOCAL_INGEST_SECRET);
    return process.env.SB_PB_LOCAL_INGEST_SECRET;
  }
  return readWindowsCredential(cfg.ingestCredentialTarget || 'sb-pb-ingest').secret;
}
