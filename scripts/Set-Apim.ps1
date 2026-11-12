param([switch]$PoliciesOnly)
. "$PSScriptRoot\Common.ps1"
$state = Read-LabState
$null = Assert-LabScope $state
$apiVersion = '2024-05-01'
$base = "https://management.azure.com$($state.apim.id)"
$token = Invoke-AzJson @('account','get-access-token','--subscription',$state.subscription,
    '--resource','https://management.azure.com/')
$armHeaders = @{ Authorization = "Bearer $($token.accessToken)"; Accept = 'application/json' }
function Put-Apim {
    param([string]$Suffix, $Properties)
    $file = Write-PrivateJson ('apim-' + ($Suffix -replace '[^a-zA-Z0-9-]', '-') + '.json') @{ properties = $Properties }
    $null = Invoke-AzJson @('rest', '--method', 'put', '--url', "${base}/${Suffix}?api-version=$apiVersion", '--body', "@$file")
}
foreach ($backend in $state.backends) {
    Put-Apim "namedValues/lab-endpoint-$($backend.label)" @{
        displayName="lab-endpoint-$($backend.label)"; value=$backend.endpoint.TrimEnd('/'); secret=$false
    }
}
if (-not $PoliciesOnly) {
foreach ($backend in $state.backends) {
    Put-Apim "backends/$($backend.label)" @{
        url = "$($backend.endpoint.TrimEnd('/'))/openai/v1"; protocol = 'http'
        circuitBreaker = @{ rules = @(@{
            name = 'transient'; failureCondition = @{ count = 1; interval = 'PT1M'; statusCodeRanges = @(
                @{ min = 429; max = 429 }, @{ min = 500; max = 599 }
            ) }; tripDuration = 'PT10S'; acceptRetryAfter = $true
        }) }
    }
}
Put-Apim 'backends/pool' @{
    type = 'Pool'
    pool = @{ services = @($state.backends | ForEach-Object {
        @{ id = "$($state.apim.id)/backends/$($_.label)"; priority = 1; weight = 1 }
    }) }
}
}
& node (Join-Path $PSScriptRoot 'policies.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Policy generation failed.' }
foreach ($scenario in @('single','balanced','sticky')) {
    if (-not $PoliciesOnly) {
    Put-Apim "apis/$scenario" @{
        displayName = "Lab $scenario"; path = "$scenario/openai/v1"; protocols = @('https')
        subscriptionRequired = $true
    }
    Put-Apim "apis/$scenario/operations/chat" @{
        displayName = 'Chat completions'; method = 'POST'; urlTemplate = '/chat/completions'
    }
    }
    $policy = Join-Path $script:Private "policies\$scenario.json"
    $null = Invoke-WebRequest -Method Put -Uri "$base/apis/$scenario/policies/policy?api-version=$apiVersion" `
        -Headers $armHeaders -ContentType 'application/json' -InFile $policy -TimeoutSec 120
}
if (-not $PoliciesOnly) {
Put-Apim 'subscriptions/lab' @{
    displayName = 'Temporary lab runtime credential'; scope = '/apis'; state = 'active'; allowTracing = $false
}
}
$state.apim.configuredUtc = [DateTime]::UtcNow.ToString('o')
Save-LabState $state
Write-Output 'APIM APIs, backend pool, affinity policy, and temporary runtime subscription configured.'
