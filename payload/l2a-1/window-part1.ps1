function Get-FbMachineFacts {
    $result = @{
        Sac = 'unknown'
        History = $false
        Cloud = $false
        Av = 'unknown'
        FreeMb = 0
    }
    if ($FB.TestSeam) {
        $machine = Read-FbJsonSeam (Join-Path $FB.Session 'test-machine.json')
        if ($null -ne $machine) {
            if ($machine.ContainsKey('sac')) { $result.Sac = [string]$machine['sac'] }
            if ($machine.ContainsKey('history')) { $result.History = [bool]$machine['history'] }
            if ($machine.ContainsKey('cloud')) { $result.Cloud = [bool]$machine['cloud'] }
            if ($machine.ContainsKey('av')) { $result.Av = [string]$machine['av'] }
            if ($machine.ContainsKey('free_mb')) { $result.FreeMb = [int64]$machine['free_mb'] }
        }
        return $result
    }
    try {
        $sacValue = (Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy' -Name VerifiedAndReputablePolicyState -ErrorAction SilentlyContinue).VerifiedAndReputablePolicyState
        if ($sacValue -eq 0) { $result.Sac = 'off' }
        elseif ($sacValue -eq 1) { $result.Sac = 'on' }
        elseif ($sacValue -eq 2) { $result.Sac = 'eval' }
    } catch { $result.Sac = 'unknown' }
    try {
        $clip = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Clipboard' -ErrorAction SilentlyContinue
        $policy = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\System' -ErrorAction SilentlyContinue
        $historyOn = $null -ne $clip -and $clip.EnableClipboardHistory -eq 1
        $policyOff = $null -ne $policy -and $policy.AllowClipboardHistory -eq 0
        $result.History = $historyOn -and -not $policyOff
        $result.Cloud = $null -ne $clip -and ($clip.EnableCloudClipboard -eq 1 -or $clip.CloudClipboardAutomaticUpload -eq 1)
    } catch {}
    try {
        $products = @(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct)
        $thirdParty = @($products | Where-Object { [string]$_.displayName -notmatch '^Windows Defender' })
        if ($thirdParty.Count -gt 0) { $result.Av = 'third-party' }
        else { $result.Av = 'defender' }
    } catch { $result.Av = 'unknown' }
    try {
        $os = Get-CimInstance -ClassName Win32_OperatingSystem
        $result.FreeMb = [int64][Math]::Floor(([double]$os.FreePhysicalMemory) / 1024)
    } catch { $result.FreeMb = 0 }
    return $result
}

function Invoke-FbHealthRead {
    param([switch]$WithKey)
    $last = $null
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        if ($WithKey) { $runId = Start-FbStep -Step 'health-key' -WithKey }
        else { $runId = Start-FbStep -Step 'health' }
        if (-not $runId) { return @{ Exit = 1; Class = 'refused'; Events = @() } }
        $last = Wait-FbStep -RunId $runId -TimeoutSec 360
        if ($last.Class -cne 'sac-refused') { return $last }
    }
    return @{ Exit = 1; Class = 'health-unreadable'; Events = $last.Events }
}

function Invoke-FbVerifyRead {
    $last = $null
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        $runId = Start-FbStep -Step 'verify' -WithKey
        if (-not $runId) { return @{ Exit = 1; Class = 'refused'; Events = @() } }
        $last = Wait-FbStep -RunId $runId -TimeoutSec 360
        if ($last.Class -cne 'sac-refused') { return $last }
    }
    return @{ Exit = 1; Class = 'other'; Events = $last.Events }
}

