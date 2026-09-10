import http from 'node:http';
import os from 'node:os';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { WebSocketServer, WebSocket } from 'ws';
import pty from 'node-pty';
import { Client as SshClient } from 'ssh2';
import { getInfrastructure } from './infrastructure.mjs';
import { getSystemStats } from './system.mjs';
import { createScriptsStore } from './scripts.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 8765;
const require = createRequire(import.meta.url);
const token = crypto.randomBytes(32).toString('hex');
const MAX_SESSIONS = 5;

function findExecutable(name) {
  return (process.env.PATH || '').split(path.delimiter).map(folder => path.join(folder.replace(/^"|"$/g, ''), name)).find(file => fs.existsSync(file));
}

const gitCommand = findExecutable('git.exe');
const gitBases = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean).map(base => path.join(base, 'Git'));
if (gitCommand) gitBases.unshift(path.resolve(path.dirname(gitCommand), '..'));
const candidates = [process.env.WORKSPACE_SHELL, ...gitBases.map(base => path.join(base, 'bin/bash.exe')), findExecutable('pwsh.exe'), findExecutable('powershell.exe'), path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')].filter(Boolean);
const shell = process.platform === 'win32' ? candidates.find(file => fs.existsSync(file)) : (process.env.SHELL || '/bin/sh');
if (!shell) throw new Error('No supported shell found. Install PowerShell or Git for Windows, or set WORKSPACE_SHELL to an executable path.');
const posix = /^(?:bash|sh)(?:\.exe)?$/i.test(path.basename(shell));
const shellLabel = posix ? 'Git Bash' : (/pwsh/i.test(shell) ? 'PowerShell 7' : 'Windows PowerShell');
function formatWorkspaceOwner(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return 'My';
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function resolveWorkspaceAccountName() {
  const fromEnv = process.env.USERNAME || process.env.USER;
  if (fromEnv) return fromEnv;
  try {
    const username = os.userInfo().username;
    if (username) return username;
  } catch { /* ignore */ }
  const profile = process.env.USERPROFILE || process.env.HOME;
  if (profile) {
    const folder = path.basename(profile);
    if (folder && !/^users?$/i.test(folder)) return folder;
  }
  return os.hostname() || 'My';
}

const workspaceName = process.env.WORKSPACE_TITLE?.trim()
  || `${formatWorkspaceOwner(resolveWorkspaceAccountName())}’s Workspace`;
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const dataDir = process.env.WORKSPACE_DATA_DIR || path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const settingsFile = path.join(dataDir, 'settings.json');
const scriptsStore = createScriptsStore(dataDir);
let settings = { notesDirectory: dataDir, activeNotesFile: 'notes.md' };
try { settings = { ...settings, activeNotesFile: 'notes.md', ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) }; } catch {}

function persistSettings() {
  fs.writeFileSync(settingsFile + '.tmp', JSON.stringify(settings, null, 2));
  fs.renameSync(settingsFile + '.tmp', settingsFile);
}

function notesDirectoryPath() {
  return path.resolve(settings.notesDirectory);
}

function safeNotesFilename(name) {
  const base = path.basename(String(name || '').trim());
  if (!/^[\w.\- ]+\.(txt|md)$/i.test(base)) return null;
  return base;
}

function listNotesFiles() {
  const dir = notesDirectoryPath();
  fs.mkdirSync(dir, { recursive: true });
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile() && /\.(txt|md)$/i.test(entry.name))
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  } catch {
    return [];
  }
}

function getActiveNotesFile() {
  const active = safeNotesFilename(settings.activeNotesFile);
  if (active && fs.existsSync(path.join(notesDirectoryPath(), active))) return active;
  const files = listNotesFiles();
  return files[0] || 'notes.md';
}

function resolveNotesPath(name) {
  const filename = safeNotesFilename(name) || getActiveNotesFile();
  return path.join(notesDirectoryPath(), filename);
}

function setActiveNotesFile(name) {
  const safe = safeNotesFilename(name);
  if (!safe) return false;
  const full = path.join(notesDirectoryPath(), safe);
  if (!fs.existsSync(full)) return false;
  settings.activeNotesFile = safe;
  persistSettings();
  return true;
}

