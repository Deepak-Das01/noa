import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function roundGb(bytes) {
  if (!bytes || bytes <= 0) return 0;
  return Math.round((bytes / (1024 ** 3)) * 10) / 10;
}

const SECTOR_BYTES = 512;

function resolveVmPath(baseDir, relativePath) {
  const cleaned = String(relativePath).replace(/^"(.*)"$/, '$1').trim();
  return path.isAbsolute(cleaned) ? cleaned : path.join(baseDir, cleaned);
}

function fileSize(filePath) {
  try {
    const resolved = path.resolve(filePath.replace(/^"(.*)"$/, '$1'));
    return fs.statSync(resolved).size;
  } catch {
    return 0;
  }
}

function getVmdkCapacityBytes(vmdkPath) {
  const resolved = path.resolve(vmdkPath);
  if (!fs.existsSync(resolved)) return 0;
  let content;
  try {
    content = fs.readFileSync(resolved, 'utf8');
  } catch {
    return fileSize(resolved);
  }
  if (!content.includes('Disk DescriptorFile') && !/^RW\s+\d+/m.test(content)) {
    return fileSize(resolved);
  }
  let total = 0;
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^(?:RW|RDONLY)\s+(\d+)\s+(?:FLAT|SPARSE|ZERO|VMF|SPLITSPARSE|VSANSPARSE|SESPARSE)\s+"([^"]+)"/i);
    if (!match) continue;
    total += Number(match[1]) * SECTOR_BYTES;
  }
  return total;
}

function getDiskCapacityBytes(diskPath, vmxDir) {
  const absolute = path.isAbsolute(diskPath) ? diskPath : path.join(vmxDir, diskPath);
  const resolved = path.resolve(absolute);
  if (!fs.existsSync(resolved)) return 0;
  const ext = path.extname(resolved).toLowerCase();
  if (ext === '.vmdk') return getVmdkCapacityBytes(resolved);
  return fileSize(resolved);
}

function collectVmDiskPaths(vmxText, vmxDir) {
  const disks = new Set();
  for (const line of vmxText.split(/\r?\n/)) {
    const match = line.match(/^(?:scsi|sata|ide|nvme)\d+:\d+\.fileName\s*=\s*"?([^"\n]+)"?/i);
    if (!match) continue;
    const diskPath = match[1].trim();
    if (/\.(vmdk|vhd|vhdx)$/i.test(diskPath)) disks.add(diskPath);
  }
  return [...disks];
}

function uniqueExistingDirs(dirs) {
  const seen = new Set();
  const result = [];
  for (const dir of dirs) {
    if (!dir) continue;
    const resolved = path.resolve(dir);
    const key = resolved.toLowerCase();
    if (seen.has(key) || !fs.existsSync(resolved)) continue;
    seen.add(key);
    result.push(resolved);
  }
  return result;
}

async function run(command, args, timeoutMs = 12000) {
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
    });
    return stdout.trim();
  } catch {
    return '';
  }
}

async function runPowerShell(script, timeoutMs = 20000) {
  const output = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], timeoutMs);
  if (!output) return null;
  try {
    return JSON.parse(output);
  } catch {
    return output;
  }
}

async function readRegistryInstallPaths() {
  const script = `
$paths = @()
foreach ($key in @(
  'HKLM:\\SOFTWARE\\WOW6432Node\\VMware, Inc.\\VMware Workstation',
  'HKLM:\\SOFTWARE\\VMware, Inc.\\VMware Workstation',
  'HKLM:\\SOFTWARE\\WOW6432Node\\VMware, Inc.\\VMware Player',
  'HKLM:\\SOFTWARE\\VMware, Inc.\\VMware Player',
  'HKLM:\\SOFTWARE\\Oracle\\VirtualBox',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Oracle\\VirtualBox'
)) {
  try {
    $value = (Get-ItemProperty $key -ErrorAction Stop).InstallPath
    if (-not $value) { $value = (Get-ItemProperty $key -ErrorAction Stop).InstallDir }
    if ($value) { $paths += [string]$value }
  } catch {}
}
$paths | ConvertTo-Json -Compress
`;
  const data = await runPowerShell(script);
  return Array.isArray(data) ? data : (data ? [data] : []);
}

