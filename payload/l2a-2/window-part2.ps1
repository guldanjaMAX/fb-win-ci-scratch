function Test-FbW1DriveTerminal {
    return [bool]$FB.DriveTerminal
}

function Write-FbManifestFacts {
    param([object]$Result)
    if ((Get-FbEventFact -Result $Result -Name 'backup') -ceq 'yes') {
        Write-FbStatus -Step 'W5' -Code 'INFO' -Reason 'backup'
    }
    if ((Get-FbEventFact -Result $Result -Name 'desktop_copy') -ceq 'yes') {
        Write-FbStatus -Step 'W5' -Code 'INFO' -Reason 'desktop-copy'
    }
}

function Invoke-FbW5 {
    if (-not $FB.Tier2On) { return 'skip' }
    try {
        $processes = Test-FbProcesses
        if (Test-FbKeyVisible) { return Stop-FbVisibleKey }
        $terminal = Test-FbW1DriveTerminal
        $variant = 'copy'
        $skipReason = $null
        if ($processes.Load) { $skipReason = 'load-running' }
        elseif (-not $terminal) { $skipReason = 'drive-not-terminal' }
        else { $variant = 'ocr-off' }

        if ($variant -ceq 'ocr-off') {
            $runId = Start-FbStep -Step 'manifest-edit' -Variant 'ocr-off'
        } else {
            $runId = Start-FbStep -Step 'manifest-edit' -Variant 'copy'
        }
        if (-not $runId) {
            Write-FbStatus -Step 'W5' -Code 'STOP' -Reason 'edit-failed'
            Set-FbProgress -Key 'w5_result' -Value 'stop'
            return 'stop'
        }
        $result = Wait-FbStep -RunId $runId -TimeoutSec 70
        if (Test-FbKeyVisible) { return Stop-FbVisibleKey }
        Write-FbManifestFacts -Result $result
        $editResult = Get-FbEventFact -Result $result -Name 'result'
        if ($editResult -ceq 'verify_failed') {
            Write-FbStatus -Step 'W5' -Code 'STOP' -Reason 'verify-failed'
            Set-FbProgress -Key 'w5_result' -Value 'stop'
            return 'stop'
        }
        if ($result.Exit -ne 0 -or $editResult -cne 'pass') {
            Write-FbStatus -Step 'W5' -Code 'STOP' -Reason 'edit-failed'
            Set-FbProgress -Key 'w5_result' -Value 'stop'
            return 'stop'
        }
        if ($skipReason) {
            Write-FbStatus -Step 'W5' -Code 'SKIP' -Reason $skipReason
        } elseif ((Get-FbEventFact -Result $result -Name 'changed') -ceq 'yes') {
            Write-FbStatus -Step 'W5' -Code 'PASS' -Reason 'ocr-off-cap-10'
        } else {
            Write-FbStatus -Step 'W5' -Code 'PASS' -Reason 'already-off'
        }
        Set-FbProgress -Key 'w5_result' -Value 'pass'
        return 'pass'
    } catch {
        Write-FbStatus -Step 'W5' -Code 'STOP' -Reason 'edit-failed'
        Set-FbProgress -Key 'w5_result' -Value 'stop'
        return 'stop'
    }
}

function Invoke-FbPreview {
    $runId = Start-FbStep -Step 'update-preview'
    if (-not $runId) { return @{ Exit = 1; Class = 'other'; Events = @() } }
    $result = Wait-FbStep -RunId $runId -TimeoutSec 320
    return $result
}

function Set-FbPrereadReady {
    $FB.W7PrereadAt = [DateTime]::UtcNow
    $FB.W7PrereadBlocked = $false
    Write-FbStatus -Step 'W7' -Code 'INFO' -Reason 'preread-ready'
}

