param(
  [Parameter(Mandatory=$true)][string]$SessionDir,
  [Parameter(Mandatory=$true)][ValidateSet('1','2')][string]$Phase
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$Host.UI.RawUI.WindowTitle = 'Financial Brain probe'
$Host.UI.RawUI.BackgroundColor = 'DarkBlue'
Clear-Host

$ProbeDir = Join-Path $SessionDir 'probe'
$AllResults = Join-Path $SessionDir 'probe-results.txt'
[IO.Directory]::CreateDirectory($ProbeDir) | Out-Null
$Results = [ordered]@{}

function Set-ProbeResult([string]$Key, [string]$Value) {
  if ($Key -notmatch '^[a-z0-9_.]{1,40}$') { throw 'bad result key' }
  if ($Value -notmatch '^[A-Za-z0-9_.:()-]{0,40}$') { $Value = 'unknown' }
  $script:Results[$Key] = $Value
}

function Save-Phase([string]$Name) {
  $Lines = New-Object System.Collections.Generic.List[string]
  foreach ($Item in $script:Results.GetEnumerator()) { $Lines.Add(($Item.Key + '=' + $Item.Value)) }
  $Text = ($Lines -join "`n") + "`n"
  [IO.File]::WriteAllText((Join-Path $ProbeDir $Name), $Text, [Text.Encoding]::ASCII)
  [IO.File]::AppendAllText($AllResults, $Text, [Text.Encoding]::ASCII)
}

function Get-YesNoUnknown($Value) {
  if ($null -eq $Value) { return 'unknown' }
  if ([int]$Value -eq 1) { return 'yes' }
  if ([int]$Value -eq 0) { return 'no' }
  return 'unknown'
}

function Get-RegValue([string]$Path, [string]$Name) {
  try { return (Get-ItemProperty -LiteralPath $Path -Name $Name -ErrorAction Stop).$Name }
  catch { return $null }
}

function Get-HashPrefix([string]$Text) {
  $Hasher = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($Hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)))).Replace('-', '').Substring(0, 8).ToLowerInvariant() }
  finally { $Hasher.Dispose() }
}

function Get-AwaitResult($Operation, [Type]$ResultType) {
  $Methods = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1
  }
  $Method = @($Methods)[0].MakeGenericMethod($ResultType)
  $Task = $Method.Invoke($null, @($Operation))
  $Task.Wait()
  return $Task.Result
}

$Shell = New-Object -ComObject WScript.Shell
$Activated = $Shell.AppActivate('Financial Brain probe')
Set-ProbeResult 'appactivate' $(if ($Activated) { 'yes' } else { 'no' })
[Console]::Beep(880, 180)

$LocalRoot = Join-Path $env:LOCALAPPDATA 'FBProbe'
$CipherPath = Join-Path $LocalRoot 'probe-key.dpapi'
$MarkerPath = Join-Path $LocalRoot 'window-marker.txt'

if ($Phase -eq '2') {
  $Readback = 'unreadable'
  $Tamper = 'failed'
  try {
    $PrefixLine = @(Get-Content -LiteralPath (Join-Path $ProbeDir 'phase1.txt') | Where-Object { $_ -like 'dpapi_prefix=*' })[-1]
    $ExpectedPrefix = $PrefixLine.Substring('dpapi_prefix='.Length)
    $Cipher = [IO.File]::ReadAllText($CipherPath, [Text.Encoding]::ASCII)
    $Secure = ConvertTo-SecureString -String $Cipher
    $Bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
    try { $Plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Bstr) }
    if ((Get-HashPrefix $Plain) -eq $ExpectedPrefix) { $Readback = 'match' } else { $Readback = 'mismatch' }
    $Plain = $null
  } catch { $Readback = 'unreadable' }
  try {
    $Cipher = [IO.File]::ReadAllText($CipherPath, [Text.Encoding]::ASCII)
    $At = [Math]::Floor($Cipher.Length / 2)
    $Swap = if ($Cipher[$At] -eq 'A') { 'B' } else { 'A' }
    $Changed = $Cipher.Substring(0, $At) + $Swap + $Cipher.Substring($At + 1)
    $TamperPath = Join-Path $LocalRoot 'probe-key-copy.dpapi'
    [IO.File]::WriteAllText($TamperPath, $Changed, [Text.Encoding]::ASCII)
    try { $null = ConvertTo-SecureString -String ([IO.File]::ReadAllText($TamperPath, [Text.Encoding]::ASCII)); $Tamper = 'failed' }
    catch { $Tamper = 'ok' }
  } catch { $Tamper = 'failed' }
  Set-ProbeResult 'dpapi_readback' $Readback
  Set-ProbeResult 'dpapi_tamper_control' $Tamper
  $Cleanup = 'yes'
  try {
    foreach ($Path in @($CipherPath, (Join-Path $LocalRoot 'probe-key-copy.dpapi'), $MarkerPath, (Join-Path $LocalRoot 'helper-marker.txt'))) {
      if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Force }
    }
    if (Test-Path -LiteralPath $LocalRoot) { Remove-Item -LiteralPath $LocalRoot -Force -ErrorAction SilentlyContinue }
    $PackageMarkers = Join-Path $env:LOCALAPPDATA 'Packages\*\LocalCache\Local\FBProbe\helper-marker.txt'
    foreach ($Path in @(Get-ChildItem -Path $PackageMarkers -File -ErrorAction SilentlyContinue)) {
      Remove-Item -LiteralPath $Path.FullName -Force
      Remove-Item -LiteralPath $Path.Directory.FullName -Force -ErrorAction SilentlyContinue
    }
  } catch { $Cleanup = 'no' }
  Set-ProbeResult 'cleanup' $Cleanup
  Save-Phase 'phase2.txt'
  [IO.File]::WriteAllText((Join-Path $ProbeDir 'window2.done'), "done=yes`n", [Text.Encoding]::ASCII)
  Write-Host 'Probe finished. This window closes in 10 seconds.'
  Start-Sleep -Seconds 10
  exit 0
}

