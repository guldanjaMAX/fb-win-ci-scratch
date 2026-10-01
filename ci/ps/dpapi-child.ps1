param(
  [Parameter(Mandatory=$true)][ValidateSet('protect','protect-scan','unprotect')][string]$Mode,
  [Parameter(Mandatory=$true)][string]$Root
)
$ErrorActionPreference = 'Stop'
[IO.Directory]::CreateDirectory($Root) | Out-Null
$cipherPath = Join-Path $Root 'cipher.txt'
$hashPath = Join-Path $Root 'hash.txt'
$readPath = Join-Path $Root 'read-reached.txt'
$ascii = New-Object Text.ASCIIEncoding

if ($Mode -eq 'protect' -or $Mode -eq 'protect-scan') {
  $random = New-Object byte[] 48
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($random) } finally { $rng.Dispose() }
  $plain = [Convert]::ToBase64String($random).Substring(0, 40)
  $secure = ConvertTo-SecureString -String $plain -AsPlainText -Force
  $cipher = ConvertFrom-SecureString -SecureString $secure
  [IO.File]::WriteAllText($cipherPath, $cipher, $ascii)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $hex = ([BitConverter]::ToString($sha.ComputeHash($ascii.GetBytes($plain))) -replace '-', '').Substring(0, 8).ToLowerInvariant() } finally { $sha.Dispose() }
  [IO.File]::WriteAllText($hashPath, $hex, $ascii)
  if ($Mode -eq 'protect-scan') {
    [IO.File]::WriteAllText((Join-Path $Root 'plain-utf8.txt'), $plain, (New-Object Text.UTF8Encoding($false)))
    [IO.File]::WriteAllText((Join-Path $Root 'plain-utf16.txt'), $plain, [Text.Encoding]::Unicode)
  }
  Write-Output "hash=$hex"
  exit 0
}

[IO.File]::WriteAllText($readPath, 'yes', $ascii)
try {
  $cipher = [IO.File]::ReadAllText($cipherPath, $ascii)
  $secure = ConvertTo-SecureString -String $cipher
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $hex = ([BitConverter]::ToString($sha.ComputeHash($ascii.GetBytes($plain))) -replace '-', '').Substring(0, 8).ToLowerInvariant() } finally { $sha.Dispose() }
  Write-Output "hash=$hex"
  exit 0
} catch {
  Write-Output 'unreadable=yes'
  exit 4
}
