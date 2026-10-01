import { createHash, randomBytes as systemRandomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";

export const embeddedScripts = {"alive.ps1":"param(\n  [Parameter(Mandatory=$true)][int]$ProbePid,\n  [Parameter(Mandatory=$true)][string]$ExpectedStart\n)\n$ErrorActionPreference = 'SilentlyContinue'\n$Process = Get-CimInstance Win32_Process -Filter (\"ProcessId={0}\" -f $ProbePid)\nif (-not $Process) { [Console]::Out.WriteLine('alive=no'); exit 0 }\n$Actual = $Process.CreationDate.ToUniversalTime().ToString('o')\nif ([String]::Equals($Actual, $ExpectedStart, [StringComparison]::Ordinal)) { [Console]::Out.WriteLine('alive=yes') }\nelse { [Console]::Out.WriteLine('alive=no') }\n","probe-env.ps1":"param([Parameter(Mandatory=$true)][int]$NodeParentPid)\n$ErrorActionPreference = 'SilentlyContinue'\n$Version = $PSVersionTable.PSVersion\n[Console]::Out.WriteLine(('ps_version={0}.{1}.{2}' -f $Version.Major, $Version.Minor, $Version.Build))\n$Parent = Get-CimInstance Win32_Process -Filter (\"ProcessId={0}\" -f $NodeParentPid)\n$ParentName = if ($Parent.Name) { [IO.Path]::GetFileNameWithoutExtension($Parent.Name).ToLowerInvariant() } else { 'unknown' }\n[Console]::Out.WriteLine(\"parent=$ParentName\")\n$Found = $false\n$Next = $Parent\nfor ($i = 0; $i -lt 8 -and $Next; $i++) {\n  if ($Next.ExecutablePath -like '*\\WindowsApps\\*') { $Found = $true; break }\n  $Next = Get-CimInstance Win32_Process -Filter (\"ProcessId={0}\" -f $Next.ParentProcessId)\n}\n[Console]::Out.WriteLine(('ancestor_windowsapps=' + $(if ($Found) { 'yes' } else { 'no' })))\n","register.ps1":"param(\n  [Parameter(Mandatory=$true)][string]$TaskName,\n  [Parameter(Mandatory=$true)][string]$EncodedStub,\n  [Parameter(Mandatory=$true)][ValidateSet('Interactive','S4U')][string]$LogonType\n)\n$ErrorActionPreference = 'Stop'\n$Action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument \"-NoProfile -ExecutionPolicy Bypass -EncodedCommand $EncodedStub\"\n$At = (Get-Date).AddMinutes(1)\n$Trigger = New-ScheduledTaskTrigger -Once -At $At\n$Trigger.EndBoundary = (Get-Date).AddHours(2).ToString('s')\n$Settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -DeleteExpiredTaskAfter ([TimeSpan]::FromHours(1))\n$User = \"$env:USERDOMAIN\\$env:USERNAME\"\n$Principal = New-ScheduledTaskPrincipal -UserId $User -LogonType $LogonType -RunLevel Limited\ntry {\n  Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal -Force | Out-Null\n  [Console]::Out.WriteLine('register=ok')\n} catch {\n  [Console]::Out.WriteLine('register=failed')\n  exit 0\n}\ntry {\n  Start-ScheduledTask -TaskName $TaskName\n  [Console]::Out.WriteLine('start=ok')\n} catch {\n  [Console]::Out.WriteLine('start=failed')\n}\n","stub.ps1":"$ErrorActionPreference = 'Stop'\n$SessionDir = __SESSION_LITERAL__\n$Phase = __PHASE_LITERAL__\n$Expected = __HASH_LITERAL__\n$ProbeDir = Join-Path $SessionDir 'probe'\n$WindowPath = Join-Path $ProbeDir 'window.ps1'\n$ResultPath = Join-Path $SessionDir 'probe-results.txt'\n$LockPath = Join-Path $ProbeDir 'window.lock'\n[IO.Directory]::CreateDirectory($ProbeDir) | Out-Null\n$Self = Get-CimInstance Win32_Process -Filter \"ProcessId=$PID\"\n$Start = $Self.CreationDate.ToUniversalTime().ToString('o')\n[IO.File]::WriteAllText($LockPath, \"pid=$PID`nstart=$Start`nphase=$Phase`n\", [Text.Encoding]::ASCII)\n$Bytes = [IO.File]::ReadAllBytes($WindowPath)\n$Hasher = [Security.Cryptography.SHA256]::Create()\ntry { $Actual = ([BitConverter]::ToString($Hasher.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }\nfinally { $Hasher.Dispose() }\nif (-not [String]::Equals($Actual, $Expected, [StringComparison]::Ordinal)) {\n  [IO.File]::AppendAllText($ResultPath, \"stop=fingerprint`n\", [Text.Encoding]::ASCII)\n  exit 0\n}\n$Offset = 0\nif ($Bytes.Length -ge 3 -and $Bytes[0] -eq 0xEF -and $Bytes[1] -eq 0xBB -and $Bytes[2] -eq 0xBF) { $Offset = 3 }\n$Text = [Text.Encoding]::UTF8.GetString($Bytes, $Offset, $Bytes.Length - $Offset)\n$Block = [ScriptBlock]::Create($Text)\n& $Block -SessionDir $SessionDir -Phase $Phase\n","unregister.ps1":"param([Parameter(Mandatory=$true)][string]$TaskName)\n$ErrorActionPreference = 'SilentlyContinue'\nUnregister-ScheduledTask -TaskName $TaskName -Confirm:$false\n","window.ps1":"param(\n  [Parameter(Mandatory=$true)][string]$SessionDir,\n  [Parameter(Mandatory=$true)][ValidateSet('1','2')][string]$Phase\n)\n$ErrorActionPreference = 'Stop'\nSet-StrictMode -Version 2.0\n$Host.UI.RawUI.WindowTitle = 'Financial Brain probe'\n$Host.UI.RawUI.BackgroundColor = 'DarkBlue'\nClear-Host\n\n$ProbeDir = Join-Path $SessionDir 'probe'\n$AllResults = Join-Path $SessionDir 'probe-results.txt'\n[IO.Directory]::CreateDirectory($ProbeDir) | Out-Null\n$Results = [ordered]@{}\n\nfunction Set-ProbeResult([string]$Key, [string]$Value) {\n  if ($Key -notmatch '^[a-z0-9_.]{1,40}$') { throw 'bad result key' }\n  if ($Value -notmatch '^[A-Za-z0-9_.:()-]{0,40}$') { $Value = 'unknown' }\n  $script:Results[$Key] = $Value\n}\n\nfunction Save-Phase([string]$Name) {\n  $Lines = New-Object System.Collections.Generic.List[string]\n  foreach ($Item in $script:Results.GetEnumerator()) { $Lines.Add(($Item.Key + '=' + $Item.Value)) }\n  $Text = ($Lines -join \"`n\") + \"`n\"\n  [IO.File]::WriteAllText((Join-Path $ProbeDir $Name), $Text, [Text.Encoding]::ASCII)\n  [IO.File]::AppendAllText($AllResults, $Text, [Text.Encoding]::ASCII)\n}\n\nfunction Get-YesNoUnknown($Value) {\n  if ($null -eq $Value) { return 'unknown' }\n  if ([int]$Value -eq 1) { return 'yes' }\n  if ([int]$Value -eq 0) { return 'no' }\n  return 'unknown'\n}\n\nfunction Get-RegValue([string]$Path, [string]$Name) {\n  try { return (Get-ItemProperty -LiteralPath $Path -Name $Name -ErrorAction Stop).$Name }\n  catch { return $null }\n}\n\nfunction Get-HashPrefix([string]$Text) {\n  $Hasher = [Security.Cryptography.SHA256]::Create()\n  try { return ([BitConverter]::ToString($Hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)))).Replace('-', '').Substring(0, 8).ToLowerInvariant() }\n  finally { $Hasher.Dispose() }\n}\n\nfunction Get-AwaitResult($Operation, [Type]$ResultType) {\n  $Methods = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {\n    $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1\n  }\n  $Method = @($Methods)[0].MakeGenericMethod($ResultType)\n  $Task = $Method.Invoke($null, @($Operation))\n  $Task.Wait()\n  return $Task.Result\n}\n\n$Shell = New-Object -ComObject WScript.Shell\n$Activated = $Shell.AppActivate('Financial Brain probe')\nSet-ProbeResult 'appactivate' $(if ($Activated) { 'yes' } else { 'no' })\n[Console]::Beep(880, 180)\n\n$LocalRoot = Join-Path $env:LOCALAPPDATA 'FBProbe'\n$CipherPath = Join-Path $LocalRoot 'probe-key.dpapi'\n$MarkerPath = Join-Path $LocalRoot 'window-marker.txt'\n\nif ($Phase -eq '2') {\n  $Readback = 'unreadable'\n  $Tamper = 'failed'\n  try {\n    $PrefixLine = @(Get-Content -LiteralPath (Join-Path $ProbeDir 'phase1.txt') | Where-Object { $_ -like 'dpapi_prefix=*' })[-1]\n    $ExpectedPrefix = $PrefixLine.Substring('dpapi_prefix='.Length)\n    $Secure = Get-Content -LiteralPath $CipherPath -Raw | ConvertTo-SecureString\n    $Bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)\n    try { $Plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Bstr) }\n    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Bstr) }\n    if ((Get-HashPrefix $Plain) -eq $ExpectedPrefix) { $Readback = 'match' } else { $Readback = 'mismatch' }\n    $Plain = $null\n  } catch { $Readback = 'unreadable' }\n  try {\n    $Cipher = (Get-Content -LiteralPath $CipherPath -Raw).Trim()\n    $At = [Math]::Floor($Cipher.Length / 2)\n    $Swap = if ($Cipher[$At] -eq 'A') { 'B' } else { 'A' }\n    $Changed = $Cipher.Substring(0, $At) + $Swap + $Cipher.Substring($At + 1)\n    $TamperPath = Join-Path $LocalRoot 'probe-key-copy.dpapi'\n    [IO.File]::WriteAllText($TamperPath, $Changed, [Text.Encoding]::ASCII)\n    try { $null = Get-Content -LiteralPath $TamperPath -Raw | ConvertTo-SecureString; $Tamper = 'failed' }\n    catch { $Tamper = 'ok' }\n  } catch { $Tamper = 'failed' }\n  Set-ProbeResult 'dpapi_readback' $Readback\n  Set-ProbeResult 'dpapi_tamper_control' $Tamper\n  $Cleanup = 'yes'\n  try {\n    foreach ($Path in @($CipherPath, (Join-Path $LocalRoot 'probe-key-copy.dpapi'), $MarkerPath, (Join-Path $LocalRoot 'helper-marker.txt'))) {\n      if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Force }\n    }\n    if (Test-Path -LiteralPath $LocalRoot) { Remove-Item -LiteralPath $LocalRoot -Force -ErrorAction SilentlyContinue }\n    $PackageMarkers = Join-Path $env:LOCALAPPDATA 'Packages\\*\\LocalCache\\Local\\FBProbe\\helper-marker.txt'\n    foreach ($Path in @(Get-ChildItem -Path $PackageMarkers -File -ErrorAction SilentlyContinue)) {\n      Remove-Item -LiteralPath $Path.FullName -Force\n      Remove-Item -LiteralPath $Path.Directory.FullName -Force -ErrorAction SilentlyContinue\n    }\n  } catch { $Cleanup = 'no' }\n  Set-ProbeResult 'cleanup' $Cleanup\n  Save-Phase 'phase2.txt'\n  [IO.File]::WriteAllText((Join-Path $ProbeDir 'window2.done'), \"done=yes`n\", [Text.Encoding]::ASCII)\n  Write-Host 'Probe finished. This window closes in 10 seconds.'\n  Start-Sleep -Seconds 10\n  exit 0\n}\n\n$Version = $PSVersionTable.PSVersion\nSet-ProbeResult 'ps_version' (\"{0}.{1}.{2}\" -f $Version.Major, $Version.Minor, $Version.Build)\nSet-ProbeResult 'ps_edition' $(if ($PSVersionTable.PSEdition) { [string]$PSVersionTable.PSEdition } else { 'Desktop' })\nSet-ProbeResult 'x64' $(if ([Environment]::Is64BitProcess) { 'yes' } else { 'no' })\n\n$ConsoleHost = 'unknown'\nif ($env:WT_SESSION) { $ConsoleHost = 'windows-terminal' }\nelse {\n  try {\n    $Current = Get-CimInstance Win32_Process -Filter \"ProcessId=$PID\"\n    $Parent = Get-CimInstance Win32_Process -Filter (\"ProcessId={0}\" -f $Current.ParentProcessId)\n    if ($Parent.Name -eq 'conhost.exe') { $ConsoleHost = 'conhost' }\n  } catch {}\n  $Delegation = Get-RegValue 'HKCU:\\Console\\%%Startup' 'DelegationTerminal'\n  if ($Delegation -and $ConsoleHost -eq 'unknown') { $ConsoleHost = 'windows-terminal' }\n}\nSet-ProbeResult 'console_host' $ConsoleHost\n$QuickMain = Get-RegValue 'HKCU:\\Console' 'QuickEdit'\n$QuickExe = Get-RegValue 'HKCU:\\Console\\%SystemRoot%_System32_WindowsPowerShell_v1.0_powershell.exe' 'QuickEdit'\n$Quick = if ($null -ne $QuickExe) { $QuickExe } else { $QuickMain }\nSet-ProbeResult 'quickedit' (Get-YesNoUnknown $Quick)\n\ntry {\n  $Os = Get-CimInstance Win32_OperatingSystem\n  Set-ProbeResult 'free_mb' ([string][Math]::Floor([double]$Os.FreePhysicalMemory / 1024))\n  Set-ProbeResult 'total_mb' ([string][Math]::Floor([double]$Os.TotalVisibleMemorySize / 1024))\n} catch { Set-ProbeResult 'free_mb' 'unknown'; Set-ProbeResult 'total_mb' 'unknown' }\n\n$SacRaw = Get-RegValue 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy' 'VerifiedAndReputablePolicyState'\n$Sac = switch ($SacRaw) { 0 { 'off' } 1 { 'on' } 2 { 'evaluation' } default { 'unknown' } }\nSet-ProbeResult 'sac' $Sac\n$HistoryOn = Get-RegValue 'HKCU:\\Software\\Microsoft\\Clipboard' 'EnableClipboardHistory'\n$CloudOn = Get-RegValue 'HKCU:\\Software\\Microsoft\\Clipboard' 'EnableCloudClipboard'\nSet-ProbeResult 'clipboard_history' (Get-YesNoUnknown $HistoryOn)\nSet-ProbeResult 'cloud_clipboard' (Get-YesNoUnknown $CloudOn)\ntry { Set-ProbeResult 'defender_rtp' $(if ((Get-MpComputerStatus).RealTimeProtectionEnabled) { 'yes' } else { 'no' }) }\ncatch { Set-ProbeResult 'defender_rtp' 'unknown' }\ntry {\n  $Av = @(Get-CimInstance -Namespace 'root/SecurityCenter2' -ClassName AntiVirusProduct | Where-Object { $_.displayName -notmatch 'Defender' })\n  Set-ProbeResult 'third_party_av' ([string]$Av.Count)\n} catch { Set-ProbeResult 'third_party_av' 'unknown' }\n\n[IO.Directory]::CreateDirectory($LocalRoot) | Out-Null\n[IO.File]::WriteAllText($MarkerPath, \"window=yes`n\", [Text.Encoding]::ASCII)\nSet-ProbeResult 'window_marker_real' $(if (Test-Path -LiteralPath $MarkerPath) { 'yes' } else { 'no' })\n$RealHelper = Join-Path $LocalRoot 'helper-marker.txt'\n$PackageHelper = Join-Path $env:LOCALAPPDATA 'Packages\\*\\LocalCache\\Local\\FBProbe\\helper-marker.txt'\nif (Test-Path -LiteralPath $RealHelper) { Set-ProbeResult 'msix_redirect' 'no' }\nelseif (@(Get-ChildItem -Path $PackageHelper -File -ErrorAction SilentlyContinue).Count -gt 0) { Set-ProbeResult 'msix_redirect' 'yes' }\nelse { Set-ProbeResult 'msix_redirect' 'unknown' }\n\n$Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' + 'abcdefghijklmnopqrstuvwxyz' + '0123456789_-'\n$Random = New-Object Random\ndo {\n  $Chars = for ($i = 0; $i -lt 40; $i++) { $Alphabet[$Random.Next(0, $Alphabet.Length)] }\n  $Dummy = -join $Chars\n} until ($Dummy -cmatch '[A-Z]' -and $Dummy -cmatch '[a-z]' -and $Dummy -match '[0-9]')\ntry { $OldHash = Get-HashPrefix ([string](Get-Clipboard -Raw -ErrorAction Stop)) } catch { $OldHash = 'unknown' }\n$DummyPath = Join-Path $ProbeDir 'dummy-key.txt'\n[IO.File]::WriteAllText($DummyPath, ('Financial Brain updates (probe): ' + $Dummy + \"`n\"), [Text.Encoding]::ASCII)\n$Info = New-Object System.Diagnostics.ProcessStartInfo\n$Info.FileName = Join-Path $env:SystemRoot 'System32\\notepad.exe'\n$Info.Arguments = '\"' + $DummyPath.Replace('\"', '\\\"') + '\"'\n$Info.UseShellExecute = $false\n$Info.CreateNoWindow = $true\n$Note = [Diagnostics.Process]::Start($Info)\nWrite-Host 'In Notepad, press Ctrl+A, then Ctrl+C, then close Notepad.'\n$Started = Get-Date\n$SecureWatched = $null\n$SawTwo = $false\n$Nudged = $false\n$LastHash = $OldHash\nwhile (((Get-Date) - $Started).TotalSeconds -lt 180) {\n  Start-Sleep -Milliseconds 500\n  try { $Clip = [string](Get-Clipboard -Raw -ErrorAction Stop) } catch { continue }\n  $Hash = Get-HashPrefix $Clip\n  if ($Hash -eq $LastHash) { $Clip = $null; continue }\n  $LastHash = $Hash\n  $Matches = [regex]::Matches($Clip, '(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{40}(?![A-Za-z0-9_-])')\n  if ($Matches.Count -gt 1) {\n    Write-Host 'That copy held more than one key-like value. Copy only the key, please.'\n    $SawTwo = $true\n  } elseif ($Matches.Count -eq 1 -and $Matches[0].Value -ceq $Dummy) {\n    $Matched = $Matches[0].Value\n    $SecureWatched = ConvertTo-SecureString $Matched -AsPlainText -Force\n    $Matched = $null\n    $Matches = $null\n    Write-Host 'Got it (40 characters)'\n    $Clip = $null\n    break\n  }\n  $Clip = $null\n  if (-not $Nudged -and ((Get-Date) - $Started).TotalSeconds -ge 60) {\n    Write-Host 'Still waiting. Copy only the key from Notepad.'\n    $Nudged = $true\n  }\n}\n$WaitSeconds = [Math]::Min(180, [Math]::Round(((Get-Date) - $Started).TotalSeconds))\nif ($SecureWatched) { Set-ProbeResult 'clip_watch' 'got-it' }\nelseif ($SawTwo) { Set-ProbeResult 'clip_watch' 'refused-two' }\nelse { Set-ProbeResult 'clip_watch' 'timeout' }\nSet-ProbeResult 'clip_wait_seconds' ([string]$WaitSeconds)\n\n$HistoryStatus = 'unknown'\n$Scanned = 0\n$Before = 0\n$After = 0\n$DeleteState = if ($HistoryOn -eq 1) { 'failed' } else { 'not-needed' }\n$Cleared = 'no'\nif ($HistoryOn -eq 1) {\n  try {\n    [Reflection.Assembly]::Load('System.Runtime.WindowsRuntime, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089') | Out-Null\n    $null = [Windows.ApplicationModel.DataTransfer.Clipboard, Windows.ApplicationModel.DataTransfer, ContentType=WindowsRuntime]\n    $null = $Shell.AppActivate('Financial Brain probe')\n    $First = Get-AwaitResult ([Windows.ApplicationModel.DataTransfer.Clipboard]::GetHistoryItemsAsync()) ([Windows.ApplicationModel.DataTransfer.ClipboardHistoryItemsResult])\n    $HistoryStatus = [string][int]$First.Status\n    foreach ($Item in @($First.Items)) {\n      $Scanned++\n      $Text = Get-AwaitResult ($Item.Content.GetTextAsync()) ([string])\n      if ($Text.Contains($Dummy)) { $Before++; $null = [Windows.ApplicationModel.DataTransfer.Clipboard]::DeleteItemFromHistory($Item) }\n      $Text = $null\n    }\n    $Second = Get-AwaitResult ([Windows.ApplicationModel.DataTransfer.Clipboard]::GetHistoryItemsAsync()) ([Windows.ApplicationModel.DataTransfer.ClipboardHistoryItemsResult])\n    foreach ($Item in @($Second.Items)) {\n      $Text = Get-AwaitResult ($Item.Content.GetTextAsync()) ([string])\n      if ($Text.Contains($Dummy)) { $After++ }\n      $Text = $null\n    }\n    $DeleteState = if ($After -eq 0) { 'ok' } else { 'failed' }\n  } catch { $DeleteState = 'unavailable' }\n}\nSet-Clipboard -Value ' '\ntry { $Cleared = if (([string](Get-Clipboard -Raw)).Contains($Dummy)) { 'no' } else { 'yes' } } catch { $Cleared = 'unknown' }\nSet-ProbeResult 'history_status' $HistoryStatus\nSet-ProbeResult 'history_items_scanned' ([string]$Scanned)\nSet-ProbeResult 'history_matches_before' ([string]$Before)\nSet-ProbeResult 'history_matches_after' ([string]$After)\nSet-ProbeResult 'history_delete' $DeleteState\nSet-ProbeResult 'clipboard_cleared' $Cleared\n\n$Source = 'clipboard'\nif (-not $SecureWatched) { $SecureWatched = ConvertTo-SecureString $Dummy -AsPlainText -Force; $Source = 'generated' }\n$Save = 'yes'\ntry { ConvertFrom-SecureString $SecureWatched | Set-Content -LiteralPath $CipherPath -Encoding ASCII }\ncatch { $Save = 'no' }\nSet-ProbeResult 'dpapi_source' $Source\nSet-ProbeResult 'dpapi_save' $Save\n$DpapiPrefix = Get-HashPrefix $Dummy\n$SecureWatched.Dispose()\n\n$CacheHit = 'no'\ntry {\n  $Files = @(Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'Packages\\Microsoft.WindowsNotepad_*\\LocalState\\TabState\\*.bin') -File -ErrorAction SilentlyContinue)\n  foreach ($File in $Files) {\n    $Bytes = [IO.File]::ReadAllBytes($File.FullName)\n    if ([Text.Encoding]::UTF8.GetString($Bytes).Contains($Dummy) -or [Text.Encoding]::Unicode.GetString($Bytes).Contains($Dummy)) { $CacheHit = 'yes'; break }\n  }\n} catch { $CacheHit = 'unknown' }\nSet-ProbeResult 'notepad_cache_hit' $CacheHit\nRemove-Item -LiteralPath $DummyPath -Force -ErrorAction SilentlyContinue\n$Dummy = $null\n\nWrite-Host 'Click once inside this window, in the dark area. If the title then starts with Select, press Esc once.'\n$Longest = 0.0\nfor ($i = 1; $i -le 20; $i++) {\n  $BeforeTick = Get-Date\n  Write-Host (\"Tick {0}/20\" -f $i)\n  Start-Sleep -Seconds 1\n  $Gap = ((Get-Date) - $BeforeTick).TotalSeconds\n  if ($Gap -gt $Longest) { $Longest = $Gap }\n}\nSet-ProbeResult 'click_freeze_seconds' ([Math]::Round($Longest, 1).ToString('0.0', [Globalization.CultureInfo]::InvariantCulture))\nSave-Phase 'phase1.txt'\n[IO.File]::AppendAllText((Join-Path $ProbeDir 'phase1.txt'), (\"dpapi_prefix=$DpapiPrefix`n\"), [Text.Encoding]::ASCII)\n[IO.File]::WriteAllText((Join-Path $ProbeDir 'window1.done'), \"done=yes`n\", [Text.Encoding]::ASCII)\nWrite-Host 'Window 1 finished. A second window opens in a moment.'\nStart-Sleep -Seconds 5\n"};

const VALID_MARKERS = new Set(["probe-sentence", "probe-window"]);
const RESULT_KEYS = new Set([
  "ps_version", "ps_edition", "x64", "console_host", "quickedit", "free_mb", "total_mb",
  "sac", "clipboard_history", "cloud_clipboard", "defender_rtp", "third_party_av", "appactivate",
  "window_marker_real", "msix_redirect", "clip_watch", "clip_wait_seconds", "history_status",
  "history_items_scanned", "history_matches_before", "history_matches_after", "history_delete",
  "clipboard_cleared", "dpapi_source", "dpapi_save", "notepad_cache_hit", "click_freeze_seconds",
  "dpapi_readback", "dpapi_tamper_control", "cleanup",
]);
const SAY_LINES = new Set([
  "Nothing to run yet. See you Friday.",
  "This probe only runs on Windows.",
  "This computer's Node is too old for the probe.",
  "The probe check is done. Nothing else to run.",
  "A window called Financial Brain probe is opening. Please follow what it says.",
  "The first window is finished. A second window is opening to read the test value back.",
  "The probe window closed before it finished.",
  "The probe is finished. Thank you.",
  "The probe window did not open. Nothing was changed.",
]);

const MODULE_DIR = realpathSync(dirname(fileURLToPath(import.meta.url)));

function tokenRun(line) {
  for (const match of line.matchAll(/[A-Za-z0-9_-]{35,}/g)) {
    const value = match[0];
    if (/[A-Z]/.test(value) && /[a-z]/.test(value) && /[0-9]/.test(value)) return true;
  }
  return false;
}

function unsafeContent(line) {
  const userPath = new RegExp("\\\\" + "Users" + "\\\\", "i");
  const posixUserPath = new RegExp("/" + "Users" + "/[^/\\s]+/", "i");
  return tokenRun(line) ||
    new RegExp(`[0-9a-f]{${12 + 12},}`, "i").test(line) ||
    /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/i.test(line) ||
    /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.test(line) ||
    /\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/i.test(line) ||
    /[a-z]+:\/\//i.test(line) ||
    /[A-Za-z]:[\\/]/.test(line) || userPath.test(line) || posixUserPath.test(line) ||
    /%[A-Za-z_][A-Za-z0-9_]*%/.test(line);
}

export function guardOutputLine(line) {
  if (typeof line !== "string" || unsafeContent(line)) return false;
  if (line === "READY" || line === "PROBE: DONE" || line === "FOLLOW: STILL WAITING") return true;
  if (/^POWERSHELL: (?:unknown|[0-9]+\.[0-9]+\.[0-9]+)$/.test(line)) return true;
  if (/^MSIX: (?:yes|no|unknown)$/.test(line)) return true;
  if (/^SHELL: (?:powershell|pwsh|bash|cmd|unknown)$/.test(line)) return true;
  if (/^POWERCFG WRITE: (?:ok|denied|skipped)$/.test(line)) return true;
  if (/^WINDOW [12]: (?:OPENED \(task\)|NOT OPENED (?:register-failed|start-failed|no-heartbeat)|CLOSED EARLY)$/.test(line)) return true;
  if (line === "WINDOW 1: ALREADY OPEN") return true;
  if (/^NEXT: (?:follow|none)$/.test(line)) return true;
  if (/^HIDDEN: [0-9]+$/.test(line)) return true;
  if (line.startsWith("SAY: ")) return SAY_LINES.has(line.slice(5));
  const result = /^RESULT ([a-z0-9_.]{1,40})=([A-Za-z0-9_.:()-]{0,40})$/.exec(line);
  return Boolean(result && RESULT_KEYS.has(result[1]));
}

export function guardLines(lines) {
  const kept = [];
  let hidden = 0;
  for (const line of lines) {
    if (guardOutputLine(line)) kept.push(line);
    else hidden += 1;
  }
  if (hidden > 0) kept.push(`HIDDEN: ${hidden}`);
  return kept;
}

function parsePairs(text) {
  const pairs = new Map();
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = /^([a-z0-9_.]{1,40})=([A-Za-z0-9_.:()\/-]{0,80})$/.exec(line);
    if (match) pairs.set(match[1], match[2]);
  }
  return pairs;
}

