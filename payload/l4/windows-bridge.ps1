param(
    [Parameter(Mandatory=$true)][string]$RunnerDir,
    [Parameter(Mandatory=$true)][string]$SessionDir,
    [Parameter(Mandatory=$true)][string]$WindowPath,
    [Parameter(Mandatory=$true)][string]$ExpectedWindowSha256,
    [Parameter(Mandatory=$true)][string]$ReceiptPath,
    [ValidateSet('on','off')][string]$TestMode = 'on'
)

$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) {
    throw 'PowerShell 5.1 required'
}
$bytes = [IO.File]::ReadAllBytes($WindowPath)
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
$priorTest = $env:FB_WINDOW_TEST
try {
    if ($TestMode -ceq 'on') { $env:FB_WINDOW_TEST = '1' }
    else { Remove-Item Env:FB_WINDOW_TEST -ErrorAction SilentlyContinue }
    $receipt = [ordered]@{
        pass = $true
        ps = '5.1'
        bytes = $bytes.Length
        sha256 = $actual
        entry = 'script-block'
        session = [IO.Path]::GetFileName($SessionDir)
        launched = $true
    } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($ReceiptPath, ($receipt + "`n"), (New-Object Text.UTF8Encoding($false)))
    & $block -SessionDir $SessionDir
} finally {
    if ($null -eq $priorTest) { Remove-Item Env:FB_WINDOW_TEST -ErrorAction SilentlyContinue }
    else { $env:FB_WINDOW_TEST = $priorTest }
}
