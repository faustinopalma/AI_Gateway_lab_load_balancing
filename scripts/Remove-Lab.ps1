param([switch]$ConfirmCleanup)
. "$PSScriptRoot\Common.ps1"
if (-not $ConfirmCleanup) { throw 'Pass -ConfirmCleanup only when authorized to delete the inventoried lab.' }
$state = Read-LabState
$null = Assert-LabScope $state
$resources = @(Invoke-AzJson @('resource', 'list', '--subscription', $state.subscription, '--resource-group', $state.resourceGroup))
foreach ($resource in $resources) {
    $known = @($state.expectedRoots | Where-Object {
        $resource.id.Equals($_, [StringComparison]::OrdinalIgnoreCase) -or
        $resource.id.StartsWith("$_/", [StringComparison]::OrdinalIgnoreCase)
    })
    if ($known.Count -eq 0) { throw "Unrecognized resource in lab group; cleanup stopped: $($resource.type)." }
}
$null = Write-PrivateJson 'inventory-before-cleanup.json' $resources
& az group delete --subscription $state.subscription --name $state.resourceGroup --yes --only-show-errors
if ($LASTEXITCODE -ne 0) { throw 'Resource group deletion failed.' }
$exists = & az group exists --subscription $state.subscription --name $state.resourceGroup --output tsv --only-show-errors
if ($LASTEXITCODE -ne 0 -or $exists.Trim() -ne 'false') { throw 'Cleanup could not be verified.' }
$state.cleanedUtc = [DateTime]::UtcNow.ToString('o')
$state.cleanupVerified = $true
Save-LabState $state
Write-Output 'Verified: the dedicated lab resource group no longer exists.'
