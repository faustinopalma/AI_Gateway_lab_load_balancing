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
    $group = Invoke-AzJson @('group', 'show', '--subscription', $State.subscription, '--name', $State.resourceGroup)
    if ($group.tags.labId -ne $State.labId -or $group.tags.purpose -ne 'llm-cache-affinity-lab') {
        throw 'Resource group ownership tags do not match the local lab manifest.'
    }
    return $group
}

function Write-PrivateJson {
    param([string]$Name, $Value)
    $path = Join-Path $script:Private $Name
    ConvertTo-Json -InputObject $Value -Depth 40 | Set-Content -LiteralPath $path -Encoding utf8
    return $path
}
