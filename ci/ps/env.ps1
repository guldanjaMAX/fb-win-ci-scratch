$ErrorActionPreference = 'Stop'

function Flag([bool]$Value) {
  if ($Value) { return 'yes' }
  return 'no'
}

$osCaption = 'unknown'
$osBuild = 'unknown'
try {
  $os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
  $osCaption = ($os.Caption -replace '[^A-Za-z0-9._-]', '_')
  $osBuild = [string]$os.BuildNumber
} catch {}

$elevated = $false
try {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  $elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} catch {}

$clipGet = $false
$clipSet = $false
try {
  Set-Clipboard -Value ' '
  $clipSet = $true
} catch {}
try { $null = Get-Clipboard -Raw -ErrorAction Stop; $clipGet = $true } catch {}

$winrt = $false
$historyEnabled = 'unknown'
$historyStatus = -1
try {
  $clipboardType = [Windows.ApplicationModel.DataTransfer.Clipboard,Windows.ApplicationModel.DataTransfer,ContentType=WindowsRuntime]
  $winrt = $null -ne $clipboardType
  $historyEnabled = Flag([bool]$clipboardType::IsHistoryEnabled())
  [void][Reflection.Assembly]::Load('System.Runtime.WindowsRuntime, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089')
  $operation = $clipboardType::GetHistoryItemsAsync()
  $task = [System.WindowsRuntimeSystemExtensions]::AsTask($operation)
  $history = $task.GetAwaiter().GetResult()
  $historyStatus = [int]$history.Status
} catch {}

$securityCenter = $false
try {
  $null = Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct -ErrorAction Stop
  $securityCenter = $true
} catch {}

$defender = 'unknown'
try {
  $defender = Flag([bool](Get-MpComputerStatus -ErrorAction Stop).RealTimeProtectionEnabled)
} catch {}

$nodeVersion = 'unknown'
try { $nodeVersion = (& node --version).Trim() } catch {}
$edition = [string]$PSVersionTable.PSEdition
$psVersion = [string]$PSVersionTable.PSVersion
$interactive = Flag([Environment]::UserInteractive)
$session = [Diagnostics.Process]::GetCurrentProcess().SessionId
Write-Output "ENV caption=$osCaption build=$osBuild ps=$psVersion edition=$edition node=$nodeVersion elevated=$(Flag $elevated) session=$session interactive=$interactive clip_get=$(Flag $clipGet) clip_set=$(Flag $clipSet) winrt=$(Flag $winrt) history_enabled=$historyEnabled history_status=$historyStatus securitycenter=$(Flag $securityCenter) defender=$defender"
