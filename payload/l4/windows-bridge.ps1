param(
    [Parameter(Mandatory=$true)][string]$RunnerDir,
    [Parameter(Mandatory=$true)][string]$ExpectedWindowSha256
)

$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) {
    throw 'PowerShell 5.1 required'
}
$windowPath = Join-Path $RunnerDir 'finish-window.txt'
$bytes = [IO.File]::ReadAllBytes($windowPath)
$sha = [Security.Cryptography.SHA256]::Create()
try {
    $actual = (($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join '')
} finally {
    $sha.Dispose()
}
if ($actual -cne $ExpectedWindowSha256) { throw 'window fingerprint mismatch' }
$text = (New-Object Text.UTF8Encoding($false, $true)).GetString($bytes)
if (-not $text.StartsWith('param([Parameter(Mandatory=$true)][string]$SessionDir)')) {
    throw 'window entry point mismatch'
}
$block = [ScriptBlock]::Create($text)
if ($null -eq $block) { throw 'window parse failed' }
[pscustomobject]@{
    pass = $true
    ps = '5.1'
    bytes = $bytes.Length
    sha256 = $actual
    entry = 'script-block'
} | ConvertTo-Json -Compress
