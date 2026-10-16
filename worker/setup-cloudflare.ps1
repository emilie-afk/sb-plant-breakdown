# Cloudflare setup for the sb-plant-breakdown Worker. Run it yourself, by hand:
#
#   cd worker
#   powershell -ExecutionPolicy Bypass -File .\setup-cloudflare.ps1
#
# BEFORE the first run (one time, by hand):
#   npx wrangler@3 login                                   # browser sign-in to Cloudflare
#   npx wrangler@3 d1 create sb-plant-breakdown            # CREATES the database
#   copy wrangler.toml wrangler.local.toml                 # put the database id in it
#   npx wrangler@3 d1 migrations apply sb-plant-breakdown --remote --config wrangler.local.toml
#                                                          # CREATES/MIGRATES the tables
#
# What THIS script changes:
#   1) DEPLOYS the Worker (wrangler deploy)                       -> live infrastructure
#   2) GENERATES two new random keys and REPLACES the Worker's
#      INGEST_SECRET and DASHBOARD_SECRET (wrangler secret bulk)  -> rotates keys
#   3) stores the same keys in Windows Credential Manager
#      (sb-pb-ingest for the collector, sb-pb-dashboard for you)  -> replaces them
#   4) writes the Worker address into collector\config.local.json
#   5) checks /v1/health and that /v1/reports refuses a request without a key
# It does not create databases, run migrations or schedule anything.
# The keys are never printed. Re-running it deploys again and ROTATES both keys,
# so the collector and every browser need the new keys afterwards.
#
# Wrangler prints warnings on stderr (e.g. "out-of-date"). Windows PowerShell
# would turn those into errors, so every wrangler call goes through cmd.exe
# and is judged by its exit code only.
Set-Location $PSScriptRoot
$env:CI = 'true'
# Account-specific settings (database id, extra origins) live in the git-ignored
# wrangler.local.toml when it exists.
$cfgArg = if (Test-Path (Join-Path $PSScriptRoot 'wrangler.local.toml')) { '--config wrangler.local.toml' } else { '' }
Import-Module CredentialManager

function NewKey { $b = New-Object byte[] 32; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); ($b | ForEach-Object { $_.ToString('x2') }) -join '' }
function Fail($msg, $detail) { if ($detail) { Write-Host $detail }; Write-Host "FAILED: $msg" -ForegroundColor Red; exit 1 }

Write-Host '1/5 Deploying the Worker...'
$out = cmd /c "npx --yes wrangler@3 deploy $cfgArg 2>&1" | Out-String
if ($LASTEXITCODE -ne 0) { Fail 'wrangler deploy' $out }
$url = ([regex]'https://[a-z0-9.-]+\.workers\.dev').Match($out).Value
if (-not $url) { Fail 'deploy did not report a workers.dev address' $out }
Write-Host "    deployed: $url"

Write-Host '2/5 Setting the two keys as Cloudflare secrets...'
$ingest = NewKey; $dash = NewKey
# One JSON file (exact values, no stray line endings), readable only by you,
# deleted straight after.
$tmp = Join-Path $env:TEMP ("pb-secrets-" + [guid]::NewGuid().ToString('N') + ".json")
[System.IO.File]::WriteAllText($tmp, (@{ INGEST_SECRET = $ingest; DASHBOARD_SECRET = $dash } | ConvertTo-Json -Compress))
try {
  icacls $tmp /inheritance:r /grant:r "$($env:USERNAME):F" | Out-Null
  $o = cmd /c "npx --yes wrangler@3 secret bulk `"$tmp`" $cfgArg 2>&1" | Out-String
  $rc = $LASTEXITCODE
} finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
if ($rc -ne 0) { Fail 'setting secrets' (($o -replace [regex]::Escape($ingest), '<redacted>') -replace [regex]::Escape($dash), '<redacted>') }

Write-Host '3/5 Storing the keys in Windows Credential Manager...'
New-StoredCredential -Target 'sb-pb-ingest'    -UserName 'worker'    -Password $ingest -Persist LocalMachine | Out-Null
New-StoredCredential -Target 'sb-pb-dashboard' -UserName 'dashboard' -Password $dash   -Persist LocalMachine | Out-Null
Remove-Variable ingest, dash

Write-Host '4/5 Pointing the collector at the Worker...'
$cfgPath = Join-Path $PSScriptRoot '..\collector\config.local.json'
$cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
$cfg.workerUrl = $url
# UTF-8 without a byte-order mark (Windows PowerShell's -Encoding UTF8 adds one)
[System.IO.File]::WriteAllText((Resolve-Path $cfgPath).Path, ($cfg | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding $false))

Write-Host '5/5 Health check (secrets can take a few seconds to apply)...'
Start-Sleep 8
try { $h = Invoke-RestMethod "$url/v1/health"; Write-Host "    $($h | ConvertTo-Json -Compress)" } catch { Write-Host "    health check failed: $($_.Exception.Message)" }
$code = try { (Invoke-WebRequest "$url/v1/reports" -UseBasicParsing).StatusCode } catch { $_.Exception.Response.StatusCode.value__ }
Write-Host "    /v1/reports without a key -> HTTP $code (401 expected)"

Write-Host ''
Write-Host "Done. Worker: $url" -ForegroundColor Green
Write-Host 'Dashboard key (copy to clipboard, then paste into Data & imports):'
Write-Host "  (Get-StoredCredential -Target sb-pb-dashboard).GetNetworkCredential().Password | Set-Clipboard"
