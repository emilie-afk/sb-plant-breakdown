# Prepare the three narrow keys the Netlify gateway uses: manual uploads,
# settings changes, and the sign-in attempt counters.
# PREPARED FOR APPROVAL: run it yourself, by hand, from the worker folder, only
# after the rollout is approved (docs/security.md, step 2).
#
#   powershell -ExecutionPolicy Bypass -File .\add-gateway-keys.ps1            # dry run: says what it would do
#   powershell -ExecutionPolicy Bypass -File .\add-gateway-keys.ps1 -Apply
#
# For each of UPLOAD_SECRET (manual report uploads only), SETTINGS_SECRET
# (shared-settings writes only) and AUTH_SECRET (sign-in attempt counters only;
# needs migration 0006):
#   - if Windows Credential Manager already holds it (sb-pb-upload /
#     sb-pb-settings), the SAME value is set on the Worker again;
#   - otherwise a new random 64-hex-character key is generated, stored in
#     Credential Manager and set as a Cloudflare secret.
# INGEST_SECRET, VIEWER_SECRET and DASHBOARD_SECRET are NOT touched, so the
# collector and the current dashboard keep working. Keys are never printed.
# Then put them in Netlify (scope: Functions) as WORKER_UPLOAD_SECRET,
# WORKER_SETTINGS_SECRET and WORKER_AUTH_SECRET, copying each with:
#   (Get-StoredCredential -Target sb-pb-upload).GetNetworkCredential().Password | Set-Clipboard
param([switch]$Apply)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$env:CI = 'true'
if (-not (Test-Path (Join-Path $PSScriptRoot 'wrangler.local.toml'))) { Write-Host 'FAILED: wrangler.local.toml not found.' -ForegroundColor Red; exit 1 }
Import-Module CredentialManager
$plan = @(@{ Secret = 'UPLOAD_SECRET'; Target = 'sb-pb-upload' }, @{ Secret = 'SETTINGS_SECRET'; Target = 'sb-pb-settings' }, @{ Secret = 'AUTH_SECRET'; Target = 'sb-pb-auth' })
$values = @{}
foreach ($k in $plan) {
  $c = Get-StoredCredential -Target $k.Target -ErrorAction SilentlyContinue
  if ($c) { Write-Host "$($k.Secret): stored as $($k.Target); the same value will be set on the Worker" ; if ($Apply) { $values[$k.Secret] = $c.GetNetworkCredential().Password } }
  else {
    Write-Host "$($k.Secret): not stored; a new key will be generated and stored as $($k.Target)"
    if ($Apply) {
      $b = New-Object byte[] 32; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
      $v = ($b | ForEach-Object { $_.ToString('x2') }) -join ''
      New-StoredCredential -Target $k.Target -UserName $k.Secret -Password $v -Persist LocalMachine | Out-Null
      $values[$k.Secret] = $v
    }
  }
}
if (-not $Apply) { Write-Host 'Dry run: nothing changed. Add -Apply to do it.'; exit 0 }
$tmp = Join-Path $env:TEMP ("pb-gw-" + [guid]::NewGuid().ToString('N') + ".json")
[System.IO.File]::WriteAllText($tmp, ($values | ConvertTo-Json -Compress))
try {
  icacls $tmp /inheritance:r /grant:r "$($env:USERNAME):F" | Out-Null
  $o = cmd /c "npx --yes wrangler@3 secret bulk `"$tmp`" --config wrangler.local.toml 2>&1" | Out-String
  $rc = $LASTEXITCODE
} finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
foreach ($v in $values.Values) { $o = $o -replace [regex]::Escape($v), '<redacted>' }
$values = $null
if ($rc -ne 0) { Write-Host $o; Write-Host 'FAILED: setting the Worker secrets.' -ForegroundColor Red; exit 1 }
Write-Host 'Set on the Worker. Next: verify-worker.ps1, then the Netlify variables (docs/security.md).' -ForegroundColor Green
exit 0
