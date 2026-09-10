import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function round(value, digits = 1) {
  if (value == null || Number.isNaN(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function memoryFromOs() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  return {
    totalGb: round(total / (1024 ** 3), 1),
    usedGb: round(used / (1024 ** 3), 1),
    usagePercent: total > 0 ? round((used / total) * 100, 1) : null,
  };
}

async function runPowerShell(script, timeoutMs = 10000) {
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
      encoding: 'utf8',
    });
    const output = stdout.trim();
    if (!output) return null;
    return JSON.parse(output);
  } catch {
    return null;
  }
}

async function getWindowsStats() {
  const script = `
$cpu = [math]::Round((Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average, 1)
$cores = (Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum
$os = Get-CimInstance Win32_OperatingSystem
$totalMem = [int64]$os.TotalVisibleMemorySize * 1024
$freeMem = [int64]$os.FreePhysicalMemory * 1024
$usedMem = $totalMem - $freeMem
$gpuName = $null
$gpuUsage = $null
$gpuMemUsed = $null
$gpuMemTotal = $null
$gpu = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | Where-Object { $_.Name -and $_.Name -notmatch 'Microsoft Basic|Remote' } | Select-Object -First 1
if ($gpu) { $gpuName = [string]$gpu.Name }
try {
  $samples = (Get-Counter '\\GPU Engine(*engtype_3D)\\Utilization Percentage' -ErrorAction Stop).CounterSamples |
    ForEach-Object { [double]$_.CookedValue } |
    Where-Object { $_ -ge 0 }
  if ($samples) { $gpuUsage = [math]::Round(($samples | Measure-Object -Maximum).Maximum, 1) }
} catch {}
$nvidia = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
if ($nvidia) {
  try {
    $line = & $nvidia.Source --query-gpu=utilization.gpu,memory.used,memory.total,name --format=csv,noheader,nounits 2>$null | Select-Object -First 1
    if ($line) {
      $parts = $line.Split(',') | ForEach-Object { $_.Trim() }
      if ($parts.Count -ge 4) {
        $gpuUsage = [double]$parts[0]
        $gpuMemUsed = [double]$parts[1]
        $gpuMemTotal = [double]$parts[2]
        $gpuName = [string]$parts[3]
      }
    }
  } catch {}
}
[ordered]@{
  cpu = [ordered]@{ usagePercent = $cpu; cores = [int]$cores }
  memory = [ordered]@{
    totalGb = [math]::Round($totalMem / 1GB, 1)
    usedGb = [math]::Round($usedMem / 1GB, 1)
    usagePercent = if ($totalMem -gt 0) { [math]::Round(($usedMem / $totalMem) * 100, 1) } else { $null }
  }
  gpu = if ($gpuName) {
    [ordered]@{
      name = $gpuName
      usagePercent = $gpuUsage
      memoryUsedMb = $gpuMemUsed
      memoryTotalMb = $gpuMemTotal
    }
  } else { $null }
} | ConvertTo-Json -Compress -Depth 5
`;
  const data = await runPowerShell(script);
  if (!data || typeof data !== 'object') return null;
  return data;
}

let cache = { at: 0, data: null };
const CACHE_MS = 1200;

export async function getSystemStats({ refresh = false } = {}) {
  if (!refresh && cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;

  let payload;
  if (process.platform === 'win32') {
    payload = await getWindowsStats();
  }

  const memory = payload?.memory || memoryFromOs();
  const data = {
    platform: process.platform,
    scannedAt: new Date().toISOString(),
    cpu: payload?.cpu || {
      usagePercent: null,
      cores: os.cpus()?.length || null,
    },
    memory,
    gpu: payload?.gpu || null,
  };

  cache = { at: Date.now(), data };
  return data;
}
