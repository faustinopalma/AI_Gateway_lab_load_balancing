param([ValidateSet('apim','aigateway')][string]$Gateway = 'apim')
. "$PSScriptRoot\Common.ps1"
$state = Read-LabState
$null = Assert-LabScope $state
if ($Gateway -eq 'apim') {
    $keys = Invoke-AzJson @('rest','--method','post','--url',
        "https://management.azure.com$($state.apim.id)/subscriptions/lab/listSecrets?api-version=2024-05-01")
    $headers = @{ 'Ocp-Apim-Subscription-Key' = $keys.primaryKey }
    $url = "$($state.apim.endpoint)/sticky/openai/v1/chat/completions"
    $model = $state.deployment
} else {
    $keys = Invoke-AzJson @('aigateway','api-key','list-secrets','--subscription',$state.subscription,
        '--resource-group',$state.resourceGroup,'--gateway-name',$state.aiGateway.name,'--name','lab')
    $headers = @{ Authorization = "Bearer $($keys.primaryKey)" }
    $url = $state.aiGateway.chatUrl
    $model = "$($state.model)-sticky"
}
$headers['x-opencode-session'] = 'ses_lab_probe'
$body = @{ model = $model; messages = @(@{ role='user'; content='Reply only ACK.' })
    max_completion_tokens = 512; reasoning_effort = 'minimal'; stream = $false } | ConvertTo-Json -Depth 10
$response = Invoke-WebRequest -Method Post -Uri $url -Headers $headers -ContentType 'application/json' `
    -Body $body -SkipHttpErrorCheck -TimeoutSec 120
$safeHeaders = @{}
foreach ($name in $response.Headers.Keys) {
    if ($name -match 'authorization|cookie|key|token' -and $name -notmatch 'ratelimit') { continue }
    $safeHeaders[$name] = $response.Headers[$name]
}
$probe = @{ gateway=$Gateway; status=[int]$response.StatusCode; headers=$safeHeaders
    response=($response.Content | ConvertFrom-Json -AsHashtable); utc=[DateTime]::UtcNow.ToString('o') }
$null = Write-PrivateJson "probe-$Gateway.json" $probe
$probe | ConvertTo-Json -Depth 15
if ($response.StatusCode -ne 200) { throw 'Gateway inference probe failed; inspect the saved error.' }