function Invoke-FbVerifyWithNetwork {
    $result = Invoke-FbVerifyRead
    if ($result.Class -cne 'network') { return @{ Outcome = 'result'; Result = $result } }
    $result = Invoke-FbVerifyRead
    while ($result.Class -ceq 'network') {
        Write-FbStatus -Step 'W3' -Code 'INFO' -Reason 'verify-network'
        $choice = Wait-FbDecision -Step 'W3' -Reason 'verify-network' -Words @('retry','finish-later')
        if ($choice -ceq 'key-visible') { return @{ Outcome = 'key-visible'; Result = $result } }
        if ($choice -ceq 'finish-later') { return @{ Outcome = 'finish-later'; Result = $result } }
        $result = Invoke-FbVerifyRead
    }
    return @{ Outcome = 'result'; Result = $result }
}

function Read-FbSelection {
    $prefixFiles = @(Get-ChildItem -LiteralPath $FB.Session -Filter 'selected-prefix-*.txt' -File)
    $manifestFiles = @(Get-ChildItem -LiteralPath $FB.Session -Filter 'selected-manifest-*.txt' -File)
    if ($prefixFiles.Count -ne 1 -or $manifestFiles.Count -ne 1) { return $false }
    if ($prefixFiles[0].Length -gt 16KB -or $manifestFiles[0].Length -gt 16KB) { return $false }
    $FB.Prefix = (Get-Content -LiteralPath $prefixFiles[0].FullName -Raw).Trim()
    $FB.Manifest = (Get-Content -LiteralPath $manifestFiles[0].FullName -Raw).Trim()
    if (-not (Test-Path -LiteralPath $FB.Manifest -PathType Leaf)) {
        Write-FbStatus -Step 'W1' -Code 'STOP' -Reason 'manifest-missing'
        return $false
    }
    $FB.Cli = Join-Path $FB.Prefix 'node_modules\brain-installer\brain.mjs'
    if (-not (Test-Path -LiteralPath $FB.Cli -PathType Leaf)) {
        Write-FbStatus -Step 'W1' -Code 'STOP' -Reason 'cli-missing'
        return $false
    }
    return $true
}

