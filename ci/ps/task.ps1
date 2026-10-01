param(
  [Parameter(Mandatory=$true)][ValidateSet('control','wrong-pin','settings','ignore-new','path-quoting')][string]$Arm,
  [Parameter(Mandatory=$true)][ValidateSet('Interactive','S4U')][string]$LogonType,
  [Parameter(Mandatory=$true)][string]$Root
)
$ErrorActionPreference = 'Stop'
[IO.Directory]::CreateDirectory($Root) | Out-Null
$session = Join-Path $Root "session space's"
[IO.Directory]::CreateDirectory($session) | Out-Null
$window = Join-Path $session 'finish-window.txt'
$marker = Join-Path $session 'window-ran.txt'
$comparison = Join-Path $session 'comparison-reached.txt'
$refusal = Join-Path $session 'refusal.txt'
$ascii = New-Object Text.ASCIIEncoding
$sleepLine = if ($Arm -eq 'ignore-new') { 'Start-Sleep -Seconds 5' } else { '' }
$windowText = @"
param([Parameter(Mandatory=`$true)][string]`$SessionDir)
[IO.File]::AppendAllText((Join-Path `$SessionDir 'window-ran.txt'), "`$PID`n", (New-Object Text.ASCIIEncoding))
$sleepLine
"@
[IO.File]::WriteAllText($window, $windowText, $ascii)
$bytes = [IO.File]::ReadAllBytes($window)
$sha = [Security.Cryptography.SHA256]::Create()
try { $pin = ([BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '').ToLowerInvariant() } finally { $sha.Dispose() }
if ($Arm -eq 'wrong-pin') { $pin = ('0' * 64) }

function Ps-Literal([string]$Value) { return "'" + ($Value -replace "'", "''") + "'" }
$stub = @"
`$ErrorActionPreference = 'Stop'
`$window = $(Ps-Literal $window)
`$session = $(Ps-Literal $session)
`$comparison = $(Ps-Literal $comparison)
`$refusal = $(Ps-Literal $refusal)
`$bytes = [IO.File]::ReadAllBytes(`$window)
`$sha = [Security.Cryptography.SHA256]::Create()
try { `$actual = ([BitConverter]::ToString(`$sha.ComputeHash(`$bytes)) -replace '-', '').ToLowerInvariant() } finally { `$sha.Dispose() }
[IO.File]::WriteAllText(`$comparison, 'yes', (New-Object Text.ASCIIEncoding))
if (`$actual -ne '$pin') { [IO.File]::WriteAllText(`$refusal, 'REFUSED window fingerprint', (New-Object Text.ASCIIEncoding)); exit 9 }
`$text = (New-Object Text.UTF8Encoding(`$false, `$true)).GetString(`$bytes)
`$block = [ScriptBlock]::Create(`$text)
& `$block -SessionDir `$session
"@
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($stub))
$suffix = [Guid]::NewGuid().ToString('N').Substring(0, 10)
$taskName = "WCI $suffix"
$end = (Get-Date).AddMinutes(10)
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5)
$trigger.EndBoundary = $end.ToString('s')
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -EncodedCommand $encoded"
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType $LogonType -RunLevel Limited

try {
  $null = Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force
  if ($Arm -eq 'settings') {
    $xml = Export-ScheduledTask -TaskName $taskName
    if ($xml -notmatch '<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>') { exit 1 }
    if ($xml -notmatch '<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>') { exit 1 }
    if ($xml -notmatch '<EndBoundary>') { exit 1 }
    if ($xml -notmatch '<RunLevel>LeastPrivilege</RunLevel>') { exit 1 }
    Write-Output 'settings=proved'
    exit 0
  }
  Start-ScheduledTask -TaskName $taskName
  if ($Arm -eq 'ignore-new') { Start-ScheduledTask -TaskName $taskName }
  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline -and -not (Test-Path $marker) -and -not (Test-Path $refusal)) { Start-Sleep -Milliseconds 250 }
  if ($Arm -eq 'wrong-pin') {
    if (-not (Test-Path $comparison) -or -not (Test-Path $refusal) -or (Test-Path $marker)) { exit 1 }
    Write-Output 'wrong-pin=refused comparison=yes marker=no'
    exit 0
  }
  if (-not (Test-Path $marker)) {
    if ($Arm -eq 'control' -and $LogonType -eq 'Interactive') { Write-Output 'no-interactive-session'; exit 3 }
    exit 1
  }
  if ($Arm -eq 'ignore-new') {
    Start-Sleep -Seconds 7
    $pids = @([IO.File]::ReadAllLines($marker))
    if ($pids.Count -ne 1) { exit 1 }
  }
  if (-not (Test-Path $comparison)) { exit 1 }
  Write-Output "$Arm=proved comparison=yes"
  exit 0
} finally {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
}
