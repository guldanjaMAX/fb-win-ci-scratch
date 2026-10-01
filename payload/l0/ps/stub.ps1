$ErrorActionPreference = 'Stop'
$SessionDir = __SESSION_LITERAL__
$Phase = __PHASE_LITERAL__
$Expected = __HASH_LITERAL__
$ProbeDir = Join-Path $SessionDir 'probe'
$WindowPath = Join-Path $ProbeDir 'window.ps1'
$ResultPath = Join-Path $SessionDir 'probe-results.txt'
$LockPath = Join-Path $ProbeDir 'window.lock'
[IO.Directory]::CreateDirectory($ProbeDir) | Out-Null
$Self = Get-CimInstance Win32_Process -Filter "ProcessId=$PID"
$Start = $Self.CreationDate.ToUniversalTime().ToString('o')
[IO.File]::WriteAllText($LockPath, "pid=$PID`nstart=$Start`nphase=$Phase`n", [Text.Encoding]::ASCII)
$Bytes = [IO.File]::ReadAllBytes($WindowPath)
$Hasher = [Security.Cryptography.SHA256]::Create()
try { $Actual = ([BitConverter]::ToString($Hasher.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
finally { $Hasher.Dispose() }
if (-not [String]::Equals($Actual, $Expected, [StringComparison]::Ordinal)) {
  [IO.File]::AppendAllText($ResultPath, "stop=fingerprint`n", [Text.Encoding]::ASCII)
  exit 0
}
$Offset = 0
if ($Bytes.Length -ge 3 -and $Bytes[0] -eq 0xEF -and $Bytes[1] -eq 0xBB -and $Bytes[2] -eq 0xBF) { $Offset = 3 }
$Text = [Text.Encoding]::UTF8.GetString($Bytes, $Offset, $Bytes.Length - $Offset)
$Block = [ScriptBlock]::Create($Text)
& $Block -SessionDir $SessionDir -Phase $Phase
