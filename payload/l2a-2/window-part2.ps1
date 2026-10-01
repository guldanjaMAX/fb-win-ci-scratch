function Test-FbW1DriveTerminal {
    $statusPath = Join-Path $FB.Run 'status.txt'
    if (-not (Test-Path -LiteralPath $statusPath -PathType Leaf)) { return $false }
    foreach ($line in Get-Content -LiteralPath $statusPath) {
        if ($line -match ' W1 INFO drive-terminal$') { return $true }
    }
    return $false
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
    return Wait-FbStep -RunId $runId -TimeoutSec 320
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
            if ($choice -cne 'wait') { return 'finish-later' }
            Start-Sleep -Seconds (Get-FbScaledSeconds 300)
            $processes = Test-FbProcesses
            if ($processes.Load) { return 'finish-later' }
        }

        $fetchRun = Start-FbStep -Step 'kit-fetch'
        if (-not $fetchRun) {
            Write-FbStatus -Step 'W6' -Code 'STOP' -Reason 'download'
            return 'stop'
        }
        $fetchResult = Wait-FbStep -RunId $fetchRun -TimeoutSec 910
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
            $installRun = Start-FbStep -Step 'kit-install'
            if (-not $installRun) {
                Write-FbStatus -Step 'W6' -Code 'STOP' -Reason 'install'
                return 'stop'
            }
            $installResult = Wait-FbStep -RunId $installRun -TimeoutSec 910
            if ($installResult.Exit -eq 0) { break }
            if ($installResult.Class -ceq 'install-busy' -and $installAttempt -eq 1) {
                $choice = Wait-FbDecision -Step 'W6' -Reason 'install-busy' -Words @('retry','finish-later')
                if ($choice -cne 'retry') { return 'finish-later' }
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
        $version = Read-FbStepLine $versionRun
        if ($versionResult.Exit -ne 0 -or $version -cne [string]$FB.Facts.kit_version) {
            Write-FbStatus -Step 'W6' -Code 'STOP' -Reason 'version'
            return 'stop'
        }
        Write-FbStatus -Step 'W6' -Code 'INFO' -Reason 'cli-version'

        if ($FB.DomainPresent) {
            $preview = Invoke-FbPreview
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
                else { $preread = Wait-FbStep -RunId $prereadRun -TimeoutSec 320 }
            }
            $readyClass = if ($FB.DomainPresent) { 'preview-ready' } else { 'health-ready' }
            if ($preread.Exit -ne 0 -or $preread.Class -cne $readyClass) {
                Write-FbStatus -Step 'W7' -Code 'SKIP' -Reason 'queue-not-empty'
                return 'skip'
            }
            Set-FbPrereadReady
        }

        $runId = Start-FbStep -Step 'update' -WithKey
        if (-not $runId) {
            if ([string]$FB.LastRefusal -match '^update-running(?:\s+([A-Za-z0-9_.:+-]+))?') {
                $runId = $Matches[1]
                if (-not $runId) { $runId = Get-FbUpdateRunId }
                if ($runId) {
                    $FB.W7RunId = $runId
                    Write-FbStatus -Step 'W7' -Code 'INFO' -Reason 'rejoin'
                    return 'pass'
                }
            }
            Write-FbStatus -Step 'W7' -Code 'STOP' -Reason 'failed'
            return 'stop'
        }
        $FB.W7RunId = $runId
        Set-FbProgress -Key 'w7_runid' -Value $runId
        Write-FbStatus -Step 'W7' -Code 'START' -Reason 'start'
        Show-FbLine -Key 'W7-START'
        return 'pass'
    } catch {
        Write-FbStatus -Step 'W7' -Code 'STOP' -Reason 'failed'
        return 'stop'
    }
}