$Version = $PSVersionTable.PSVersion
Set-ProbeResult 'ps_version' ("{0}.{1}.{2}" -f $Version.Major, $Version.Minor, $Version.Build)
Set-ProbeResult 'ps_edition' $(if ($PSVersionTable.PSEdition) { [string]$PSVersionTable.PSEdition } else { 'Desktop' })
Set-ProbeResult 'x64' $(if ([Environment]::Is64BitProcess) { 'yes' } else { 'no' })

$ConsoleHost = 'unknown'
if ($env:WT_SESSION) { $ConsoleHost = 'windows-terminal' }
else {
  try {
    $Current = Get-CimInstance Win32_Process -Filter "ProcessId=$PID"
    $Parent = Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f $Current.ParentProcessId)
    if ($Parent.Name -eq 'conhost.exe') { $ConsoleHost = 'conhost' }
  } catch {}
  $Delegation = Get-RegValue 'HKCU:\Console\%%Startup' 'DelegationTerminal'
  if ($Delegation -and $ConsoleHost -eq 'unknown') { $ConsoleHost = 'windows-terminal' }
}
Set-ProbeResult 'console_host' $ConsoleHost
$QuickMain = Get-RegValue 'HKCU:\Console' 'QuickEdit'
$QuickExe = Get-RegValue 'HKCU:\Console\%SystemRoot%_System32_WindowsPowerShell_v1.0_powershell.exe' 'QuickEdit'
$Quick = if ($null -ne $QuickExe) { $QuickExe } else { $QuickMain }
Set-ProbeResult 'quickedit' (Get-YesNoUnknown $Quick)

try {
  $Os = Get-CimInstance Win32_OperatingSystem
  Set-ProbeResult 'free_mb' ([string][Math]::Floor([double]$Os.FreePhysicalMemory / 1024))
  Set-ProbeResult 'total_mb' ([string][Math]::Floor([double]$Os.TotalVisibleMemorySize / 1024))
} catch { Set-ProbeResult 'free_mb' 'unknown'; Set-ProbeResult 'total_mb' 'unknown' }

$SacRaw = Get-RegValue 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy' 'VerifiedAndReputablePolicyState'
$Sac = switch ($SacRaw) { 0 { 'off' } 1 { 'on' } 2 { 'evaluation' } default { 'unknown' } }
Set-ProbeResult 'sac' $Sac
$HistoryOn = Get-RegValue 'HKCU:\Software\Microsoft\Clipboard' 'EnableClipboardHistory'
$CloudOn = Get-RegValue 'HKCU:\Software\Microsoft\Clipboard' 'EnableCloudClipboard'
Set-ProbeResult 'clipboard_history' (Get-YesNoUnknown $HistoryOn)
Set-ProbeResult 'cloud_clipboard' (Get-YesNoUnknown $CloudOn)
try { Set-ProbeResult 'defender_rtp' $(if ((Get-MpComputerStatus).RealTimeProtectionEnabled) { 'yes' } else { 'no' }) }
catch { Set-ProbeResult 'defender_rtp' 'unknown' }
try {
  $Av = @(Get-CimInstance -Namespace 'root/SecurityCenter2' -ClassName AntiVirusProduct | Where-Object { $_.displayName -notmatch 'Defender' })
  Set-ProbeResult 'third_party_av' ([string]$Av.Count)
} catch { Set-ProbeResult 'third_party_av' 'unknown' }