async function findOnPath(executable) {
  const output = await run('where.exe', [executable]);
  return output.split(/\r?\n/).map(line => line.trim()).find(line => line && fs.existsSync(line)) || '';
}

function parseVmwareVmx(vmxPath, displayName = '') {
  const text = fs.readFileSync(vmxPath, 'utf8');
  const read = key => {
    const match = text.match(new RegExp(`^${key}\\s*=\\s*"?([^"\\n]+)"?`, 'm'));
    return match ? match[1].trim() : '';
  };
  const memoryMb = Number(read('memsize')) || null;
  const cpu = Number(read('numvcpus')) || null;
  const vmxDir = path.dirname(vmxPath);
  let storageBytes = 0;
  for (const diskPath of collectVmDiskPaths(text, vmxDir)) {
    storageBytes += getDiskCapacityBytes(diskPath, vmxDir);
  }
  return {
    id: path.basename(vmxPath, '.vmx'),
    name: displayName || read('displayName') || path.basename(vmxPath, '.vmx'),
    status: 'Stopped',
    cpu,
    memoryMb,
    storageGb: roundGb(storageBytes),
    ipAddresses: [],
    uptimeSeconds: null,
    vmxPath,
  };
}

function parseVmwareInventory() {
  const inventoryPath = path.join(os.homedir(), 'AppData', 'Roaming', 'VMware', 'inventory.vmls');
  if (!fs.existsSync(inventoryPath)) return [];
  const entries = new Map();
  for (const line of fs.readFileSync(inventoryPath, 'utf8').split(/\r?\n/)) {
    const config = line.match(/^vmlist(\d+)\.config\s*=\s*"(.+)"$/);
    const display = line.match(/^vmlist(\d+)\.DisplayName\s*=\s*"(.+)"$/);
    if (config) {
      const idx = config[1];
      if (!entries.has(idx)) entries.set(idx, {});
      entries.get(idx).path = config[2];
    }
    if (display) {
      const idx = display[1];
      if (!entries.has(idx)) entries.set(idx, {});
      entries.get(idx).displayName = display[2];
    }
  }
  return [...entries.values()]
    .filter(entry => entry.path && fs.existsSync(entry.path))
    .map(entry => ({ path: entry.path, displayName: entry.displayName || path.basename(entry.path, '.vmx') }));
}

function parseVmwarePreferences() {
  const preferencesPath = path.join(os.homedir(), 'AppData', 'Roaming', 'VMware', 'preferences.ini');
  if (!fs.existsSync(preferencesPath)) return [];
  const folders = [];
  for (const line of fs.readFileSync(preferencesPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^(prefvmx\.defaultVMLocation|vmx\.defaultVMLocation)\s*=\s*"(.+)"/i);
    if (match) folders.push(match[2]);
  }
  return folders;
}

function optionalScanRoots() {
  const raw = process.env.WORKSPACE_INFRA_VM_PATHS || '';
  return raw.split(path.delimiter).map(item => item.trim()).filter(Boolean);
}

async function getVmwareUptimesFromLocks(runningVmxPaths) {
  if (!runningVmxPaths.length) return new Map();
  const pathsLiteral = runningVmxPaths
    .map(vmxPath => `'${String(vmxPath).replace(/'/g, "''")}'`)
    .join(', ');
  const script = `
$vmxPaths = @(${pathsLiteral})
$procs = @(Get-Process -Name vmware-vmx -ErrorAction SilentlyContinue)
$result = @()
foreach ($vmx in $vmxPaths) {
  $procId = $null
  $lockDir = "$vmx.lck"
  if (Test-Path -LiteralPath $lockDir) {
    foreach ($lockFile in Get-ChildItem -LiteralPath $lockDir -Filter '*.lck' -ErrorAction SilentlyContinue) {
      if ($lockFile.Name -match 'M(\\d+)\\.lck$') { $procId = [int]$Matches[1]; break }
      if (-not $procId -and $lockFile.Name -match '(\\d+)\\.lck$') { $procId = [int]$Matches[1] }
    }
  }
  $uptimeSeconds = $null
  if ($procId) {
    $proc = $procs | Where-Object { $_.Id -eq $procId } | Select-Object -First 1
    if ($proc) { $uptimeSeconds = [int][math]::Floor(((Get-Date) - $proc.StartTime).TotalSeconds) }
  }
  if ($null -eq $uptimeSeconds -and $vmxPaths.Count -eq 1 -and $procs.Count -eq 1) {
    $uptimeSeconds = [int][math]::Floor(((Get-Date) - $procs[0].StartTime).TotalSeconds)
  }
  $result += [ordered]@{
    vmxPath = [string]$vmx
    uptimeSeconds = $uptimeSeconds
  }
}
$result | ConvertTo-Json -Compress -Depth 4
`;
  const data = await runPowerShell(script);
  const rows = Array.isArray(data) ? data : (data ? [data] : []);
  const map = new Map();
  for (const row of rows) {
    const vmxPath = path.resolve(String(row.vmxPath || '')).toLowerCase();
    const uptime = row.uptimeSeconds;
    if (vmxPath && uptime != null && uptime >= 0) map.set(vmxPath, uptime);
  }
  return map;
}

