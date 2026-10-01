$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = '@@TITLE@@'
$SessionDir = '@@SESSION@@'
$RunDir = '@@RUN@@'
[IO.Directory]::CreateDirectory($RunDir) | Out-Null
$Started = (Get-Process -Id $PID -ErrorAction Stop).StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
$Lf = [char]10
$Lock = "pid=$PID" + $Lf + "start=$Started" + $Lf
[IO.File]::WriteAllText((Join-Path $RunDir 'window.lock'), $Lock, [Text.Encoding]::ASCII)
$WindowPath = Join-Path $SessionDir 'finish-window.txt'
$Bytes = [IO.File]::ReadAllBytes($WindowPath)
$Sha = [Security.Cryptography.SHA256]::Create()
try { $Got = ([BitConverter]::ToString($Sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() } finally { $Sha.Dispose() }
if ($Got -ne '@@PIN@@') {
  $Utc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  $Refusal = "$Utc RUN STOP preflight window-fingerprint" + $Lf
  [IO.File]::AppendAllText((Join-Path $RunDir 'status.txt'), $Refusal, [Text.Encoding]::ASCII)
  exit 0
}
if ($Bytes.Length -ge 3 -and $Bytes[0] -eq 239 -and $Bytes[1] -eq 187 -and $Bytes[2] -eq 191) {
  [byte[]]$Bytes = $Bytes[3..($Bytes.Length - 1)]
}
$Text = [Text.Encoding]::UTF8.GetString($Bytes)
& ([ScriptBlock]::Create($Text)) -SessionDir '@@SESSION@@'
