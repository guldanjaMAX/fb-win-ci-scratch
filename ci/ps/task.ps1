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

function Fail-Task([string]$Cmdlet, [string]$Setting, [string]$ErrorText) {
  $safe = $ErrorText -replace [regex]::Escape($Root), '[ROOT]'
  $safe = $safe -replace [regex]::Escape($taskName), '[TASK]'
  if ($user) { $safe = $safe -replace [regex]::Escape($user), '[USER]' }
  if ($env:USERNAME) { $safe = $safe -replace [regex]::Escape($env:USERNAME), '[USER]' }
  if ($env:USERDOMAIN) { $safe = $safe -replace [regex]::Escape($env:USERDOMAIN), '[DOMAIN]' }
  $safe = $safe -replace '[\r\n]+', ' '
  Write-Output "DETAIL task cmdlet=$Cmdlet setting=$Setting error=$safe"
  exit 1
}

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
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name

try {
  try {
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -EncodedCommand $encoded"
  } catch { Fail-Task 'New-ScheduledTaskAction' 'EncodedCommand' $_.Exception.Message }
  try {
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -DeleteExpiredTaskAfter ([TimeSpan]::FromDays(1))
  } catch { Fail-Task 'New-ScheduledTaskSettingsSet' 'proven-settings' $_.Exception.Message }
  try {
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType $LogonType -RunLevel Limited
  } catch { Fail-Task 'New-ScheduledTaskPrincipal' 'LogonType-RunLevel' $_.Exception.Message }
  try {
    $null = Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force
  } catch { Fail-Task 'Register-ScheduledTask' 'registration' $_.Exception.Message }
  if ($Arm -eq 'settings') {
    try { [xml]$xml = Export-ScheduledTask -TaskName $taskName }
    catch { Fail-Task 'Export-ScheduledTask' 'xml' $_.Exception.Message }
    function Read-TaskSetting([string]$Name) {
      $node = $xml.SelectSingleNode("//*[local-name()='$Name']")
      if ($null -eq $node) { return $null }
      return [string]$node.InnerText
    }
    $checks = @(
      @('MultipleInstancesPolicy', 'IgnoreNew'),
      @('ExecutionTimeLimit', 'PT0S'),
      @('StartWhenAvailable', 'true'),
      @('DisallowStartIfOnBatteries', 'false'),
      @('StopIfGoingOnBatteries', 'false'),
      @('DeleteExpiredTaskAfter', 'P1D'),
      @('RunLevel', 'LeastPrivilege')
    )
    foreach ($check in $checks) {
      $actual = Read-TaskSetting $check[0]
      # Task Scheduler omits RunLevel from the exported XML when it is the default, LeastPrivilege.
      if (($check[0] -eq 'RunLevel') -and [string]::IsNullOrEmpty($actual)) { $actual = 'LeastPrivilege' }
      if ($actual -cne $check[1]) {
        Fail-Task 'Export-ScheduledTask' $check[0] "expected=$($check[1]) actual=$actual"
      }
    }
    $endBoundary = Read-TaskSetting 'EndBoundary'
    if ([string]::IsNullOrWhiteSpace($endBoundary)) {
      Fail-Task 'Export-ScheduledTask' 'EndBoundary' 'expected=nonempty actual=empty'
    }
    Write-Output 'settings=proved'
    exit 0
  }
  try { Start-ScheduledTask -TaskName $taskName }
  catch { Fail-Task 'Start-ScheduledTask' 'first-start' $_.Exception.Message }
  if ($Arm -eq 'ignore-new') {
    try { Start-ScheduledTask -TaskName $taskName }
    catch { Fail-Task 'Start-ScheduledTask' 'ignore-new-second-start' $_.Exception.Message }
  }
  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline -and -not (Test-Path $marker) -and -not (Test-Path $refusal)) { Start-Sleep -Milliseconds 250 }
  if ($Arm -eq 'wrong-pin') {
    if (-not (Test-Path $comparison) -or -not (Test-Path $refusal) -or (Test-Path $marker)) {
      Fail-Task 'Test-Path' 'wrong-pin-decision' 'comparison-or-refusal-missing-or-marker-present'
    }
    Write-Output 'wrong-pin=refused comparison=yes marker=no'
    exit 0
  }
  if (-not (Test-Path $marker)) {
    if ($Arm -eq 'control' -and $LogonType -eq 'Interactive') { Write-Output 'no-interactive-session'; exit 3 }
    Fail-Task 'Test-Path' 'window-marker' 'marker-missing'
  }
  if ($Arm -eq 'ignore-new') {
    Start-Sleep -Seconds 7
    $pids = @([IO.File]::ReadAllLines($marker))
    if ($pids.Count -ne 1) { Fail-Task 'ReadAllLines' 'IgnoreNew' "expected=1 actual=$($pids.Count)" }
  }
  if (-not (Test-Path $comparison)) { Fail-Task 'Test-Path' 'comparison' 'comparison-missing' }
  Write-Output "$Arm=proved comparison=yes"
  exit 0
} finally {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
}
