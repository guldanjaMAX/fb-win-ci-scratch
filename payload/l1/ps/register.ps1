$ErrorActionPreference = 'Stop'
$TaskName = '@@TASK@@'
$Encoded = '@@STUB@@'
$Action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -EncodedCommand $Encoded"
$User = "$env:USERDOMAIN\$env:USERNAME"
$At = (Get-Date).AddMinutes(1)
$Trigger = New-ScheduledTaskTrigger -Once -At $At
$Trigger.EndBoundary = (Get-Date).AddDays(2).ToString('s')
$Settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -DeleteExpiredTaskAfter ([TimeSpan]::FromDays(1))
$Principal = New-ScheduledTaskPrincipal -UserId $User -LogonType @@LOGON@@ -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal -Force | Out-Null
[Console]::Out.WriteLine('REGISTERED')
Start-ScheduledTask -TaskName $TaskName
[Console]::Out.WriteLine('STARTED')
