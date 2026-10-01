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
$probe = Join-Path $env:TEMP ('l4-window-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($probe) | Out-Null
$priorTest = $env:FB_WINDOW_TEST
try {
    Copy-Item -LiteralPath (Join-Path $RunnerDir 'facts.json') -Destination (Join-Path $probe 'facts.json')
    Copy-Item -LiteralPath (Join-Path $RunnerDir 'phrases.json') -Destination (Join-Path $probe 'phrases.json')
    [IO.File]::WriteAllText((Join-Path $probe 'fb-test-seam.marker'), "on`n", [Text.Encoding]::ASCII)
    $env:FB_WINDOW_TEST = '1'
    & $block -SessionDir $probe *> $null
    $status = @(Get-Content -LiteralPath (Join-Path $probe 'run\status.txt'))
    if (-not ($status -match ' W1 STOP preflight tier2-off$')) { throw 'off-gate probe missing stop' }
    if (-not ($status -match ' W11 DONE done$')) { throw 'off-gate probe missing done' }
} finally {
    if ($null -eq $priorTest) { Remove-Item Env:FB_WINDOW_TEST -ErrorAction SilentlyContinue }
    else { $env:FB_WINDOW_TEST = $priorTest }
    if ($probe.StartsWith((Join-Path $env:TEMP 'l4-window-'))) {
        Remove-Item -LiteralPath $probe -Recurse -Force -ErrorAction SilentlyContinue
    }
}
[pscustomobject]@{
    pass = $true
    ps = '5.1'
    bytes = $bytes.Length
    sha256 = $actual
    entry = 'script-block'
    launch = 'off-gate'
} | ConvertTo-Json -Compress
