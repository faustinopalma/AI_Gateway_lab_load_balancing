param([ValidateRange(100,3000)][int]$Capacity = 1000)
. "$PSScriptRoot\Common.ps1"
$state = Read-LabState
$null = Assert-LabScope $state
$oldName = $state.deployment
foreach ($backend in $state.backends) {
    $body = Write-PrivateJson "deployment-$($backend.label).json" @{
        sku=@{ name='GlobalStandard'; capacity=$Capacity }
        properties=@{ model=@{ format='OpenAI'; name=$state.model; version=$state.modelVersion }
            versionUpgradeOption='NoAutoUpgrade' }
    }
    $null = Invoke-AzJson @('rest','--method','put','--url',
        "https://management.azure.com$($backend.id)/deployments/$($state.model)?api-version=2026-11-01",
        '--body',"@$body")
}
$state.deployment = $state.model
$state.modelCapacity = $Capacity
Save-LabState $state
if ($oldName -ne $state.deployment) {
    foreach ($backend in $state.backends) {
        $null = Invoke-AzJson @('rest','--method','delete','--url',
            "https://management.azure.com$($backend.id)/deployments/${oldName}?api-version=2026-11-01")
    }
}
Write-Output 'Identical model deployments use the model-family name and sufficient pay-as-you-go rate quota.'