[IO.Directory]::CreateDirectory($LocalRoot) | Out-Null
[IO.File]::WriteAllText($MarkerPath, "window=yes`n", [Text.Encoding]::ASCII)
Set-ProbeResult 'window_marker_real' $(if (Test-Path -LiteralPath $MarkerPath) { 'yes' } else { 'no' })
$RealHelper = Join-Path $LocalRoot 'helper-marker.txt'
$PackageHelper = Join-Path $env:LOCALAPPDATA 'Packages\*\LocalCache\Local\FBProbe\helper-marker.txt'
if (Test-Path -LiteralPath $RealHelper) { Set-ProbeResult 'msix_redirect' 'no' }
elseif (@(Get-ChildItem -Path $PackageHelper -File -ErrorAction SilentlyContinue).Count -gt 0) { Set-ProbeResult 'msix_redirect' 'yes' }
else { Set-ProbeResult 'msix_redirect' 'unknown' }

$Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' + 'abcdefghijklmnopqrstuvwxyz' + '0123456789_-'
$Random = New-Object Random
do {
  $Chars = for ($i = 0; $i -lt 40; $i++) { $Alphabet[$Random.Next(0, $Alphabet.Length)] }
  $Dummy = -join $Chars
} until ($Dummy -cmatch '[A-Z]' -and $Dummy -cmatch '[a-z]' -and $Dummy -match '[0-9]')
try { $OldHash = Get-HashPrefix ([string](Get-Clipboard -Raw -ErrorAction Stop)) } catch { $OldHash = 'unknown' }
$DummyPath = Join-Path $ProbeDir 'dummy-key.txt'
[IO.File]::WriteAllText($DummyPath, ('Financial Brain updates (probe): ' + $Dummy + "`n"), [Text.Encoding]::ASCII)
$Info = New-Object System.Diagnostics.ProcessStartInfo
$Info.FileName = Join-Path $env:SystemRoot 'System32\notepad.exe'
$Info.Arguments = '"' + $DummyPath.Replace('"', '\"') + '"'
$Info.UseShellExecute = $false
$Info.CreateNoWindow = $true
$Note = [Diagnostics.Process]::Start($Info)
Write-Host 'In Notepad, press Ctrl+A, then Ctrl+C, then close Notepad.'
$Started = Get-Date
$SecureWatched = $null
$SawTwo = $false
$Nudged = $false
$LastHash = $OldHash
while (((Get-Date) - $Started).TotalSeconds -lt 180) {
  Start-Sleep -Milliseconds 500
  try { $Clip = [string](Get-Clipboard -Raw -ErrorAction Stop) } catch { continue }
  $Hash = Get-HashPrefix $Clip
  if ($Hash -eq $LastHash) { $Clip = $null; continue }
  $LastHash = $Hash
  $Matches = [regex]::Matches($Clip, '(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{40}(?![A-Za-z0-9_-])')
  if ($Matches.Count -gt 1) {
    Write-Host 'That copy held more than one key-like value. Copy only the key, please.'
    $SawTwo = $true
  } elseif ($Matches.Count -eq 1 -and $Matches[0].Value -ceq $Dummy) {
    $Matched = $Matches[0].Value
    $SecureWatched = ConvertTo-SecureString $Matched -AsPlainText -Force
    $Matched = $null
    $Matches = $null
    Write-Host 'Got it (40 characters)'
    $Clip = $null
    break
  }
  $Clip = $null
  if (-not $Nudged -and ((Get-Date) - $Started).TotalSeconds -ge 60) {
    Write-Host 'Still waiting. Copy only the key from Notepad.'
    $Nudged = $true
  }
}
$WaitSeconds = [Math]::Min(180, [Math]::Round(((Get-Date) - $Started).TotalSeconds))
if ($SecureWatched) { Set-ProbeResult 'clip_watch' 'got-it' }
elseif ($SawTwo) { Set-ProbeResult 'clip_watch' 'refused-two' }
else { Set-ProbeResult 'clip_watch' 'timeout' }
Set-ProbeResult 'clip_wait_seconds' ([string]$WaitSeconds)

