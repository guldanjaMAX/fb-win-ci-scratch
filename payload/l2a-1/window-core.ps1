param([Parameter(Mandatory=$true)][string]$SessionDir)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$script:FbKey = $null
$script:FbUtf8 = New-Object System.Text.UTF8Encoding -ArgumentList $false
$script:FB = @{
    Session = $SessionDir
    Run = (Join-Path $SessionDir 'run')
    Prefix = $null
    Manifest = $null
    Cli = $null
    Node = $null
    Facts = $null
    DomainPresent = $false
    Rehearsal = $false
    Tier2On = $false
    W8On = $false
    TestSeam = $false
    KeyReady = $false
    LastRefusal = $null
    HealthResult = $null
    HealthRead = $false
    Rejoin = $false
    RejoinRunId = $null
    PausedChoice = $null
    HistoryOn = $false
    CloudClipboardOn = $false
    W7RunId = $null
}

function Initialize-FbCore {
    $host.UI.RawUI.WindowTitle = 'Financial Brain update'
    $host.UI.RawUI.BackgroundColor = 'DarkBlue'
    $host.UI.RawUI.ForegroundColor = 'White'
    Clear-Host
    [IO.Directory]::CreateDirectory($FB.Run) | Out-Null
    [IO.Directory]::CreateDirectory((Join-Path $FB.Run 'steps')) | Out-Null
    $factsPath = Join-Path $FB.Session 'facts.json'
    if (-not (Test-Path -LiteralPath $factsPath -PathType Leaf)) { throw 'facts missing' }
    if ((Get-Item -LiteralPath $factsPath).Length -gt 1MB) { throw 'facts too large' }
    $FB.Facts = Get-Content -LiteralPath $factsPath -Raw | ConvertFrom-Json
    $markerPath = Join-Path $FB.Session 'REHEARSAL.marker'
    $markerLines = @()
    if (Test-Path -LiteralPath $markerPath -PathType Leaf) {
        if ((Get-Item -LiteralPath $markerPath).Length -le 1KB) {
            $markerText = [IO.File]::ReadAllText($markerPath, [Text.Encoding]::ASCII)
            $markerLines = @($markerText -split "`r?`n" | ForEach-Object { $_.Trim() })
        }
    }
    $FB.Rehearsal = $markerLines.Count -gt 0 -and $markerLines[0] -ceq 'tier2'
    $FB.Tier2On = $FB.Facts.tier2 -ceq 'on' -or $FB.Rehearsal
    $FB.W8On = $FB.Facts.w8 -ceq 'on' -or ($FB.Rehearsal -and $markerLines -ccontains 'w8')
    $FB.TestSeam = $env:FB_WINDOW_TEST -ceq '1' -and (Test-Path -LiteralPath (Join-Path $FB.Session 'fb-test-seam.marker') -PathType Leaf)
    if ($FB.TestSeam) { Write-FbStatus -Step 'RUN' -Code 'INFO' -Reason 'test-seam-on' }
}

