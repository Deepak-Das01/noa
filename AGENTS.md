# Project instructions — Noa

## Canonical location

- **Main project directory:** `C:\Projects\noa` only. Never edit, package, or commit from older Codex/output paths or another laptop’s copy unless syncing back here first.
- **Public repository:** `https://github.com/Deepak-Das01/noa.git` (`origin` on `main`).
- After meaningful changes on this machine: **commit and push to GitHub** so other laptops can `git pull`. Do not leave long-lived work only on one PC.

## Multi-laptop / portable app rules

- The app must work on **any Windows laptop** without paths, usernames, or VM folders hardcoded in source code.
- Per-machine data lives only under `data\` on that PC (notes, settings, logs, runtime). **Never commit `data\` contents** except `data/.gitkeep`.
- Workspace title comes from the signed-in Windows user at runtime (`USERNAME` / profile / hostname). Optional override: `WORKSPACE_TITLE`.
- Infrastructure, shells, VMware/Hyper-V/VirtualBox paths, and notes folder are detected or configured **on that PC** — not baked into the repo.
- Browser-only data (themes, SSH passwords, view state) stays in **browser local storage** on each machine; it is not in git.
- Distribution ZIPs (`package-release.ps1`) must exclude `data\` host files, `node_modules` source tree is bundled in ZIP but not committed to git.

## Never commit (personal / machine-specific)

- `data/runtime.json`, `data/settings.json`, `data/notes.md`, `data/server.log`, `data/server-error.log`
- `node_modules/`, `*.zip`, `.env`, credentials, API keys, SSH keys
- Absolute paths like `C:\Users\…` in docs/examples — use generic placeholders (`Documents\Noa`, `{username}`)

Before every commit: `git status` must not stage files under `data/` (except `.gitkeep`) or secrets.

## Documentation and releases

- Every application change MUST update **README.md** in the same task (Unreleased changelog, usage, limitations, restart/migration notes).
- Documented baseline: **0.2.3** (keep `package.json` and README in sync; bump only when preparing a release).
- Before delivering a distribution ZIP: run `package-release.ps1`; include README.md and this AGENTS.md; exclude personal data and logs.

## Git workflow (this machine)

```powershell
cd C:\Projects\noa
git status
git add -A
git commit -m "Describe the change"
git push origin main
```

On another laptop: clone/pull, `npm install` or `Setup Workspace.cmd`, then `Start Workspace.cmd`. Do not copy `data\` from one PC to another unless the user explicitly wants to migrate notes.
