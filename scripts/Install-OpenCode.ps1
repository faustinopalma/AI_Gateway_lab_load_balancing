param([string]$Version = '2.2.5')
. "$PSScriptRoot\Common.ps1"
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Use an explicit release version.' }
$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
if ($architecture -notin @('arm64','x64')) { throw 'This installer supports Windows ARM64 and x64.' }
$directory = Join-Path $script:Private "tools\opencode-$Version"
$null = New-Item -ItemType Directory -Path $directory -Force
$archive = "opencode-windows-$architecture.zip"
& gh release download "v$Version" --repo anomalyco/opencode --pattern $archive --pattern SHA256SUMS `
    --dir $directory --clobber
if ($LASTEXITCODE -ne 0) { throw 'Official OpenCode download failed. Stop and resolve tool installation.' }
$checksum = Get-Content -LiteralPath (Join-Path $directory 'SHA256SUMS') |
    Where-Object { $_ -match "^[a-fA-F0-9]{64}\s+\*?$([regex]::Escape($archive))$" }
if (@($checksum).Count -ne 1) { throw 'No unique official archive checksum was found.' }
$expected = ($checksum -split '\s+')[0]
$actual = (Get-FileHash -LiteralPath (Join-Path $directory $archive) -Algorithm SHA256).Hash
if ($actual -ne $expected) { throw 'Official OpenCode archive checksum does not match.' }
Expand-Archive -LiteralPath (Join-Path $directory $archive) -DestinationPath $directory -Force
$executables = @(Get-ChildItem -LiteralPath $directory -Filter '*.exe' -Recurse)
if ($executables.Count -ne 1) { throw 'Expected one executable in the official CLI archive.' }
$versionOutput = & $executables[0].FullName --version
if ($LASTEXITCODE -ne 0 -or $versionOutput.Trim() -ne "opencode v$Version") { throw 'Installed OpenCode version verification failed.' }
$null = Write-PrivateJson 'opencode-tool.json' @{
    version=$Version; executable=$executables[0].FullName; archive=$archive; sha256=$actual
    source="https://github.com/anomalyco/opencode/releases/tag/v$Version"
}
Write-Output "Official OpenCode $Version installed locally and checksum verified."
