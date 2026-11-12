param([switch]$CacheScope)
. "$PSScriptRoot\Common.ps1"
$state = Read-LabState
$null = Assert-LabScope $state
try {
    $keys = Invoke-AzJson @('rest','--method','post','--url',
        "https://management.azure.com$($state.apim.id)/subscriptions/lab/listSecrets?api-version=2024-05-01")
    $env:LAB_APIM_KEY = $keys.primaryKey
    Push-Location $script:Root
    try {
        $runner = if ($CacheScope) { 'check-cache-scope.mjs' } else { 'check-edges.mjs' }
        & node (Join-Path $PSScriptRoot $runner)
        if ($LASTEXITCODE -ne 0) { throw 'An edge-case check failed; inspect saved evidence.' }
    } finally { Pop-Location }
} finally {
    Remove-Item Env:\LAB_APIM_KEY -ErrorAction SilentlyContinue
}