function Invoke-FbW6 {
    if (-not $FB.Tier2On) { return 'skip' }
    try {
        Show-FbLine -Key 'W6-GETTING'
        $processes = Test-FbProcesses
        if ($processes.Load) {
            $choice = Wait-FbDecision -Step 'W6' -Reason 'load-running' -Words @('wait','finish-later')
            if ($choice -ceq 'key-visible') { return Stop-FbVisibleKey }
            if ($choice -cne 'wait') { Write-FbStatus -Step 'W6' -Code 'SKIP' -Reason 'finish-later'; return 'finish-later' }
            $waitUntil = [DateTime]::UtcNow.AddSeconds((Get-FbScaledSeconds 300))
            while ([DateTime]::UtcNow -lt $waitUntil) {
                Start-Sleep -Seconds ([Math]::Min((Get-FbScaledSeconds 120), [Math]::Max(1, [int][Math]::Ceiling(($waitUntil - [DateTime]::UtcNow).TotalSeconds))))
                Write-FbStatus -Step 'W6' -Code 'INFO' -Reason 'heartbeat'
            }
            if (Test-FbKeyVisible) { return Stop-FbVisibleKey }
            $processes = Test-FbProcesses
            if ($processes.Load) { Write-FbStatus -Step 'W6' -Code 'SKIP' -Reason 'finish-later'; return 'finish-later' }
        }

        if (Test-FbKeyVisible) { return Stop-FbVisibleKey }
        $fetchRun = Start-FbStep -Step 'kit-fetch'
        if (-not $fetchRun) {
            Write-FbStatus -Step 'W6' -Code 'STOP' -Reason 'download'
            return 'stop'
        }
        $fetchResult = Wait-FbStep -RunId $fetchRun -TimeoutSec 910
        if (Test-FbKeyVisible) { return Stop-FbVisibleKey }
        $fetchReason = Get-FbEventFact -Result $fetchResult -Name 'reason'
        if ($fetchResult.Exit -ne 0 -or $fetchReason -cne 'ok') {
            if ($fetchReason -ceq 'sha') { $stopReason = 'sha' }
            elseif ($fetchReason -ceq 'bytes') { $stopReason = 'bytes' }
            else { $stopReason = 'download' }
            Write-FbStatus -Step 'W6' -Code 'STOP' -Reason $stopReason
            return 'stop'
        }
        Write-FbStatus -Step 'W6' -Code 'INFO' -Reason 'kit-fetched'
        Write-FbStatus -Step 'W6' -Code 'INFO' -Reason 'kit-sha'
        Set-FbProgress -Key 'w6_kit_sha16' -Value ([string]$FB.Facts.kit_sha256).Substring(0, 16)

        $installAttempt = 0
        while ($true) {
            $installAttempt++
            if ((Test-FbProcesses).Load) {
                Write-FbStatus -Step 'W6' -Code 'SKIP' -Reason 'load-running'
                return 'finish-later'
            }
            if (Test-FbKeyVisible) { return Stop-FbVisibleKey }
            $installRun = Start-FbStep -Step 'kit-install'
            if (-not $installRun) {
                Write-FbStatus -Step 'W6' -Code 'STOP' -Reason 'install'
                return 'stop'
            }
            $installResult = Wait-FbStep -RunId $installRun -TimeoutSec 910
            if (Test-FbKeyVisible) { return Stop-FbVisibleKey }
            if ($installResult.Exit -eq 0) { break }
            if ($installResult.Class -ceq 'install-busy' -and $installAttempt -eq 1) {
                $choice = Wait-FbDecision -Step 'W6' -Reason 'install-busy' -Words @('retry','finish-later')
                if ($choice -ceq 'key-visible') { return Stop-FbVisibleKey }
                if ($choice -cne 'retry') { Write-FbStatus -Step 'W6' -Code 'SKIP' -Reason 'finish-later'; return 'finish-later' }
                continue
            }
            Write-FbStatus -Step 'W6' -Code 'STOP' -Reason 'install'
            return 'stop'
        }
        Write-FbStatus -Step 'W6' -Code 'INFO' -Reason 'kit-installed'

        $versionRun = Start-FbStep -Step 'cli-version'
        if (-not $versionRun) {
            Write-FbStatus -Step 'W6' -Code 'STOP' -Reason 'version'
            return 'stop'
        }
        $versionResult = Wait-FbStep -RunId $versionRun -TimeoutSec 70
        if (Test-FbKeyVisible) { return Stop-FbVisibleKey }
        $version = Read-FbStepLine $versionRun
        if ($versionResult.Exit -ne 0 -or $version -cne [string]$FB.Facts.kit_version) {
            Write-FbStatus -Step 'W6' -Code 'STOP' -Reason 'version'
            return 'stop'
        }
        Write-FbStatus -Step 'W6' -Code 'INFO' -Reason 'cli-version'

        if ($FB.DomainPresent) {
            $preview = Invoke-FbPreview
            if (Test-FbKeyVisible) { return Stop-FbVisibleKey }
            if ($preview.Class -ceq 'preview-ready' -and $preview.Exit -eq 0) {
                Write-FbStatus -Step 'W6' -Code 'INFO' -Reason 'payload-proven'
                Set-FbPrereadReady
            } elseif ($preview.Class -ceq 'projection-not-ready') {
                $FB.W7PrereadBlocked = $true
                Write-FbStatus -Step 'W7' -Code 'SKIP' -Reason 'queue-not-empty'
            } else {
                Write-FbStatus -Step 'W6' -Code 'STOP' -Reason 'payload'
                return 'stop'
            }
        } else {
            Write-FbStatus -Step 'W6' -Code 'INFO' -Reason 'payload-unproven-no-domain'
        }
        return 'pass'
    } catch {
        Write-FbStatus -Step 'W6' -Code 'STOP' -Reason 'install'
        return 'stop'
    }
}

