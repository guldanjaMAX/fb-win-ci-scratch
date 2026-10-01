param([Parameter(Mandatory=$true)][string]$TaskName)
$ErrorActionPreference = 'SilentlyContinue'
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
