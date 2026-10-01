function Invoke-FbWindowMain {
    try {
        Initialize-FbCore
        Write-FbStatus -Step 'RUN' -Code 'START' -Reason 'start'
        if (-not $FB.Tier2On) {
            Write-FbStatus -Step 'RUN' -Code 'INFO' -Reason 'tier2-off'
            if ($FB.W8On) { Write-FbStatus -Step 'RUN' -Code 'INFO' -Reason 'w8-only' }
        }
        $w1 = Invoke-FbW1
        if ($FB.Rejoin) {
            [void](Complete-FbW7 -RunId $FB.RejoinRunId)
            [void](Invoke-FbW11)
            return
        }
        if ($w1 -ceq 'stop') { [void](Invoke-FbW11); return }
        if (-not $FB.Tier2On -and $FB.W8On) {
            [void](Invoke-FbW8)
            [void](Invoke-FbW11)
            return
        }
        if ($w1 -ceq 'finish-later') {
            if ($FB.W8On) { [void](Invoke-FbW8) }
            [void](Invoke-FbW11)
            return
        }
        $w3 = Invoke-FbW3
        if ($w3 -cne 'pass') {
            if ($FB.W8On) { [void](Invoke-FbW8) }
            [void](Invoke-FbW11)
            return
        }
        if ($FB.PausedChoice -ceq 'deploy-recover') {
            $recoverRun = Start-FbStep -Step 'deploy-recover' -WithKey
            if ($recoverRun) {
                $recover = Wait-FbStep -RunId $recoverRun -TimeoutSec 960
                if ($recover.Exit -ne 0) { Write-FbStatus -Step 'W7' -Code 'STOP' -Reason 'failed' }
            } else { Write-FbStatus -Step 'W7' -Code 'STOP' -Reason 'failed' }
            [void](Invoke-FbW11)
            return
        }
        $w4 = Invoke-FbW4
        if ($w4 -cne 'pass') {
            if ($FB.W8On) { [void](Invoke-FbW8) }
            [void](Invoke-FbW11)
            return
        }
        $w5 = Invoke-FbW5
        if ($w5 -cne 'pass') {
            if ($FB.W8On) { [void](Invoke-FbW8) }
            [void](Invoke-FbW11)
            return
        }
        $w6 = Invoke-FbW6
        if ($w6 -cne 'pass') { [void](Invoke-FbW11); return }
        $w7 = Start-FbW7
        if ($w7 -cne 'pass') {
            if ($FB.W8On) { [void](Invoke-FbW8) }
            [void](Invoke-FbW11)
            return
        }
        if ($FB.W8On) { [void](Invoke-FbW8) }
        [void](Complete-FbW7 -RunId $FB.W7RunId)
        [void](Invoke-FbW11)
    } catch {
        Stop-FbUnexpected
    }
}

Invoke-FbWindowMain
if (-not $FB.TestSeam) {
    while ($true) { Start-Sleep -Seconds 3600 }
}
