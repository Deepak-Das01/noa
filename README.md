# Noa

**Product:** Noa (Terminal Workspace)  
**Current version:** 0.2.3  
**Release date:** 2026-09-11  
**Default URL:** [http://127.0.0.1:8765](http://127.0.0.1:8765)  
**Canonical dev folder:** `C:\Projects\noa`  
**Public repository:** [github.com/Deepak-Das01/noa](https://github.com/Deepak-Das01/noa)  
**Status:** Windows x64 portable app with bundled dependencies; validated on the development PC, not across all Windows devices.

Noa is a **local Windows workspace** that runs in your browser on a single machine. It combines a multi-tab terminal, autosaving notes, VM infrastructure monitoring, and settings — without cloud accounts, subscriptions, or hardcoded paths tied to one laptop.

## What Noa includes

| Area | What you get |
| --- | --- |
| **Terminal** | Up to 5 tabs (local PowerShell/Git Bash or remote SSH), split view, copy/clear, font controls, reconnect after refresh |
| **Notes** | Multi-file `.txt`/`.md` editor with autosave, rename, delete, find, wrap, and configurable save folder |
| **Infrastructure** | Detects Hyper-V, VirtualBox, and VMware on this PC; VM cards with CPU, RAM, storage, IP, uptime; run saved scripts with output popup |
| **Settings** | 50/50 layout: preferences + live system monitor (CPU/RAM/GPU) on the left, full README guide on the right |
| **Themes** | Dark, Light, Glass (acrylic), and customizable Gradient |
| **Branding** | “Welcome to Noa” tagline, Cortana-style ring logo with slow glow animation |
| **Portability** | Works on any laptop: title uses `{username}'s Workspace`, VM paths detected at runtime, personal data stays in `data\` per PC |
| **Distribution** | Portable ZIP with `node_modules`, git clone workflow, multi-laptop setup documented below |

The header title is **never hardcoded** — on each machine it becomes `{Windows username}'s Workspace` (for example `Alex's Workspace` on another laptop). Set `WORKSPACE_TITLE` only if you want a custom full title. After restart or page load, Noa keeps **one default local terminal** and opens the **Terminal** view.

## Features

### Terminal

- Up to five interactive terminals per workspace, each backed by node-pty and rendered with xterm.js.
- A **+** button opens additional local terminals. Each tab can be closed individually while keeping at least one open.
- A **Remote** button opens an SSH connection dialog with server name, address, username, and password fields. Successful logins are remembered in browser storage for quick reconnect.
- A split-view icon button (after **Remote**) shows two terminals side by side. Click a pane to focus it; tab clicks assign terminals to the focused pane. Click the icon again to return to a single view.
- Local shells start in your Windows user home folder, like a normal PowerShell window. Git Bash is used when available from standard installations or Git on PATH; otherwise PowerShell 7 or Windows PowerShell is used.
- Supports command input, terminal colors, Ctrl+C, scrolling, and font-size controls.
- Copy copies selected terminal text; Clear clears the terminal display.
- A connection badge reports the active tab’s connection state. The browser reconnects to existing server sessions after reload.
- Responsive fitting keeps terminal rows within the available content area, including after resizing, font changes, and returning from Notes.
- After typing `exit`, **Restart shell** starts a new shell in the active tab (shows a brief reload animation).
- On load or app restart, extra terminal sessions are closed so **one default terminal** remains.

### Notes

- Multiple note files (`.txt` and `.md`) in your notes folder.
- **+** creates a new `.txt` file; the dropdown selects which file to edit; **Delete** removes the current file after confirmation; double-click the file name to rename.
- The status bar shows the full path to the open file on this PC.
- Autosaves approximately 400 ms after typing stops, on tab switch, refresh, restart, and browser close. Ctrl+S also saves.
- Find / Find next, word wrap, line-number toggle, and text-size controls.
- Status bar shows line, column, UTF-8, word count, and save state.
- The notes endpoint accepts up to 1 MB per save request.

### Settings

- Split layout: **50/50** panels — settings and system monitor on the left, full **README.md** product guide on the right.
- **System monitor** shows live CPU, memory, and GPU usage (Windows performance counters / `nvidia-smi` when available). Updates every few seconds while Settings is open.
- **Infrastructure scripts** — create, edit, and save PowerShell or Batch scripts stored in `data\scripts.json` on this PC (not in git).
- Appearance settings offer four themes: **Dark**, **Light**, **Glass** (Windows acrylic-style translucent surfaces), and **Gradient** (custom start/end/accent colors plus angle). Theme and gradient choices are stored in browser local storage and affect the workspace and terminal. Refresh the browser to see theme changes; no server restart is required.
- Save-folder field accepts an absolute folder path and creates the folder if needed and permitted.
- Changing the save folder copies the current notes; the original remains in place.
- An existing `notes.md` in the new folder is never overwritten: choose another folder.
- Restart app saves pending notes, shows a reload animation, ends extra terminals, and returns to a single default terminal on the same port. Running commands end during restart.

### Infrastructure

- **Infrastructure** navigation shows hypervisors detected on this Windows PC.
- **Run** executes a saved script selected from the dropdown below **Refresh**. The button glows while running, turns **green** on success or **red** on failure; click it to open a popup with the full output. **Save** writes the output to your notes folder as `scriptname-output-YYYY-MM-DD HH-MM-SS.txt`.
- Create and manage scripts in **Settings → Infrastructure scripts** (PowerShell or Batch).
- Supported scanners: **Hyper-V**, **VirtualBox**, and **VMware Workstation/Player**.
- VMware VMs are discovered from the Workstation inventory (`inventory.vmls`), VMware preferences, registry install paths, and each VM's own folder on the current PC. No VM paths are hardcoded in the app.
- Each detected hypervisor lists its virtual machines as cards with status, CPU, RAM, storage, IP address, and uptime.
- IP and uptime appear when a VM is **running**. VMware IPs are resolved from each VM’s MAC address in VMware DHCP lease files on that PC, then guestinfo/neighbor data, with guest-tools (`vmrun`) only as a last resort.
- VMware disk size reads split/sparse VMDK descriptors (not just the small descriptor file).
- Click **Refresh** to rescan. Results are cached briefly to keep the UI responsive.

### Interface

Compact Windows Fluent-inspired styling with a slim header, segmented navigation, translucent surfaces, restrained mint accents, lightweight controls, keyboard focus states, and reduced-motion support. Four appearance themes are available: dark, light, glass (acrylic), and customizable gradient. Terminal, Notes, Infrastructure, and Settings share the same application window.

- Header tagline: **Welcome to Noa**
- Noa logo: Cortana-style circular rings with a very slow, smooth glow animation (disabled when reduced motion is preferred)
- Workspace title: `{Windows username}'s Workspace` on each PC (not hardcoded); optional `WORKSPACE_TITLE` env override

## Requirements and compatibility

- A modern Windows installation with ConPTY support. Windows 11 is the primary target.
- Node.js 22 or 24 LTS (64-bit recommended for the bundled release).
- A modern browser and a writable application folder.
- Git for Windows is optional. Without it, PowerShell is used; this does not provide all Linux commands. Git Bash is also not a full Linux distribution.

This release is a portable **source application**, not a standalone executable. The distribution ZIP bundles `node_modules` for **Windows x64**, so internet access is not required on the destination PC for the first launch. Other Windows versions and ARM64 devices have not been physically validated. If native modules fail on the destination architecture, run `Setup Workspace.cmd` to rebuild them locally; Microsoft's C++ build tools may be required in that case.

## Distribution package (0.2.3)

| Item | Detail |
| --- | --- |
| **File name** | `TerminalWorkspace-0.2.3-Windows.zip` (build with `package-release.ps1`) |
| **Approx. size** | ~17 MB (includes `node_modules`) |
| **Target** | Windows 10/11 x64 |
| **Node.js** | 22 or 24 LTS required on the destination PC (not bundled) |
| **Default port** | 8765 |

### ZIP folder layout

After extraction you get one folder:

```text
TerminalWorkspace-0.2.3/
  INSTALL.txt                Quick install steps (same as below)
  package.json               Version 0.2.3 and dependency list
  package-lock.json          Locked dependency versions
  server.mjs                 HTTP API and terminal sessions
  infrastructure.mjs         Hypervisor and VM detection (Windows)
  scripts.mjs                Infrastructure script storage and execution
  system.mjs                 CPU, memory, and GPU stats (Windows)
  public/                    Frontend (HTML, CSS, JavaScript)
  node_modules/              Pre-installed dependencies (Windows x64)
  data/                      Empty on first install (.gitkeep only)
  Setup Workspace.cmd        Reinstall dependencies if needed
  Start Workspace.cmd        Launch the app
  Start Workspace.ps1        Launcher script used by Start Workspace.cmd
  Restart Workspace.cmd      Restart after a prior launch
  Restart Workspace.ps1      Restart script
  README.md                  Full documentation
  AGENTS.md                  Contributor rules
  test.mjs                   Integration smoke test
  package-release.ps1        Rebuild script (source copies only; not required to run the app)
```

### What the ZIP includes

- Application source (`public/`, `server.mjs`, launchers).
- All npm dependencies in `node_modules` (xterm.js, node-pty, ws, ssh2, and their dependencies).
- Documentation (`README.md`, `INSTALL.txt`, `AGENTS.md`).

### What the ZIP excludes (no host-specific data)

The release is built with `package-release.ps1` and deliberately omits data from the computer that created the ZIP:

| Excluded | Why |
| --- | --- |
| `data\runtime.json` | Server URL and PID from the source machine |
| `data\server.log`, `data\server-error.log` | Local log files |
| `data\notes.md` | Your notes |
| `data\settings.json` | Saved notes-folder path (absolute path from source PC) |
| Browser local storage | Not in the ZIP; themes, SSH passwords, and UI prefs are per-browser on each PC |

On first launch on a new PC, the app creates fresh `data\` files and uses the new Windows account name in the title.

## First-time installation

Use **`TerminalWorkspace-0.2.3-Windows.zip`** (or build the latest with `package-release.ps1`).

1. Copy the ZIP to the other computer (USB drive, network share, email attachment, etc.).
2. Extract the entire ZIP into a writable folder, for example:
   `C:\Users\YourName\Documents\Noa`
   Do **not** run directly from inside the ZIP. Do **not** install into `Program Files`.
3. Install [Node.js 22 or 24 LTS](https://nodejs.org/) (64-bit) if it is not already installed. Reopen PowerShell or Command Prompt afterward so `node` is on PATH.
4. Open the extracted folder and double-click **`Start Workspace.cmd`**. Your browser should open at **`http://127.0.0.1:8765`**.
5. If Start reports missing or incompatible dependencies, run **`Setup Workspace.cmd`** once, then start again.

See **`INSTALL.txt`** inside the extracted folder for the same steps.

From PowerShell:

```powershell
cd "C:\Users\YourName\Documents\Noa"
& ".\Start Workspace.cmd"
```

The quoted filenames and `&` are required because launcher filenames contain spaces.

### Setup vs Start

| Script | When to use |
| --- | --- |
| **Start Workspace.cmd** | Every normal launch. Dependencies are already in the ZIP. |
| **Setup Workspace.cmd** | Only if Start fails with a missing or incompatible native module, or after changing `package.json` dependencies. Runs `npm install` on that PC. |

You do **not** need to run Setup on a typical Windows x64 PC when using the 0.2.3 ZIP as shipped.

## Start, restart, and stop

- **Start:** double-click `Start Workspace.cmd`, or run the command above. The launcher attempts to reopen an already-running instance.
- **Restart:** use Settings → Restart app. Alternatively:

```powershell
& ".\Restart Workspace.cmd"
```

The restart launcher expects an existing `data\runtime.json` from a previous launch. For the first launch, use Start Workspace.

- **Foreground mode:** run `node server.mjs` from the app directory and press Ctrl+C to stop it.
- **Background mode:** closing the browser does not stop the server. Its PID is recorded in `data\runtime.json`; identify the corresponding Node process before stopping it in Task Manager. Do not stop unrelated Node processes.

A browser refresh preserves the shell while the server remains running. Restarting or stopping the server ends the shell and clears its in-memory history. Notes remain on disk.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| Ctrl+Shift+N | Toggle Notes / Terminal |
| Ctrl+S while Notes is open | Save notes |
| Ctrl+C in Terminal | Interrupt the current command |
| Ctrl+L in a supporting shell | Clear/redraw the shell screen |
| Enter in the notes Find field | Find the next match |

## Storage and privacy

| Location | Purpose |
| --- | --- |
| `data\notes.md` | Default notes document |
| `data\settings.json` | Saved notes-directory preference |
| `data\runtime.json` | Current server URL and PID |
| `data\server.log` | Launcher-managed server output |
| `data\server-error.log` | Launcher-managed startup errors |
| Browser local storage | Theme, Notes-open preference, and remembered remote SSH connections (name, server, username, and password) |

Browser preferences belong to that browser and origin; a different browser or a different port may use separate preferences. Notes and folder settings are stored on disk, independently of browser storage.

The server listens on `127.0.0.1`, not the LAN. API requests use a per-launch token, and WebSocket connections check the origin. Terminal commands run with the permissions of the account running the server; this is not an isolated execution sandbox. Do not expose the app through a public proxy. No cloud sync is implemented.

Saved remote SSH passwords are stored unencrypted in browser local storage on this computer only. Anyone with access to this browser profile can read them. Use key-based SSH when possible on shared machines.

## Optional configuration

| Variable or path | Behavior |
| --- | --- |
| `PORT` | Listen port (default **8765**). Set to `0` for a random free port |
| `WORKSPACE_SHELL` | Full path to a supported Bash/sh or PowerShell executable |
| `WORKSPACE_CWD` | Override the starting folder for local shells (default: your user home folder) |
| `WORKSPACE_DATA_DIR` | Override the server's data directory |
| `WORKSPACE_TITLE` | Optional full header/title override (default: `{username}'s Workspace` on that PC) |
| `GET /api/system` | Live CPU, memory, and GPU stats (Settings system monitor; Windows) |
| `GET /api/readme` | README markdown for the Settings product guide panel |
| `WORKSPACE_INFRA_VM_PATHS` | Optional extra VM search folders on this PC, separated by `;` |
| `runtime\node.exe` | Optional runtime detected by Start Workspace; otherwise use Node on PATH |

Example for foreground use:

```powershell
$env:PORT = "8080"
node .\server.mjs
```

An occupied explicitly selected port causes startup to fail; choose another port or remove the override. The Windows launchers currently use the app's `data` folder for discovery and logs, so use the default data location with them. Use foreground mode when overriding WORKSPACE_DATA_DIR.

## Development and GitHub (main copy)

| Item | Value |
| --- | --- |
| **Canonical dev folder** | `C:\Projects\noa` |
| **Public repository** | [github.com/Deepak-Das01/noa](https://github.com/Deepak-Das01/noa) |
| **Default branch** | `main` |

After changes on the dev PC, commit and push so other laptops stay in sync:

```powershell
cd C:\Projects\noa
git add -A
git status
git commit -m "Your message"
git push origin main
```

**Never push personal data:** `data\` (notes, settings, logs, runtime), `.env`, keys, or ZIPs. Only source code and docs belong in git. See `AGENTS.md`.

## Using Noa on multiple laptops

Noa is designed so **each laptop keeps its own data** while sharing the same app code from GitHub.

| What travels via git | What stays on each PC only |
| --- | --- |
| Source code, README, launchers | `data\notes.md`, `data\settings.json` |
| | `data\runtime.json`, logs |
| | Browser themes, SSH saved passwords (local storage) |
| | Workspace title (`{username}'s Workspace`) |
| | VM/hypervisor inventory (detected at runtime) |

### Set up on a new laptop

```powershell
git clone https://github.com/Deepak-Das01/noa.git C:\Projects\noa
cd C:\Projects\noa
npm install
```

Or pull updates on an existing clone:

```powershell
cd C:\Projects\noa
git pull origin main
npm install
```

Then run **`Start Workspace.cmd`**. Do **not** copy another PC’s `data\` folder unless you intentionally want to migrate notes.

### Transfer without git (ZIP)

1. Build or copy **`TerminalWorkspace-0.2.3-Windows.zip`** (or rebuild with `package-release.ps1`).
2. On the destination: extract, install Node.js 22+, run **`Start Workspace.cmd`**.
3. If native modules fail (unusual on matching Windows x64), run **`Setup Workspace.cmd`** on that PC only.

The ZIP does not carry your personal data. Each new machine starts with a clean `data\` folder and its own workspace title (from that PC's Windows username).

### Transfer your notes (optional)

Back up `notes.md` from the folder shown in Settings → Notes location (default: `data\notes.md`). To move notes to the new PC:

1. Extract and start the app on the new PC once (or copy `notes.md` into `data\` before first launch).
2. Paste your `notes.md` into the desired folder, **or** use Settings to pick a folder that already contains your file.

Do **not** copy `settings.json` from the old PC: it stores an absolute path that may not exist on the new computer. Set the notes folder again in Settings on the destination.

### Transfer themes and SSH saved servers (optional)

Theme and gradient choices and saved remote SSH entries live in **browser local storage**, not in the ZIP. They stay in the browser on the original PC. On a new PC you will configure themes and remote connections again in Settings and the Remote dialog.

### Rebuild the distribution ZIP

From a source copy of the project (with `node_modules` installed), run:

```powershell
cd "C:\path\to\TerminalWorkspace"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\package-release.ps1"
```

This creates **`TerminalWorkspace-<version>-Windows.zip`** in the project folder (for example `TerminalWorkspace-0.2.3-Windows.zip`). The script:

- Reads the version from `package.json`.
- Copies the project including `node_modules`.
- Strips host-specific files from `data\` (`runtime.json`, logs, `notes.md`, `settings.json`).
- Adds `INSTALL.txt` and an empty `data\.gitkeep`.
- Excludes other `*.zip` files and `.git`.

After rebuilding, update this README if the version or packaging behavior changes.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| PowerShell says `'.\Restart' is not recognized` | Use `& ".\Restart Workspace.cmd"` with quotes |
| Node.js not found | Install Node.js, reopen PowerShell, and check `node --version` |
| Dependencies missing | Run Setup Workspace.cmd |
| Native module fails to load | Reinstall dependencies on the destination architecture; inspect npm's error output |
| App fails to start | Read `data\server-error.log`; check the chosen port and folder permissions |
| A Linux command is missing | Check the selected shell. PowerShell and Git Bash have different command sets |
| Remote SSH fails to connect | Install the Windows OpenSSH client, verify the server address and username, and complete any host-key or password prompts in the terminal |
| Cannot open more terminals | Close an existing tab first. The workspace supports up to five terminals |
| Notes folder is rejected | Use an absolute, writable folder; choose one without an existing notes.md |
| Settings API reports Not found after an update | Restart the server to load the updated backend |
| Restart reconnect times out | Run Start Workspace.cmd, then refresh the browser |
| Infrastructure shows no hypervisor | Install Hyper-V, VirtualBox, or VMware on this PC; run the app as a user who can manage VMs; click Refresh |
| Infrastructure VM list is incomplete | VMware reads `inventory.vmls` on that PC; set `WORKSPACE_INFRA_VM_PATHS` for extra folders. VirtualBox/Hyper-V use their CLI tools. Some scans may need administrator rights |
| Windows denies stopping a process | Run the launcher as the account that started the app; do not terminate unrelated processes |

## Project structure

```text
noa/  (or TerminalWorkspace-<version>/ in the ZIP)
  public/index.html          Application markup
  public/style.css           Themes, layout, responsive styles
  public/app.js              UI, notes, settings, terminal client
  server.mjs                 HTTP APIs and terminal sessions
  infrastructure.mjs         Hypervisor and VM detection (Windows)
  system.mjs                 CPU, memory, GPU monitor (Windows)
  package.json               Version, scripts, dependencies
  package-lock.json          npm lockfile
  pnpm-lock.yaml             pnpm dependency lock (development)
  pnpm-workspace.yaml        Native dependency build allowance
  Setup Workspace.cmd        npm install (fallback if bundled deps fail)
  Start Workspace.cmd/.ps1   Windows launcher
  Restart Workspace.cmd/.ps1 Windows restart launcher
  package-release.ps1        Build TerminalWorkspace-<version>-Windows.zip
  INSTALL.txt                Quick install (added to distribution ZIP only)
  test.mjs                   Integration smoke test
  AGENTS.md                  Contributor change-documentation rules
  README.md                  Usage, release history, known limits
  data/                      Local user data; excluded from release ZIP
  TerminalWorkspace-0.2.3-Windows.zip   Portable distribution (when built)
```

## Development and validation

Frontend: plain HTML, CSS, and JavaScript. Backend: Node.js HTTP server and ws. Terminal: xterm.js, FitAddon, and node-pty. No frontend framework or build step is required.

```powershell
node --check .\server.mjs
node --check .\public\app.js
npm test
```

The integration smoke test covers HTTP assets, notes persistence, access checks, and command output. It has previously shown shell startup/resize timing failures; a passing result is not proof of compatibility with every Windows device. Separate local checks verified PowerShell command execution, dynamic title rendering, folder copying/overwrite protection, and authenticated restart on the same port. Browser checks covered themes, tabs, controls, scrolling, and terminal fitting on desktop and narrow viewports.

## Versioning and change-documentation policy

The current application baseline is **0.2.3**. `package.json` is the version source; keep this README synchronized with it. Do not bump the version merely for every edit. When preparing a new release, select the appropriate version and date, and move the accumulated Unreleased entries into that release section.

**Every future change must be recorded in this README in the same update**, including UI changes, features, fixes, behavior changes, dependency changes, and documentation corrections. Add concise entries under Unreleased, describing what changed, relevant validation, and any migration or restart requirement. Update affected usage instructions and known limitations as well. Keep previous release entries intact. Refresh the distribution ZIP whenever a release package is delivered.

## Changelog

### Unreleased

_No unreleased changes._

### 0.2.3 — 2026-09-11

**Noa** — build **`TerminalWorkspace-0.2.3-Windows.zip`** with `package-release.ps1`. Restart the app after server changes (`/api/notes/files`, `/api/scripts`); refresh the browser for UI updates.

**Notes**

- Multiple **.txt** and **.md** files: **+** creates files, dark custom file picker, **Delete** with confirmation, double-click rename, full path in status bar
- Auto-save on edit, tab switch, refresh, restart, and browser close (manual Save/Export removed)

**Infrastructure**

- **Scripts** in Settings (PowerShell or Batch); run from Infrastructure with dropdown; **Run** glows green/red; output in popup; **Save** writes to notes folder
- VMware **IP** from ISC DHCP lease files matched to each VM MAC (no hardcoded subnets; `vmrun` last resort)
- VMware **uptime** via `vmware-vmx` process matching when lock-file PIDs are stale

**Validation:** `npm test` smoke checks; no personal `data\` files in git or release ZIP.

### 0.2.2 — 2026-09-10

**Noa** — full feature release. Build **`TerminalWorkspace-0.2.2-Windows.zip`** with `package-release.ps1`. Portable Windows x64 package with bundled `node_modules`, full README, `INSTALL.txt`, and no host-specific data. Default URL: **`http://127.0.0.1:8765`**.

**Project and portability**

- Canonical development folder: **`C:\Projects\noa`**
- Public git repository: **[github.com/Deepak-Das01/noa](https://github.com/Deepak-Das01/noa)** (`main` branch only)
- Multi-laptop design: each PC keeps its own `data\`, browser storage, and detected VMs; code syncs via git
- Stricter **`.gitignore`** so notes, settings, logs, and runtime never enter the public repo (see `AGENTS.md`)

**Branding and header**

- Product name **Noa** with tagline **Welcome to Noa**
- Cortana-style circular ring logo with very slow, smooth glow animation (respects reduced motion)
- Workspace title from the **current PC's Windows username** at startup — not hardcoded (`WORKSPACE_TITLE` optional override)

**Terminal and restart**

- Default listen port **8765** (`PORT` env to override; `0` = random port)
- **Restart app** and **Restart shell** show a full-screen reload animation until the workspace is ready
- After restart or page load: **one default terminal** kept, split view reset, Terminal view active

**Settings**

- **50/50 split layout**: preferences + system monitor on the left, live **README.md** product guide on the right (`GET /api/readme`)
- Elevated setting cards with icons, hover states, and matching product-guide panel
- **System monitor** (`GET /api/system`): live CPU, memory, and GPU usage; polls every ~2.5 s while Settings is open

**Infrastructure**

- VM cards: status, CPU, RAM, storage, **IP address**, and **uptime** (when VM is running)
- VMware storage reads split/sparse **VMDK** descriptors (fixes 0 GB display)
- Two-row VM card layout (resources + network) to prevent IP/uptime overlap
- VMware uptime via running `vmware-vmx` process start time matched to each VM lock file (with lock-file fallback)
- Portable detection: Hyper-V, VirtualBox, VMware inventory/registry on each PC (`WORKSPACE_INFRA_VM_PATHS` optional)

**Fixes**

- `Start Workspace.ps1` Node version check fixed for PowerShell on Node 22+

**Validation:** Restart the app after server changes. Refresh the browser for UI/CSS. Run `npm test` for smoke checks.

### 0.2.1 — 2026-09-10

Latest portable Windows x64 release **`TerminalWorkspace-0.2.1-Windows.zip`** with bundled `node_modules`, full README documentation, and no host-specific data. Includes Infrastructure view, Glass/Gradient themes, multi-terminal tabs, SSH remote connections, and split-view terminals.

- Added **Infrastructure** navigation: detects Hyper-V, VirtualBox, and VMware on the current PC and shows VM cards (status, CPU, RAM, storage).
- Made Infrastructure detection portable via each hypervisor's inventory/registry on that PC; optional `WORKSPACE_INFRA_VM_PATHS` for extra VM folders.
- Infrastructure panel uses full window width for hypervisor and VM cards.
- Updated distribution docs, `INSTALL.txt`, and `package-release.ps1` output for version 0.2.1.

Restart the app after installing this ZIP to load server changes. Refresh the browser for UI updates.

### 0.2.0 — 2026-09-10

Portable Windows x64 release **`TerminalWorkspace-0.2.0-Windows.zip`** (~17 MB) with bundled `node_modules`. Excludes host notes, settings, logs, and session data. Added `package-release.ps1`, `INSTALL.txt`, and README distribution/install documentation for easy setup on another PC. Destination PCs need Node.js 22+ only; Setup is optional unless native modules fail.

- Fixed overlapping +/Remote/Split buttons in the tab bar by grouping actions separately and correcting Remote button width.
- Reworked the terminal tab bar into a compact segmented control for Glass and Gradient themes.
- Fixed the terminal not filling its panel; unified toolbar/tab button styling.
- Added **Glass** and **Gradient** appearance themes with customizable gradient colors and angle.
- Fixed Windows console window flash when closing a local terminal tab.
- Local terminals now start in the Windows user home folder.
- Added split-view for two terminals side by side.
- Switched remote SSH to the `ssh2` library with saved-server support and direct password auth.
- Added multi-terminal tabs (up to five) with local and remote connections.
- Refined the workspace UI with sleeker Fluent-inspired styling.

### 0.1.0 — 2026-09-09

Initial documented baseline containing the work completed before version tracking was introduced:

- Added a local single-port application with an interactive terminal and autosaving notes.
- Added Terminal, Notes, and Settings navigation; note search, export, wrap, line numbers, font controls, and a compact status bar.
- Refined the UI with Fluent-inspired dark/light themes and a compact developer workspace layout.
- Fixed the terminal's measured area by separating outer padding from the xterm host; refit after layout and font changes.
- Added configurable notes storage with safe copying and existing-file protection.
- Added an authenticated app restart action, reconnection, and Windows start/restart launchers.
- Removed developer-specific paths and identity; detect the Windows account name, available runtime, and supported shell.
- Added setup instructions and a clean Windows transfer package without private data or installed dependencies.
- Set the package version to 0.1.0 and established mandatory README change tracking for subsequent work.

Activation: documentation/version metadata changes do not require a restart. Updating server code in future releases does require restarting the app. Compatibility is currently locally validated, with the limits described above.

