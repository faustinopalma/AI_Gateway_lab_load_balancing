targetScope = 'resourceGroup'

param prefix string
param location string = resourceGroup().location
param owner string = 'fausto.palma'
param modelName string = 'gpt-5-nano'
param modelVersion string = '2025-08-07'
param deploymentName string = modelName
param modelCapacity int = 1000
param labId string

var tags = {
  purpose: 'llm-cache-affinity-lab'
  owner: owner
  labId: labId
}

resource accounts 'Microsoft.CognitiveServices/accounts@2026-11-01' = [for i in range(0, 3): {
  name: '${prefix}-b${i + 1}'
  location: location
  kind: 'OpenAI'
  sku: {
    name: 'S0'
  }
  tags: tags
  properties: {
    customSubDomainName: '${prefix}-b${i + 1}'
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
  }
}]

resource deployments 'Microsoft.CognitiveServices/accounts/deployments@2026-11-01' = [for i in range(0, 3): {
  parent: accounts[i]
  name: deploymentName
  sku: {
    name: 'GlobalStandard'
    capacity: modelCapacity
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: modelName
      version: modelVersion
    }
    versionUpgradeOption: 'NoAutoUpgrade'
  }
}]

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

var inferenceRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd')

resource inferenceAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for i in range(0, 3): {
  name: guid(accounts[i].id, apim.id, inferenceRole)
  scope: accounts[i]
  properties: {
    principalId: apim.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: inferenceRole
  }
}]

output apimName string = apim.name
output apimId string = apim.id
output apimUrl string = apim.properties.gatewayUrl
output backends array = [for i in range(0, 3): {
  label: 'b${i + 1}'
  name: accounts[i].name
  id: accounts[i].id
  endpoint: accounts[i].properties.endpoint
}]
output deployment string = deploymentName
output model string = modelName
output version string = modelVersion