function encodePowerShell(text) {
  return Buffer.from(text, "utf16le").toString("base64");
}

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function scriptInvocation(name, parameters = {}, tag = "") {
  const source = Buffer.from(embeddedScripts[name], "utf8").toString("base64");
  const args = Object.entries(parameters).map(([key, value]) => ` -${key} ${quotePowerShell(value)}`).join("");
  return `${tag ? `# ${tag}\n` : ""}$Source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${source}')); & ([ScriptBlock]::Create($Source))${args}`;
}

function systemPaths(env) {
  const root = env.SystemRoot || env.WINDIR || "C:\\Windows";
  return {
    powershell: win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    powercfg: win32.join(root, "System32", "powercfg.exe"),
  };
}

function runChild(command, args, options, timeout = 60_000) {
  const spawn = options.spawn || spawnSync;
  return spawn(command, args, {
    encoding: "utf8",
    env: options.env || process.env,
    maxBuffer: 1024 * 1024,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
    windowsHide: true,
  });
}

function runPowerShell(source, options, timeout = 60_000) {
  return runChild(systemPaths(options.env || process.env).powershell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(source),
  ], options, timeout);
}

function emitWrite(options, path, data, mode = "write") {
  if (options.onWrite) options.onWrite(path, data);
  if (mode === "append") appendFileSync(path, data, "utf8");
  else writeFileSync(path, data);
}

