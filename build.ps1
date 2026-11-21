[CmdletBinding()]
param(
    [string]$OutputDirectory,
    [ValidateSet('x64', 'arm64')][string]$Arch,
    [switch]$Installer
)

$ErrorActionPreference = 'Stop'
$previousDist = $env:MOBIUS_DIST
Push-Location -LiteralPath $PSScriptRoot
try {
    if ($OutputDirectory) { $env:MOBIUS_DIST = [IO.Path]::GetFullPath($OutputDirectory) }
    $task = if ($Installer) { 'installer' } else { 'package' }
    $flags = if ($Arch) { @('--', "--arch=$Arch") } else { @() }
    & npm.cmd run $task @flags
    exit $LASTEXITCODE
} finally {
    $env:MOBIUS_DIST = $previousDist
    Pop-Location
}
