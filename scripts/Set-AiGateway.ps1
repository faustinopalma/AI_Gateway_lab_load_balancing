. "$PSScriptRoot\Common.ps1"
$state = Read-LabState
$null = Assert-LabScope $state
if (-not $state.aiGateway.id) { throw 'No standalone AI Gateway is recorded in the lab state.' }
$scope = @('--subscription', $state.subscription, '--resource-group', $state.resourceGroup,
    '--gateway-name', $state.aiGateway.name)
$modelIds = @()
foreach ($backend in $state.backends) {
    $role = Invoke-AzJson @('role', 'assignment', 'create', '--subscription', $state.subscription,
        '--assignee-object-id', $state.aiGateway.identity, '--assignee-principal-type', 'ServicePrincipal',
        '--role', 'Cognitive Services OpenAI User', '--scope', $backend.id)
    $foundry = Write-PrivateJson "foundry-$($backend.label).json" @{
        endpoint = $backend.endpoint
        resourceIds = @($backend.id)
        authentication = @{ kind = 'ManagedIdentity'; managedIdentity = @{ resource = 'https://cognitiveservices.azure.com/' } }
    }
    $null = Invoke-AzJson (@('aigateway','model-provider','create') + $scope + @(
        '--name', $backend.label, '--kind', 'Foundry', '--foundry', "@$foundry"))
    $deployment = Write-PrivateJson "model-$($backend.label).json" @{
        modelName = $state.deployment; modelVersion = $state.modelVersion
        resourceId = "$($backend.id)/deployments/$($state.deployment)"
    }
    $existingModels = Invoke-AzJson (@('aigateway','model','list') + $scope + @('--provider-name',$backend.label,'--query','[].name'))
    $action = if (@($existingModels) -contains 'lab-chat') { 'update' } else { 'create' }
    $deploymentFlag = if ($action -eq 'update') { '--deployment' } else { '--deployment-config' }
    $modelArgs = @('aigateway','model',$action) + $scope + @(
        '--provider-name', $backend.label, '--name', 'lab-chat', $deploymentFlag, "@$deployment")
    if ($action -eq 'create') {
        $modelArgs += @('--api-format','OpenAIChatCompletions','--supported-endpoints','/openai/v1/chat/completions')
    }
    $model = Invoke-AzJson $modelArgs
    $modelIds += $model.id
}
# Preserve the measured header-only probe; native session affinity needs a separate alias.
foreach ($scenario in @('single','balanced','sticky')) {
    $targets = if ($scenario -eq 'single') { @($modelIds[0]) } else { $modelIds }
    $pool = Write-PrivateJson "alias-$scenario.json" @($targets | ForEach-Object {
        @{ resourceId = $_; priority = 0; weight = 1 }
    })
    $alias = Invoke-AzJson (@('aigateway','model-alias','set') + $scope + @(
        '--name', "$($state.model)-$scenario", '--routing-name', "$($state.model)-$scenario", '--backend-models', "@$pool"))
    $null = Write-PrivateJson "alias-$scenario-saved.json" $alias
}
$existingKeys = Invoke-AzJson (@('aigateway','api-key','list') + $scope + @('--query','[].name'))
if (@($existingKeys) -notcontains 'lab') {
    $null = Invoke-AzJson (@('aigateway','api-key','create') + $scope + @('--name','lab','--display-name','Temporary lab runtime credential'))
}
$gateway = Invoke-AzJson @('aigateway','show','--subscription',$state.subscription,
    '--resource-group',$state.resourceGroup,'--name',$state.aiGateway.name)
$null = Write-PrivateJson 'aigateway-resource.json' $gateway
if ($gateway.properties.frontend.defaultHostname) {
    $base = "https://$($gateway.properties.frontend.defaultHostname)"
} elseif ($gateway.properties.gatewayUrl) {
    $base = $gateway.properties.gatewayUrl.TrimEnd('/')
} else { throw 'No documented runtime endpoint was returned by the standalone gateway.' }
$state.aiGateway.chatUrl = "$base/default/models/openai/v1/chat/completions"
$state.aiGateway.modelRegistrations = $modelIds
$state.aiGateway.affinityProbe = 'Historical equal-weight pool with session headers; native session affinity is disabled. See docs/REPORT.md for the documented portal configuration.'
$state.aiGateway.configuredUtc = [DateTime]::UtcNow.ToString('o')
Save-LabState $state
Write-Output 'Standalone gateway providers, models, aliases, and temporary runtime credential configured.'
