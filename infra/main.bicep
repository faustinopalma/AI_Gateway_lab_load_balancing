targetScope = 'resourceGroup'

param prefix string
param location string = resourceGroup().location
param owner string = 'fausto.palma'
param modelName string = 'gpt-5-nano'
param modelVersion string = '2025-08-07'
param deploymentName string = modelName
param modelCapacity int = 1000
param labId string
param backendSubscriptions array = [
  subscription().subscriptionId
  subscription().subscriptionId
  subscription().subscriptionId
]
param backendResourceGroup string = resourceGroup().name
@allowed([
  'OpenAI'
  'AIServices'
])
param backendKind string = 'OpenAI'

var tags = {
  purpose: 'llm-cache-affinity-lab'
  owner: owner
  labId: labId
}

resource apim 'Microsoft.ApiManagement/service@2024-05-01' = {
  name: '${prefix}-apim'
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  sku: {
    name: 'BasicV2'
    capacity: 1
  }
  properties: {
    publisherName: 'LLM affinity laboratory'
    publisherEmail: 'lab@example.invalid'
    publicNetworkAccess: 'Enabled'
  }
}

module backends 'backend.bicep' = [for i in range(0, 3): {
  name: 'backend-b${i + 1}'
  scope: resourceGroup(backendSubscriptions[i], backendResourceGroup)
  params: {
    name: '${prefix}-b${i + 1}'
    label: 'b${i + 1}'
    location: location
    tags: tags
    kind: backendKind
    modelName: modelName
    modelVersion: modelVersion
    deploymentName: deploymentName
    modelCapacity: modelCapacity
    apimPrincipalId: apim.identity.principalId
  }
}]

output apimName string = apim.name
output apimId string = apim.id
output apimUrl string = apim.properties.gatewayUrl
output backends array = [for i in range(0, 3): backends[i].outputs.backend]
output deployment string = deploymentName
output model string = modelName
output version string = modelVersion
