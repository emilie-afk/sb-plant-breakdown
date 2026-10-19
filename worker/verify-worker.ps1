# Checks a deployed sb-plant-breakdown Worker. Writes nothing: every write
# probe sends a body the Worker refuses before storing anything.
#
#   powershell -ExecutionPolicy Bypass -File .\verify-worker.ps1 -Url https://sb-plant-breakdown.<account>.workers.dev
#
# Exits 0 only if ALL of these hold (otherwise exits 1 at the first failure):
#   - GET /v1/health answers HTTP 200 with ok:true
#   - GET /v1/reports without a key answers 401
#   - the viewer key stored in Windows Credential Manager (sb-pb-viewer) is
#     accepted: GET /v1/reports -> 200
#   - the new code and migration 0004 are live: /v1/reports?history=1 carries
#     the report-history fields
#   - the viewer key cannot write: ingest, settings and failure records -> 403,
#     and cannot read the collector's coverage route -> 403
#   - the collector key (sb-pb-ingest) reaches the coverage route -> 200
# Keys are read from Credential Manager and never printed.
param([Parameter(Mandatory = $true)][string]$Url, [int]$WaitSeconds = 60)
$ErrorActionPreference = 'Stop'
$Url = $Url.TrimEnd('/')
function Fail($msg) { Write-Host "FAILED: $msg" -ForegroundColor Red; exit 1 }
function Ok($msg) { Write-Host "    ok: $msg" -ForegroundColor Green }
if ($Url -notmatch '^https://[a-z0-9.-]+$') { Fail 'Url must look like https://host' }
Import-Module CredentialManager
function StoredKey([string]$target) {
  $c = Get-StoredCredential -Target $target -ErrorAction SilentlyContinue
  if ($c) { return $c.GetNetworkCredential().Password }
  return $null
}
function Status([string]$method, [string]$path, [string]$key, [string]$body) {
  $h = @{}
  if ($key) { $h['authorization'] = "Bearer $key" }
  try {
    $p = @{ Uri = "$Url$path"; Method = $method; Headers = $h; UseBasicParsing = $true; TimeoutSec = 30 }
    if ($body) { $p['Body'] = $body; $p['ContentType'] = 'application/json' }
    return [int](Invoke-WebRequest @p).StatusCode
  } catch {
    if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode.value__ }
    return 0
  }
}
# New secrets and code can take a few seconds to reach every location.
function WaitFor([scriptblock]$probe, [int]$want) {
  $deadline = (Get-Date).AddSeconds($WaitSeconds); $s = 0
  do { $s = & $probe; if ($s -eq $want) { return $s }; Start-Sleep 4 } while ((Get-Date) -lt $deadline)
  return $s
}

$viewer = StoredKey 'sb-pb-viewer'
$ingest = StoredKey 'sb-pb-ingest'
Write-Host "Verifying $Url"

$s = WaitFor { Status 'GET' '/v1/health' $null $null } 200
if ($s -ne 200) { Fail "GET /v1/health answered HTTP $s" }
try { $hj = Invoke-RestMethod "$Url/v1/health" -TimeoutSec 30 } catch { Fail 'GET /v1/health did not return JSON' }
if (-not $hj.ok) { Fail 'GET /v1/health did not report ok' }
Ok 'GET /v1/health -> 200, ok'

$s = Status 'GET' '/v1/reports' $null $null
if ($s -ne 401) { Fail "GET /v1/reports without a key answered HTTP $s (401 required)" }
Ok 'GET /v1/reports without a key -> 401'

if (-not $viewer) { Fail 'no read-only viewer key in Credential Manager (sb-pb-viewer). Run update-worker.ps1.' }
$s = WaitFor { Status 'GET' '/v1/reports' $viewer $null } 200
if ($s -ne 200) { Fail "the stored viewer key is not accepted by the Worker (GET /v1/reports -> HTTP $s)" }
Ok 'viewer key authenticates: GET /v1/reports -> 200'

try { $r = Invoke-RestMethod "$Url/v1/reports?history=1" -Headers @{ authorization = "Bearer $viewer" } -TimeoutSec 30 }
catch { Fail 'GET /v1/reports?history=1 failed' }
if ($r.reports.Count -gt 0 -and -not ($r.reports[0].PSObject.Properties.Name -contains 'completeness')) {
  Fail 'no report-history fields: the new Worker code or migration 0004 is not live'
}
Ok "report history available ($($r.reports.Count) stored revisions)"

foreach ($c in @(
    @{ m = 'POST'; p = '/v1/ingest/product-report'; b = '{}' },
    @{ m = 'PUT';  p = '/v1/settings/classification_overrides'; b = '{}' },
    @{ m = 'POST'; p = '/v1/ingest/collection-failure'; b = '{}' },
    @{ m = 'GET';  p = '/v1/ingest/coverage'; b = $null })) {
  $s = Status $c.m $c.p $viewer $c.b
  if ($s -ne 403) { Fail "viewer key: $($c.m) $($c.p) answered HTTP $s (403 required)" }
  Ok "viewer key refused: $($c.m) $($c.p) -> 403"
}

if (-not $ingest) { Fail 'no collector key in Credential Manager (sb-pb-ingest).' }
$s = Status 'GET' '/v1/ingest/coverage' $ingest $null
if ($s -ne 200) { Fail "collector key: GET /v1/ingest/coverage answered HTTP $s (200 required)" }
Ok 'collector key reaches the coverage route -> 200'
Remove-Variable viewer, ingest
Write-Host 'All Worker checks passed.' -ForegroundColor Green
exit 0