function Wait-FbW7Run {
    param([Parameter(Mandatory=$true)][string]$RunId)
    $folder = Join-Path (Join-Path $FB.Run 'steps') $RunId
    $eventsPath = Join-Path $folder 'events.txt'
    $exitPath = Join-Path $folder 'exit.txt'
    $alivePath = Join-Path $folder 'alive.txt'
    $events = @()
    $seen = 0
    $stage = 0
    $lastLineAt = [DateTime]::UtcNow
    $silenceReported = $false
    $pending = $false
    $agentWarning = $false
    $ynPrompt = $false
    while ($true) {
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
                            Write-FbStatus -Step 'W7' -Code 'INFO' -Reason 'stage' -N $stage
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
        if (Test-Path -LiteralPath $exitPath -PathType Leaf) {
            $exitLine = (Get-Content -LiteralPath $exitPath -Raw).Trim()
            if ($exitLine -match '^EXIT\s+(-?\d+)\s+([a-z0-9-]+)\s+') {
                return @{
                    Exit = [int]$Matches[1]
                    Class = $Matches[2]
                    Events = $events
                    Pending = $pending
                    AgentWarning = $agentWarning
                    YnPrompt = $ynPrompt
                }
            }
            throw 'bad update exit'
        }
        if (Test-Path -LiteralPath $alivePath -PathType Leaf) {
            if (((Get-Date).ToUniversalTime() - (Get-Item -LiteralPath $alivePath).LastWriteTimeUtc).TotalSeconds -gt 60) {
                return @{ Exit = 1; Class = 'dead'; Events = $events; Pending = $pending; AgentWarning = $agentWarning; YnPrompt = $ynPrompt }
            }
        }
        $threshold = if ($stage -eq 5) { Get-FbScaledSeconds 1320 } else { Get-FbScaledSeconds 900 }
        if (-not $silenceReported -and (([DateTime]::UtcNow - $lastLineAt).TotalSeconds -ge $threshold)) {
            Write-FbStatus -Step 'W7' -Code 'INFO' -Reason 'silent-15min'
            $silenceReported = $true
        }
        Start-Sleep -Seconds 2
    }
}

function Start-FbW7Retry {
    param([string]$Reason)
    $runId = Start-FbStep -Step 'update' -WithKey
    if (-not $runId) { return $null }
    $FB.W7RunId = $runId
    Set-FbProgress -Key 'w7_runid' -Value $runId
    Write-FbStatus -Step 'W7' -Code 'INFO' -Reason $Reason
    return $runId
}

function Read-FbDecisionId {
    param([string]$Word)
    $path = Join-Path $FB.Run 'decision.txt'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    $line = (Get-Content -LiteralPath $path -Raw).Trim()
    if ($line -match ('^' + [regex]::Escape($Word) + '\s+id=([0-9a-f]{6})$')) { return $Matches[1] }
    return $null
}

function Invoke-FbDeployRecovery {
    $choice = Wait-FbDecision -Step 'W7' -Reason 'update-queued' -Words @('deploy-recover','finish-later')
    if ($choice -cne 'deploy-recover') { return 'finish-later' }
    $decisionId = Read-FbDecisionId -Word 'deploy-recover'
    if (-not $decisionId) {
        Write-FbStatus -Step 'W7' -Code 'STOP' -Reason 'failed'
        return 'stop'
    }
    $recoverRun = Start-FbStep -Step 'deploy-recover' -WithKey -DecisionId $decisionId
    if (-not $recoverRun) {
        Write-FbStatus -Step 'W7' -Code 'STOP' -Reason 'failed'
        return 'stop'
    }
    $recover = Wait-FbStep -RunId $recoverRun -TimeoutSec 910
    if ($recover.Exit -ne 0 -or $recover.Class -cne 'deploy-recovered') {
        Write-FbStatus -Step 'W7' -Code 'STOP' -Reason 'failed'
        return 'stop'
    }
    return 'stop'
}

function Invoke-FbPostUpdateCopy {
    $copyRun = Start-FbStep -Step 'manifest-edit' -Variant 'copy'
    if (-not $copyRun) { return $false }
    $copyResult = Wait-FbStep -RunId $copyRun -TimeoutSec 70
    Write-FbManifestFacts -Result $copyResult
    return $copyResult.Exit -eq 0 -and (Get-FbEventFact -Result $copyResult -Name 'result') -ceq 'pass'
}

