param(
    [Parameter(Mandatory = $true)]
    [string]$VaultPath
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$resolvedVault = (Resolve-Path -LiteralPath $VaultPath).Path
$target = Join-Path $resolvedVault '.obsidian\plugins\google-drive-vault-sync'

if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'main.js'))) {
    throw 'main.js is missing. Run npm run build first.'
}

New-Item -ItemType Directory -Path $target -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot 'main.js') -Destination (Join-Path $target 'main.js') -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'manifest.json') -Destination (Join-Path $target 'manifest.json') -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'styles.css') -Destination (Join-Path $target 'styles.css') -Force
Write-Output "deployed=$target"