function uniqueNewTxtName() {
  const dir = notesDirectoryPath();
  let index = 1;
  let name = `note-${index}.txt`;
  while (fs.existsSync(path.join(dir, name))) {
    index += 1;
    name = `note-${index}.txt`;
  }
  return name;
}

function ensureDefaultNotesFile() {
  const dir = notesDirectoryPath();
  fs.mkdirSync(dir, { recursive: true });
  const files = listNotesFiles();
  if (!files.length) {
    const defaultFile = path.join(dir, 'notes.md');
    if (!fs.existsSync(defaultFile)) fs.writeFileSync(defaultFile, '', 'utf8');
    settings.activeNotesFile = 'notes.md';
    persistSettings();
  }
}

ensureDefaultNotesFile();
let notesFile = resolveNotesPath();
const assets = new Map([
  ['/', [path.join(root, 'public/index.html'), 'text/html']],
  ['/app.js', [path.join(root, 'public/app.js'), 'text/javascript']],
  ['/style.css', [path.join(root, 'public/style.css'), 'text/css']],
  ['/vendor/xterm.js', [require.resolve('@xterm/xterm'), 'text/javascript']],
  ['/vendor/fit.js', [require.resolve('@xterm/addon-fit'), 'text/javascript']],
  ['/vendor/xterm.css', [path.join(path.dirname(require.resolve('@xterm/xterm')), '../css/xterm.css'), 'text/css']],
]);

const sessions = new Map();
let origin;

