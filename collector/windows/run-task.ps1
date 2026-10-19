# What the scheduled task runs. Logs to %LOCALAPPDATA%\sb-plant-breakdown-collector\logs
# and keeps 90 days of logs. Exit code is the collector's exit code.
param(
  [string]$CollectorDir = (Split-Path -Parent $PSScriptRoot),
  [switch]$Headless
)
$ErrorActionPreference = 'Stop'
$base = Join-Path $env:LOCALAPPDATA 'sb-plant-breakdown-collector'
$logs = Join-Path $base 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
Get-ChildItem $logs -File | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-90) } | Remove-Item -Force

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$log = Join-Path $logs "run-$stamp.log"
$err = Join-Path $logs "run-$stamp.err"
$nodeArgs = @('src/collect.mjs', '--config', 'config.local.json')
if ($Headless) { $nodeArgs += '--headless' }

Push-Location $CollectorDir
try {
  $p = Start-Process -FilePath 'node' -ArgumentList $nodeArgs -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput $log -RedirectStandardError $err
  $code = $p.ExitCode
} finally { Pop-Location }
Add-Content -Path (Join-Path $logs 'task.log') -Value ("{0}  exit {1}  {2}" -f (Get-Date -Format s), $code, (Split-Path $log -Leaf))
exit $code