function Get-FbUpdateRunId {
    $lockPath = Join-Path $FB.Run 'update.lock'
    if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) { return $null }
    foreach ($line in Get-Content -LiteralPath $lockPath) {
        if ($line -match '^runid=([A-Za-z0-9_.:+-]+)$') { return $Matches[1] }
    }
    return $null
}

function Write-FbW7StageStatus {
    param([Parameter(Mandatory=$true)][ValidateRange(1,13)][int]$Stage)
    # Windows PowerShell 5.1 boxes a populated Nullable[int] as Int32. The
    # shared formatter's .Value access therefore throws under strict mode.
    $line = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ') + ' W7 INFO stage n=' + [string]$Stage + "`n"
    [IO.File]::AppendAllText((Join-Path $FB.Run 'status.txt'), $line, $script:FbUtf8)
}

function Write-FbW7Failed {
    param(
        [Parameter(Mandatory=$true)]
        [ValidateSet(
            'start-refused',
            'start-exception',
            'recovery-decision-id',
            'recovery-start',
            'recovery-result',
            'complete-runid',
            'complete-yn-prompt',
            'complete-verified-line',
            'complete-retry-declined',
            'complete-result',
            'complete-exception'
        )]
        [string]$Detail
    )
    [IO.File]::WriteAllText((Join-Path $FB.Run 'w7-detail.txt'), ($Detail + "`n"), $script:FbUtf8)
    Write-FbStatus -Step 'W7' -Code 'STOP' -Reason 'failed'
}

