param([switch]$ConfirmCleanup)
. "$PSScriptRoot\Common.ps1"
if (-not $ConfirmCleanup) { throw 'Pass -ConfirmCleanup only when authorized to delete the inventoried lab.' }
$state = Read-LabState
$null = Assert-LabScope $state
$groups = @(Get-LabGroups $state)
$resources = @(
    foreach ($scope in $groups) {
        Invoke-AzJson @('resource', 'list', '--subscription', $scope.subscription, '--resource-group', $scope.resourceGroup)
    }
)
Assert-LabResources -State $state -Resources $resources
$null = Write-PrivateJson 'inventory-before-cleanup.json' $resources
foreach ($scope in $groups) {
    & az group delete --subscription $scope.subscription --name $scope.resourceGroup --yes --only-show-errors
    if ($LASTEXITCODE -ne 0) { throw 'Resource group deletion failed.' }
    $exists = & az group exists --subscription $scope.subscription --name $scope.resourceGroup --output tsv --only-show-errors
    if ($LASTEXITCODE -ne 0 -or $exists.Trim() -ne 'false') { throw 'Cleanup could not be verified.' }
}
$state.cleanedUtc = [DateTime]::UtcNow.ToString('o')
$state.cleanupVerified = $true
Save-LabState $state
Write-Output "Verified: all $($groups.Count) dedicated lab resource groups no longer exist."
