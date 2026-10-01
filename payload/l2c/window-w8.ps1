function Invoke-FbW8 {
    $deadline = [DateTime]::UtcNow.AddMinutes(8)

    function Get-FbW8Remaining {
        $seconds = [int][Math]::Floor(($deadline - [DateTime]::UtcNow).TotalSeconds)
        if ($seconds -lt 1) { return 1 }
        return $seconds
    }

    function Get-FbW8Fact {
        param($Result, [string]$Name)
        foreach ($event in @($Result.Events)) {
            $text = [string]$event
            if ($text -match ("(?:^|\s)fact " + [Regex]::Escape($Name) + "=([A-Za-z0-9_.:+-]{0,64})$")) {
                return $Matches[1]
            }
        }
        return $null
    }

    function Invoke-FbW8Step {
        param([string]$Name, [string]$Variant = "")
        if ($Variant) { $runId = Start-FbStep -Step $Name -Variant $Variant }
        else { $runId = Start-FbStep -Step $Name }
        if (-not $runId) { return @{ Exit = 3; Class = "refused"; Events = @() } }
        return Wait-FbStep -RunId $runId -TimeoutSec (Get-FbW8Remaining)
    }

    function Complete-FbW8Local {
        param([string]$Value, [string]$ReturnValue)
        Set-FbProgress -Key w8_result -Value $Value | Out-Null
        return $ReturnValue
    }

    function Invoke-FbW8Discard {
        Invoke-FbW8Step -Name google-discard | Out-Null
        Set-FbProgress -Key w8_backup -Value none | Out-Null
    }

    function Test-FbW8Lease {
        $leaseResult = Invoke-FbW8Step -Name google-lease
        return (Get-FbW8Fact -Result $leaseResult -Name lease) -eq "free"
    }

    function Format-FbW8List {
        param([string[]]$Names)
        $words = @()
        foreach ($name in $Names) {
            if ($name -eq "drive") { $words += "Drive" }
            elseif ($name -eq "gmail") { $words += "Gmail" }
            elseif ($name -eq "calendar") { $words += "Calendar" }
        }
        if ($words.Count -eq 1) { return $words[0] }
        if ($words.Count -eq 2) { return ($words[0] + " and " + $words[1]) }
        return ($words[0] + ", " + $words[1] + " and " + $words[2])
    }

    if (-not $FB.W8On) {
        Write-FbStatus -Step W8 -Code SKIP -Reason off
        return (Complete-FbW8Local -Value off -ReturnValue skip)
    }

    $processes = Test-FbProcesses
    if ($processes.Load) {
        Write-FbStatus -Step W8 -Code SKIP -Reason google-busy
        Show-FbLine -Key W8-BUSY
        return (Complete-FbW8Local -Value busy -ReturnValue skip)
    }
    if (-not (Test-FbW8Lease)) {
        Write-FbStatus -Step W8 -Code SKIP -Reason google-busy
        Show-FbLine -Key W8-BUSY
        return (Complete-FbW8Local -Value busy -ReturnValue skip)
    }

    if ((Get-FbProgress -Key w8_backup) -eq "present") { Invoke-FbW8Discard }
    Show-FbLine -Key W8-CHECK
    Write-FbStatus -Step W8 -Code INFO -Reason check-start

    $preResult = $null
    for ($attempt = 1; $attempt -le 3; $attempt += 1) {
        $preResult = Invoke-FbW8Step -Name google-scopes -Variant pre
        if ((Get-FbW8Fact -Result $preResult -Name reason) -ne "sac") { break }
    }
    if ((Get-FbW8Fact -Result $preResult -Name reason) -eq "sac") {
        Write-FbStatus -Step W8 -Code INFO -Reason sac-refused
        Write-FbStatus -Step W8 -Code STOP -Reason check-failed
        return (Complete-FbW8Local -Value check-failed -ReturnValue stop)
    }
    if ((Get-FbW8Fact -Result $preResult -Name record) -eq "none") {
        Write-FbStatus -Step W8 -Code SKIP -Reason google-none
        return (Complete-FbW8Local -Value none -ReturnValue skip)
    }
    $accountHash = Get-FbW8Fact -Result $preResult -Name account_hash
    if ($accountHash) { Set-FbProgress -Key w8_account_hash -Value $accountHash | Out-Null }
    $oldGrant = @{}
    foreach ($scope in @("drive", "gmail", "calendar")) {
        $oldGrant[$scope] = Get-FbW8Fact -Result $preResult -Name ("granted_" + $scope)
    }

    $calendarResult = $null
    for ($attempt = 1; $attempt -le 3; $attempt += 1) {
        $calendarResult = Invoke-FbW8Step -Name google-calendar-check
        if ($calendarResult.Class -ne "sac") { break }
    }
    if ($calendarResult.Class -eq "ok") {
        Write-FbStatus -Step W8 -Code PASS -Reason calendar-ok
        Show-FbLine -Key W8-OK
        return (Complete-FbW8Local -Value calendar-ok -ReturnValue pass)
    }
    if ($calendarResult.Class -eq "google-none") {
        Write-FbStatus -Step W8 -Code SKIP -Reason google-none
        return (Complete-FbW8Local -Value none -ReturnValue skip)
    }
    if ($calendarResult.Class -eq "sac") {
        Write-FbStatus -Step W8 -Code INFO -Reason sac-refused
        Write-FbStatus -Step W8 -Code STOP -Reason check-failed
        return (Complete-FbW8Local -Value check-failed -ReturnValue stop)
    }
    if ($calendarResult.Class -ne "reconnect") {
        Write-FbStatus -Step W8 -Code STOP -Reason check-failed
        return (Complete-FbW8Local -Value check-failed -ReturnValue stop)
    }
    Write-FbStatus -Step W8 -Code INFO -Reason reconnect-needed

    $retryCount = 0
    while ($retryCount -le 1) {
        if (-not (Test-FbW8Lease)) {
            Write-FbStatus -Step W8 -Code SKIP -Reason google-busy
            Show-FbLine -Key W8-BUSY
            Invoke-FbW8Discard
            return (Complete-FbW8Local -Value busy -ReturnValue skip)
        }
        if ((Get-FbProgress -Key w8_backup) -ne "present") {
            $backupResult = Invoke-FbW8Step -Name google-backup
            if ((Get-FbW8Fact -Result $backupResult -Name backup) -ne "yes") {
                Write-FbStatus -Step W8 -Code STOP -Reason connect-failed
                return (Complete-FbW8Local -Value backup-failed -ReturnValue stop)
            }
            Set-FbProgress -Key w8_backup -Value present | Out-Null
        }

        Show-FbLine -Key W8-HOST
        Show-FbLine -Key W8-BOXES
        Show-FbLine -Key W8-OPENING
        Show-FbWindow
        Write-FbStatus -Step W8 -Code WAITING -Reason google-consent -Who owner

        $wallCount = 0
        while ($true) {
            $connectResult = Invoke-FbW8Step -Name google-connect
            if ($connectResult.Class -eq "client-id-wall" -and $wallCount -eq 0) {
                $wallCount = 1
                continue
            }
            break
        }
        if ($connectResult.Class -eq "connected") {
            Write-FbStatus -Step W8 -Code INFO -Reason connected
        }
        elseif ($connectResult.Class -eq "consent-not-finished") {
            Write-FbStatus -Step W8 -Code SKIP -Reason consent-not-finished
            Show-FbLine -Key W8-NOT-FINISHED
            Invoke-FbW8Discard
            return (Complete-FbW8Local -Value consent-not-finished -ReturnValue skip)
        }
        elseif ($connectResult.Class -eq "google-busy") {
            Write-FbStatus -Step W8 -Code SKIP -Reason google-busy
            Show-FbLine -Key W8-BUSY
            Invoke-FbW8Discard
            return (Complete-FbW8Local -Value busy -ReturnValue skip)
        }
        else {
            Write-FbStatus -Step W8 -Code STOP -Reason connect-failed
            Invoke-FbW8Discard
            return (Complete-FbW8Local -Value connect-failed -ReturnValue stop)
        }

        $postResult = Invoke-FbW8Step -Name google-scopes -Variant post
        $missing = @()
        foreach ($scope in @("drive", "gmail", "calendar")) {
            if ((Get-FbW8Fact -Result $postResult -Name ("granted_" + $scope)) -ne "yes") {
                $missing += $scope
                Write-FbStatus -Step W8 -Code INFO -Reason ("scope-missing-" + $scope)
            }
        }
        $account = Get-FbW8Fact -Result $postResult -Name account
        if ($account -eq "changed") { Write-FbStatus -Step W8 -Code INFO -Reason account-changed }
        elseif ($account -eq "same") { Write-FbStatus -Step W8 -Code INFO -Reason account-same }
        else { Write-FbStatus -Step W8 -Code INFO -Reason account-unknown }

        if ($missing.Count -eq 0 -and @("same", "unknown") -contains $account) {
            Write-FbStatus -Step W8 -Code PASS -Reason scopes-all
            Show-FbLine -Key W8-ALL
            Invoke-FbW8Discard
            return (Complete-FbW8Local -Value scopes-all -ReturnValue pass)
        }

        Show-FbLine -Key W8-MISSING -Fill @{ list = Format-FbW8List -Names $missing }
        if ($account -eq "changed") { Show-FbLine -Key W8-OTHER-ACCOUNT }
        $regression = $account -eq "changed"
        foreach ($scope in $missing) {
            if ($oldGrant[$scope] -eq "yes") { $regression = $true }
        }
        if ($regression) { $default = "restore" } else { $default = "keep" }
        $waitReason = "google-partial"
        if ($account -eq "changed") { $waitReason = "google-account" }
        $waitSeconds = [Math]::Min(300, (Get-FbW8Remaining))
        $decision = Wait-FbDecision -Step W8 -Reason $waitReason -Words @("restore", "keep", "retry") -DefaultAfterSec $waitSeconds -Default $default
        if ($decision -eq "retry" -and $retryCount -eq 0) {
            $retryCount = 1
            continue
        }
        if ($decision -eq "restore") {
            $restoreResult = Invoke-FbW8Step -Name google-restore
            if ((Get-FbW8Fact -Result $restoreResult -Name restore) -eq "done") {
                Set-FbProgress -Key w8_backup -Value none | Out-Null
                Write-FbStatus -Step W8 -Code INFO -Reason restored
                return (Complete-FbW8Local -Value restored -ReturnValue pass)
            }
            Write-FbStatus -Step W8 -Code STOP -Reason connect-failed
            return (Complete-FbW8Local -Value restore-failed -ReturnValue stop)
        }
        Invoke-FbW8Discard
        Write-FbStatus -Step W8 -Code INFO -Reason kept
        return (Complete-FbW8Local -Value kept -ReturnValue pass)
    }
}
