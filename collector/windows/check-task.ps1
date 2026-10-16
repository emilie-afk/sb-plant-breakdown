# Read-only status of the scheduled collector task. Changes nothing.
#
#   powershell -ExecutionPolicy Bypass -File .\check-task.ps1
#
# Tells a VERIFIED SCHEDULED RUN apart from a manual one:
#   - a manual collector run (node src/collect.mjs, npm run collect) does not
#     go through the task at all, so it never counts;
#   - a run of the task started by hand ("Run" in Task Scheduler,
#     Start-ScheduledTask) does go through the task, so the task's last run
#     only counts as SCHEDULED when it started within 10 minutes after the
#     trigger time, finished with result 0, and run-task.ps1 logged exit 0.
#   Windows' task-history log is often switched off; when it is on, its
#   "launched by time trigger" events are shown as extra evidence.
param([string]$TaskName = 'SB plant-breakdown collector')
$ErrorActionPreference = 'Stop'
$t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $t) { Write-Host "NOT INSTALLED: no task named '$TaskName'." -ForegroundColor Red; exit 1 }
$i = $t | Get-ScheduledTaskInfo
$trig = $t.Triggers | Select-Object -First 1
$start = [datetimeoffset]::Parse($trig.StartBoundary)
$tz = Get-TimeZone
$codes = @{ 0 = 'success'; 267009 = 'still running'; 267011 = 'has not run yet'; 267014 = 'terminated by a person';
            20 = 'collector exit 20: Shopify sign-in needed'; 21 = 'collector exit 21: human check'; 22 = 'collector exit 22: unexpected page';
            30 = 'collector exit 30: export failed'; 31 = 'collector exit 31: upload failed'; 34 = 'collector exit 34: file failed checks'; 10 = 'collector exit 10: config' }
function Describe($c) { $d = $codes[[int]$c]; if ($d) { "$c ($d)" } else { "$c (0x{0:X})" -f $c } }

Write-Host "Task:        $TaskName"
Write-Host "State:       $($t.State)   Enabled: $($t.Settings.Enabled)"
Write-Host ("Trigger:     daily at {0:HH:mm} (UTC{1}), every {2} day(s); PC time zone {3}" -f $start.LocalDateTime, $start.ToString('zzz'), $trig.DaysInterval, $tz.Id)
Write-Host "Runs as:     $($t.Principal.UserId) ($($t.Principal.LogonType); runs only while this user is signed in)"
Write-Host ("Next run:    {0:yyyy-MM-dd HH:mm}" -f $i.NextRunTime)
Write-Host ("Last run:    {0:yyyy-MM-dd HH:mm:ss}   result {1}   missed runs {2}" -f $i.LastRunTime, (Describe $i.LastTaskResult), $i.NumberOfMissedRuns)

$logs = Join-Path $env:LOCALAPPDATA 'sb-plant-breakdown-collector\logs'
$taskLog = Join-Path $logs 'task.log'
$entries = @()
if (Test-Path $taskLog) {
  $entries = Get-Content $taskLog | ForEach-Object {
    if ($_ -match '^(\S+)\s+exit\s+(-?\d+)\s+(\S+)') { [pscustomobject]@{ At = [datetime]$Matches[1]; Exit = [int]$Matches[2]; Log = $Matches[3] } }
  }
}
Write-Host ''
Write-Host 'Completed task runs (task.log, newest last):'
if ($entries) { $entries | Select-Object -Last 5 | ForEach-Object { Write-Host ("  {0:yyyy-MM-dd HH:mm:ss}  exit {1}  {2}" -f $_.At, $_.Exit, $_.Log) } } else { Write-Host '  none recorded yet' }

$evidence = @()
try {
  Get-WinEvent -LogName 'Microsoft-Windows-TaskScheduler/Operational' -MaxEvents 500 -ErrorAction Stop |
    Where-Object { $_.Id -eq 107 -and $_.Message -like "*$TaskName*" } | Select-Object -First 3 |
    ForEach-Object { $evidence += ("  {0:yyyy-MM-dd HH:mm:ss}  launched by its time trigger (event 107)" -f $_.TimeCreated) }
} catch { }

# Was the last run a verified scheduled run?
$last = $i.LastRunTime
$verdict = 'NO VERIFIED SCHEDULED RUN YET'
$why = ''
if ($i.LastTaskResult -eq 267011 -or $last.Year -lt 2000) { $why = 'the task has never run.' }
else {
  $due = $last.Date.Add($start.LocalDateTime.TimeOfDay)
  $lag = ($last - $due).TotalMinutes
  $done = $entries | Where-Object { $_.At -ge $last -and $_.At -le $last.AddHours(3) } | Select-Object -First 1
  if ($lag -lt 0 -or $lag -gt 10) { $why = ("the last run started at {0:HH:mm}, not within 10 minutes after the {1:HH:mm} trigger, so it was started by hand." -f $last, $due) }
  elseif ($i.LastTaskResult -ne 0) { $why = 'the last scheduled run finished with result ' + (Describe $i.LastTaskResult) + '.' }
  elseif (-not $done -or $done.Exit -ne 0) { $why = 'run-task.ps1 did not log exit 0 for that run.' }
  else { $verdict = 'VERIFIED SCHEDULED RUN'; $why = ("started {0:yyyy-MM-dd HH:mm:ss} by the {1:HH:mm} trigger, result 0, collector log {2}." -f $last, $due, $done.Log) }
}
Write-Host ''
Write-Host "$verdict`: $why" -ForegroundColor $(if ($verdict -like 'VERIFIED*') { 'Green' } else { 'Yellow' })
if ($evidence) { Write-Host 'Task history log:'; $evidence | ForEach-Object { Write-Host $_ } }
else { Write-Host '(Windows task history is off or has no trigger events for this task; timing above is the evidence.)' }

$latest = Get-ChildItem $logs -Filter 'run-*.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 1
if ($latest) { Write-Host ''; Write-Host "Latest task log ($($latest.Name)):"; Get-Content $latest.FullName | Select-Object -Last 12 | ForEach-Object { Write-Host "  $_" } }
