# Read-only status of the scheduled collector task. Changes nothing.
#
#   powershell -ExecutionPolicy Bypass -File .\check-task.ps1
#
# A run counts as a VERIFIED SCHEDULED RUN only when all of these line up for
# ONE task instance (Task Scheduler's InstanceId):
#   1. event 107  Task Scheduler launched the instance because of its TIME trigger
#                 (a run started by hand logs event 110 instead)
#   2. event 100  the instance started
#   3. event 201  its action finished with result code 0
#   4. event 102  the instance completed
#   5. run-task.ps1 wrote a collector log during that instance, logged
#      "exit 0" for it in task.log, and the log ends "done (exit 0)" with every
#      period uploaded (succeeded) or unchanged (identical data)
# Start time alone is never enough. If Windows' Task Scheduler history
# (Microsoft-Windows-TaskScheduler/Operational) is off, the answer is
# NOT VERIFIED. Turning it on needs an administrator: Task Scheduler >
# Action > "Enable All Tasks History" (this script never changes it).
param([string]$TaskName = 'SB plant-breakdown collector', [int]$Instances = 5)
$ErrorActionPreference = 'Stop'
$t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $t) { Write-Host "NOT INSTALLED: no task named '$TaskName'." -ForegroundColor Red; exit 1 }
$i = $t | Get-ScheduledTaskInfo
$trig = $t.Triggers | Select-Object -First 1
$start = [datetimeoffset]::Parse($trig.StartBoundary)
$codes = @{ 0 = 'success'; 267009 = 'still running'; 267011 = 'has not run yet'; 267014 = 'terminated by a person';
            5 = 'collector exit 5: another run held the lock'; 10 = 'collector exit 10: config';
            20 = 'collector exit 20: Shopify sign-in needed'; 21 = 'collector exit 21: human check'; 22 = 'collector exit 22: unexpected page';
            30 = 'collector exit 30: export failed'; 31 = 'collector exit 31: upload failed'; 34 = 'collector exit 34: file failed checks';
            35 = 'collector exit 35: browser profile in use by another program' }
function Describe($c) { $n = [int64]$c; $d = $codes[[int]($n -band 0x7fffffff)]; if ($n -le 0x7fffffff -and $d) { "$n ($d)" } else { "$n (0x{0:X})" -f $n } }

Write-Host "Task:        $TaskName"
Write-Host "State:       $($t.State)   Enabled: $($t.Settings.Enabled)"
Write-Host ("Trigger:     daily at {0:HH:mm} (UTC{1}), every {2} day(s); PC time zone {3}" -f $start.LocalDateTime, $start.ToString('zzz'), $trig.DaysInterval, (Get-TimeZone).Id)
$interactive = $t.Principal.LogonType -eq 'Interactive'
Write-Host ("Runs as:     {0} ({1}){2}" -f $t.Principal.UserId, $t.Principal.LogonType,
  $(if ($interactive) { ' - only while this user is signed in to Windows (a locked screen is fine; signed out or PC off = no run)' } else { '' }))
Write-Host ("Next run:    {0:yyyy-MM-dd HH:mm}" -f $i.NextRunTime)
Write-Host ("Last run:    {0:yyyy-MM-dd HH:mm:ss}   result {1}   missed runs {2}" -f $i.LastRunTime, (Describe $i.LastTaskResult), $i.NumberOfMissedRuns)

# ---- collector logs written by run-task.ps1 --------------------------
$logs = Join-Path $env:LOCALAPPDATA 'sb-plant-breakdown-collector\logs'
$taskLog = @{}
if (Test-Path (Join-Path $logs 'task.log')) {
  Get-Content (Join-Path $logs 'task.log') | ForEach-Object { if ($_ -match '^(\S+)\s+exit\s+(-?\d+)\s+(\S+)') { $taskLog[$Matches[3]] = [int]$Matches[2] } }
}
$runLogs = @(Get-ChildItem $logs -Filter 'run-*.log' -ErrorAction SilentlyContinue | ForEach-Object {
  if ($_.Name -match '^run-(\d{8}-\d{6})\.log$') { [pscustomobject]@{ File = $_; Start = [datetime]::ParseExact($Matches[1], 'yyyyMMdd-HHmmss', $null) } }
})
function CollectorVerdict($log) {
  $lines = Get-Content $log.File.FullName
  $exit = if ($taskLog.ContainsKey($log.File.Name)) { $taskLog[$log.File.Name] } else { $null }
  $done0 = [bool]($lines | Select-String -SimpleMatch 'done (exit 0)')
  $ups = @($lines | Select-String -Pattern 'uploaded: (succeeded|unchanged)')
  $bad = @($lines | Select-String -Pattern 'upload failed|refused before upload|export_failed|validation_failed|sign_in|captcha')
  [pscustomobject]@{ TaskLogExit = $exit; Done0 = $done0; Uploads = $ups.Count; Problems = $bad.Count;
                     Ok = ($exit -eq 0 -and $done0 -and $ups.Count -gt 0 -and $bad.Count -eq 0) }
}