function Invoke-FbW1 {
    try {
        Write-FbStatus -Step 'W1' -Code 'START' -Reason 'readout'
        if (-not $FB.Tier2On -and -not $FB.W8On) {
            Write-FbStatus -Step 'W1' -Code 'STOP' -Reason 'tier2-off'
            Show-FbLine -Key 'W1-CHECK'
            return 'stop'
        }
        if (-not (Read-FbSelection)) {
            if ($null -eq $FB.Manifest) {
                Write-FbStatus -Step 'W1' -Code 'STOP' -Reason 'selection'
            }
            Show-FbLine -Key 'W1-CHECK'
            return 'stop'
        }
        $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
        if ($null -eq $nodeCommand) {
            Write-FbStatus -Step 'W1' -Code 'STOP' -Reason 'node-old'
            Show-FbLine -Key 'W1-CHECK'
            return 'stop'
        }
        $FB.Node = $nodeCommand.Source
        $desktop = [Environment]::GetFolderPath('Desktop')
        [IO.File]::WriteAllText((Join-Path $FB.Run 'desktop-dir.txt'), ($desktop + "`n"), $script:FbUtf8)

        $nodeRun = Start-FbStep -Step 'node-version'
        $nodeResult = Wait-FbStep -RunId $nodeRun -TimeoutSec 40
        $nodeVersion = Read-FbStepLine $nodeRun
        Write-FbStatus -Step 'W1' -Code 'INFO' -Reason 'node-version'
        if ($nodeResult.Exit -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) {
            Write-FbStatus -Step 'W1' -Code 'STOP' -Reason 'node-old'
            Show-FbLine -Key 'W1-CHECK'
            return 'stop'
        }
        $cliRun = Start-FbStep -Step 'cli-version'
        $cliResult = Wait-FbStep -RunId $cliRun -TimeoutSec 70
        $FB.CliVersion = Read-FbStepLine $cliRun
        Write-FbStatus -Step 'W1' -Code 'INFO' -Reason 'cli-version'
        if ($cliResult.Exit -ne 0) {
            Write-FbStatus -Step 'W1' -Code 'STOP' -Reason 'cli-missing'
            Show-FbLine -Key 'W1-CHECK'
            return 'stop'
        }

        $processes = Test-FbProcesses
        $FB.LoadRunning = $processes.Load
        if ($processes.Load) { Write-FbStatus -Step 'W1' -Code 'INFO' -Reason 'load-running' }
        if ($processes.Update) {
            $FB.Rejoin = $true
            $lockPath = Join-Path $FB.Run 'update.lock'
            if (Test-Path -LiteralPath $lockPath -PathType Leaf) {
                foreach ($line in Get-Content -LiteralPath $lockPath) {
                    if ($line -match '^runid=([A-Za-z0-9_.:+-]+)$') { $FB.RejoinRunId = $Matches[1] }
                }
            }
            Write-FbStatus -Step 'W1' -Code 'INFO' -Reason 'update-running'
        }

        if ($processes.Load) { $driveRun = Start-FbStep -Step 'drive-state' -Variant 'load-yes' }
        else { $driveRun = Start-FbStep -Step 'drive-state' -Variant 'load-no' }
        $driveResult = Wait-FbStep -RunId $driveRun -TimeoutSec 130
        $domain = Get-FbEventFact -Result $driveResult -Name 'domain'
        $FB.DomainPresent = $domain -ceq 'yes'
        if ($FB.DomainPresent) { Write-FbStatus -Step 'W1' -Code 'INFO' -Reason 'domain-yes' }
        else { Write-FbStatus -Step 'W1' -Code 'INFO' -Reason 'domain-no' }
        $driveState = Get-FbEventFact -Result $driveResult -Name 'drive_state'
        $driveTerminal = Get-FbEventFact -Result $driveResult -Name 'terminal'
        $driveReview = Get-FbEventFact -Result $driveResult -Name 'review'
        if ($driveReview -ceq 'yes') { Write-FbStatus -Step 'W1' -Code 'INFO' -Reason 'drive-review' }
        if ($driveState -ceq 'unreadable' -or $driveResult.Exit -eq 2) { Write-FbStatus -Step 'W1' -Code 'INFO' -Reason 'drive-unreadable' }
        elseif ($driveState -ceq 'absent') { Write-FbStatus -Step 'W1' -Code 'INFO' -Reason 'drive-none' }
        elseif ($driveTerminal -ceq 'yes') { Write-FbStatus -Step 'W1' -Code 'INFO' -Reason 'drive-terminal' }
        else { Write-FbStatus -Step 'W1' -Code 'INFO' -Reason 'drive-loading' }

        $FB.HealthRead = $false
        if ($FB.DomainPresent) {
            $FB.HealthResult = Invoke-FbHealthRead
            $FB.HealthRead = $true
            if ($FB.HealthResult.Class -ceq 'health-ready') { Write-FbStatus -Step 'W1' -Code 'INFO' -Reason 'health-ready' }
            elseif ($FB.HealthResult.Class -ceq 'health-pending' -or $FB.HealthResult.Class -ceq 'health-capped') { Write-FbStatus -Step 'W1' -Code 'INFO' -Reason 'health-pending' }
            elseif ($FB.HealthResult.Class -ceq 'health-mismatch') { Write-FbStatus -Step 'W1' -Code 'INFO' -Reason 'health-mismatch' }
            elseif ($FB.HealthResult.Class -ceq 'health-paused') { Write-FbStatus -Step 'W1' -Code 'INFO' -Reason 'health-paused' }
            else { Write-FbStatus -Step 'W1' -Code 'INFO' -Reason 'health-unreadable' }
        } else {
            Write-FbStatus -Step 'W1' -Code 'INFO' -Reason 'health-needs-key'
        }

        $machine = Get-FbMachineFacts
        $FB.HistoryOn = $machine.History
        $FB.CloudClipboardOn = $machine.Cloud
        Write-FbStatus -Step 'W1' -Code 'INFO' -Reason ('sac-' + $machine.Sac)
        if ($machine.History) { Write-FbStatus -Step 'W1' -Code 'INFO' -Reason 'history-on' }
        else { Write-FbStatus -Step 'W1' -Code 'INFO' -Reason 'history-off' }
        if ($machine.Cloud) { Write-FbStatus -Step 'W1' -Code 'INFO' -Reason 'history-cloud-on' }
        if ($machine.Av -ceq 'third-party') {
            Write-FbStatus -Step 'W1' -Code 'INFO' -Reason 'av-third-party'
            Write-FbStatus -Step 'W1' -Code 'STOP' -Reason 'av-third-party'
            Show-FbLine -Key 'W1-CHECK'
            return 'stop'
        } elseif ($machine.Av -ceq 'defender') { Write-FbStatus -Step 'W1' -Code 'INFO' -Reason 'av-defender' }
        else { Write-FbStatus -Step 'W1' -Code 'INFO' -Reason 'av-unknown' }
        if ($machine.FreeMb -lt [int64]$FB.Facts.min_free_mb) {
            Write-FbStatus -Step 'W1' -Code 'INFO' -Reason 'memory-low'
            Write-FbStatus -Step 'W1' -Code 'STOP' -Reason 'memory-low'
            Show-FbLine -Key 'W1-CHECK'
            return 'stop'
        }
        Write-FbStatus -Step 'W1' -Code 'INFO' -Reason 'memory-ok'

        if ($processes.Load -or $driveTerminal -cne 'yes') { Show-FbLine -Key 'W1-BUSY'; Show-FbLine -Key 'W1-DOCS-LOADING' }
        else { Show-FbLine -Key 'W1-READY'; Show-FbLine -Key 'W1-DOCS-DONE' }
        if (-not $FB.Tier2On) { Show-FbLine -Key 'W1-UPDATE-NOT-TODAY' }
        elseif (-not $processes.Load -and (-not $FB.HealthRead -or $FB.HealthResult.Class -cne 'health-paused')) { Show-FbLine -Key 'W1-UPDATE-CAN' }

        if ($FB.Rejoin) { return 'pass' }
        if ($FB.HealthRead -and $FB.HealthResult.Class -ceq 'health-paused') {
            if (-not $FB.Tier2On) { return 'pass' }
            $choice = Wait-FbDecision -Step 'W1' -Reason 'brain-paused' -Words @('continue','deploy-recover','finish-later')
            if ($choice -ceq 'key-visible') { return Stop-FbVisibleKey }
            $FB.PausedChoice = $choice
            if ($choice -ceq 'finish-later') { return 'finish-later' }
        }
        return 'pass'
    } catch {
        Stop-FbUnexpected
        return 'stop'
    }
}

