param([ValidateRange(1,150)][int]$TimeoutMinutes = 120)
. "$PSScriptRoot\Common.ps1"
$state = Read-LabState
$null = Assert-LabScope $state
$deadline = [DateTime]::UtcNow.AddMinutes($TimeoutMinutes)
$probeFile = Join-Path $script:Private 'diagnostic-probes.json'
$probes = if (Test-Path -LiteralPath $probeFile) { @(Get-Content -LiteralPath $probeFile -Raw | ConvertFrom-Json) } else { @() }
do {
    & "$PSScriptRoot\Invoke-EdgeChecks.ps1" -CacheScope | Out-Null
    $probes += @(Get-Content -LiteralPath (Join-Path $script:Private 'cache-scope.json') -Raw | ConvertFrom-Json)
    $null = Write-PrivateJson 'diagnostic-probes.json' $probes
    & "$PSScriptRoot\Get-LabLogs.ps1" -Query 'AzureDiagnostics | where Category in ("RequestResponse", "AzureOpenAIRequestUsage") | summarize by CorrelationId, Resource' `
        -OutputName 'backend-correlations.json' | Out-Null
    $table = (Get-Content -LiteralPath (Join-Path $script:Private 'backend-correlations.json') -Raw | ConvertFrom-Json).tables[0]
    $idColumn = [Array]::IndexOf(@($table.columns.name), 'CorrelationId')
    $resourceColumn = [Array]::IndexOf(@($table.columns.name), 'Resource')
    if ($idColumn -lt 0 -or $resourceColumn -lt 0) { throw 'Diagnostic correlation columns are missing.' }
    $identities = @{}
    foreach ($row in $table.rows) { $identities[$row[$idColumn]] = $row[$resourceColumn] }
    $verified = @($probes | Where-Object {
        $id = if ($_.backendRequestId) { $_.backendRequestId } else { $_.requestId }
        $identities.ContainsKey($id) -and $identities[$id].EndsWith("-$($_.intendedBackend)", [StringComparison]::OrdinalIgnoreCase)
    } | ForEach-Object { $_.intendedBackend } | Select-Object -Unique)
    Write-Output "Model diagnostic readiness: $($verified.Count)/3 independently matched backends."
    if ($verified.Count -eq 3) {
        $null = Write-PrivateJson 'diagnostic-readiness.json' @{
            verifiedUtc = [DateTime]::UtcNow.ToString('o')
            verifiedBackends = $verified
        }
        return
    }
    Start-Sleep -Seconds 60
} while ([DateTime]::UtcNow -lt $deadline)
throw 'Model diagnostics did not become ready within the bounded wait. Retain the lab evidence and stop acceptance measurements.'
