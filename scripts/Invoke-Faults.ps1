param([ValidateSet('apim','aigateway')][string]$Gateway = 'apim', [switch]$ColdTransportOnly)
. "$PSScriptRoot\Common.ps1"
if ($ColdTransportOnly -and $Gateway -ne 'aigateway') { throw 'The isolated transport probe is for the standalone gateway.' }
$state = Read-LabState
$null = Assert-LabScope $state
$token = Invoke-AzJson @('account','get-access-token','--subscription',$state.subscription,
    '--resource','https://management.azure.com/')
$env:LAB_ARM_TOKEN = $token.accessToken
try {
    foreach ($status in @(429,503)) {
        $base = "https://management.azure.com$($state.apim.id)"
        foreach ($item in @(
            @{ suffix="apis/fault$status"; properties=@{displayName="Synthetic lab $status"; path="fault$status/openai/v1"; protocols=@('https');subscriptionRequired=$false} }
            @{ suffix="apis/fault$status/operations/chat"; properties=@{displayName='Synthetic pre-response fault';method='POST';urlTemplate='/chat/completions'} }
        )) {
            $file = Write-PrivateJson "fault-$Gateway-$status-$($item.suffix -replace '/','-').json" @{properties=$item.properties}
            $null = Invoke-AzJson @('rest','--method','put','--url',"$base/$($item.suffix)?api-version=2024-05-01",'--body',"@$file")
        }
        $xml = "<policies><inbound><return-response><set-status code=`"$status`" reason=`"Synthetic lab fault`"/><set-header name=`"Retry-After`" exists-action=`"override`"><value>1</value></set-header><set-body>{`"error`":{`"code`":`"synthetic_lab_$status`"}}</set-body></return-response></inbound><backend/><outbound/><on-error/></policies>"
        $file = Write-PrivateJson "fault-$status-policy.json" @{properties=@{format='rawxml';value=$xml}}
        $null = Invoke-WebRequest -Method Put -Uri "$base/apis/fault$status/policies/policy?api-version=2024-05-01" `
            -Headers @{Authorization="Bearer $($token.accessToken)";Accept='application/json'} -ContentType 'application/json' -InFile $file
    }
    if ($Gateway -eq 'apim') {
        $keys = Invoke-AzJson @('rest','--method','post','--url',
            "https://management.azure.com$($state.apim.id)/subscriptions/lab/listSecrets?api-version=2024-05-01")
        $env:LAB_APIM_KEY = $keys.primaryKey
    } else {
        foreach ($item in @(
            @{ suffix='apis/fault-native'; properties=@{displayName='Native gateway synthetic faults'; path='openai/v1'; protocols=@('https');subscriptionRequired=$false} }
            @{ suffix='apis/fault-native/operations/chat'; properties=@{displayName='Synthetic pre-response fault';method='POST';urlTemplate='/chat/completions'} }
        )) {
            $file = Write-PrivateJson "native-$($item.suffix -replace '/','-').json" @{properties=$item.properties}
            $null = Invoke-AzJson @('rest','--method','put','--url',"$base/$($item.suffix)?api-version=2024-05-01",'--body',"@$file")
        }
        $primary = $state.aiGateway.modelRegistrations[0]
        $aliasName = "$($state.model)-failover"
        if ($ColdTransportOnly) {
            $env:LAB_FAULT_PROVIDER = 'b1-cold-' + (New-Guid).ToString('N').Substring(0,8)
            $provider = Write-PrivateJson 'cold-provider.json' @{
                endpoint=$state.backends[0].endpoint; resourceIds=@($state.backends[0].id)
                authentication=@{kind='ManagedIdentity';managedIdentity=@{resource='https://cognitiveservices.azure.com/'}}
            }
            $null = Invoke-AzJson @('aigateway','model-provider','create','--subscription',$state.subscription,
                '--resource-group',$state.resourceGroup,'--gateway-name',$state.aiGateway.name,
                '--name',$env:LAB_FAULT_PROVIDER,'--kind','Foundry','--foundry',"@$provider")
            $deployment = Write-PrivateJson 'cold-deployment.json' @{
                modelName=$state.deployment; modelVersion=$state.modelVersion
                resourceId="$($state.backends[0].id)/deployments/$($state.deployment)"
            }
            $model = Invoke-AzJson @('aigateway','model','create','--subscription',$state.subscription,
                '--resource-group',$state.resourceGroup,'--gateway-name',$state.aiGateway.name,
                '--provider-name',$env:LAB_FAULT_PROVIDER,'--name','lab-chat','--deployment-config',"@$deployment",
                '--api-format','OpenAIChatCompletions','--supported-endpoints','/openai/v1/chat/completions')
            $primary = $model.id
            $aliasName = "$($state.model)-$($env:LAB_FAULT_PROVIDER)"
        }
        if ($ColdTransportOnly) {
            $targets = Write-PrivateJson 'fault-native-targets.json' @(
                @{resourceId=$primary;priority=0;weight=1}
                @{resourceId=$state.aiGateway.modelRegistrations[1];priority=1;weight=1}
                @{resourceId=$state.aiGateway.modelRegistrations[2];priority=1;weight=1}
            )
            $null = Invoke-AzJson @('aigateway','model-alias','set','--subscription',$state.subscription,
                '--resource-group',$state.resourceGroup,'--gateway-name',$state.aiGateway.name,
                '--name',$aliasName,'--routing-name',$aliasName,'--backend-models',"@$targets")
        }
        $keys = Invoke-AzJson @('aigateway','api-key','list-secrets','--subscription',$state.subscription,
            '--resource-group',$state.resourceGroup,'--gateway-name',$state.aiGateway.name,'--name','lab')
        $env:LAB_AIGATEWAY_KEY = $keys.primaryKey
    }
    Push-Location $script:Root
    try {
        $mode = if ($ColdTransportOnly) { 'cold' } else { 'all' }
        & node (Join-Path $PSScriptRoot 'faults.mjs') $Gateway $mode
        if ($LASTEXITCODE -ne 0) { throw 'Fault acceptance was not met; evidence was retained and restoration attempted.' }
    } finally { Pop-Location }
} finally {
    Remove-Item Env:\LAB_ARM_TOKEN -ErrorAction SilentlyContinue
    Remove-Item Env:\LAB_APIM_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:\LAB_AIGATEWAY_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:\LAB_FAULT_PROVIDER -ErrorAction SilentlyContinue
}