function markerValue(sessionDir, options) {
  let value = "";
  try {
    const bytes = readFileSync(join(sessionDir, "REHEARSAL.marker"));
    if (bytes.length <= 1024) value = bytes.toString("ascii").split(/\r?\n/, 1)[0].trim();
  } catch {}
  if (options.onGate) options.onGate(value);
  return value;
}

function inspectEnvironment(options) {
  const result = runPowerShell(scriptInvocation("probe-env.ps1", { NodeParentPid: options.parentPid ?? process.ppid }, "probe ancestor_windowsapps Get-CimInstance Win32_Process"), options);
  const pairs = result?.status === 0 ? parsePairs(result.stdout) : new Map();
  const psVersion = /^\d+\.\d+\.\d+$/.test(pairs.get("ps_version") || "") ? pairs.get("ps_version") : "unknown";
  const parent = (pairs.get("parent") || "unknown").toLowerCase();
  const shell = parent === "powershell" || parent === "pwsh" || parent === "bash" || parent === "cmd" ? parent : "unknown";
  const env = options.env || process.env;
  const packagePath = [env.LOCALAPPDATA, env.APPDATA].some((value) => typeof value === "string" && /[\\/]Packages[\\/]/i.test(value));
  const ancestor = pairs.get("ancestor_windowsapps");
  const msix = packagePath || ancestor === "yes" ? "yes" : ancestor === "no" ? "no" : "unknown";
  return { psVersion, shell, msix };
}

