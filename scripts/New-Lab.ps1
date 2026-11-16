param(
    [Parameter(Mandatory)][string]$SubscriptionId,
    [string]$Location = 'swedencentral',
    [string]$Owner = 'fausto.palma',
    [string[]]$BackendSubscriptionIds,
    [switch]$CreateAiGateway
)
. "$PSScriptRoot\Common.ps1"
if (-not $env:AZURE_CONFIG_DIR) { throw 'Set AZURE_CONFIG_DIR to the authorized CLI profile.' }
if ($BackendSubscriptionIds) {
    if ($BackendSubscriptionIds.Count -ne 3 -or @($BackendSubscriptionIds | Sort-Object -Unique).Count -ne 3 -or
        $SubscriptionId -notin $BackendSubscriptionIds) {
        throw 'Provide three distinct backend subscriptions, including the primary gateway subscription.'
    }
    $accounts = @($BackendSubscriptionIds | ForEach-Object {
        Invoke-AzJson @('account','show','--subscription',$_)
    })
    if (@($accounts.tenantId | Sort-Object -Unique).Count -ne 1 -or
        @($accounts | Where-Object { $_.state -ne 'Enabled' }).Count -gt 0) {
        throw 'All three backend subscriptions must be enabled and belong to the same tenant.'
    }
}
if (Test-Path -LiteralPath $script:StateFile) {
    $previous = Read-LabState
    if (-not $previous.cleanupVerified) { throw 'An existing local lab must be cleaned up before creating another lab.' }
    $null = Write-PrivateJson 'previous-state.json' $previous
}
$null = New-Item -ItemType Directory -Path $script:Private -Force
$suffix = (New-Guid).ToString('N').Substring(0, 8)
$state = @{
    subscription = $SubscriptionId
    resourceGroup = "rg-llm-affinity-$suffix"
    prefix = "llma-$suffix"
    labId = (New-Guid).ToString()
    location = $Location
    owner = $Owner
    startedUtc = [DateTime]::UtcNow.ToString('o')
    expectedRoots = @()
    backendKind = if ($BackendSubscriptionIds) { 'AIServices' } else { 'OpenAI' }
}
$backendSubscriptions = if ($BackendSubscriptionIds) { $BackendSubscriptionIds } else { @($SubscriptionId) * 3 }
$state.groups = @($backendSubscriptions | Select-Object -Unique | ForEach-Object {
    @{ subscription=$_; resourceGroup=$state.resourceGroup }
})
foreach ($scope in $state.groups) {
    $exists = & az group exists --subscription $scope.subscription --name $scope.resourceGroup --only-show-errors --output tsv
    if ($LASTEXITCODE -ne 0 -or $exists.Trim() -ne 'false') { throw 'A proposed resource group is not confirmed absent.' }
}
$state.expectedRoots = @(
    "/subscriptions/$SubscriptionId/resourceGroups/$($state.resourceGroup)/providers/Microsoft.ApiManagement/service/$($state.prefix)-apim"
    for ($i = 0; $i -lt 3; $i++) {
        "/subscriptions/$($backendSubscriptions[$i])/resourceGroups/$($state.resourceGroup)/providers/Microsoft.CognitiveServices/accounts/$($state.prefix)-b$($i+1)"
    }
)
Save-LabState $state
foreach ($scope in $state.groups) {
    $null = Invoke-AzJson @('group', 'create', '--subscription', $scope.subscription, '--name', $scope.resourceGroup,
        '--location', $Location, '--tags', 'purpose=llm-cache-affinity-lab', "owner=$Owner", "labId=$($state.labId)")
}
$group = Assert-LabScope $state
$parameters = Write-PrivateJson 'parameters.json' @{
    '$schema' = 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#'
    contentVersion = '1.0.0.0'
    parameters = @{
        prefix = @{ value = $state.prefix }; labId = @{ value = $state.labId }; owner = @{ value = $Owner }
        backendSubscriptions = @{ value = $backendSubscriptions }
        backendKind = @{ value = $state.backendKind }
    }
}
$template = Join-Path $script:Root 'infra\main.bicep'
$common = @('--subscription', $SubscriptionId, '--resource-group', $state.resourceGroup,
    '--name', 'lab', '--template-file', $template, '--parameters', "@$parameters")
$preview = & az deployment group what-if @common --no-pretty-print --only-show-errors --output json
if ($LASTEXITCODE -ne 0) { throw 'Deployment preview failed. No deployment was started.' }
$preview | Set-Content -LiteralPath (Join-Path $script:Private 'what-if.json') -Encoding utf8
$deployment = Invoke-AzJson (@('deployment', 'group', 'create') + $common)
$out = $deployment.properties.outputs
$state.apim = @{ id = $out.apimId.value; name = $out.apimName.value; endpoint = $out.apimUrl.value }
$state.backends = $out.backends.value
$state.deployment = $out.deployment.value
$state.model = $out.model.value
$state.modelVersion = $out.version.value
Save-LabState $state
if ($CreateAiGateway) {
    $state.aiGateway = @{ name = "$($state.prefix)-aigw" }
    $root = "$($group.id)/providers/Microsoft.ApiManagement/aigateways/$($state.aiGateway.name)"
    $state.expectedRoots += $root
    Save-LabState $state
    $gateway = Invoke-AzJson @('aigateway', 'create', '--subscription', $SubscriptionId,
        '--resource-group', $state.resourceGroup, '--name', $state.aiGateway.name, '--location', $Location,
        '--system-assigned', 'true', '--sku', 'Standard', '--tags',
        'purpose=llm-cache-affinity-lab', "owner=$Owner", "labId=$($state.labId)")
    $state.aiGateway.id = $gateway.id
    $state.aiGateway.identity = $gateway.identity.principalId
    $state.aiGateway.properties = $gateway.properties
    Save-LabState $state
}
Write-Output "Lab infrastructure created in $($state.resourceGroup). Local state is excluded from Git."