function Start-FbW7 {
    if (-not $FB.Tier2On) { return 'skip' }
    try {
        if ($FB.ContainsKey('W7PrereadBlocked') -and $FB.W7PrereadBlocked) { return 'skip' }
        $fresh = $FB.ContainsKey('W7PrereadAt') -and
            (([DateTime]::UtcNow - [DateTime]$FB.W7PrereadAt).TotalMinutes -le 5)
        if (-not $fresh) {
            if ($FB.DomainPresent) { $preread = Invoke-FbPreview }
            else {
                $prereadRun = Start-FbStep -Step 'health-key' -WithKey
                if (-not $prereadRun) { $preread = @{ Exit = 1; Class = 'other'; Events = @() } }
                else { $preread = Wait-FbStep -RunId $prereadRun -TimeoutSec 320 -AllowKeyVisible }
            }
            if ($preread.Class -ceq 'key-visible') { return Stop-FbVisibleKey }
            if (Test-FbKeyVisible) { return Stop-FbVisibleKey }
            $readyClass = if ($FB.DomainPresent) { 'preview-ready' } else { 'health-ready' }
            if ($preread.Exit -ne 0 -or $preread.Class -cne $readyClass) {
                Write-FbStatus -Step 'W7' -Code 'SKIP' -Reason 'queue-not-empty'
                return 'skip'
            }
            Set-FbPrereadReady
        }

        if (Test-FbKeyVisible) { return Stop-FbVisibleKey }
        $runId = Start-FbStep -Step 'update' -WithKey
        if (-not $runId) {
            if ([string]$FB.LastRefusal -match '^update-running(?:\s+([A-Za-z0-9_.:+-]+))?') {
                $runId = $Matches[1]
                if (-not $runId) { $runId = Get-FbUpdateRunId }
                if ($runId -ceq 'unknown') { $runId = $null }
                if ($runId) {
                    $FB.W7RunId = $runId
                    Write-FbStatus -Step 'W7' -Code 'INFO' -Reason 'rejoin'
                    return 'pass'
                }
            }
            Write-FbW7Failed -Detail 'start-refused'
            return 'stop'
        }
        $FB.W7RunId = $runId
        if (-not (Get-FbProgress -Key 'w7_total_attempts')) { Set-FbProgress -Key 'w7_total_attempts' -Value '1' }
        Set-FbProgress -Key 'w7_runid' -Value $runId
        Write-FbStatus -Step 'W7' -Code 'START' -Reason 'start'
        Show-FbLine -Key 'W7-START'
        return 'pass'
    } catch {
        Write-FbW7Failed -Detail 'start-exception'
        return 'stop'
    }
}

