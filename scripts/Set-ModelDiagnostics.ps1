. "$PSScriptRoot\Common.ps1"
$state = Read-LabState
$null = Assert-LabScope $state
if (-not $state.telemetry.workspaceId) { throw 'Create the lab telemetry workspace first.' }
foreach ($resource in @($state.backends) + @(@{ id=$state.apim.id; label='apim' })) {
    $categories = if ($resource.label -eq 'apim') { @('GatewayLogs') } else { @('RequestResponse','AzureOpenAIRequestUsage') }
    $body = Write-PrivateJson "diagnostics-$($resource.label).json" @{
        properties=@{
            workspaceId=$state.telemetry.workspaceId
            logs=@($categories | ForEach-Object { @{ category=$_; enabled=$true } })
            metrics=@()
        }
    }
    $null = Invoke-AzJson @('rest','--method','put','--url',
        "https://management.azure.com$($resource.id)/providers/Microsoft.Insights/diagnosticSettings/lab?api-version=2021-05-01-preview",
        '--body',"@$body")
}
Write-Output 'Model request diagnostics and APIM gateway diagnostics enabled only on lab resources.'
