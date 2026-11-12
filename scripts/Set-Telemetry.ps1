param([switch]$ConfigureGatewayExporter)
. "$PSScriptRoot\Common.ps1"
$state = Read-LabState
$group = Assert-LabScope $state
foreach ($provider in @('Microsoft.Insights','Microsoft.OperationalInsights')) {
    $registration = Invoke-AzJson @('provider','show','--subscription',$state.subscription,'--namespace',$provider)
    if ($registration.registrationState -ne 'Registered') {
        $null = Invoke-AzJson @('provider','register','--subscription',$state.subscription,'--namespace',$provider,'--wait')
    }
}
$groupId = $group.id
$prefix = $state.apim.name -replace '-apim$',''
$state.expectedRoots += "$groupId/providers/Microsoft.OperationalInsights/workspaces/$prefix-logs"
$state.expectedRoots += "$groupId/providers/Microsoft.Insights/components/$prefix-insights"
$state.expectedRoots = @($state.expectedRoots | Select-Object -Unique)
Save-LabState $state
$tags = Write-PrivateJson 'telemetry-tags.json' $group.tags
$deployment = Invoke-AzJson @('deployment','group','create','--subscription',$state.subscription,
    '--resource-group',$state.resourceGroup,'--name','lab-telemetry',
    '--template-file',(Join-Path $script:Root 'infra\telemetry.bicep'),'--parameters',
    "location=$($group.location)","prefix=$prefix","tags=@$tags")
$outputs = $deployment.properties.outputs
$state.telemetry = @{
    workspaceId=$outputs.workspaceId.value; workspaceCustomerId=$outputs.workspaceCustomerId.value
    insightsId=$outputs.insightsId.value
}
Save-LabState $state
if ($ConfigureGatewayExporter) {
    $settings = Write-PrivateJson 'telemetry-exporter.json' @{ connectionString=$outputs.connectionString.value }
    $null = Invoke-AzJson @('aigateway','telemetry-exporter','create','--subscription',$state.subscription,
        '--resource-group',$state.resourceGroup,'--gateway-name',$state.aiGateway.name,
        '--name','lab','--kind','ApplicationInsights','--application-insights',"@$settings",'--payload-capture','false')
}
Write-Output 'Scoped telemetry workspace configured with a 0.1-GB daily cap. Enable model diagnostics separately.'
