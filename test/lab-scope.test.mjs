import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('distributed cleanup validates every group, resource scope and ownership before deletion', () => {
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', `
    . .\\scripts\\Common.ps1
    $state = @{
      subscription='s1'; resourceGroup='lab'; labId='campaign'; owner='lab-owner'
      groups=@(1..3 | ForEach-Object { @{ subscription="s$_"; resourceGroup='lab' } })
      expectedRoots=@(1..3 | ForEach-Object { "/subscriptions/s$_/resourceGroups/lab/providers/Test/accounts/b$_" })
    }
    $script:checked=@()
    $script:badOwner=$false
    function Invoke-AzJson {
      param([string[]]$Arguments)
      $subscription=$Arguments[3]
      $script:checked+=$subscription
      return @{
        id="/subscriptions/$subscription/resourceGroups/lab"
        tags=@{ labId='campaign'; purpose='llm-cache-affinity-lab'
          owner=if ($script:badOwner -and $subscription -eq 's3') { 'someone-else' } else { 'lab-owner' } }
      }
    }
    $primary=Assert-LabScope $state
    if ($script:checked.Count -ne 3 -or $primary.id -notlike '/subscriptions/s1/*') { throw 'Scope validation skipped a subscription.' }
    $script:badOwner=$true
    $rejected=$false
    try { $null=Assert-LabScope $state } catch { $rejected=$_.Exception.Message -like '*ownership tags*' }
    if (-not $rejected) { throw 'Accepted a mismatched group owner.' }
    $resources=@(1..3 | ForEach-Object { @{
      id="/subscriptions/s$_/resourceGroups/lab/providers/Test/accounts/b$_"; type='Test/accounts'
      tags=@{ labId='campaign'; purpose='llm-cache-affinity-lab'; owner='lab-owner' }
    } })
    Assert-LabResources -State $state -Resources $resources
    $resources[2].id='/subscriptions/unrelated/resourceGroups/lab/providers/Test/accounts/b3'
    $rejected=$false
    try { Assert-LabResources -State $state -Resources $resources } catch { $rejected=$_.Exception.Message -like '*Unrecognized resource*' }
    if (-not $rejected) { throw 'Accepted a resource outside the inventory.' }
    $resources[2].id=$state.expectedRoots[2]
    $resources[2].tags.labId='another-campaign'
    $rejected=$false
    try { Assert-LabResources -State $state -Resources $resources } catch { $rejected=$_.Exception.Message -like '*ownership tags*' }
    if (-not $rejected) { throw 'Accepted a resource from another campaign.' }
    if (@(Get-LabGroups @{ subscription='legacy'; resourceGroup='lab' }).Count -ne 1) { throw 'Legacy single-group manifest is unsupported.' }
  `], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