function Get-FbClipboardText {
    if ($FB.TestSeam) {
        $path = Join-Path $FB.Session 'test-clipboard.txt'
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
        return Get-Content -LiteralPath $path -Raw
    }
    try { return Get-Clipboard -Format Text -Raw -ErrorAction Stop } catch { return $null }
}

function Clear-FbClipboard {
    if ($FB.TestSeam) {
        Remove-Item -LiteralPath (Join-Path $FB.Session 'test-clipboard.txt') -Force -ErrorAction SilentlyContinue
    } else {
        Set-Clipboard -Value ' '
    }
}

function Find-FbClipboardCandidates {
    param([string]$Text)
    if ($null -eq $Text) { return @() }
    $found = @()
    foreach ($match in [regex]::Matches($Text, '[A-Za-z0-9_-]+')) {
        if (@($FB.Facts.key_lengths) -contains $match.Value.Length) { $found += $match.Value }
    }
    return @($found)
}

function Remove-FbClipboardHistoryItem {
    param([Security.SecureString]$Key)
    if ($FB.TestSeam) {
        $history = Read-FbJsonSeam (Join-Path $FB.Session 'test-history.json')
        if ($null -eq $history) { return $false }
        return $history.ContainsKey('delete_ok') -and [bool]$history['delete_ok']
    }
    [void][Reflection.Assembly]::Load('System.Runtime.WindowsRuntime, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089')
    $clipboardType = [Windows.ApplicationModel.DataTransfer.Clipboard,Windows.ApplicationModel.DataTransfer,ContentType=WindowsRuntime]
    $operation = $clipboardType::GetHistoryItemsAsync()
    $operationInterface = @($operation.GetType().GetInterfaces() | Where-Object { $_.Name -match '^IAsyncOperation' })[0]
    $resultType = $operationInterface.GenericTypeArguments[0]
    $asTaskMethod = @([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -ceq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 })[0]
    $task = $asTaskMethod.MakeGenericMethod($resultType).Invoke($null, @($operation))
    $task.Wait()
    $history = $task.Result
    if ([int]$history.Status -ne 0) { return $false }
    $bstr = [IntPtr]::Zero
    $plain = $null
    try {
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Key)
        $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
        foreach ($item in @($history.Items)) {
            $textOperation = $item.Content.GetTextAsync()
            $textInterface = @($textOperation.GetType().GetInterfaces() | Where-Object { $_.Name -match '^IAsyncOperation' })[0]
            $textType = $textInterface.GenericTypeArguments[0]
            $textTask = $asTaskMethod.MakeGenericMethod($textType).Invoke($null, @($textOperation))
            $textTask.Wait()
            if ([string]$textTask.Result -like ('*' + $plain + '*')) {
                return [bool]$clipboardType::DeleteItemFromHistory($item)
            }
        }
    } finally {
        $plain = $null
        if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    }
    return $false
}