function Wait-FbW7Run {
    param(
        [Parameter(Mandatory=$true)][string]$RunId,
        [switch]$RejoinWait,
        [switch]$RejoinStatusWritten
    )
    $folder = Join-Path (Join-Path $FB.Run 'steps') $RunId
    $eventsPath = Join-Path $folder 'events.txt'
    $exitPath = Join-Path $folder 'exit.txt'
    $alivePath = Join-Path $folder 'alive.txt'
    $events = @()
    $seen = 0
    $stage = 0
    $lastLineAt = [DateTime]::UtcNow
    $lastHeartbeat = [DateTime]::UtcNow
    $staleObservedAt = $null
    $rejoinActive = [bool]$RejoinWait
    $rejoinWritten = [bool]$RejoinStatusWritten
    $rejoinStartedAt = if ($rejoinActive) { [DateTime]::UtcNow } else { $null }
    $silenceReported = $false
    $pending = $false
    $agentWarning = $false
    $ynPrompt = $false
    while ($true) {
        # Sample exit.txt before reading events (the supervisor closes events.txt first), so the
        # final stage lines are never lost when the update ends between the two reads.
        $exitSeen = Test-Path -LiteralPath $exitPath -PathType Leaf
        if (Test-Path -LiteralPath $eventsPath -PathType Leaf) {
            $all = @(Get-Content -LiteralPath $eventsPath)
            if ($all.Count -gt $seen) {
                for ($index = $seen; $index -lt $all.Count; $index++) {
                    $eventLine = $all[$index]
                    $events += $eventLine
                    $lastLineAt = [DateTime]::UtcNow
                    $silenceReported = $false
                    if ($eventLine -match '\sstage\s+\S+\s+n=(\d+)$') {
                        $nextStage = [int]$Matches[1]
                        if ($nextStage -gt $stage) {
                            $stage = $nextStage
                            Write-FbW7StageStatus -Stage $stage
                            if ($stage -eq 5) { Show-FbLine -Key 'W7-PAUSE20' -Fill @{ k = $stage } }
                            else { Show-FbLine -Key 'W7-STEP' -Fill @{ k = $stage } }
                        }
                    }
                    if ($eventLine -match '\sclass\s+pending-migration$' -and -not $pending) {
                        $pending = $true
                        Write-FbStatus -Step 'W7' -Code 'INFO' -Reason 'pending-migration-seen'
                    }
                    if ($eventLine -match '\sclass\s+agent-refresh-warning$' -and -not $agentWarning) {
                        $agentWarning = $true
                        Write-FbStatus -Step 'W7' -Code 'INFO' -Reason 'agent-refresh-warning'
                    }
                    if ($eventLine -match '\sanomaly\s+yn-prompt$') { $ynPrompt = $true }
                }
                $seen = $all.Count
            }
        }
        if ($exitSeen) {
            $exitLine = ([string](Get-Content -LiteralPath $exitPath -Raw)).Trim()
            if ($exitLine -match '^EXIT\s+(-?\d+)\s+([a-z0-9-]+)\s+') {
                return @{
                    Exit = [int64]$Matches[1]
                    Class = $Matches[2]
                    Events = $events
                    Pending = $pending
                    AgentWarning = $agentWarning
                    YnPrompt = $ynPrompt
                }
            }
            throw 'bad update exit'
        }
        $aliveFresh = $false
        if (Test-Path -LiteralPath $alivePath -PathType Leaf) {
            $aliveAge = ((Get-Date).ToUniversalTime() - (Get-Item -LiteralPath $alivePath).LastWriteTimeUtc).TotalSeconds
            if ($aliveAge -le 60) { $aliveFresh = $true }
            elseif (-not $rejoinActive) {
                if ($null -eq $staleObservedAt) { $staleObservedAt = [DateTime]::UtcNow }
                elseif (([DateTime]::UtcNow - $staleObservedAt).TotalSeconds -ge (Get-FbScaledSeconds 30)) {
                    if ((Test-FbProcesses).Update) {
                        if (-not $rejoinWritten) {
                            Write-FbStatus -Step 'W7' -Code 'INFO' -Reason 'rejoin'
                            $rejoinWritten = $true
                        }
                        $rejoinActive = $true
                        if ($null -eq $rejoinStartedAt) { $rejoinStartedAt = [DateTime]::UtcNow }
                        $staleObservedAt = $null
                    } else {
                        return @{ Exit = 1; Class = 'dead'; Events = $events; Pending = $pending; AgentWarning = $agentWarning; YnPrompt = $ynPrompt }
                    }
                }
            } else { $staleObservedAt = $null }
        }
        if ($rejoinActive) {
            if ($aliveFresh) {
                $rejoinActive = $false
                $staleObservedAt = $null
            } else {
                $rejoinLimit = ([DateTime]::UtcNow - $rejoinStartedAt).TotalSeconds -ge (Get-FbScaledSeconds 3600)
                if ($rejoinLimit -or -not (Test-FbProcesses).Update) {
                    return @{ Exit = 1; Class = 'dead'; Events = $events; Pending = $pending; AgentWarning = $agentWarning; YnPrompt = $ynPrompt }
                }
            }
        }
        $threshold = if ($stage -eq 5) { Get-FbScaledSeconds 1320 } else { Get-FbScaledSeconds 900 }
        if (-not $silenceReported -and (([DateTime]::UtcNow - $lastLineAt).TotalSeconds -ge $threshold)) {
            Write-FbStatus -Step 'W7' -Code 'INFO' -Reason 'silent-15min'
            $silenceReported = $true
        }
        if (([DateTime]::UtcNow - $lastHeartbeat).TotalSeconds -ge (Get-FbScaledSeconds 120)) {
            Write-FbStatus -Step 'W7' -Code 'INFO' -Reason 'heartbeat'
            $lastHeartbeat = [DateTime]::UtcNow
        }
        $pollSeconds = if ($rejoinActive) { Get-FbScaledSeconds 10 } else { 2 }
        Start-Sleep -Seconds $pollSeconds
    }
}