function readPowerSetting(command, alias, options) {
  const result = runChild(command, ["-query", "SCHEME_CURRENT", "SUB_SLEEP", alias], options);
  if (result?.status !== 0) return null;
  const match = /Current AC Power Setting Index:\s*0x([0-9a-f]+)/i.exec(result.stdout || "");
  if (!match) return null;
  const seconds = Number.parseInt(match[1], 16);
  return Number.isSafeInteger(seconds) ? seconds : null;
}

function powercfgCheck(options) {
  const command = systemPaths(options.env || process.env).powercfg;
  const standby = readPowerSetting(command, "STANDBYIDLE", options);
  const hibernate = readPowerSetting(command, "HIBERNATEIDLE", options);
  if (standby === null || hibernate === null || standby % 60 !== 0 || hibernate % 60 !== 0) {
    return { read: "unparsed", write: "skipped" };
  }
  const first = runChild(command, ["-change", "-standby-timeout-ac", String(standby / 60)], options);
  const second = runChild(command, ["-change", "-hibernate-timeout-ac", String(hibernate / 60)], options);
  if (first?.status !== 0 || second?.status !== 0) return { read: "parsed", write: "denied" };
  const standbyAfter = readPowerSetting(command, "STANDBYIDLE", options);
  const hibernateAfter = readPowerSetting(command, "HIBERNATEIDLE", options);
  return { read: "parsed", write: standbyAfter === standby && hibernateAfter === hibernate ? "ok" : "denied" };
}