function Save-FbKey {
    $folder = Join-Path $env:LOCALAPPDATA 'FinancialBrain'
    [IO.Directory]::CreateDirectory($folder) | Out-Null
    $target = Join-Path $folder 'update-key.dpapi'
    $temp = Join-Path $folder ('.update-key-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    try {
        $protected = ConvertFrom-SecureString $script:FbKey
        [IO.File]::WriteAllText($temp, ($protected + "`n"), $script:FbUtf8)
        $roundTrip = ConvertTo-SecureString ((Get-Content -LiteralPath $temp -Raw).Trim())
        $a = [IntPtr]::Zero
        $b = [IntPtr]::Zero
        try {
            $a = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($script:FbKey)
            $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($roundTrip)
            if ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($a) -cne [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)) { throw 'key save check failed' }
        } finally {
            if ($a -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($a) }
            if ($b -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
            $roundTrip.Dispose()
        }
        Move-Item -LiteralPath $temp -Destination $target -Force
        return $true
    } catch {
        Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
        return $false
    }
}

function Stop-FbVisibleKey {
    Remove-FbHeldKey
    Write-FbStatus -Step 'W3' -Code 'STOP' -Reason 'key-visible'
    Show-FbLine -Key 'W3-LATER'
    return 'stop'
}

function Invoke-FbW3 {
    try {
        Write-FbStatus -Step 'W3' -Code 'START' -Reason 'key-start'
        $keyFolder = Join-Path $env:LOCALAPPDATA 'FinancialBrain'
        $keyPath = Join-Path $keyFolder 'update-key.dpapi'
        if (Test-Path -LiteralPath $keyPath -PathType Leaf) {
            Write-FbStatus -Step 'W3' -Code 'INFO' -Reason 'key-file-found'
            Show-FbLine -Key 'W3-USING-SAVED'
            try {
                $script:FbKey = ConvertTo-SecureString ((Get-Content -LiteralPath $keyPath -Raw).Trim())
                $FB.KeyReady = $true
                $savedFlow = Invoke-FbVerifyWithNetwork
                if ($savedFlow.Outcome -ceq 'key-visible') { return Stop-FbVisibleKey }
                if ($savedFlow.Outcome -ceq 'finish-later') { Remove-FbHeldKey; Show-FbLine -Key 'W3-LATER'; return 'finish-later' }
                $savedResult = $savedFlow.Result
                if ($savedResult.Class -ceq 'key-visible') { return Stop-FbVisibleKey }
                if ($savedResult.Class -ceq 'key-ok') {
                    Write-FbStatus -Step 'W3' -Code 'PASS' -Reason 'key-checked'
                    Show-FbLine -Key 'W3-CHECKED'
                    return 'pass'
                }
            } catch {}
            Remove-FbHeldKey
            Write-FbStatus -Step 'W3' -Code 'INFO' -Reason 'key-file-rejected'
            Show-FbLine -Key 'W3-SAVED-OLD'
        }

        if ($FB.HistoryOn -and -not [bool]$FB.Facts.history_delete_proven) {
            Write-FbStatus -Step 'W3' -Code 'SKIP' -Reason 'history-unproven'
            Show-FbLine -Key 'W3-LATER'
            return 'finish-later'
        }
        if ($FB.CloudClipboardOn -and -not [bool]$FB.Facts.cloud_clipboard_allowed) {
            Write-FbStatus -Step 'W3' -Code 'SKIP' -Reason 'history-cloud'
            Show-FbLine -Key 'W3-LATER'
            return 'finish-later'
        }
        Show-FbLine -Key 'W3-PAUSE'
        Show-FbWindow
        Flush-FbInput
        Show-FbLine -Key 'W3-COPY'
        Write-FbStatus -Step 'W3' -Code 'WAITING' -Who 'owner' -Reason 'copy-key'
        $badKeys = 0
        $started = [DateTime]::UtcNow
        $nudged = $false
        while ($true) {
            if (Test-FbKeyVisible) { return Stop-FbVisibleKey }
            $elapsed = ([DateTime]::UtcNow - $started).TotalSeconds
            if (-not $nudged -and $elapsed -ge (Get-FbScaledSeconds 60)) {
                $nudged = $true
                Write-FbStatus -Step 'W3' -Code 'INFO' -Reason 'nudge'
                Show-FbLine -Key 'W3-NUDGE'
            }
            if ($elapsed -ge (Get-FbScaledSeconds 180)) {
                Write-FbStatus -Step 'W3' -Code 'SKIP' -Reason 'timeout'
                Show-FbLine -Key 'W3-LATER'
                return 'finish-later'
            }
            $text = Get-FbClipboardText
            $candidates = @(Find-FbClipboardCandidates $text)
            if ($candidates.Count -gt 1) {
                Write-FbStatus -Step 'W3' -Code 'INFO' -Reason 'two-candidates'
                Show-FbLine -Key 'W3-TWO'
                Start-Sleep -Milliseconds 500
                continue
            }
            if ($candidates.Count -ne 1) { Start-Sleep -Milliseconds 500; continue }
            $script:FbKey = ConvertTo-SecureString $candidates[0] -AsPlainText -Force
            $candidates = @()
            $text = $null
            $FB.KeyReady = $true
            Clear-FbClipboard
            Write-FbStatus -Step 'W3' -Code 'INFO' -Reason 'got-it'
            if ($FB.HistoryOn) {
                if (Remove-FbClipboardHistoryItem -Key $script:FbKey) {
                    Write-FbStatus -Step 'W3' -Code 'INFO' -Reason 'history-deleted'
                } else {
                    Write-FbStatus -Step 'W3' -Code 'INFO' -Reason 'history-delete-failed'
                    $historyChoice = Wait-FbDecision -Step 'W3' -Reason 'key-history' -Words @('continue','finish-later')
                    if ($historyChoice -ceq 'key-visible') { return Stop-FbVisibleKey }
                    if ($historyChoice -ceq 'finish-later') { Remove-FbHeldKey; Show-FbLine -Key 'W3-LATER'; return 'finish-later' }
                }
            }
            Show-FbLine -Key 'W3-GOT'
            Show-FbLine -Key 'W3-CHECKING'
            $verifyFlow = Invoke-FbVerifyWithNetwork
            if ($verifyFlow.Outcome -ceq 'key-visible') { return Stop-FbVisibleKey }
            if ($verifyFlow.Outcome -ceq 'finish-later') { Remove-FbHeldKey; Show-FbLine -Key 'W3-LATER'; return 'finish-later' }
            $verify = $verifyFlow.Result
            if ($verify.Class -ceq 'key-visible') { return Stop-FbVisibleKey }
            if ($verify.Class -ceq 'key-ok') {
                if (Test-FbKeyVisible) { return Stop-FbVisibleKey }
                Write-FbStatus -Step 'W3' -Code 'PASS' -Reason 'key-checked'
                Show-FbLine -Key 'W3-CHECKED'
                if (Save-FbKey) {
                    Set-FbProgress -Key 'key_file' -Value 'saved'
                    Write-FbStatus -Step 'W3' -Code 'PASS' -Reason 'key-saved'
                    Show-FbLine -Key 'W3-SAVED'
                } else {
                    Write-FbStatus -Step 'W3' -Code 'INFO' -Reason 'save-failed'
                }
                Show-FbLine -Key 'W3-SHARE'
                return 'pass'
            }
            Remove-FbHeldKey
            $badKeys++
            Set-FbProgress -Key 'w3_bad_keys' -Value ([string]$badKeys)
            Write-FbStatus -Step 'W3' -Code 'INFO' -Reason 'key-bad'
            Show-FbLine -Key 'W3-BAD'
            if ($badKeys -ge 2) {
                Write-FbStatus -Step 'W3' -Code 'STOP' -Reason 'two-bad'
                Show-FbLine -Key 'W3-LATER'
                return 'stop'
            }
            $started = [DateTime]::UtcNow
            $nudged = $false
        }
    } catch {
        Remove-FbHeldKey
        Stop-FbUnexpected
        return 'stop'
    }
}

