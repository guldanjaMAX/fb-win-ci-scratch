param([Parameter(Mandatory=$true)][int]$NodeParentPid)
$ErrorActionPreference = 'SilentlyContinue'
$Version = $PSVersionTable.PSVersion
[Console]::Out.WriteLine(('ps_version={0}.{1}.{2}' -f $Version.Major, $Version.Minor, $Version.Build))
$Parent = Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f $NodeParentPid)
$ParentName = if ($Parent.Name) { [IO.Path]::GetFileNameWithoutExtension($Parent.Name).ToLowerInvariant() } else { 'unknown' }
[Console]::Out.WriteLine("parent=$ParentName")
$Found = $false
$Next = $Parent
for ($i = 0; $i -lt 8 -and $Next; $i++) {
  if ($Next.ExecutablePath -like '*\WindowsApps\*') { $Found = $true; break }
  $Next = Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f $Next.ParentProcessId)
}
[Console]::Out.WriteLine(('ancestor_windowsapps=' + $(if ($Found) { 'yes' } else { 'no' })))
