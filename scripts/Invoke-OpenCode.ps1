param([ValidateSet('apim','aigateway')][string]$Gateway = 'apim', [switch]$Direct)
. "$PSScriptRoot\Common.ps1"
$state = Read-LabState
$null = Assert-LabScope $state
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
        $mode = if ($Direct) { 'direct' } else { 'observe' }
        & node (Join-Path $PSScriptRoot 'opencode-check.mjs') $Gateway $mode
        if ($LASTEXITCODE -ne 0) { throw 'Real OpenCode validation failed; inspect private evidence.' }
    } finally { Pop-Location }
} finally {
    Remove-Item Env:\LAB_APIM_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:\LAB_AIGATEWAY_KEY -ErrorAction SilentlyContinue
}