# ---- Task Scheduler history --------------------------------------------
$hist = $null
try { $hist = Get-WinEvent -ListLog 'Microsoft-Windows-TaskScheduler/Operational' } catch { }
Write-Host ''
if (-not $hist -or -not $hist.IsEnabled) {
  Write-Host 'Task Scheduler history: OFF' -ForegroundColor Yellow
  Write-Host 'NOT VERIFIED: without Task Scheduler history a scheduled run cannot be told apart from one started by hand.' -ForegroundColor Yellow
  Write-Host 'To turn it on (administrator): Task Scheduler > Action > "Enable All Tasks History". Runs before that stay unverified.'
  $latest = $runLogs | Sort-Object Start | Select-Object -Last 1
  if ($latest) {
    $v = CollectorVerdict $latest
    Write-Host ("Latest collector log from the task: {0}  task.log exit {1}  done(exit 0) {2}  uploads ok {3}" -f $latest.File.Name, $v.TaskLogExit, $v.Done0, $v.Uploads)
  }
  exit 2
}

$path = '\' + $TaskName
$ev = @(Get-WinEvent -LogName 'Microsoft-Windows-TaskScheduler/Operational' -MaxEvents 3000 -ErrorAction SilentlyContinue |
  Where-Object { $_.Id -in 100, 102, 107, 110, 201 } | ForEach-Object {
    $x = [xml]$_.ToXml(); $d = @{}
    $x.Event.EventData.Data | ForEach-Object { $d[$_.Name] = $_.'#text' }
    if ($d['TaskName'] -eq $path) {
      [pscustomobject]@{ Id = $_.Id; Time = $_.TimeCreated; Instance = ($d['InstanceId'], $d['TaskInstanceId'] | Where-Object { $_ } | Select-Object -First 1); Result = $d['ResultCode'] }
    }
  })
$byInst = $ev | Group-Object Instance | Sort-Object { ($_.Group | Measure-Object Time -Minimum).Minimum } -Descending | Select-Object -First $Instances
Write-Host "Task Scheduler history: ON ($($ev.Count) events for this task)"
if (-not $byInst) { Write-Host 'NOT VERIFIED: no runs of this task are in the history yet.' -ForegroundColor Yellow; exit 2 }

$verified = $null
foreach ($g in $byInst) {
  $e = $g.Group
  $get = { param($id) $e | Where-Object Id -eq $id | Select-Object -First 1 }
  $e107 = & $get 107; $e110 = & $get 110; $e100 = & $get 100; $e201 = & $get 201; $e102 = & $get 102
  $how = if ($e107) { 'time trigger (107)' } elseif ($e110) { 'started by hand (110)' } else { 'trigger unknown' }
  $log = $null
  if ($e100) {
    $until = if ($e102) { $e102.Time } else { (Get-Date) }
    $log = $runLogs | Where-Object { $_.Start -ge $e100.Time.AddSeconds(-5) -and $_.Start -le $until } | Sort-Object Start | Select-Object -First 1
  }
  $cv = if ($log) { CollectorVerdict $log } else { $null }
  # ResultCode can be a large unsigned value (e.g. 0x80070014), so compare as Int64.
  $res = if ($e201 -and $e201.Result -ne $null) { [int64]$e201.Result } else { $null }
  $ok = $e107 -and -not $e110 -and $e100 -and ($res -eq 0) -and $e102 -and $cv -and $cv.Ok
  Write-Host ("  {0:yyyy-MM-dd HH:mm:ss}  {1,-22} action result {2,-6} completed {3,-5} log {4,-24} {5}" -f
    ($e | Measure-Object Time -Minimum).Minimum, $how, $(if ($res -ne $null) { if ($res -gt 255) { '0x{0:X}' -f $res } else { $res } } else { '-' }), [bool]$e102,
    $(if ($log) { $log.File.Name } else { '(none)' }),
    $(if ($cv) { "task.log exit $($cv.TaskLogExit), uploads ok $($cv.Uploads), problems $($cv.Problems)" } else { '' }))
  if ($ok -and -not $verified) { $verified = [pscustomobject]@{ At = $e100.Time; Log = $log.File.Name; Instance = $g.Name } }
}
Write-Host ''
if ($verified) {
  Write-Host ("VERIFIED SCHEDULED RUN: instance {0} started {1:yyyy-MM-dd HH:mm:ss} by the time trigger; action result 0; completed; collector log {2} exit 0 with every period uploaded or unchanged." -f $verified.Instance, $verified.At, $verified.Log) -ForegroundColor Green
  exit 0
}
Write-Host 'NOT VERIFIED: no recent instance has a time trigger, result 0, completion and a clean collector log together.' -ForegroundColor Yellow
exit 2
