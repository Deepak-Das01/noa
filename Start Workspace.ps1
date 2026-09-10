$ErrorActionPreference = 'Stop'
$appRoot = $PSScriptRoot
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$portableNode = Join-Path $appRoot 'runtime\node.exe'
$nodePath = if (Test-Path -LiteralPath $portableNode) { $portableNode } elseif ($nodeCommand) { $nodeCommand.Source } else { $null }
if (-not $nodePath) { throw 'Node.js is required. Install Node.js 22 or 24 LTS for your Windows architecture, reopen PowerShell, and run this launcher again.' }
$nodeMajor = [int]((& $nodePath -p "process.versions.node.split('.')[0]") | Select-Object -Last 1)
if ($nodeMajor -lt 22) { throw 'This app requires Node.js 22 or later. Install Node.js 22 or 24 LTS.' }
New-Item -ItemType Directory -Force -Path (Join-Path $appRoot 'data') | Out-Null
if (-not (Test-Path -LiteralPath (Join-Path $appRoot 'node_modules\node-pty'))) {
  throw 'Dependencies are missing. Run Setup Workspace.cmd once, then start the app.'
}
if (-not $env:PORT) { $env:PORT = '8765' }
$runtimePath = Join-Path $appRoot 'data\runtime.json'
function Test-WorkspaceUrl($url) {
  try { $response = Invoke-WebRequest -Uri $url -TimeoutSec 2 -UseBasicParsing; return ($response.StatusCode -eq 200 -and ($response.Content.Contains('content="Terminal Workspace"') -or $response.Content.Contains('<title>Terminal Workspace</title>'))) } catch { return $false }
}
if (Test-Path -LiteralPath $runtimePath) {
  try { $runtime = Get-Content -LiteralPath $runtimePath -Raw | ConvertFrom-Json; if (Test-WorkspaceUrl $runtime.url) { Start-Process $runtime.url; exit } } catch {}
}
$launched = Start-Process -FilePath $nodePath -ArgumentList ('"' + (Join-Path $appRoot 'server.mjs') + '"') -WorkingDirectory $appRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $appRoot 'data\server.log') -RedirectStandardError (Join-Path $appRoot 'data\server-error.log')
for ($attempt = 0; $attempt -lt 60; $attempt++) {
  Start-Sleep -Milliseconds 250
  if ($launched.HasExited) { throw ('App could not start: ' + (Get-Content -LiteralPath (Join-Path $appRoot 'data\server-error.log') -Raw)) }
  if (Test-Path -LiteralPath $runtimePath) {
    try { $runtime = Get-Content -LiteralPath $runtimePath -Raw | ConvertFrom-Json; if ($runtime.pid -eq $launched.Id -and (Test-WorkspaceUrl $runtime.url)) { Start-Process $runtime.url; exit } } catch {}
  }
}
throw 'Workspace could not start. Check data\server-error.log.'
