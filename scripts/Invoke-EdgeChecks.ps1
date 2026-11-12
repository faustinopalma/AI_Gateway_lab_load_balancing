param([switch]$CacheScope, [ValidateSet('apim','aigateway')][string]$Gateway = 'apim')
. "$PSScriptRoot\Common.ps1"
$state = Read-LabState
$null = Assert-LabScope $state
if ($CacheScope -and $Gateway -ne 'apim') { throw 'The controlled cache-scope probe uses explicit APIM backend selection.' }
try {
    if ($Gateway -eq 'apim') {
        $keys = Invoke-AzJson @('rest','--method','post','--url',
            "https://management.azure.com$($state.apim.id)/subscriptions/lab/listSecrets?api-version=2024-05-01")
        $env:LAB_APIM_KEY = $keys.primaryKey
    } else {
        $keys = Invoke-AzJson @('aigateway','api-key','list-secrets','--subscription',$state.subscription,
            '--resource-group',$state.resourceGroup,'--gateway-name',$state.aiGateway.name,'--name','lab')
        $env:LAB_AIGATEWAY_KEY = $keys.primaryKey
    }
    Push-Location $script:Root
    try {
        $runner = if ($CacheScope) { 'check-cache-scope.mjs' } else { 'check-edges.mjs' }
        & node (Join-Path $PSScriptRoot $runner) $Gateway
        if ($LASTEXITCODE -ne 0) { throw 'An edge-case check failed; inspect saved evidence.' }
    } finally { Pop-Location }
} finally {
    Remove-Item Env:\LAB_APIM_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:\LAB_AIGATEWAY_KEY -ErrorAction SilentlyContinue
}