function appendRunBlock(sessionDir, mode, environment, powercfg, options) {
  const now = (options.now ? options.now() : new Date()).toISOString();
  const block = [
    `run=${now}`,
    `mode=${mode}`,
    `ps_version=${environment.psVersion}`,
    `msix=${environment.msix}`,
    `shell=${environment.shell}`,
    `powercfg_read=${powercfg.read}`,
    `powercfg_write=${powercfg.write}`,
  ].join("\n");
  emitWrite(options, join(sessionDir, "probe-results.txt"), `${block}\n`, "append");
}

export function buildStub({ sessionDir, phase, expectedHash }) {
  const text = embeddedScripts["stub.ps1"]
    .replace("__SESSION_LITERAL__", quotePowerShell(sessionDir))
    .replace("__PHASE_LITERAL__", quotePowerShell(phase))
    .replace("__HASH_LITERAL__", quotePowerShell(expectedHash));
  return { text, encoded: encodePowerShell(text) };
}

function readLock(sessionDir) {
  try {
    const pairs = parsePairs(readFileSync(join(sessionDir, "probe", "window.lock"), "utf8"));
    const pid = Number.parseInt(pairs.get("pid"), 10);
    const start = pairs.get("start");
    const phase = pairs.get("phase") || "1";
    if (Number.isInteger(pid) && pid > 0 && start) return { pid, start, phase };
  } catch {}
  return null;
}

