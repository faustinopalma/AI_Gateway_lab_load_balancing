$ErrorActionPreference = 'Stop'
$script:Root = Split-Path $PSScriptRoot -Parent
$script:Private = Join-Path $script:Root '.lab'
$script:StateFile = Join-Path $script:Private 'state.json'

function Invoke-AzJson {
    param([Parameter(Mandatory)][string[]]$Arguments)
    $raw = & az @Arguments --only-show-errors --output json
    if ($LASTEXITCODE -ne 0) {
        throw "Azure CLI failed: az $($Arguments[0..([Math]::Min(2, $Arguments.Count - 1))] -join ' ')"
    }
    if ($raw) { return ($raw -join "`n" | ConvertFrom-Json -AsHashtable) }
}

function Read-LabState {
    if (-not (Test-Path -LiteralPath $script:StateFile)) { throw 'No local lab state exists.' }
    Get-Content -LiteralPath $script:StateFile -Raw | ConvertFrom-Json -AsHashtable
}

function Save-LabState {
    param([Parameter(Mandatory)]$State)
    $State | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $script:StateFile -Encoding utf8
}

function Assert-LabScope {
    param([Parameter(Mandatory)]$State)
    $primary = $null
    foreach ($scope in @(Get-LabGroups $State)) {
        $group = Invoke-AzJson @('group', 'show', '--subscription', $scope.subscription, '--name', $scope.resourceGroup)
        if ($group.tags.labId -ne $State.labId -or $group.tags.purpose -ne 'llm-cache-affinity-lab' -or
            $group.tags.owner -ne $State.owner) {
            throw 'Resource group ownership tags do not match the local lab manifest.'
        }
        if ($scope.subscription -eq $State.subscription -and $scope.resourceGroup -eq $State.resourceGroup) {
            $primary = $group
        }
    }
    if (-not $primary) { throw 'The primary lab group is missing from the manifest.' }
    return $primary
}

function Get-LabGroups {
    param([Parameter(Mandatory)]$State)
    if ($State.groups) { return $State.groups }
    return @(@{ subscription=$State.subscription; resourceGroup=$State.resourceGroup })
}

function Assert-LabResources {
    param([Parameter(Mandatory)]$State, [AllowEmptyCollection()][object[]]$Resources)
    foreach ($resource in $Resources) {
        $known = @($State.expectedRoots | Where-Object {
            $resource.id.Equals($_, [StringComparison]::OrdinalIgnoreCase) -or
            $resource.id.StartsWith("$_/", [StringComparison]::OrdinalIgnoreCase)
        })
        if ($known.Count -eq 0) { throw "Unrecognized resource in lab group; cleanup stopped: $($resource.type)." }
        if ($resource.tags.purpose -ne 'llm-cache-affinity-lab' -or $resource.tags.owner -ne $State.owner -or
            $resource.tags.labId -ne $State.labId) {
            throw "Resource ownership tags do not match the lab manifest; cleanup stopped: $($resource.type)."
        }
    }
}

function Write-PrivateJson {
    param([string]$Name, $Value)
    $path = Join-Path $script:Private $Name
    ConvertTo-Json -InputObject $Value -Depth 40 | Set-Content -LiteralPath $path -Encoding utf8
    return $path
}
