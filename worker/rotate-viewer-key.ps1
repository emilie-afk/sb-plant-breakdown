# Retire the read-only viewer key that older dashboard builds carried in the
# page (it is PUBLIC: treat it as known), and replace it with a new one held
# only by the Netlify gateway.
# PREPARED FOR APPROVAL: run it yourself, by hand, from the worker folder, at
# the cut-over step of docs/security.md (BEFORE any private setting is
# imported), together with setting WORKER_VIEWER_SECRET in Netlify.
#
#   powershell -ExecutionPolicy Bypass -File .\rotate-viewer-key.ps1           # dry run
#   powershell -ExecutionPolicy Bypass -File .\rotate-viewer-key.ps1 -Apply
#
# -Apply: generates a new 64-hex-character key, sets it as VIEWER_SECRET on the
# Worker (the old value stops working at once, everywhere, including every old
# public deploy that embedded it) and stores it in Credential Manager as
# sb-pb-viewer. The old value is NOT kept anywhere: an exposed key must never
# be reactivated, so there is no way back to it (rollback = fix forward or a
# new key, see docs/security.md).
# Immediately afterwards set WORKER_VIEWER_SECRET in Netlify (scope:
# Functions) to the new value and redeploy, or signed-in dashboards cannot
# read until you do:
#   (Get-StoredCredential -Target sb-pb-viewer).GetNetworkCredential().Password | Set-Clipboard
# Keys are never printed.
param([switch]$Apply)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$env:CI = 'true'
if (-not (Test-Path (Join-Path $PSScriptRoot 'wrangler.local.toml'))) { Write-Host 'FAILED: wrangler.local.toml not found.' -ForegroundColor Red; exit 1 }
Import-Module CredentialManager
$old = Get-StoredCredential -Target 'sb-pb-viewer' -ErrorAction SilentlyContinue
Write-Host ('Current viewer key: ' + $(if ($old) { 'stored as sb-pb-viewer' } else { 'not stored' }))
Write-Host 'This replaces VIEWER_SECRET on the Worker; the old key stops working immediately.'
if (-not $Apply) { Write-Host 'Dry run: nothing changed. Add -Apply to rotate.'; exit 0 }
$b = New-Object byte[] 32; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
$new = ($b | ForEach-Object { $_.ToString('x2') }) -join ''
$tmp = Join-Path $env:TEMP ("pb-viewer-" + [guid]::NewGuid().ToString('N') + ".json")
[System.IO.File]::WriteAllText($tmp, (@{ VIEWER_SECRET = $new } | ConvertTo-Json -Compress))
try {
  icacls $tmp /inheritance:r /grant:r "$($env:USERNAME):F" | Out-Null
  $o = cmd /c "npx --yes wrangler@3 secret bulk `"$tmp`" --config wrangler.local.toml 2>&1" | Out-String
  $rc = $LASTEXITCODE
} finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
$o = $o -replace [regex]::Escape($new), '<redacted>'
if ($rc -ne 0) { Write-Host $o; Write-Host 'FAILED: the Worker secret was not changed; the old key still works.' -ForegroundColor Red; exit 1 }
Remove-StoredCredential -Target 'sb-pb-viewer-previous' -ErrorAction SilentlyContinue | Out-Null   # from an older version of this script
New-StoredCredential -Target 'sb-pb-viewer' -UserName 'viewer' -Password $new -Persist LocalMachine | Out-Null
Remove-Variable new, old
Write-Host 'Rotated. Now update WORKER_VIEWER_SECRET in Netlify and redeploy, then run verify-worker.ps1.' -ForegroundColor Green
exit 0