async function lockAlive(lock, options) {
  if (!lock) return false;
  if (options.isPidAlive) return Boolean(await options.isPidAlive(lock));
  const source = scriptInvocation("alive.ps1", { ProbePid: lock.pid, ExpectedStart: lock.start });
  const result = runPowerShell(source, options);
  return result?.status === 0 && parsePairs(result.stdout).get("alive") === "yes";
}

async function unregister(options) {
  const taskName = options.taskName || "Financial Brain probe";
  runPowerShell(scriptInvocation("unregister.ps1", { TaskName: taskName }, "Unregister-ScheduledTask"), options);
}

async function waitForHeartbeat(sessionDir, phase, options) {
  if (options.waitForLock) return Boolean(await options.waitForLock(phase));
  const sleep = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  for (let elapsed = 0; elapsed < 30; elapsed += 1) {
    const lock = readLock(sessionDir);
    if (lock?.phase === phase) return true;
    await sleep(1000);
  }
  return false;
}

async function openWindow(sessionDir, phase, options) {
  const probeDir = join(sessionDir, "probe");
  mkdirSync(probeDir, { recursive: true });
  const windowBytes = Buffer.from(options.windowSource || embeddedScripts["window.ps1"], "utf8");
  emitWrite(options, join(probeDir, "window.ps1"), windowBytes);
  const env = options.env || process.env;
  if (env.LOCALAPPDATA) {
    const markerDir = join(env.LOCALAPPDATA, "FBProbe");
    mkdirSync(markerDir, { recursive: true });
    emitWrite(options, join(markerDir, "helper-marker.txt"), "helper=yes\n");
  }
  const hash = createHash("sha256").update(windowBytes).digest("hex");
  const stub = buildStub({ sessionDir, phase, expectedHash: hash });
  if (stub.encoded.length >= 8000) return "register-failed";
  const taskName = options.taskName || "Financial Brain probe";
  const logonType = options.logonType || "Interactive";
  const source = scriptInvocation("register.ps1", {
    TaskName: taskName,
    EncodedStub: stub.encoded,
    LogonType: logonType,
  }, "Register-ScheduledTask Start-ScheduledTask");
  const result = runPowerShell(source, options);
  const pairs = result?.status === 0 ? parsePairs(result.stdout) : new Map();
  if (pairs.get("register") !== "ok") return "register-failed";
  if (pairs.get("start") !== "ok") return "start-failed";
  if (!await waitForHeartbeat(sessionDir, phase, options)) return "no-heartbeat";
  return "opened";
}