function Start-FbW7Retry {
    param([string]$Reason)
    $attempts = Get-FbProgress -Key 'w7_total_attempts'
    if (-not $attempts) { $attempts = '1' }
    if ([int]$attempts -ge 2) { return $null }
    if (Test-FbKeyVisible) { [void](Stop-FbVisibleKey); return $null }
    $runId = Start-FbStep -Step 'update' -WithKey
    if (-not $runId) { return $null }
    Set-FbProgress -Key 'w7_total_attempts' -Value ([string]([int]$attempts + 1))
    $FB.W7RunId = $runId
    Set-FbProgress -Key 'w7_runid' -Value $runId
    Write-FbStatus -Step 'W7' -Code 'INFO' -Reason $Reason
    return $runId
}

function Read-FbDecisionId {
    param([string]$Word)
    $path = Join-Path $FB.Run 'decision.txt'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    $line = ([string](Get-Content -LiteralPath $path -Raw)).Trim()
    if ($line -match ('^' + [regex]::Escape($Word) + '\s+id=([0-9a-f]{6})$')) { return $Matches[1] }
    return $null
}

function Invoke-FbDeployRecovery {
    $choice = Wait-FbDecision -Step 'W7' -Reason 'update-queued' -Words @('deploy-recover','finish-later')
    if ($choice -ceq 'key-visible') { return Stop-FbVisibleKey }
    if ($choice -cne 'deploy-recover') { return 'finish-later' }
    $decisionId = Read-FbDecisionId -Word 'deploy-recover'
    if (-not $decisionId) {
        Write-FbW7Failed -Detail 'recovery-decision-id'
        return 'stop'
    }
    if (Test-FbKeyVisible) { return Stop-FbVisibleKey }
    $recoverRun = Start-FbStep -Step 'deploy-recover' -WithKey -DecisionId $decisionId
    if (-not $recoverRun) {
        Write-FbW7Failed -Detail 'recovery-start'
        return 'stop'
    }
    $recover = Wait-FbStep -RunId $recoverRun -TimeoutSec 910
    if (Test-FbKeyVisible) { return Stop-FbVisibleKey }
    if ($recover.Exit -ne 0 -or $recover.Class -cne 'deploy-recovered') {
        Write-FbW7Failed -Detail 'recovery-result'
        return 'stop'
    }
    Write-FbStatus -Step 'W7' -Code 'INFO' -Reason 'recovered'
    return 'stop'
}

function Invoke-FbPostUpdateCopy {
    $copyRun = Start-FbStep -Step 'manifest-edit' -Variant 'copy'
    if (-not $copyRun) { return $false }
    $copyResult = Wait-FbStep -RunId $copyRun -TimeoutSec 70
    if (Test-FbKeyVisible) { [void](Stop-FbVisibleKey); return $false }
    Write-FbManifestFacts -Result $copyResult
    return $copyResult.Exit -eq 0 -and (Get-FbEventFact -Result $copyResult -Name 'result') -ceq 'pass'
}

