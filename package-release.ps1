# Builds TerminalWorkspace-<version>-Windows.zip with dependencies included.
# Excludes host-specific runtime data, logs, notes, and settings.
$ErrorActionPreference = 'Stop'

$appRoot = $PSScriptRoot
$package = Get-Content -LiteralPath (Join-Path $appRoot 'package.json') -Raw | ConvertFrom-Json
$version = $package.version
$folderName = "TerminalWorkspace-$version"
$zipName = "$folderName-Windows.zip"
$zipPath = Join-Path $appRoot $zipName
$stagingRoot = Join-Path $env:TEMP "tw-pack-$version"
$stagingDir = Join-Path $stagingRoot $folderName

if (Test-Path -LiteralPath $stagingRoot) { Remove-Item -LiteralPath $stagingRoot -Recurse -Force }
New-Item -ItemType Directory -Path $stagingDir -Force | Out-Null

$excludeDirs = @('.git', '.cursor', 'agent-transcripts')
$excludeFiles = @('*.zip', 'package-release.ps1')
$hostDataFiles = @('runtime.json', 'server-error.log', 'server.log', 'settings.json', 'notes.md')

Get-ChildItem -LiteralPath $appRoot -Force | ForEach-Object {
  if ($excludeDirs -contains $_.Name) { return }
  if ($_.Name -like '*.zip') { return }
  if ($_.Name -eq 'package-release.ps1') { return }
  Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $stagingDir $_.Name) -Recurse -Force
}

$dataDir = Join-Path $stagingDir 'data'
if (Test-Path -LiteralPath $dataDir) {
  Get-ChildItem -LiteralPath $dataDir -File -Force | ForEach-Object {
    if ($hostDataFiles -contains $_.Name) { Remove-Item -LiteralPath $_.FullName -Force }
  }
} else {
  New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
}

$gitkeep = Join-Path $dataDir '.gitkeep'
if (-not (Test-Path -LiteralPath $gitkeep)) {
  Set-Content -LiteralPath $gitkeep -Value '' -Encoding ascii
}

$installText = @"
Terminal Workspace $version — quick install (Windows)

1. Extract this entire folder to a writable location, such as:
   Documents\$folderName
   Do not run directly from inside the ZIP file.

2. Install Node.js 22 or 24 LTS (64-bit) if it is not already installed.
   Reopen PowerShell or Command Prompt after installing Node.js.

3. Double-click Start Workspace.cmd
   Dependencies are already included. Setup is only needed if Start reports missing modules.

4. Optional: if dependencies fail to load, run Setup Workspace.cmd once, then start again.

Features on any Windows PC (detected at runtime, no hardcoded paths):
  - Terminal (up to 5 tabs), Notes, Infrastructure (Hyper-V / VirtualBox / VMware VMs), Settings
  - Themes: Dark, Light, Glass, Gradient
  - Remote SSH connections (saved in browser storage on that PC)

This package does not include your notes, saved SSH passwords, theme choices, VM data, or prior session data.
Those are created on the new computer when you use the app.

See README.md for full documentation, troubleshooting, and optional environment variables.

Requirements: Windows 10/11 with ConPTY, Node.js 22+, modern browser.
Target: Windows x64 (native modules bundled for this architecture).
"@
Set-Content -LiteralPath (Join-Path $stagingDir 'INSTALL.txt') -Value $installText -Encoding UTF8

if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($stagingRoot, $zipPath, [System.IO.Compression.CompressionLevel]::Optimal, $false)
Remove-Item -LiteralPath $stagingRoot -Recurse -Force

$sizeMb = [math]::Round((Get-Item -LiteralPath $zipPath).Length / 1MB, 1)
Write-Host "Created $zipPath ($sizeMb MB)"
