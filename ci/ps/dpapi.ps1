param(
  [Parameter(Mandatory=$true)][ValidateSet('control','tamper','disk-scan')][string]$Arm,
  [Parameter(Mandatory=$true)][string]$Root
)
$ErrorActionPreference = 'Stop'
[IO.Directory]::CreateDirectory($Root) | Out-Null
$child = Join-Path $PSScriptRoot 'dpapi-child.ps1'
$powerShell = Join-Path $PSHOME 'powershell.exe'

function Quote-Argument([string]$Value) {
  return '"' + ($Value -replace '"', '\"') + '"'
}

function Invoke-Child([string]$Mode) {
  $info = New-Object Diagnostics.ProcessStartInfo
  $info.FileName = $powerShell
  $info.Arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -File ' + (Quote-Argument $child) + ' -Mode ' + $Mode + ' -Root ' + (Quote-Argument $Root)
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $process = New-Object Diagnostics.Process
  $process.StartInfo = $info
  if (-not $process.Start()) { throw 'child-start' }
  $stdout = $process.StandardOutput.ReadToEnd()
  $null = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  return @{ Code = $process.ExitCode; Out = $stdout }
}

if ($Arm -eq 'control' -or $Arm -eq 'tamper') {
  $first = Invoke-Child 'protect'
  if ($first.Code -ne 0) { exit 1 }
  $expected = [IO.File]::ReadAllText((Join-Path $Root 'hash.txt')).Trim()
  if ($Arm -eq 'tamper') {
    $cipherPath = Join-Path $Root 'cipher.txt'
    $cipher = [IO.File]::ReadAllText($cipherPath)
    $replacement = if ($cipher[0] -eq 'A') { 'B' } else { 'A' }
    [IO.File]::WriteAllText($cipherPath, $replacement + $cipher.Substring(1), (New-Object Text.ASCIIEncoding))
  }
  $second = Invoke-Child 'unprotect'
  $reached = Test-Path (Join-Path $Root 'read-reached.txt')
  if (-not $reached) { exit 1 }
  if ($Arm -eq 'control') {
    if ($second.Code -ne 0 -or $second.Out -notmatch "hash=$expected") { exit 1 }
    Write-Output 'control=match processes=2'
    exit 0
  }
  if ($second.Code -eq 0 -or $second.Out -notmatch 'unreadable=yes') { exit 1 }
  Write-Output 'tamper=unreadable read=yes'
  exit 0
}

$utf8Path = Join-Path $Root 'plain-utf8.txt'
$utf16Path = Join-Path $Root 'plain-utf16.txt'
$protected = Invoke-Child 'protect-scan'
if ($protected.Code -ne 0 -or -not (Test-Path (Join-Path $Root 'cipher.txt'))) { exit 1 }
$canary = [IO.File]::ReadAllText($utf8Path, (New-Object Text.UTF8Encoding($false, $true)))
function Count-Canary {
  $count = 0
  foreach ($file in Get-ChildItem -LiteralPath $Root -File) {
    if ($file.Name -eq 'cipher.txt') { continue }
    $bytes = [IO.File]::ReadAllBytes($file.FullName)
    $asUtf8 = [Text.Encoding]::UTF8.GetString($bytes)
    $asUtf16 = [Text.Encoding]::Unicode.GetString($bytes)
    if ($asUtf8.Contains($canary) -or $asUtf16.Contains($canary)) { $count += 1 }
  }
  return $count
}
$before = Count-Canary
Remove-Item -LiteralPath $utf8Path, $utf16Path -Force
$after = Count-Canary
if ($before -ne 2 -or $after -ne 0) { exit 1 }
Write-Output 'disk-before=2 disk-after=0'
