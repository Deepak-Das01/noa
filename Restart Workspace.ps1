$ErrorActionPreference = 'Stop'
$runtime = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'data\runtime.json') -Raw | ConvertFrom-Json
$serverProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($runtime.pid)"
if ($serverProcess -and $serverProcess.Name -eq 'node.exe' -and $serverProcess.CommandLine -like '*server.mjs*') {
  Stop-Process -Id $runtime.pid
}
$env:PORT = ([uri]$runtime.url).Port.ToString()
& (Join-Path $PSScriptRoot 'Start Workspace.ps1')