function Invoke-FbW4 {
    try {
        if ($FB.LoadRunning) {
            $loadChoice = Wait-FbDecision -Step 'W4' -Reason 'load-running' -Words @('wait','finish-later')
            if ($loadChoice -ceq 'key-visible') { return Stop-FbVisibleKey }
            if ($loadChoice -cne 'wait') { Write-FbStatus -Step 'W4' -Code 'SKIP' -Reason 'finish-later'; Show-FbLine -Key 'W4-LATER'; return 'finish-later' }
            Start-Sleep -Seconds (Get-FbScaledSeconds 480)
            $processes = Test-FbProcesses
            if ($processes.Load) { Write-FbStatus -Step 'W4' -Code 'SKIP' -Reason 'finish-later'; Show-FbLine -Key 'W4-LATER'; return 'finish-later' }
        }
        if ($FB.HealthRead) { $reading = $FB.HealthResult }
        else {
            $reading = Invoke-FbHealthRead -WithKey
            $FB.HealthRead = $true
            $FB.HealthResult = $reading
        }
        if ($reading.Class -ceq 'health-paused') { Write-FbStatus -Step 'W4' -Code 'SKIP' -Reason 'finish-later'; Show-FbLine -Key 'W4-LATER'; return 'finish-later' }
        $pending = Get-FbPendingCount $reading
        $capped = $reading.Class -ceq 'health-capped'
        if (($null -eq $pending -or $pending -le 0) -and -not $capped) {
            Write-FbStatus -Step 'W4' -Code 'PASS' -Reason 'queue-zero'
            Set-FbProgress -Key 'w4_result' -Value 'pass'
            return 'pass'
        }
        if ($capped) { Write-FbStatus -Step 'W4' -Code 'INFO' -Reason 'capped'; $shown = 10000 }
        else { Write-FbStatus -Step 'W4' -Code 'INFO' -Reason 'pending' -N ([int]$pending); $shown = [int]$pending }
        $projection = [int][Math]::Ceiling(([double]$shown) / [double]$FB.Facts.drain_per_minute)
        Write-FbStatus -Step 'W4' -Code 'INFO' -Reason 'projection' -N $projection
        Show-FbLine -Key 'W4-BUSY' -Fill @{ n = $shown; m = $projection }
        $choice = Wait-FbDecision -Step 'W4' -Reason 'queue' -Words @('wait','finish-later') -DefaultAfterSec 600 -Default 'finish-later'
        if ($choice -ceq 'key-visible') { return Stop-FbVisibleKey }
        if ($choice -cne 'wait') { Write-FbStatus -Step 'W4' -Code 'SKIP' -Reason 'finish-later'; Show-FbLine -Key 'W4-LATER'; return 'finish-later' }
        $minutes = [Math]::Max($projection, 8)
        Start-Sleep -Seconds (Get-FbScaledSeconds ($minutes * 60))
        Write-FbStatus -Step 'W4' -Code 'INFO' -Reason 'wait-elapsed'
        if ($FB.DomainPresent) { $second = Invoke-FbHealthRead }
        else { $second = Invoke-FbHealthRead -WithKey }
        $secondPending = Get-FbPendingCount $second
        if ($second.Class -ceq 'health-pending' -or $second.Class -ceq 'health-capped' -or ($null -ne $secondPending -and $secondPending -gt 0)) {
            Write-FbStatus -Step 'W4' -Code 'SKIP' -Reason 'finish-later'
            Show-FbLine -Key 'W4-LATER'
            return 'finish-later'
        }
        Write-FbStatus -Step 'W4' -Code 'PASS' -Reason 'queue-zero'
        Set-FbProgress -Key 'w4_result' -Value 'pass'
        return 'pass'
    } catch {
        Stop-FbUnexpected
        return 'stop'
    }
}