function Write-FbStatus {
    param(
        [Parameter(Mandatory=$true)][string]$Step,
        [Parameter(Mandatory=$true)][string]$Code,
        [Parameter(Mandatory=$true)][string]$Reason,
        [string]$Who,
        [Nullable[int]]$N,
        [string]$Id,
        [string[]]$Words
    )
    $parts = @([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'), $Step, $Code)
    if ($Code -ceq 'STOP' -and $Reason -cne 'lead-stop') {
        if (@('selection','cli-missing','manifest-missing','node-old','av-third-party','memory-low','tier2-off') -ccontains $Reason) { $parts += 'preflight' }
        elseif (@('two-bad','key-visible') -ccontains $Reason) { $parts += 'key' }
        elseif (@('download','sha','bytes','install','version','payload','pending-migration') -ccontains $Reason) { $parts += 'kit' }
        elseif (@('queued','mismatch','failed','second-failure') -ccontains $Reason) { $parts += 'update' }
        elseif (@('check-failed','connect-failed') -ccontains $Reason) { $parts += 'google' }
        elseif (@('edit-failed','verify-failed') -ccontains $Reason) { $parts += 'manifest' }
    }
    if ($Who) { $parts += $Who }
    $parts += $Reason
    if ($null -ne $N) { $parts += ('n=' + $N.Value) }
    if ($Id) { $parts += ('id=' + $Id) }
    if ($Words -and $Words.Count -gt 0) { $parts += ('words=' + ($Words -join ',')) }
    $line = ($parts -join ' ') + "`n"
    [IO.File]::AppendAllText((Join-Path $FB.Run 'status.txt'), $line, $script:FbUtf8)
}

function Show-FbLine {
    param([Parameter(Mandatory=$true)][string]$Key, [hashtable]$Fill)
    $phrasesPath = Join-Path $FB.Session 'phrases.json'
    if (-not (Test-Path -LiteralPath $phrasesPath -PathType Leaf)) { throw 'phrases missing' }
    if ((Get-Item -LiteralPath $phrasesPath).Length -gt 1MB) { throw 'phrases too large' }
    $sentences = @{
        'W1-READY' = 'Your Brain: ready.'
        'W1-BUSY' = 'Your Brain: still putting away recent documents.'
        'W1-DOCS-DONE' = 'Documents: finished loading.'
        'W1-DOCS-LOADING' = 'Documents: still loading.'
        'W1-UPDATE-CAN' = 'Update: can start.'
        'W1-UPDATE-NOT-TODAY' = 'Update: not today. Your Brain keeps working as it is.'
        'W1-CHECK' = 'This computer needs a quick check first. Nothing was changed.'
        'W3-PAUSE' = 'Please pause your screen share for a minute; your password manager will be on screen.'
        'W3-COPY' = 'Open your password manager, find Financial Brain updates, and click Copy. I''ll say Got it.'
        'W3-NUDGE' = 'Still waiting for the key. Click Copy on Financial Brain updates in your password manager.'
        'W3-TWO' = 'That copy held more than one key-like value. Copy only the key, please.'
        'W3-GOT' = 'Got it.'
        'W3-CHECKING' = 'Checking the key.'
        'W3-BAD' = 'That key didn''t work. Please copy it once more.'
        'W3-CHECKED' = 'Checked.'
        'W3-SAVED' = 'Saved on this computer.'
        'W3-SHARE' = 'You can share again.'
        'W3-LATER' = 'Let''s do this part later. You can share again.'
        'W3-USING-SAVED' = 'Using the key saved on this computer.'
        'W3-SAVED-OLD' = 'The key saved on this computer no longer works.'
        'W4-BUSY' = 'Your Brain is still putting away about {n} recent items. That takes about {m} minutes.'
        'W4-LATER' = 'We''ll do the update another time. Your Brain keeps working as it is.'
        'W6-GETTING' = 'Getting the update ready.'
        'W7-START' = 'Updating your Brain. This usually takes 10 to 25 minutes, sometimes longer. Nothing for you to do.'
        'W7-STEP' = 'Update step {k} of 13. Nothing for you to do.'
        'W7-PAUSE20' = 'Update step {k} of 13: a safety pause that can last up to 20 minutes. Nothing for you to do.'
        'W7-DONE' = 'Updated. Your Brain is on {v}.'
        'W8-CHECK' = 'Checking your calendar connection.'
        'W8-OK' = 'Your calendar connection works.'
        'W8-BUSY' = 'Google is busy loading your documents, so the calendar check waits for another day.'
        'W8-HOST' = 'Google will warn that this app isn''t verified. That''s because it''s your own private app, made just for your Brain. Click Advanced, then Continue.'
        'W8-BOXES' = 'If Google shows boxes, tick every one, then click Continue.'
        'W8-OPENING' = 'Google is opening in your browser. Pick your Google account.'
        'W8-ALL' = 'Google gave your Brain access to Drive, Gmail and Calendar.'
        'W8-MISSING' = 'Google did not give access to {list}. {list} won''t load until it''s allowed. We''ll sort that out with you.'
        'W8-OTHER-ACCOUNT' = 'That was a different Google account from before.'
        'W8-NOT-FINISHED' = 'The Google sign-in didn''t finish. That''s fine; we''ll do it another time.'
        'LEAD' = 'One moment: someone on our side needs to look at this. Your Brain is safe.'
        'W11-DONE' = 'Done here. You can close this window.'
    }
    if (-not $sentences.ContainsKey($Key)) { throw 'sentence missing' }
    $line = [string]$sentences[$Key]
    if ($Fill) {
        foreach ($name in $Fill.Keys) { $line = $line.Replace(('{' + $name + '}'), [string]$Fill[$name]) }
    }
    if ($line.Length -gt 160 -or $line -match '[^\x00-\x7F]') { throw 'sentence invalid' }
    [IO.File]::WriteAllText((Join-Path $FB.Run 'now.txt'), ($line + "`n"), $script:FbUtf8)
    Write-Host $line
}

function Show-FbWindow {
    if ($FB.TestSeam) { return }
    try {
        $shell = New-Object -ComObject WScript.Shell
        [void]$shell.AppActivate('Financial Brain update')
        [Console]::Beep(880, 180)
    } catch {}
}

function Quote-FbArgument {
    param([string]$Value)
    if ($Value -notmatch '[\s"]') { return $Value }
    return '"' + ($Value -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

function Start-FbStep {
    param(
        [Parameter(Mandatory=$true)][string]$Step,
        [string]$Variant,
        [switch]$WithKey
    )
    $allowedVariants = @{
        'drive-state' = @('load-yes', 'load-no')
        'manifest-edit' = @('copy', 'ocr-off')
        'google-scopes' = @('pre', 'post')
    }
    if ($allowedVariants.ContainsKey($Step)) {
        if (-not $Variant -or $allowedVariants[$Step] -cnotcontains $Variant) { throw 'bad step variant' }
    } elseif ($Variant) { throw 'unexpected step variant' }
    $keySteps = @('verify', 'health-key', 'update', 'deploy-recover')
    if ($WithKey -and $keySteps -cnotcontains $Step) { throw 'key not allowed for step' }
    if ($WithKey -and (-not $FB.KeyReady -or $null -eq $script:FbKey)) { throw 'key unavailable' }

    $argv = @((Join-Path $FB.Session 'fb-run.mjs'), 'start', $Step, '--session', $FB.Session)
    if ($Variant) { $argv += @('--variant', $Variant) }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $FB.Node
    $psi.Arguments = (($argv | ForEach-Object { Quote-FbArgument $_ }) -join ' ')
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.EnvironmentVariables.Clear()
    $allow = @('PATH','PATHEXT','SystemRoot','windir','ComSpec','TEMP','TMP','USERPROFILE','HOMEDRIVE','HOMEPATH','APPDATA','LOCALAPPDATA','USERNAME','USERDOMAIN','ProgramData','ProgramFiles','ProgramFiles(x86)','ALLUSERSPROFILE','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS','OS')
    foreach ($name in $allow) {
        $value = [Environment]::GetEnvironmentVariable($name)
        if ($null -ne $value) { $psi.EnvironmentVariables[$name] = $value }
    }
    $psi.EnvironmentVariables['BRAIN_NO_WRANGLER_LOGIN'] = '1'
    $bstr = [IntPtr]::Zero
    $plain = $null
    try {
        if ($WithKey) {
            $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($script:FbKey)
            $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
            $psi.EnvironmentVariables['CLOUDFLARE_API_TOKEN'] = $plain
        }
        $process = New-Object System.Diagnostics.Process
        $process.StartInfo = $psi
        [void]$process.Start()
        $line = $process.StandardOutput.ReadLine()
        $errorText = $process.StandardError.ReadToEnd()
        $process.WaitForExit()
    } finally {
        $plain = $null
        [void]$psi.EnvironmentVariables.Remove('CLOUDFLARE_API_TOKEN')
        if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    }
    if ($line -match '^RUN\s+\S+\s+(\S+)$') {
        $FB.LastRefusal = $null
        return $Matches[1]
    }
    if ($line -match '^REFUSED\s+(.+)$') {
        $FB.LastRefusal = $Matches[1]
        return $null
    }
    throw 'supervisor returned no run id'
}

function Wait-FbStep {
    param(
        [Parameter(Mandatory=$true)][string]$RunId,
        [int]$TimeoutSec = 0,
        [scriptblock]$OnEvent
    )
    $folder = Join-Path (Join-Path $FB.Run 'steps') $RunId
    $eventsPath = Join-Path $folder 'events.txt'
    $exitPath = Join-Path $folder 'exit.txt'
    $alivePath = Join-Path $folder 'alive.txt'
    $events = @()
    $seen = 0
    $started = [DateTime]::UtcNow
    while ($true) {
        if (Test-FbKeyVisible) { return @{ Exit = 1; Class = 'key-visible'; Events = $events } }
        if (Test-Path -LiteralPath $eventsPath -PathType Leaf) {
            $all = @(Get-Content -LiteralPath $eventsPath)
            if ($all.Count -gt $seen) {
                for ($i = $seen; $i -lt $all.Count; $i++) {
                    $events += $all[$i]
                    if ($OnEvent) { & $OnEvent $all[$i] }
                }
                $seen = $all.Count
            }
        }
        if (Test-Path -LiteralPath $exitPath -PathType Leaf) {
            $exitLine = (Get-Content -LiteralPath $exitPath -Raw).Trim()
            if ($exitLine -match '^EXIT\s+(-?\d+)\s+([a-z0-9-]+)\s+') {
                return @{ Exit = [int]$Matches[1]; Class = $Matches[2]; Events = $events }
            }
            throw 'bad step exit'
        }
        if (Test-Path -LiteralPath $alivePath -PathType Leaf) {
            if (((Get-Date).ToUniversalTime() - (Get-Item -LiteralPath $alivePath).LastWriteTimeUtc).TotalSeconds -gt 60) {
                return @{ Exit = 1; Class = 'dead'; Events = $events }
            }
        }
        if ($TimeoutSec -gt 0 -and (([DateTime]::UtcNow - $started).TotalSeconds -ge $TimeoutSec)) {
            return @{ Exit = 1; Class = 'timeout'; Events = $events }
        }
        Start-Sleep -Seconds 2
    }
}

function New-FbDecisionId {
    $bytes = New-Object byte[] 3
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Get-FbScaledSeconds {
    param([int]$Seconds)
    if (-not $FB.TestSeam) { return $Seconds }
    $scale = 1.0
    if ($env:FB_TEST_TIME_SCALE) { [void][double]::TryParse($env:FB_TEST_TIME_SCALE, [ref]$scale) }
    if ($scale -le 0) { $scale = 1.0 }
    return [Math]::Max(1, [int][Math]::Ceiling($Seconds * $scale))
}

function Test-FbKeyVisible {
    $decisionPath = Join-Path $FB.Run 'decision.txt'
    if (-not (Test-Path -LiteralPath $decisionPath -PathType Leaf)) { return $false }
    $line = (Get-Content -LiteralPath $decisionPath -Raw).Trim()
    return $line -ceq 'key-visible' -or $line -match '^key-visible\s+id='
}

function Wait-FbDecision {
    param(
        [Parameter(Mandatory=$true)][string]$Step,
        [Parameter(Mandatory=$true)][string]$Reason,
        [Parameter(Mandatory=$true)][string[]]$Words,
        [int]$DefaultAfterSec = 0,
        [string]$Default
    )
    $id = New-FbDecisionId
    Write-FbStatus -Step $Step -Code 'WAITING' -Who 'lead' -Reason $Reason -Id $id -Words $Words
    $decisionPath = Join-Path $FB.Run 'decision.txt'
    $started = [DateTime]::UtcNow
    $limit = if ($DefaultAfterSec -gt 0) { Get-FbScaledSeconds $DefaultAfterSec } else { 0 }
    while ($true) {
        if (Test-Path -LiteralPath $decisionPath -PathType Leaf) {
            $line = (Get-Content -LiteralPath $decisionPath -Raw).Trim()
            if ($line -ceq 'key-visible' -or $line -match '^key-visible\s+id=') { return 'key-visible' }
            if ($line -match '^(\S+)\s+id=([0-9a-f]{6})$') {
                $word = $Matches[1]
                $foundId = $Matches[2]
                if ($foundId -ceq $id -and $Words -ccontains $word) { return $word }
                Write-FbStatus -Step 'RUN' -Code 'INFO' -Reason 'decision-ignored'
                Remove-Item -LiteralPath $decisionPath -Force -ErrorAction SilentlyContinue
            }
        }
        if ($limit -gt 0 -and (([DateTime]::UtcNow - $started).TotalSeconds -ge $limit)) { return $Default }
        Start-Sleep -Milliseconds 250
    }
}

function Read-FbJsonSeam {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    if ((Get-Item -LiteralPath $Path).Length -gt 1MB) { throw 'test seam file too large' }
    [void][Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
    $serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
    return $serializer.DeserializeObject([IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8))
}

function Test-FbProcesses {
    $load = $false
    $update = $false
    $updatePid = 0
    if ($FB.TestSeam) {
        $rows = Read-FbJsonSeam (Join-Path $FB.Session 'test-processes.json')
        if ($null -eq $rows) { $rows = @() }
        foreach ($row in @($rows)) {
            $command = [string]$row['CommandLine']
            $pidValue = [int]$row['ProcessId']
            if ($command -match '(?i)brain\.mjs"?\s+(load|ingest)(\s|$)') { $load = $true }
            if ($command -match '(?i)brain\.mjs"?\s+(update|upgrade|deploy)(\s|$)') { $update = $true; $updatePid = $pidValue }
        }
    } else {
        $rows = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'")
        foreach ($row in $rows) {
            $command = [string]$row.CommandLine
            if ($command -match '(?i)brain\.mjs"?\s+(load|ingest)(\s|$)') { $load = $true }
            if ($command -match '(?i)brain\.mjs"?\s+(update|upgrade|deploy)(\s|$)') { $update = $true; $updatePid = [int]$row.ProcessId }
        }
    }
    return @{ Load = $load; Update = $update; UpdatePid = $updatePid }
}

function Get-FbProgress {
    param([Parameter(Mandatory=$true)][string]$Key)
    $path = Join-Path $FB.Run 'progress.txt'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    $value = $null
    foreach ($line in Get-Content -LiteralPath $path) {
        if ($line -match ('^' + [regex]::Escape($Key) + '=([A-Za-z0-9_.:+-]+)$')) { $value = $Matches[1] }
    }
    return $value
}

function Set-FbProgress {
    param([Parameter(Mandatory=$true)][string]$Key, [Parameter(Mandatory=$true)][string]$Value)
    if ($Key -notmatch '^[a-z0-9_]{1,40}$' -or $Value -notmatch '^[A-Za-z0-9_.:+-]+$') { throw 'bad progress value' }
    [IO.File]::AppendAllText((Join-Path $FB.Run 'progress.txt'), ($Key + '=' + $Value + "`n"), $script:FbUtf8)
}

function Read-FbStepLine {
    param([string]$RunId)
    $path = Join-Path (Join-Path (Join-Path $FB.Run 'steps') $RunId) 'out.log'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return '' }
    if ((Get-Item -LiteralPath $path).Length -gt 1MB) { throw 'step output too large' }
    return (Get-Content -LiteralPath $path -Raw).Trim()
}

function Get-FbEventFact {
    param([object]$Result, [string]$Name)
    foreach ($eventLine in @($Result.Events)) {
        if ($eventLine -match ('\sfact\s+' + [regex]::Escape($Name) + '=([A-Za-z0-9_.:+-]{0,64})$')) { return $Matches[1] }
    }
    return $null
}

function Get-FbPendingCount {
    param([object]$Result)
    foreach ($eventLine in @($Result.Events)) {
        if ($eventLine -match '\smetric\s+[a-z0-9_]+=(\d+)$') { return [int64]$Matches[1] }
    }
    return $null
}

function Remove-FbHeldKey {
    if ($null -ne $script:FbKey) { $script:FbKey.Dispose() }
    $script:FbKey = $null
    $FB.KeyReady = $false
}

function Stop-FbUnexpected {
    Write-FbStatus -Step 'RUN' -Code 'STOP' -Reason 'lead-stop'
    Show-FbLine -Key 'LEAD'
}

function Flush-FbInput {
    try { $host.UI.RawUI.FlushInputBuffer() } catch {}
}
