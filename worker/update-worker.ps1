# Update the deployed sb-plant-breakdown Worker WITHOUT rotating its keys.
# Run it yourself, by hand, from the worker folder:
#
#   powershell -ExecutionPolicy Bypass -File .\update-worker.ps1 [-AddOrigin https://deploy-preview-<n>--<site>.netlify.app]
#
# What THIS script changes:
#   1) APPLIES pending D1 migrations (0004 adds report-history columns; it only
#      ADDS columns and fills them for existing reports, nothing is deleted)
#   2) optionally ADDS one browser origin to ALLOWED_ORIGINS in wrangler.local.toml
#   3) DEPLOYS the Worker code (wrangler deploy)
#   4) READ-ONLY VIEWER KEY: if none is stored yet, GENERATES one, sets it as
#      the VIEWER_SECRET Cloudflare secret and stores it in Windows Credential
#      Manager as sb-pb-viewer. If one is stored but the Worker rejects it, the
#      stored value is set on the Worker again (a re-sync, not a new key).
#      INGEST_SECRET and DASHBOARD_SECRET are NOT touched.
#   5) VERIFIES the deployment and STOPS WITH A NONZERO EXIT CODE unless the
#      deploy reported a workers.dev address and verify-worker.ps1 passes:
#        - GET /v1/health answers ok
#        - GET /v1/reports without a key answers 401
#        - the stored viewer key is accepted (GET /v1/reports -> 200) and the
#          new code is live (report history fields present)
#        - the viewer key CANNOT write: ingest, settings and failure records -> 403
#        - the stored collector key reaches the new coverage route (200)
#      The write checks send bodies the Worker refuses before storing anything.
# Keys are never printed; wrangler output is redacted before it is shown.
param([string]$AddOrigin = '')
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$env:CI = 'true'
$local = Join-Path $PSScriptRoot 'wrangler.local.toml'
$script:secrets = @()
function Redact([string]$s) { foreach ($x in $script:secrets) { if ($x) { $s = $s -replace [regex]::Escape($x), '<redacted>' } }; $s }
function Fail($msg, $detail) { if ($detail) { Write-Host (Redact $detail) }; Write-Host "FAILED: $msg" -ForegroundColor Red; exit 1 }
function Ok($msg) { Write-Host "    ok: $msg" -ForegroundColor Green }
if (-not (Test-Path $local)) { Fail 'wrangler.local.toml not found (it holds the database id).' }
Import-Module CredentialManager

