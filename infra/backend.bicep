targetScope = 'resourceGroup'

param name string
param label string
param location string
param tags object
@allowed([
  'OpenAI'
  'AIServices'
])
param kind string
param modelName string
param modelVersion string
param deploymentName string
param modelCapacity int
param apimPrincipalId string

resource account 'Microsoft.CognitiveServices/accounts@2026-11-01' = {
  name: name
  location: location
  kind: kind
  sku: {
    name: 'S0'
  }
  tags: tags
  properties: union({
    customSubDomainName: name
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
  }, kind == 'AIServices' ? {
    allowProjectManagement: true
  } : {})
}

resource deployment 'Microsoft.CognitiveServices/accounts/deployments@2026-11-01' = {
  parent: account
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
}

resource inferenceAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(account.id, apimPrincipalId, 'openai-inference')
  scope: account
  properties: {
    principalId: apimPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd')
  }
}

output backend object = {
  label: label
  name: account.name
  id: account.id
  endpoint: account.properties.endpoint
  subscription: subscription().subscriptionId
  kind: kind
}
