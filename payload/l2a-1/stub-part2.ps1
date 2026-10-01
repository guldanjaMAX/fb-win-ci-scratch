function Invoke-FbW5 {
    Write-FbStatus -Step 'RUN' -Code 'INFO' -Reason 'part-missing'
    return 'skip'
}

function Invoke-FbW6 {
    Write-FbStatus -Step 'RUN' -Code 'INFO' -Reason 'part-missing'
    return 'skip'
}

function Start-FbW7 {
    Write-FbStatus -Step 'RUN' -Code 'INFO' -Reason 'part-missing'
    return 'skip'
}

function Complete-FbW7 {
    param([string]$RunId)
    Write-FbStatus -Step 'RUN' -Code 'INFO' -Reason 'part-missing'
    return 'skip'
}