function StoredKey([string]$target) {
  $c = Get-StoredCredential -Target $target -ErrorAction SilentlyContinue
  if ($c) { $v = $c.GetNetworkCredential().Password; $script:secrets += $v; return $v }
  return $null
}
# HTTP status of a request; never throws, never prints the key.
function Status([string]$method, [string]$url, [string]$key, [string]$body) {
  $h = @{}
  if ($key) { $h['authorization'] = "Bearer $key" }
  try {
    $p = @{ Uri = $url; Method = $method; Headers = $h; UseBasicParsing = $true; TimeoutSec = 30 }
    if ($body) { $p['Body'] = $body; $p['ContentType'] = 'application/json' }
    return [int](Invoke-WebRequest @p).StatusCode
  } catch {
    if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode.value__ }
    return 0
  }
}
function PushViewer([string]$value) {
  $tmp = Join-Path $env:TEMP ("pb-viewer-" + [guid]::NewGuid().ToString('N') + ".json")
  [System.IO.File]::WriteAllText($tmp, (@{ VIEWER_SECRET = $value } | ConvertTo-Json -Compress))
  try {
    icacls $tmp /inheritance:r /grant:r "$($env:USERNAME):F" | Out-Null
    $o = cmd /c "npx --yes wrangler@3 secret bulk `"$tmp`" --config wrangler.local.toml 2>&1" | Out-String
    $rc = $LASTEXITCODE
  } finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
  if ($rc -ne 0) { Fail 'setting VIEWER_SECRET' $o }
}

$ingest = StoredKey 'sb-pb-ingest'
$viewer = StoredKey 'sb-pb-viewer'
if (-not $ingest) { Fail 'sb-pb-ingest is not in Windows Credential Manager (run setup-cloudflare.ps1 first).' }

Write-Host '1/5 Applying pending D1 migrations...'
$o = cmd /c "npx --yes wrangler@3 d1 migrations apply sb-plant-breakdown --remote --config wrangler.local.toml 2>&1" | Out-String
if ($LASTEXITCODE -ne 0) { Fail 'migrations' $o }
Write-Host ((($o -split "`n") | Select-String -Pattern '0004|No migrations|applied' | Out-String).Trim())

if ($AddOrigin) {
  Write-Host "2/5 Allowing origin $AddOrigin ..."
  if ($AddOrigin -notmatch '^https://[a-z0-9.-]+$') { Fail 'origin must look like https://host' }
  $t = [System.IO.File]::ReadAllText($local)
  $m = [regex]::Match($t, 'ALLOWED_ORIGINS\s*=\s*"([^"]*)"')
  if (-not $m.Success) { Fail 'ALLOWED_ORIGINS not found in wrangler.local.toml' }
  $list = @($m.Groups[1].Value.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  if ($list -notcontains $AddOrigin) {
    $new = 'ALLOWED_ORIGINS = "' + (($list + $AddOrigin) -join ',') + '"'
    [System.IO.File]::WriteAllText($local, $t.Replace($m.Value, $new), (New-Object System.Text.UTF8Encoding $false))
    Ok 'origin added'
  } else { Ok 'origin already allowed' }
} else { Write-Host '2/5 No origin to add.' }

Write-Host '3/5 Deploying the Worker...'
$out = cmd /c "npx --yes wrangler@3 deploy --config wrangler.local.toml 2>&1" | Out-String
if ($LASTEXITCODE -ne 0) { Fail 'wrangler deploy' $out }
$url = ([regex]'https://[a-z0-9.-]+\.workers\.dev').Match($out).Value
if (-not $url) { Fail 'the deploy did not report a workers.dev address' $out }
Ok "deployed: $url"

Write-Host '4/5 Read-only viewer key...'
$created = $false
if (-not $viewer) {
  $b = New-Object byte[] 32; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  $viewer = ($b | ForEach-Object { $_.ToString('x2') }) -join ''
  $script:secrets += $viewer
  PushViewer $viewer
  New-StoredCredential -Target 'sb-pb-viewer' -UserName 'viewer' -Password $viewer -Persist LocalMachine | Out-Null
  $created = $true
  Ok 'created, set on the Worker, stored as sb-pb-viewer'
} else { Ok 'sb-pb-viewer already stored (checked against the Worker below)' }

Write-Host '5/5 Verifying the deployed Worker...'
# If a stored viewer key is rejected (e.g. the secret was never set on this
# Worker), set the SAME stored value again once; this is not a new key.
$s = 0; $deadline = (Get-Date).AddSeconds(60)
do { $s = Status 'GET' "$url/v1/reports" $viewer $null; if ($s -eq 200) { break }; Start-Sleep 4 } while ((Get-Date) -lt $deadline)
if ($s -eq 401 -and -not $created) {
  Write-Host '    the Worker rejects the stored viewer key; setting the stored value on the Worker again'
  PushViewer $viewer
}
& (Join-Path $PSScriptRoot 'verify-worker.ps1') -Url $url -WaitSeconds 90
if ($LASTEXITCODE -ne 0) { Write-Host 'FAILED: the deployed Worker did not pass its checks (see above).' -ForegroundColor Red; exit 1 }

Remove-Variable ingest, viewer
Write-Host ''
Write-Host 'All checks passed.' -ForegroundColor Green
Write-Host 'The dashboard reaches the Worker only through its Netlify functions (server side).'
Write-Host 'Netlify environment variables (scope: Functions ONLY, never Builds), see docs/security.md:'
Write-Host "  WORKER_URL           = $url"
Write-Host '  WORKER_VIEWER_SECRET = the read-only viewer key (sb-pb-viewer)'
Write-Host '  WORKER_UPLOAD_SECRET / WORKER_SETTINGS_SECRET: run add-gateway-keys.ps1'
Write-Host 'Copy a key without showing it:'
Write-Host '    (Get-StoredCredential -Target sb-pb-viewer).GetNetworkCredential().Password | Set-Clipboard'
Write-Host 'Never set SB_SHARED_URL / SB_SHARED_KEY again: the page must not carry a key.'
exit 0