function Invoke-FbW11 {
    try {
        if ($FB.KeyReady -and -not $FB.DomainPresent) {
            $lastKeyHealth = Start-FbStep -Step 'health-key' -WithKey
            if ($lastKeyHealth) { [void](Wait-FbStep -RunId $lastKeyHealth -TimeoutSec 360) }
            Write-FbStatus -Step 'W11' -Code 'INFO' -Reason 'health-with-key'
        }
        Remove-FbHeldKey
        if (Test-Path Env:CLOUDFLARE_API_TOKEN) { Remove-Item Env:CLOUDFLARE_API_TOKEN -ErrorAction SilentlyContinue }
        if (Test-Path Env:CLOUDFLARE_API_TOKEN) { throw 'key environment remained' }
        Write-FbStatus -Step 'W11' -Code 'INFO' -Reason 'key-removed'
        if ($FB.DomainPresent -and $FB.Node -and $FB.Manifest) {
            $healthRun = Start-FbStep -Step 'health'
            if ($healthRun) {
                $health = Wait-FbStep -RunId $healthRun -TimeoutSec 360
                if ($health.Exit -eq 0) { Write-FbStatus -Step 'W11' -Code 'INFO' -Reason 'health-no-key' }
                else { Write-FbStatus -Step 'W11' -Code 'INFO' -Reason 'health-failed' }
            } else { Write-FbStatus -Step 'W11' -Code 'INFO' -Reason 'health-failed' }
        }
        if ($FB.Node -and $FB.Cli) {
            $versionRun = Start-FbStep -Step 'cli-version'
            $version = Wait-FbStep -RunId $versionRun -TimeoutSec 70
            $versionText = Read-FbStepLine $versionRun
            if ($version.Exit -eq 0 -and $versionText -ceq [string]$FB.Facts.kit_version) { Write-FbStatus -Step 'W11' -Code 'INFO' -Reason 'version-match' }
            else { Write-FbStatus -Step 'W11' -Code 'INFO' -Reason 'version-other' }
        } else { Write-FbStatus -Step 'W11' -Code 'INFO' -Reason 'version-other' }
        Show-FbLine -Key 'W11-DONE'
        Write-FbStatus -Step 'W11' -Code 'DONE' -Reason 'done'
        Flush-FbInput
        return 'pass'
    } catch {
        Stop-FbUnexpected
        return 'stop'
    }
}