function shellEnv() {
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', PS1: '\\[\\033[38;5;111m\\]\\w\\[\\033[0m\\] $ ' };
  if (posix && process.platform === 'win32') {
    const base = path.resolve(path.dirname(shell), '..');
    env.PATH = [path.dirname(shell), path.join(base, 'usr/bin'), path.join(base, 'mingw64/bin'), process.env.PATH || ''].join(path.delimiter);
  }
  return env;
}

function localLabel(index) {
  if (index === 0) return 'This laptop';
  return `Local ${index + 1}`;
}

function broadcastSession(session, message) {
  for (const ws of session.sockets) if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function appendSessionOutput(session, text) {
  session.history = (session.history + text).slice(-250000);
  broadcastSession(session, { type: 'data', data: text });
}

const CLOSE_FORCE_MS = 5000;

function clearCloseTimer(session) {
  if (session.closeTimer) {
    clearTimeout(session.closeTimer);
    session.closeTimer = null;
  }
}

function handleSessionExit(session, exitCode) {
  clearCloseTimer(session);
  session.terminal = null;
  session.closing = false;
  session.exited = true;
  broadcastSession(session, { type: 'exit', exitCode });
}

function closeSessionTerminal(session, { force = false } = {}) {
  if (session.sshStream) {
    try { session.sshStream.close(); } catch {}
    session.sshStream = null;
  }
  if (session.sshConn) {
    try { session.sshConn.end(); } catch {}
    session.sshConn = null;
    session.terminal = null;
    session.closing = false;
    clearCloseTimer(session);
    return;
  }
  if (!session.terminal) {
    session.closing = false;
    clearCloseTimer(session);
    return;
  }
  if (!force && session.kind === 'local') {
    if (!session.closing) {
      session.closing = true;
      session.terminal.write(posix ? 'exit\n' : 'exit\r');
      clearCloseTimer(session);
      session.closeTimer = setTimeout(() => closeSessionTerminal(session, { force: true }), CLOSE_FORCE_MS);
    }
    return;
  }
  clearCloseTimer(session);
  try { session.terminal.kill(); } catch {}
  session.terminal = null;
  session.closing = false;
}

function bindSshStream(session, stream) {
  session.sshStream = stream;
  session.terminal = {
    write: data => stream.write(data),
    resize: (cols, rows) => stream.setWindow(rows, cols, 0, 0),
    kill: () => closeSessionTerminal(session),
  };
  session.exited = false;
  stream.on('data', data => appendSessionOutput(session, data.toString()));
  stream.on('close', () => {
    closeSessionTerminal(session);
    session.exited = true;
    broadcastSession(session, { type: 'exit' });
  });
}

function spawnRemoteSession(session) {
  closeSessionTerminal(session);
  const conn = new SshClient();
  session.sshConn = conn;
  conn.on('keyboard-interactive', (_name, _instructions, prompts, finish) => {
    finish(prompts.map(prompt => (/password/i.test(prompt.prompt) && session.password) ? session.password : ''));
  });
  conn.on('ready', () => {
    conn.shell({ term: 'xterm-256color', cols: 100, rows: 30 }, (error, stream) => {
      if (error) {
        appendSessionOutput(session, `\r\nSSH shell error: ${error.message}\r\n`);
        session.exited = true;
        broadcastSession(session, { type: 'exit' });
        conn.end();
        return;
      }
      bindSshStream(session, stream);
    });
  });
  conn.on('error', error => {
    appendSessionOutput(session, `\r\nSSH connection failed: ${error.message}\r\n`);
    closeSessionTerminal(session);
    session.exited = true;
    broadcastSession(session, { type: 'exit' });
  });
  conn.connect({
    host: session.host,
    port: 22,
    username: session.user,
    password: session.password || undefined,
    tryKeyboard: Boolean(session.password),
    readyTimeout: 20000,
    hostVerifier: () => true,
  });
}

function serializeSession(session) {
  return { id: session.id, label: session.label, kind: session.kind, host: session.host, user: session.user, name: session.name, exited: session.exited };
}

function spawnSessionProcess(session) {
  if (session.kind === 'remote') {
    spawnRemoteSession(session);
    return;
  }
  closeSessionTerminal(session, { force: true });
  const spawnOptions = {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd: process.env.WORKSPACE_CWD || os.homedir(),
    env: shellEnv(),
  };
  if (process.platform === 'win32') {
    spawnOptions.useConpty = true;
    spawnOptions.useConptyDll = true;
  }
  const terminal = pty.spawn(shell, posix ? ['-i'] : ['-NoLogo'], spawnOptions);
  session.terminal = terminal;
  session.exited = false;
  session.closing = false;
  terminal.onData(data => appendSessionOutput(session, data));
  terminal.onExit(({ exitCode }) => handleSessionExit(session, exitCode));
}

function createSession({ kind = 'local', host = null, user = null, name = null, password = null } = {}) {
  if (sessions.size >= MAX_SESSIONS) return null;
  const id = crypto.randomBytes(8).toString('hex');
  const localIndex = [...sessions.values()].filter(item => item.kind === 'local').length;
  const cleanHost = typeof host === 'string' ? host.trim() : '';
  const cleanUser = typeof user === 'string' ? user.trim() : '';
  const cleanName = typeof name === 'string' ? name.trim() : '';
  if (kind === 'remote' && (!cleanHost || !cleanUser)) throw new Error('Enter a server address and username.');
  const session = {
    id,
    kind,
    host: kind === 'remote' ? cleanHost : null,
    user: kind === 'remote' ? cleanUser : null,
    name: kind === 'remote' ? (cleanName || null) : null,
    password: kind === 'remote' && typeof password === 'string' ? password : null,
    label: kind === 'remote' ? (cleanName || `${cleanUser}@${cleanHost}`) : localLabel(localIndex),
    terminal: null,
    sshConn: null,
    sshStream: null,
    history: '',
    sockets: new Set(),
    exited: false,
    closing: false,
    closeTimer: null,
  };
  sessions.set(id, session);
  spawnSessionProcess(session);
  return session;
}

function destroySession(id) {
  const session = sessions.get(id);
  if (!session) return false;
  closeSessionTerminal(session);
  for (const ws of session.sockets) ws.terminate();
  sessions.delete(id);
  return true;
}

function restartSession(id) {
  const session = sessions.get(id);
  if (!session) return false;
  if (session.terminal) return false;
  session.history = '';
  spawnSessionProcess(session);
  return true;
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'");
  if (req.headers.host !== new URL(origin).host) { res.writeHead(403).end(); return; }
  const url = new URL(req.url, origin);
  const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (url.pathname.startsWith('/api/')) {
    if (req.headers['x-workspace-token'] !== token || (req.headers.origin && req.headers.origin !== origin)) { json(403, { error: 'Access denied' }); return; }
    if (url.pathname === '/api/settings' && req.method === 'GET') {
      notesFile = resolveNotesPath();
      json(200, { notesDirectory: settings.notesDirectory, notesFile, activeNotesFile: getActiveNotesFile() });
      return;
    }
    if (url.pathname === '/api/settings' && req.method === 'PUT') {
      try {
        let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 8192) { json(413, { error: 'Settings too large' }); return; } }
        const { notesDirectory } = JSON.parse(body);
        if (typeof notesDirectory !== 'string' || !path.isAbsolute(notesDirectory.trim())) { json(400, { error: 'Enter a full folder path on this computer.' }); return; }
        const directory = path.resolve(notesDirectory.trim());
        if (directory.toLowerCase() !== notesDirectoryPath().toLowerCase()) {
          const previousPath = resolveNotesPath();
          const previousContent = fs.existsSync(previousPath) ? fs.readFileSync(previousPath, 'utf8') : '';
          fs.mkdirSync(directory, { recursive: true });
          settings.notesDirectory = directory;
          const targetNotes = path.join(directory, 'notes.md');
          if (!fs.existsSync(targetNotes) && previousContent) fs.writeFileSync(targetNotes, previousContent, { flag: 'wx' });
          const files = listNotesFiles();
          settings.activeNotesFile = files.includes('notes.md') ? 'notes.md' : (files[0] || 'notes.md');
          if (!files.length) fs.writeFileSync(targetNotes, previousContent, 'utf8');
          persistSettings();
          notesFile = resolveNotesPath();
        }
        json(200, { notesDirectory: settings.notesDirectory, notesFile, activeNotesFile: getActiveNotesFile() });
      } catch { json(400, { error: 'Cannot use this folder. Check the path and write permissions.' }); }
      return;
    }
    if (url.pathname === '/api/scripts' && req.method === 'GET') {
      json(200, scriptsStore.list());
      return;
    }
    if (url.pathname === '/api/scripts' && req.method === 'PUT') {
      try {
        let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 262144 + 4096) { json(413, { error: 'Script too large' }); return; } }
        const payload = JSON.parse(body || '{}');
        if (payload.active) {
          json(200, scriptsStore.setActive(payload.active));
          return;
        }
        json(200, scriptsStore.save(payload));
      } catch (error) { json(400, { error: error.message || 'Could not save script.' }); }
      return;
    }
    if (url.pathname === '/api/scripts' && req.method === 'DELETE') {
      try {
        let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 4096) { json(413, { error: 'Request too large' }); return; } }
        const { id } = JSON.parse(body || '{}');
        if (!id) { json(400, { error: 'Script not found.' }); return; }
        json(200, scriptsStore.delete(id));
      } catch (error) { json(400, { error: error.message || 'Could not delete script.' }); }
      return;
    }
    if (url.pathname === '/api/scripts/run' && req.method === 'POST') {
      try {
        let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 4096) { json(413, { error: 'Request too large' }); return; } }
        const { id } = JSON.parse(body || '{}');
        if (!id) { json(400, { error: 'Select a script to run.' }); return; }
        json(200, await scriptsStore.run(id));
      } catch (error) { json(400, { error: error.message || 'Could not run script.' }); }
      return;
    }
    if (url.pathname === '/api/infrastructure' && req.method === 'GET') {
      try {
        const refresh = url.searchParams.get('refresh') === '1';
        json(200, await getInfrastructure({ refresh }));
      } catch (error) {
        json(500, { error: error.message || 'Could not scan infrastructure.' });
      }
      return;
    }
    if (url.pathname === '/api/readme' && req.method === 'GET') {
      const readmePath = path.join(root, 'README.md');
      if (!fs.existsSync(readmePath)) { json(404, { error: 'README not found.' }); return; }
      json(200, { markdown: fs.readFileSync(readmePath, 'utf8') });
      return;
    }
    if (url.pathname === '/api/system' && req.method === 'GET') {
      try {
        const refresh = url.searchParams.get('refresh') === '1';
        json(200, await getSystemStats({ refresh }));
      } catch (error) {
        json(500, { error: error.message || 'Could not read system stats.' });
      }
      return;
    }
    if (url.pathname === '/api/notes/files' && req.method === 'GET') {
      json(200, { files: listNotesFiles(), active: getActiveNotesFile(), directory: notesDirectoryPath() });
      return;
    }
    if (url.pathname === '/api/notes/files' && req.method === 'POST') {
      try {
        const dir = notesDirectoryPath();
        fs.mkdirSync(dir, { recursive: true });
        const name = uniqueNewTxtName();
        const full = path.join(dir, name);
        fs.writeFileSync(full, '', 'utf8');
        setActiveNotesFile(name);
        notesFile = full;
        json(201, { file: name, files: listNotesFiles(), active: name, directory: dir });
      } catch { json(400, { error: 'Could not create a new note file.' }); }
      return;
    }
    if (url.pathname === '/api/notes/files' && req.method === 'PATCH') {
      try {
        let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 4096) { json(413, { error: 'Request too large' }); return; } }
        const { file, newName } = JSON.parse(body || '{}');
        const from = safeNotesFilename(file);
        const to = safeNotesFilename(newName);
        if (!from || !to) { json(400, { error: 'Use a valid .txt or .md file name.' }); return; }
        const dir = notesDirectoryPath();
        const fromPath = path.join(dir, from);
        const toPath = path.join(dir, to);
        if (!fs.existsSync(fromPath)) { json(404, { error: 'File not found.' }); return; }
        if (from !== to && fs.existsSync(toPath)) { json(409, { error: 'A file with that name already exists.' }); return; }
        if (from !== to) fs.renameSync(fromPath, toPath);
        if (settings.activeNotesFile === from) {
          settings.activeNotesFile = to;
          persistSettings();
        }
        notesFile = resolveNotesPath(getActiveNotesFile());
        json(200, { from, file: to, files: listNotesFiles(), active: getActiveNotesFile(), directory: dir });
      } catch { json(400, { error: 'Could not rename note file.' }); }
      return;
    }
    if (url.pathname === '/api/notes/files' && req.method === 'DELETE') {
      try {
        let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 4096) { json(413, { error: 'Request too large' }); return; } }
        const { file } = JSON.parse(body || '{}');
        const target = safeNotesFilename(file);
        if (!target) { json(400, { error: 'Invalid note file.' }); return; }
        const dir = notesDirectoryPath();
        const full = path.join(dir, target);
        if (!fs.existsSync(full)) { json(404, { error: 'File not found.' }); return; }
        const wasActive = getActiveNotesFile() === target;
        fs.unlinkSync(full);
        let remaining = listNotesFiles();
        if (!remaining.length) {
          const defaultFile = path.join(dir, 'notes.md');
          fs.writeFileSync(defaultFile, '', 'utf8');
          remaining = listNotesFiles();
        }
        const active = wasActive ? (remaining.includes('notes.md') ? 'notes.md' : remaining[0]) : getActiveNotesFile();
        settings.activeNotesFile = active;
        persistSettings();
        notesFile = resolveNotesPath(active);
        json(200, { deleted: target, files: remaining, active, directory: dir });
      } catch { json(400, { error: 'Could not delete note file.' }); }
      return;
    }
    if (url.pathname === '/api/notes' && req.method === 'GET') {
      const file = safeNotesFilename(url.searchParams.get('file')) || getActiveNotesFile();
      const full = resolveNotesPath(file);
      json(200, { text: fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '', file, path: full, directory: notesDirectoryPath() });
      return;
    }
    if (url.pathname === '/api/notes' && req.method === 'PUT') {
      try {
        let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 1024 * 1024) { json(413, { error: 'Notes exceed 1 MB' }); return; } }
        const { text, file } = JSON.parse(body);
        if (typeof text !== 'string') throw new Error('Invalid notes');
        const target = safeNotesFilename(file) || getActiveNotesFile();
        const full = resolveNotesPath(target);
        fs.mkdirSync(notesDirectoryPath(), { recursive: true });
        fs.writeFileSync(full + '.tmp', text, 'utf8');
        fs.renameSync(full + '.tmp', full);
        setActiveNotesFile(target);
        notesFile = full;
        json(200, { saved: true, file: target, path: full, directory: notesDirectoryPath() });
      } catch { json(400, { error: 'Could not save notes' }); }
      return;
    }
    if (url.pathname === '/api/sessions' && req.method === 'GET') {
      json(200, { sessions: [...sessions.values()].map(serializeSession), maxSessions: MAX_SESSIONS, shellLabel });
      return;
    }
    if (url.pathname === '/api/sessions' && req.method === 'POST') {
      try {
        let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 4096) { json(413, { error: 'Request too large' }); return; } }
        const payload = JSON.parse(body || '{}');
        const kind = payload.kind === 'remote' ? 'remote' : 'local';
        if (sessions.size >= MAX_SESSIONS) { json(409, { error: 'Maximum of 5 terminals open.' }); return; }
        const session = createSession({ kind, host: payload.host, user: payload.user, name: payload.name, password: payload.password });
        if (!session) { json(409, { error: 'Maximum of 5 terminals open.' }); return; }
        json(201, serializeSession(session));
      } catch (error) { json(400, { error: error.message || 'Could not open terminal.' }); }
      return;
    }
    const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(restart))?$/);
    if (sessionMatch) {
      const session = sessions.get(sessionMatch[1]);
      if (!session) { json(404, { error: 'Terminal not found.' }); return; }
      if (req.method === 'DELETE') {
        if (sessions.size <= 1) { json(409, { error: 'Keep at least one terminal open.' }); return; }
        destroySession(session.id);
        json(200, { ok: true });
        return;
      }
      if (req.method === 'POST' && sessionMatch[2] === 'restart') {
        if (!restartSession(session.id)) { json(409, { error: 'Terminal is still running.' }); return; }
        json(200, serializeSession(session));
        return;
      }
    }
    if (url.pathname === '/api/restart-app' && req.method === 'POST') {
      if (server.restarting) { json(409, { error: 'Restart already in progress' }); return; }
      server.restarting = true;
      const port = server.address().port;
      json(200, { restarting: true });
      setTimeout(() => {
        for (const session of sessions.values()) closeSessionTerminal(session, { force: true });
        for (const session of sessions.values()) for (const socket of session.sockets) socket.terminate();
        server.close(() => {
          const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], { cwd: root, env: { ...process.env, PORT: String(port) }, detached: true, windowsHide: true, stdio: 'ignore' });
          child.on('error', error => { console.error('Restart failed:', error.message); process.exit(1); });
          child.on('spawn', () => { child.unref(); process.exit(0); });
        });
        server.closeAllConnections();
      }, 300);
      return;
    }
    json(404, { error: 'Not found' });
    return;
  }
  if (req.method !== 'GET' || !assets.has(url.pathname)) { res.writeHead(404).end(); return; }
  const [file, type] = assets.get(url.pathname);
  let content = fs.readFileSync(file);
  if (url.pathname === '/') content = content.toString().replace('__TOKEN__', token).replace('__SHELL__', escapeHtml(shellLabel)).replaceAll('__WORKSPACE_NAME__', escapeHtml(workspaceName));
  res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' }); res.end(content);
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, origin);
  if (req.headers.host !== new URL(origin).host || req.headers.origin !== origin || url.pathname !== '/terminal' || url.searchParams.get('token') !== token) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, origin);
  const sessionId = url.searchParams.get('session');
  const session = sessions.get(sessionId);
  if (!session) { ws.close(); return; }
  session.sockets.add(ws);
  ws.send(JSON.stringify({ type: 'meta', ...serializeSession(session) }));
  ws.send(JSON.stringify({ type: 'data', data: session.history }));
  if (!session.terminal) ws.send(JSON.stringify({ type: 'exit' }));
  ws.on('message', raw => {
    try {
      const message = JSON.parse(raw);
      if (message.type === 'input' && typeof message.data === 'string') session.terminal?.write(message.data);
      if (message.type === 'resize' && Number.isInteger(message.cols) && Number.isInteger(message.rows)) {
        session.terminal?.resize(Math.max(2, Math.min(500, message.cols)), Math.max(2, Math.min(200, message.rows)));
      }
    } catch {}
  });
  ws.on('close', () => session.sockets.delete(ws));
  ws.on('error', () => {});
});

server.listen(Number(process.env.PORT || DEFAULT_PORT), '127.0.0.1', () => {
  origin = `http://127.0.0.1:${server.address().port}`;
  createSession({ kind: 'local' });
  fs.writeFileSync(path.join(dataDir, 'runtime.json'), JSON.stringify({ url: origin, pid: process.pid }));
  console.log(`Terminal Workspace running at ${origin}`);
});

function stop() {
  for (const session of sessions.values()) closeSessionTerminal(session);
  for (const session of sessions.values()) for (const ws of session.sockets) ws.terminate();
  server.close(() => process.exit(0));
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
