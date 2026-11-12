param(
    [Parameter(Mandatory)][string]$SubscriptionId,
    [string]$Location = 'swedencentral',
    [string]$Owner = 'fausto.palma',
    [switch]$CreateAiGateway
)
. "$PSScriptRoot\Common.ps1"
if (-not $env:AZURE_CONFIG_DIR) { throw 'Set AZURE_CONFIG_DIR to the authorized CLI profile.' }
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
}
$exists = & az group exists --subscription $SubscriptionId --name $state.resourceGroup --only-show-errors --output tsv
if ($LASTEXITCODE -ne 0 -or $exists.Trim() -ne 'false') { throw 'The proposed resource group is not confirmed absent.' }
Save-LabState $state
$group = Invoke-AzJson @('group', 'create', '--subscription', $SubscriptionId, '--name', $state.resourceGroup,
    '--location', $Location, '--tags', 'purpose=llm-cache-affinity-lab', "owner=$Owner", "labId=$($state.labId)")
$parameters = Write-PrivateJson 'parameters.json' @{
    '$schema' = 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#'
    contentVersion = '1.0.0.0'
    parameters = @{
        prefix = @{ value = $state.prefix }; labId = @{ value = $state.labId }; owner = @{ value = $Owner }
    }
}
$template = Join-Path $script:Root 'infra\main.bicep'
$common = @('--subscription', $SubscriptionId, '--resource-group', $state.resourceGroup,
    '--name', 'lab', '--template-file', $template, '--parameters', "@$parameters")
$preview = & az deployment group what-if @common --no-pretty-print --only-show-errors --output json
if ($LASTEXITCODE -ne 0) { throw 'Deployment preview failed. No deployment was started.' }
$preview | Set-Content -LiteralPath (Join-Path $script:Private 'what-if.json') -Encoding utf8
$state.expectedRoots = @(
    "$($group.id)/providers/Microsoft.ApiManagement/service/$($state.prefix)-apim"
    (1..3 | ForEach-Object { "$($group.id)/providers/Microsoft.CognitiveServices/accounts/$($state.prefix)-b$_" })
) | ForEach-Object { $_ }
Save-LabState $state
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