$HistoryStatus = 'unknown'
$Scanned = 0
$Before = 0
$After = 0
$DeleteState = if ($HistoryOn -eq 1) { 'failed' } else { 'not-needed' }
$Cleared = 'no'
if ($HistoryOn -eq 1) {
  try {
    [Reflection.Assembly]::Load('System.Runtime.WindowsRuntime, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089') | Out-Null
    $null = [Windows.ApplicationModel.DataTransfer.Clipboard, Windows.ApplicationModel.DataTransfer, ContentType=WindowsRuntime]
    $null = $Shell.AppActivate('Financial Brain probe')
    $First = Get-AwaitResult ([Windows.ApplicationModel.DataTransfer.Clipboard]::GetHistoryItemsAsync()) ([Windows.ApplicationModel.DataTransfer.ClipboardHistoryItemsResult])
    $HistoryStatus = [string][int]$First.Status
    foreach ($Item in @($First.Items)) {
      $Scanned++
      $Text = Get-AwaitResult ($Item.Content.GetTextAsync()) ([string])
      if ($Text.Contains($Dummy)) { $Before++; $null = [Windows.ApplicationModel.DataTransfer.Clipboard]::DeleteItemFromHistory($Item) }
      $Text = $null
    }
    $Second = Get-AwaitResult ([Windows.ApplicationModel.DataTransfer.Clipboard]::GetHistoryItemsAsync()) ([Windows.ApplicationModel.DataTransfer.ClipboardHistoryItemsResult])
    foreach ($Item in @($Second.Items)) {
      $Text = Get-AwaitResult ($Item.Content.GetTextAsync()) ([string])
      if ($Text.Contains($Dummy)) { $After++ }
      $Text = $null
    }
    $DeleteState = if ($After -eq 0) { 'ok' } else { 'failed' }
  } catch { $DeleteState = 'unavailable' }
}
Set-Clipboard -Value ' '
try { $Cleared = if (([string](Get-Clipboard -Raw)).Contains($Dummy)) { 'no' } else { 'yes' } } catch { $Cleared = 'unknown' }
Set-ProbeResult 'history_status' $HistoryStatus
Set-ProbeResult 'history_items_scanned' ([string]$Scanned)
Set-ProbeResult 'history_matches_before' ([string]$Before)
Set-ProbeResult 'history_matches_after' ([string]$After)
Set-ProbeResult 'history_delete' $DeleteState
Set-ProbeResult 'clipboard_cleared' $Cleared

$Source = 'clipboard'
if (-not $SecureWatched) { $SecureWatched = ConvertTo-SecureString $Dummy -AsPlainText -Force; $Source = 'generated' }
$Save = 'yes'
try {
  $Cipher = ConvertFrom-SecureString -SecureString $SecureWatched
  [IO.File]::WriteAllText($CipherPath, $Cipher, [Text.Encoding]::ASCII)
}
catch { $Save = 'no' }
Set-ProbeResult 'dpapi_source' $Source
Set-ProbeResult 'dpapi_save' $Save
$DpapiPrefix = Get-HashPrefix $Dummy
$SecureWatched.Dispose()

$CacheHit = 'no'
try {
  $Files = @(Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'Packages\Microsoft.WindowsNotepad_*\LocalState\TabState\*.bin') -File -ErrorAction SilentlyContinue)
  foreach ($File in $Files) {
    $Bytes = [IO.File]::ReadAllBytes($File.FullName)
    if ([Text.Encoding]::UTF8.GetString($Bytes).Contains($Dummy) -or [Text.Encoding]::Unicode.GetString($Bytes).Contains($Dummy)) { $CacheHit = 'yes'; break }
  }
} catch { $CacheHit = 'unknown' }
Set-ProbeResult 'notepad_cache_hit' $CacheHit
Remove-Item -LiteralPath $DummyPath -Force -ErrorAction SilentlyContinue
$Dummy = $null

Write-Host 'Click once inside this window, in the dark area. If the title then starts with Select, press Esc once.'
$Longest = 0.0
for ($i = 1; $i -le 20; $i++) {
  $BeforeTick = Get-Date
  Write-Host ("Tick {0}/20" -f $i)
  Start-Sleep -Seconds 1
  $Gap = ((Get-Date) - $BeforeTick).TotalSeconds
  if ($Gap -gt $Longest) { $Longest = $Gap }
}
Set-ProbeResult 'click_freeze_seconds' ([Math]::Round($Longest, 1).ToString('0.0', [Globalization.CultureInfo]::InvariantCulture))
Save-Phase 'phase1.txt'
[IO.File]::AppendAllText((Join-Path $ProbeDir 'phase1.txt'), ("dpapi_prefix=$DpapiPrefix`n"), [Text.Encoding]::ASCII)
[IO.File]::WriteAllText((Join-Path $ProbeDir 'window1.done'), "done=yes`n", [Text.Encoding]::ASCII)
Write-Host 'Window 1 finished. A second window opens in a moment.'
Start-Sleep -Seconds 5
