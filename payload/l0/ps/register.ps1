param(
  [Parameter(Mandatory=$true)][string]$TaskName,
  [Parameter(Mandatory=$true)][string]$EncodedStub,
  [Parameter(Mandatory=$true)][ValidateSet('Interactive','S4U')][string]$LogonType
)
$ErrorActionPreference = 'Stop'
$Action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -EncodedCommand $EncodedStub"
$At = (Get-Date).AddMinutes(1)
$Trigger = New-ScheduledTaskTrigger -Once -At $At
$Trigger.EndBoundary = (Get-Date).AddHours(2).ToString('s')
$Settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -DeleteExpiredTaskAfter ([TimeSpan]::FromHours(1))
$User = "$env:USERDOMAIN\$env:USERNAME"
$Principal = New-ScheduledTaskPrincipal -UserId $User -LogonType $LogonType -RunLevel Limited
try {
  Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal -Force | Out-Null
  [Console]::Out.WriteLine('register=ok')
} catch {
  [Console]::Out.WriteLine('register=failed')
  exit 0
}
try {
  Start-ScheduledTask -TaskName $TaskName
  [Console]::Out.WriteLine('start=ok')
} catch {
  [Console]::Out.WriteLine('start=failed')
}