async function getVmwareGuestIp(vmrun, vmxPath) {
  const output = await run(vmrun, ['-T', 'ws', 'getGuestIPAddress', vmxPath], 8000);
  const ip = String(output || '').trim();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && ip !== '0.0.0.0') return [ip];
  return [];
}

async function getVmwareRunningPaths() {
  const script = `
$paths = @()
try {
  $props = Get-ItemProperty 'HKCU:\\Software\\VMware, Inc.\\Running VM List' -ErrorAction Stop
  $paths = $props.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' } | ForEach-Object { $_.Name }
} catch {}
$paths | ConvertTo-Json -Compress
`;
  const data = await runPowerShell(script);
  const paths = Array.isArray(data) ? data : (data ? [data] : []);
  return new Set(paths.map(item => path.resolve(String(item)).toLowerCase()));
}

async function findVmwareInstallRoot(registryPaths) {
  const candidates = [
    process.env.VMWARE_HOME,
    process.env.VMWARE_ROOT,
    ...registryPaths.filter(item => /vmware/i.test(item)),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'VMware', 'VMware Workstation'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'VMware', 'VMware Workstation'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'VMware', 'VMware Player'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'VMware', 'VMware Player'),
  ].filter(Boolean);
  for (const root of candidates) {
    if (fs.existsSync(path.join(root, 'vmrun.exe'))) return root;
  }
  const vmrun = await findOnPath('vmrun.exe');
  return vmrun ? path.dirname(vmrun) : '';
}

function collectVmwareVmxFiles(inventoryEntries, installRoot) {
  const vmxFiles = new Map();
  for (const entry of inventoryEntries) {
    vmxFiles.set(path.resolve(entry.path).toLowerCase(), entry);
  }
  const searchRoots = uniqueExistingDirs([
    ...inventoryEntries.map(entry => path.dirname(entry.path)),
    ...parseVmwarePreferences(),
    ...optionalScanRoots(),
    path.join(os.homedir(), 'Documents', 'Virtual Machines'),
    path.join(os.homedir(), 'vmware'),
    installRoot,
  ]);
  for (const root of searchRoots) {
    const stack = [root];
    while (stack.length) {
      const current = stack.pop();
      let entries;
      try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules') continue;
          stack.push(full);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.vmx')) {
          const key = path.resolve(full).toLowerCase();
          if (!vmxFiles.has(key)) vmxFiles.set(key, { path: full, displayName: path.basename(full, '.vmx') });
        }
      }
    }
  }
  return [...vmxFiles.values()];
}

