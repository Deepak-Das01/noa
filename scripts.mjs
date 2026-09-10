import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const MAX_SCRIPT_BYTES = 256 * 1024;
const RUN_TIMEOUT_MS = 5 * 60 * 1000;

function findPowerShell() {
  const candidates = [
    process.env.WORKSPACE_SHELL,
    path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ...(process.env.PATH || '').split(path.delimiter).map(folder => path.join(folder.replace(/^"|"$/g, ''), 'powershell.exe')),
  ].filter(Boolean);
  return candidates.find(file => fs.existsSync(file));
}

export function createScriptsStore(dataDir) {
  const file = path.join(dataDir, 'scripts.json');
  const scriptsDir = path.join(dataDir, 'scripts');

  function load() {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return {
        scripts: Array.isArray(data.scripts) ? data.scripts.filter(item => item?.id && item?.name) : [],
        activeScriptId: data.activeScriptId || null,
      };
    } catch {
      return { scripts: [], activeScriptId: null };
    }
  }

  function persist(state) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(state, null, 2));
    fs.renameSync(file + '.tmp', file);
  }

  function sanitizeShell(shell) {
    return shell === 'batch' ? 'batch' : 'powershell';
  }

  function sanitizeScript(input) {
    const name = String(input.name || '').trim().slice(0, 80);
    if (!name) throw new Error('Enter a script name.');
    const shell = sanitizeShell(input.shell);
    const content = String(input.content ?? '');
    if (Buffer.byteLength(content) > MAX_SCRIPT_BYTES) throw new Error('Script is too large.');
    return { name, shell, content };
  }

  function findById(state, id) {
    return state.scripts.find(script => script.id === id);
  }

  function resolveActive(state) {
    if (state.activeScriptId && findById(state, state.activeScriptId)) return state.activeScriptId;
    return state.scripts[0]?.id || null;
  }

  function removeScriptFiles(id) {
    for (const ext of ['.ps1', '.bat']) {
      const scriptPath = path.join(scriptsDir, `${id}${ext}`);
      if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath);
    }
  }

  return {
    list() {
      const state = load();
      const active = resolveActive(state);
      if (active !== state.activeScriptId) {
        state.activeScriptId = active;
        persist(state);
      }
      return { scripts: state.scripts, active };
    },

    save(script) {
      const state = load();
      const data = sanitizeScript(script);
      let savedId;
      if (script.id && findById(state, script.id)) {
        Object.assign(findById(state, script.id), data);
        savedId = script.id;
      } else {
        savedId = crypto.randomBytes(8).toString('hex');
        state.scripts.push({ id: savedId, ...data });
        if (!state.activeScriptId) state.activeScriptId = savedId;
      }
      persist(state);
      return { ...this.list(), savedId };
    },

    delete(id) {
      const state = load();
      const index = state.scripts.findIndex(script => script.id === id);
      if (index < 0) throw new Error('Script not found.');
      state.scripts.splice(index, 1);
      if (state.activeScriptId === id) state.activeScriptId = state.scripts[0]?.id || null;
      persist(state);
      removeScriptFiles(id);
      return this.list();
    },

    setActive(id) {
      const state = load();
      if (!findById(state, id)) throw new Error('Script not found.');
      state.activeScriptId = id;
      persist(state);
      return this.list();
    },

    run(id) {
      const state = load();
      const script = findById(state, id);
      if (!script) throw new Error('Script not found.');
      fs.mkdirSync(scriptsDir, { recursive: true });
      const isBatch = script.shell === 'batch';
      const ext = isBatch ? '.bat' : '.ps1';
      const scriptPath = path.join(scriptsDir, `${script.id}${ext}`);
      fs.writeFileSync(scriptPath, script.content, 'utf8');

      const command = isBatch
        ? (process.env.ComSpec || 'cmd.exe')
        : findPowerShell();
      if (!command) throw new Error('PowerShell was not found on this PC.');

      const args = isBatch
        ? ['/d', '/s', '/c', scriptPath]
        : ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath];

      return new Promise((resolve, reject) => {
        const child = spawn(command, args, { windowsHide: true, cwd: dataDir });
        let output = '';
        let killed = false;
        const timer = setTimeout(() => {
          killed = true;
          child.kill();
          reject(new Error('Script timed out after 5 minutes.'));
        }, RUN_TIMEOUT_MS);

        const append = chunk => {
          output += chunk.toString();
          if (output.length > 1024 * 1024) output = output.slice(-1024 * 1024);
        };

        child.stdout.on('data', append);
        child.stderr.on('data', append);
        child.on('error', error => {
          clearTimeout(timer);
          reject(error);
        });
        child.on('close', code => {
          clearTimeout(timer);
          if (killed) return;
          resolve({
            success: code === 0,
            exitCode: code,
            output: output.trim(),
            script: { id: script.id, name: script.name },
          });
        });
      });
    },
  };
}