function phaseResults(sessionDir, phase) {
  let text = "";
  try { text = readFileSync(join(sessionDir, "probe", `phase${phase}.txt`), "utf8"); } catch {}
  const lines = [];
  for (const [key, value] of parsePairs(text)) {
    if (RESULT_KEYS.has(key) && /^[A-Za-z0-9_.:()-]{0,40}$/.test(value)) lines.push(`RESULT ${key}=${value}`);
  }
  return lines;
}

function baseLines(environment, powercfg) {
  return [
    "READY",
    `POWERSHELL: ${environment.psVersion}`,
    `MSIX: ${environment.msix}`,
    `SHELL: ${environment.shell}`,
    `POWERCFG WRITE: ${powercfg.write}`,
  ];
}

export async function runProbe(argv = [], supplied = {}) {
  const options = { ...supplied };
  const sessionDir = realpathSync(options.sessionDir || MODULE_DIR);
  const marker = markerValue(sessionDir, options);
  if (!VALID_MARKERS.has(marker)) {
    return { code: 0, lines: guardLines(["SAY: Nothing to run yet. See you Friday.", "NEXT: none"]) };
  }
  const platform = options.platform || process.platform;
  if (platform !== "win32") return { code: 0, lines: guardLines(["SAY: This probe only runs on Windows.", "NEXT: none"]) };
  const nodeMajor = options.nodeMajor ?? Number.parseInt(process.versions.node.split(".")[0], 10);
  if (nodeMajor < 22) return { code: 0, lines: guardLines(["SAY: This computer's Node is too old for the probe.", "NEXT: none"]) };

  const command = argv[0] || "start";
  if (command === "start") {
    const environment = inspectEnvironment(options);
    const powercfg = powercfgCheck(options);
    appendRunBlock(sessionDir, marker, environment, powercfg, options);
    const lines = baseLines(environment, powercfg);
    if (marker === "probe-sentence") {
      lines.push("SAY: The probe check is done. Nothing else to run.", "NEXT: none");
      return { code: 0, lines: guardLines(lines) };
    }
    const existing = readLock(sessionDir);
    if (existing && await lockAlive(existing, options)) {
      lines.push("WINDOW 1: ALREADY OPEN", "NEXT: follow");
      return { code: 0, lines: guardLines(lines) };
    }
    const opened = await openWindow(sessionDir, "1", options);
    if (opened === "opened") {
      lines.push("WINDOW 1: OPENED (task)", "SAY: A window called Financial Brain probe is opening. Please follow what it says.", "NEXT: follow");
    } else {
      lines.push(`WINDOW 1: NOT OPENED ${opened}`, "SAY: The probe window did not open. Nothing was changed.");
      await unregister(options);
      lines.push("NEXT: none");
    }
    return { code: 0, lines: guardLines(lines) };
  }

  if (command === "follow") {
    const requested = Number.parseInt(argv[1] || "540", 10);
    const cap = Math.min(590, Math.max(5, Number.isFinite(requested) ? requested : 540));
    const probeDir = join(sessionDir, "probe");
    const sleep = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    for (let elapsed = 0; elapsed < cap; elapsed += 2) {
      if (existsSync(join(probeDir, "window2.done"))) {
        const lines = phaseResults(sessionDir, "2");
        await unregister(options);
        lines.push("PROBE: DONE", "SAY: The probe is finished. Thank you.", "NEXT: none");
        return { code: 0, lines: guardLines(lines) };
      }
      if (existsSync(join(probeDir, "window1.done")) && !existsSync(join(probeDir, "phase2.started"))) {
        const lines = phaseResults(sessionDir, "1");
        const opened = await openWindow(sessionDir, "2", options);
        if (opened === "opened") {
          emitWrite(options, join(probeDir, "phase2.started"), "started=yes\n");
          lines.push("WINDOW 2: OPENED (task)", "SAY: The first window is finished. A second window is opening to read the test value back.", "NEXT: follow");
        } else {
          lines.push(`WINDOW 2: NOT OPENED ${opened}`, "SAY: The probe window did not open. Nothing was changed.");
          await unregister(options);
          lines.push("NEXT: none");
        }
        return { code: 0, lines: guardLines(lines) };
      }
      if (elapsed % 10 === 0) {
        const lock = readLock(sessionDir);
        if (lock && !await lockAlive(lock, options)) {
          await unregister(options);
          return { code: 0, lines: guardLines([
            `WINDOW ${lock.phase === "2" ? "2" : "1"}: CLOSED EARLY`,
            "SAY: The probe window closed before it finished.",
            "NEXT: none",
          ]) };
        }
      }
      await sleep(2000);
    }
    return { code: 0, lines: guardLines(["FOLLOW: STILL WAITING", "NEXT: follow"]) };
  }
  return { code: 0, lines: guardLines(["SAY: Nothing to run yet. See you Friday.", "NEXT: none"]) };
}