async function detectHyperV() {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
if (-not (Get-Command Get-VM -ErrorAction SilentlyContinue)) {
  @{ installed = $false; name = 'Hyper-V'; version = ''; vms = @() } | ConvertTo-Json -Compress
  exit
}
$hostVersion = (Get-Item 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion').GetValue('DisplayVersion')
if (-not $hostVersion) { $hostVersion = (Get-Item 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion').GetValue('ReleaseId') }
$vms = @()
foreach ($vm in Get-VM) {
  $storage = 0
  foreach ($drive in Get-VMHardDiskDrive -VM $vm) {
    if ($drive.Path) {
      $vhd = Get-VHD -Path $drive.Path -ErrorAction SilentlyContinue
      if ($vhd) { $storage += [int64]$vhd.Size }
    }
  }
  $ips = @()
  foreach ($adapter in Get-VMNetworkAdapter -VM $vm -ErrorAction SilentlyContinue) {
    foreach ($ip in $adapter.IPAddresses) {
      if ($ip -match '^\\d{1,3}(\\.\\d{1,3}){3}$') { $ips += [string]$ip }
    }
  }
  $uptimeSeconds = $null
  if ($vm.State -eq 'Running') { $uptimeSeconds = [int][math]::Floor($vm.Uptime.TotalSeconds) }
  $vms += [ordered]@{
    id = $vm.Id.Guid
    name = $vm.Name
    status = [string]$vm.State
    cpu = [int]$vm.ProcessorCount
    memoryMb = [int][math]::Round($vm.MemoryAssigned / 1MB)
    storageGb = [math]::Round($storage / 1GB, 1)
    ipAddresses = @($ips)
    uptimeSeconds = $uptimeSeconds
  }
}
@{ installed = $true; name = 'Hyper-V'; version = [string]$hostVersion; vms = $vms } | ConvertTo-Json -Compress -Depth 5
`;
  const data = await runPowerShell(script);
  if (!data || typeof data !== 'object') return { id: 'hyper-v', name: 'Hyper-V', installed: false, version: '', vms: [] };
  return { id: 'hyper-v', ...data };
}

async function getVBoxDiskCapacityBytes(vbox, diskPath) {
  const info = await run(vbox, ['showhdinfo', diskPath, '--machinereadable']);
  const capacity = info.split(/\r?\n/).find(line => line.startsWith('capacity='));
  if (capacity) {
    const bytes = Number(capacity.slice('capacity='.length));
    if (bytes > 0) return bytes;
  }
  return getDiskCapacityBytes(diskPath, path.dirname(diskPath));
}

async function getVBoxGuestIps(vbox, name) {
  const ips = new Set();
  for (let index = 0; index < 8; index += 1) {
    const output = await run(vbox, ['guestproperty', 'get', name, `/VirtualBox/GuestInfo/Net/${index}/V4/IP`]);
    const match = String(output).match(/Value:\s*(\S+)/);
    if (match && /^\d{1,3}(\.\d{1,3}){3}$/.test(match[1]) && match[1] !== '0.0.0.0') ips.add(match[1]);
  }
  return [...ips];
}

async function findVirtualBoxManage(registryPaths) {
  const candidates = [
    process.env.VBOX_INSTALL_PATH && path.join(process.env.VBOX_INSTALL_PATH, 'VBoxManage.exe'),
    process.env.VBOX_MSI_INSTALL_PATH && path.join(process.env.VBOX_MSI_INSTALL_PATH, 'VBoxManage.exe'),
    ...registryPaths.filter(item => /virtualbox/i.test(item)).map(item => path.join(item, 'VBoxManage.exe')),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Oracle', 'VirtualBox', 'VBoxManage.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Oracle', 'VirtualBox', 'VBoxManage.exe'),
  ].filter(Boolean);
  const existing = candidates.find(file => fs.existsSync(file));
  if (existing) return existing;
  return await findOnPath('VBoxManage.exe');
}

async function detectVirtualBox(registryPaths) {
  const vbox = await findVirtualBoxManage(registryPaths);
  if (!vbox) return { id: 'virtualbox', name: 'VirtualBox', installed: false, version: '', vms: [] };

  const version = await run(vbox, ['--version']);
  const list = await run(vbox, ['list', 'vms']);
  const vms = [];
  for (const line of list.split(/\r?\n/).filter(Boolean)) {
    const match = line.match(/^"(.+)"\s+\{([^}]+)\}/);
    if (!match) continue;
    const name = match[1];
    const id = match[2];
    const info = await run(vbox, ['showvminfo', name, '--machinereadable']);
    const read = key => {
      const row = info.split(/\r?\n/).find(entry => entry.startsWith(`${key}=`));
      if (!row) return '';
      return row.slice(key.length + 1).replace(/^"(.*)"$/, '$1');
    };
    const rawState = read('VMState') || 'unknown';
    const state = rawState.replace(/_/g, ' ');
    const memoryMb = Number(read('memory')) || null;
    const cpu = Number(read('cpus')) || null;
    let storageBytes = 0;
    for (const row of info.split(/\r?\n/)) {
      const diskMatch = row.match(/^"(?:SATA|IDE|SCSI|NVMe)-\d+-\d+"="([^"]+\.(?:vdi|vmdk|vhd|vhdx))"/i)
        || row.match(/="([^"]+\.(?:vdi|vmdk|vhd|vhdx))"/i);
      if (diskMatch) storageBytes += await getVBoxDiskCapacityBytes(vbox, diskMatch[1]);
    }
    let uptimeSeconds = null;
    const stateChangeTime = Number(read('VMStateChangeTime'));
    if (rawState === 'running' && stateChangeTime > 0) {
      uptimeSeconds = Math.max(0, Math.floor(Date.now() / 1000 - stateChangeTime));
    }
    const ipAddresses = rawState === 'running' ? await getVBoxGuestIps(vbox, name) : [];
    vms.push({
      id,
      name,
      status: state.charAt(0).toUpperCase() + state.slice(1),
      cpu,
      memoryMb,
      storageGb: roundGb(storageBytes),
      ipAddresses,
      uptimeSeconds,
    });
  }
  return { id: 'virtualbox', name: 'VirtualBox', installed: true, version, vms };
}

async function detectVMware(registryPaths) {
  const installRoot = await findVmwareInstallRoot(registryPaths);
  const vmrun = installRoot ? path.join(installRoot, 'vmrun.exe') : '';
  const versionFile = installRoot && path.join(installRoot, 'product-version');
  let version = versionFile && fs.existsSync(versionFile) ? fs.readFileSync(versionFile, 'utf8').trim() : '';
  const hasInventory = fs.existsSync(path.join(os.homedir(), 'AppData', 'Roaming', 'VMware', 'inventory.vmls'));
  if (!vmrun && !hasInventory) return { id: 'vmware', name: 'VMware Workstation', installed: false, version: '', vms: [] };

  const running = await getVmwareRunningPaths();
  if (vmrun) {
    const runningList = await run(vmrun, ['list']);
    for (const line of runningList.split(/\r?\n/).slice(1)) {
      const vmx = line.trim();
      if (vmx) running.add(path.resolve(vmx).toLowerCase());
    }
  }

  const inventoryEntries = parseVmwareInventory();
  const vmEntries = collectVmwareVmxFiles(inventoryEntries, installRoot);
  const runningVmxPaths = vmEntries
    .map(entry => entry.path)
    .filter(vmxPath => running.has(path.resolve(vmxPath).toLowerCase()));
  const uptimeByVmx = await getVmwareUptimesFromLocks(runningVmxPaths);
  const vms = [];
  for (const entry of vmEntries) {
    const vm = parseVmwareVmx(entry.path, entry.displayName);
    const vmxKey = path.resolve(entry.path).toLowerCase();
    if (running.has(vmxKey)) {
      vm.status = 'Running';
      vm.uptimeSeconds = uptimeByVmx.get(vmxKey) ?? null;
      if (vmrun) vm.ipAddresses = await getVmwareGuestIp(vmrun, entry.path);
    }
    delete vm.vmxPath;
    vms.push(vm);
  }
  vms.sort((a, b) => a.name.localeCompare(b.name));

  return { id: 'vmware', name: 'VMware Workstation', installed: true, version, vms };
}

let cache = { at: 0, data: null };
const CACHE_MS = 5000;

export async function getInfrastructure({ refresh = false } = {}) {
  if (process.platform !== 'win32') {
    return {
      platform: process.platform,
      scannedAt: new Date().toISOString(),
      hypervisors: [],
      message: 'Infrastructure scanning is supported on Windows only.',
    };
  }
  if (!refresh && cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;

  const registryPaths = await readRegistryInstallPaths();
  const hypervisors = await Promise.all([
    detectHyperV(),
    detectVirtualBox(registryPaths),
    detectVMware(registryPaths),
  ]);
  const installed = hypervisors.filter(item => item.installed);
  const data = {
    platform: 'win32',
    scannedAt: new Date().toISOString(),
    hypervisors: installed.length ? installed : hypervisors,
    totalVms: hypervisors.reduce((sum, item) => sum + item.vms.length, 0),
  };
  cache = { at: Date.now(), data };
  return data;
}