function Complete-FbW7 {
    param([string]$RunId)
    try {
        if (-not $RunId) { $RunId = $FB.W7RunId }
        if (-not $RunId) {
            Write-FbW7Failed -Detail 'complete-runid'
            return 'stop'
        }
        if ($RunId -cne $FB.W7RunId) { $FB.W7RunId = $RunId }
        $initialRejoin = $FB.Rejoin -or $RunId -ceq $FB.RejoinRunId
        if ($initialRejoin) {
            Write-FbStatus -Step 'W7' -Code 'INFO' -Reason 'rejoin'
        }
        while ($true) {
            if ($initialRejoin) {
                $result = Wait-FbW7Run -RunId $RunId -RejoinWait -RejoinStatusWritten
                $initialRejoin = $false
            } else { $result = Wait-FbW7Run -RunId $RunId }
            if (Test-FbKeyVisible) { return Stop-FbVisibleKey }
            if ($result.Pending) {
                Write-FbStatus -Step 'W7' -Code 'STOP' -Reason 'pending-migration'
                Set-FbProgress -Key 'w7_result' -Value 'stop'
                return 'stop'
            }
            if ($result.YnPrompt) {
                Write-FbW7Failed -Detail 'complete-yn-prompt'
                Set-FbProgress -Key 'w7_result' -Value 'stop'
                return 'stop'
            }
            if ($result.Class -ceq 'verified' -and $result.Exit -eq 0) {
                $output = Read-FbStepLine $RunId
                $expected = [regex]::Escape([string]$FB.Facts.kit_version)
                if ($output -notmatch ('upgrade verified, now at ' + $expected + '(?:\s|$)')) {
                    Write-FbW7Failed -Detail 'complete-verified-line'
                    return 'stop'
                }
                Write-FbStatus -Step 'W7' -Code 'PASS' -Reason 'verified'
                Show-FbLine -Key 'W7-DONE' -Fill @{ v = [string]$FB.Facts.kit_version }
                if (-not (Invoke-FbPostUpdateCopy)) {
                    Write-FbStatus -Step 'W5' -Code 'STOP' -Reason 'edit-failed'
                    return 'stop'
                }
                Set-FbProgress -Key 'w7_result' -Value 'pass'
                return 'pass'
            }
            if ($result.Class -ceq 'queue-first' -or $result.Class -ceq 'queue-prepause') {
                Write-FbStatus -Step 'W7' -Code 'SKIP' -Reason 'queue-not-empty'
                Set-FbProgress -Key 'w7_result' -Value 'skip'
                return 'skip'
            }
            if ($result.Class -ceq 'queued-paused' -or $result.Class -ceq 'mismatch') {
                $stopReason = if ($result.Class -ceq 'queued-paused') { 'queued' } else { 'mismatch' }
                Write-FbStatus -Step 'W7' -Code 'STOP' -Reason $stopReason
                Show-FbLine -Key 'LEAD'
                Show-FbWindow
                return Invoke-FbDeployRecovery
            }
            if ($result.Class -ceq 'cpu-reset') {
                $RunId = Start-FbW7Retry -Reason 'retry-cpu-reset'
                if (-not $RunId) { Write-FbStatus -Step 'W7' -Code 'STOP' -Reason 'second-failure'; return 'stop' }
                continue
            }
            if ($result.Class -ceq 'last-stage-503') {
                $RunId = Start-FbW7Retry -Reason 'retry-last-stage-503'
                if (-not $RunId) { Write-FbStatus -Step 'W7' -Code 'STOP' -Reason 'second-failure'; return 'stop' }
                continue
            }
            if (@('dead','update-busy','network') -ccontains $result.Class) {
                $choice = Wait-FbDecision -Step 'W7' -Reason 'update-retry' -Words @('continue','stop')
                if ($choice -ceq 'key-visible') { return Stop-FbVisibleKey }
                if ($choice -cne 'continue') {
                    Write-FbW7Failed -Detail 'complete-retry-declined'
                    return 'stop'
                }
                $RunId = Start-FbW7Retry -Reason 'start'
                if (-not $RunId) { Write-FbStatus -Step 'W7' -Code 'STOP' -Reason 'second-failure'; return 'stop' }
                continue
            }
            Write-FbW7Failed -Detail 'complete-result'
            Set-FbProgress -Key 'w7_result' -Value 'stop'
            return 'stop'
        }
    } catch {
        Write-FbW7Failed -Detail 'complete-exception'
        return 'stop'
    }
}
