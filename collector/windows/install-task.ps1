# Proposes, installs or removes the Windows scheduled task. NOTHING is
# scheduled unless you pass -Apply.
#
#   .\install-task.ps1                      # show the proposed task, change nothing
#   .\install-task.ps1 -At 16:00 -Apply     # create / update it (daily at 16:00 local PC time)
#   .\install-task.ps1 -Uninstall           # remove it
#
# -At is the PC's local time. Choose a time at least one hour after midnight
# in America/Los_Angeles so "yesterday" in the store's calendar is complete:
# 07:15 Pacific time, which is 21:15 or 22:15 at UTC+7 depending on US
# daylight saving; any time from about 16:00 at UTC+7 works year-round. The
# collector itself always computes dates in America/Los_Angeles.
param(
  [string]$TaskName = 'SB plant-breakdown collector',
  [string]$At,
  [switch]$Apply,
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$runner = Join-Path $PSScriptRoot 'run-task.ps1'
$action = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$runner`""

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed scheduled task '$TaskName'."
  } else { Write-Host "No scheduled task named '$TaskName'." }
  exit 0
}

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Write-Host "Task name : $TaskName"
Write-Host "Runs      : $action"
Write-Host "As        : the signed-in user ($env:USERNAME), only while signed in (the browser needs a desktop)"
Write-Host "Trigger   : daily at $(if ($At) { $At } else { '<choose with -At HH:mm>' }) local time, plus a catch-up run when the PC was off"
Write-Host "Limits    : 2 h per run, never two runs at once"
Write-Host "Currently : $(if ($existing) { 'installed (' + $existing.State + ')' } else { 'not installed' })"

if (-not $Apply) { Write-Host "`nNothing changed. Add -At HH:mm -Apply to install."; exit 0 }
if (-not $At) { throw 'Pass -At HH:mm (local PC time) together with -Apply.' }

$a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$runner`""
$t = New-ScheduledTaskTrigger -Daily -At $At
$s = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2)
$p = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
if ($existing) {
  Set-ScheduledTask -TaskName $TaskName -Action $a -Trigger $t -Settings $s -Principal $p | Out-Null
  Write-Host "Updated '$TaskName'."
} else {
  Register-ScheduledTask -TaskName $TaskName -Action $a -Trigger $t -Settings $s -Principal $p | Out-Null
  Write-Host "Installed '$TaskName'."
}
