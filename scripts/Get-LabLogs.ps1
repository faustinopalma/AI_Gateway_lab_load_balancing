param(
    [string]$Query = 'AzureDiagnostics | where TimeGenerated > ago(1h) | take 5',
    [string]$OutputName = 'log-query.json'
)
. "$PSScriptRoot\Common.ps1"
$state = Read-LabState
$null = Assert-LabScope $state
$body = Write-PrivateJson 'log-query-request.json' @{ query=$Query; timespan='PT2H' }
$result = Invoke-AzJson @('rest','--method','post','--resource','https://api.loganalytics.io',
    '--url',"https://api.loganalytics.io/v1/workspaces/$($state.telemetry.workspaceCustomerId)/query",
    '--body',"@$body")
$null = Write-PrivateJson $OutputName $result
$result | ConvertTo-Json -Depth 20
