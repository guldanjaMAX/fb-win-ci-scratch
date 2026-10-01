param(
  [Parameter(Mandatory=$true)][string]$Path,
  [Parameter(Mandatory=$true)][string]$DisplayPath
)
$ErrorActionPreference = 'Stop'
$bytes = [IO.File]::ReadAllBytes($Path)
$text = New-Object Text.UTF8Encoding($false, $true)
try {
  $source = $text.GetString($bytes)
} catch {
  Write-Output 'errors=1'
  $message = $_.Exception.Message -replace '[\r\n]+', ' '
  Write-Output "DETAIL parse file=$DisplayPath line=1 message=$message"
  exit 1
}
$tokens = $null
$errors = $null
$null = [Management.Automation.Language.Parser]::ParseInput($source, $Path, [ref]$tokens, [ref]$errors)
Write-Output "errors=$($errors.Count)"
foreach ($errorItem in @($errors)) {
  $message = $errorItem.Message -replace '[\r\n]+', ' '
  Write-Output "DETAIL parse file=$DisplayPath line=$($errorItem.Extent.StartLineNumber) message=$message"
}
if ($errors.Count -gt 0) { exit 1 }
