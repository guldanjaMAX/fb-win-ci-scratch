param(
  [Parameter(Mandatory=$true)][int]$ProbePid,
  [Parameter(Mandatory=$true)][string]$ExpectedStart
)
$ErrorActionPreference = 'SilentlyContinue'
$Process = Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f $ProbePid)
if (-not $Process) { [Console]::Out.WriteLine('alive=no'); exit 0 }
$Actual = $Process.CreationDate.ToUniversalTime().ToString('o')
if ([String]::Equals($Actual, $ExpectedStart, [StringComparison]::Ordinal)) { [Console]::Out.WriteLine('alive=yes') }
else { [Console]::Out.WriteLine('alive=no') }
