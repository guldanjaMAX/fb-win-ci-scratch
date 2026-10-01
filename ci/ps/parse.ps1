param([Parameter(Mandatory=$true)][string]$Path)
$ErrorActionPreference = 'Stop'
$bytes = [IO.File]::ReadAllBytes($Path)
$text = New-Object Text.UTF8Encoding($false, $true)
try {
  $source = $text.GetString($bytes)
} catch {
  Write-Output 'errors=1'
  exit 1
}
$tokens = $null
$errors = $null
$null = [Management.Automation.Language.Parser]::ParseInput($source, $Path, [ref]$tokens, [ref]$errors)
Write-Output "errors=$($errors.Count)"
if ($errors.Count -gt 0) { exit 1 }