function Complete-FbW7 {
    param([string]$RunId)
    try {
        if (-not $RunId) { $RunId = $FB.W7RunId }
        if (-not $RunId) {
            Write-FbStatus -Step 'W7' -Code 'STOP' -Reason 'failed'
            return 'stop'
        }
        if ($RunId -cne $FB.W7RunId) { $FB.W7RunId = $RunId }
        if ($FB.Rejoin -or $RunId -ceq $FB.RejoinRunId) {
            Write-FbStatus -Step 'W7' -Code 'INFO' -Reason 'rejoin'
        }
        $manualRetryUsed = $false
        while ($true) {
            $result = Wait-FbW7Run -RunId $RunId
            if ($result.Pending) {
                Write-FbStatus -Step 'W7' -Code 'STOP' -Reason 'pending-migration'
                Set-FbProgress -Key 'w7_result' -Value 'stop'
                return 'stop'
            }
            if ($result.YnPrompt) {
                Write-FbStatus -Step 'W7' -Code 'STOP' -Reason 'failed'
                Set-FbProgress -Key 'w7_result' -Value 'stop'
                return 'stop'
            }
            if ($result.Class -ceq 'verified' -and $result.Exit -eq 0) {
                $output = Read-FbStepLine $RunId
                $expected = [regex]::Escape([string]$FB.Facts.kit_version)
                if ($output -notmatch ('upgrade verified, now at ' + $expected + '(?:\s|$)')) {
                    Write-FbStatus -Step 'W7' -Code 'STOP' -Reason 'failed'
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
                if ((Get-FbProgress -Key 'w7_retry_cpu') -ceq '1') {
                    Write-FbStatus -Step 'W7' -Code 'STOP' -Reason 'second-failure'
                    return 'stop'
                }
                Set-FbProgress -Key 'w7_retry_cpu' -Value '1'
                $RunId = Start-FbW7Retry -Reason 'retry-cpu-reset'
                if (-not $RunId) { Write-FbStatus -Step 'W7' -Code 'STOP' -Reason 'failed'; return 'stop' }
                continue
            }
            if ($result.Class -ceq 'last-stage-503') {
                if ((Get-FbProgress -Key 'w7_retry_503') -ceq '1') {
                    Write-FbStatus -Step 'W7' -Code 'STOP' -Reason 'second-failure'
                    return 'stop'
                }
                Set-FbProgress -Key 'w7_retry_503' -Value '1'
                $RunId = Start-FbW7Retry -Reason 'retry-last-stage-503'
                if (-not $RunId) { Write-FbStatus -Step 'W7' -Code 'STOP' -Reason 'failed'; return 'stop' }
                continue
            }
            if (@('dead','update-busy','network','unknown-update') -ccontains $result.Class) {
                $choice = Wait-FbDecision -Step 'W7' -Reason 'update-retry' -Words @('continue','stop')
                if ($choice -cne 'continue') {
                    Write-FbStatus -Step 'W7' -Code 'STOP' -Reason 'failed'
                    return 'stop'
                }
                if ($manualRetryUsed) {
                    Write-FbStatus -Step 'W7' -Code 'STOP' -Reason 'second-failure'
                    return 'stop'
                }
                if ($result.Class -ceq 'dead' -and (Test-FbProcesses).Update) {
                    Write-FbStatus -Step 'W7' -Code 'STOP' -Reason 'failed'
                    return 'stop'
                }
                $manualRetryUsed = $true
                $RunId = Start-FbW7Retry -Reason 'start'
                if (-not $RunId) { Write-FbStatus -Step 'W7' -Code 'STOP' -Reason 'failed'; return 'stop' }
                continue
            }
            Write-FbStatus -Step 'W7' -Code 'STOP' -Reason 'failed'
            Set-FbProgress -Key 'w7_result' -Value 'stop'
            return 'stop'
        }
    } catch {
        Write-FbStatus -Step 'W7' -Code 'STOP' -Reason 'failed'
        return 'stop'
    }
}