export function scanJavaScriptSpawnSafety(source) {
  const marker = "return spawn(command, args, {";
  const at = source.indexOf(marker);
  if (at < 0) return ["spawn-wrapper-missing"];
  const block = source.slice(at, source.indexOf("});", at) + 3);
  const issues = [];
  if (!/windowsHide:\s*true/.test(block)) issues.push("windowsHide");
  if (!/shell:\s*false/.test(block) || /shell:\s*true/.test(block)) issues.push("shell");
  return issues;
}

export function staticCheckPowerShell(source, { allowEncoded = false, namesText = "" } = {}) {
  const issues = [];
  const bytes = Buffer.from(source, "utf8");
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) issues.push("bom");
  if ([...bytes].some((byte) => byte > 0x7f)) issues.push("non-ascii");
  const compiled = ["A", "dd", "-Type"].join("");
  const sealed = String.fromCharCode(97, 108, 105, 103, 110);
  const checks = [
    [new RegExp(compiled, "i"), "compiled-type"],
    [/Invoke-Expression|\biex\b/i, "dynamic-expression"],
    [/Start-Process/i, "start-process"],
    [/SendKeys/i, "send-keys"],
    [/Read-Host/i, "read-host"],
    [/\bdisabled\b/i, "blocked-word"],
    [new RegExp(sealed, "i"), "sealed-word"],
    [/\&\&|\|\||\?\?|\?\.|\s\?\s|\-Parallel\b|\bclean\s*\{/i, "ps7-syntax"],
  ];
  if (!allowEncoded) checks.push([/-EncodedCommand/i, "encoded-command"]);
  for (const [pattern, name] of checks) if (pattern.test(source)) issues.push(name);
  for (const match of source.matchAll(/Set-Clipboard\s+-Value\s+([^\r\n]+)/gi)) {
    if (match[1].trim() !== "' '") issues.push("clipboard-value");
  }
  for (const name of namesText.split(/\r?\n/).filter(Boolean)) {
    try { if (new RegExp(`\\b(?:${name})\\b`, "i").test(source)) issues.push("name"); } catch {}
  }
  return [...new Set(issues)];
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const result = await runProbe(process.argv.slice(2));
    for (const line of result.lines) process.stdout.write(`${line}\n`);
    process.exitCode = result.code;
  } catch {
    process.stdout.write("HELPER: ERROR internal\n");
    process.exitCode = 1;
  }
}
