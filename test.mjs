import './ai-tests.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

test('local terminal, access checks, and durable notes', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-test-'));
  const child = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: '0', WORKSPACE_DATA_DIR: data }, stdio: ['ignore', 'pipe', 'pipe'] });
  let socket;
  try {
    const url = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Startup timeout')), 10000);
      child.stdout.on('data', chunk => {
        const match = chunk.toString().match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) { clearTimeout(timeout); resolve(match[0]); }
      });
      child.on('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited ${code}`)); });
    });
    const html = await (await fetch(url)).text();
    assert.match(html, /name="application-name" content="Terminal Workspace"/);
    const accountName = process.env.USERNAME || os.userInfo().username || path.basename(process.env.USERPROFILE || '');
    if (accountName) {
      assert.match(html, new RegExp(`${accountName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'));
      assert.match(html, /Workspace<\/title>/);
    }
    const token = html.match(/name="workspace-token" content="([^"]+)"/)[1];
    for (const asset of ['/app.js', '/style.css', '/ai.css', '/vendor/xterm.js', '/vendor/fit.js', '/vendor/xterm.css']) {
      assert.equal((await fetch(url + asset)).status, 200);
    }
    assert.equal((await fetch(url + '/api/notes')).status, 403);
    const headers = { 'X-Workspace-Token': token, 'Content-Type': 'application/json' };
    const scriptSaved = await (await fetch(url + '/api/scripts', { method: 'PUT', headers, body: JSON.stringify({ name: 'Test script', shell: 'powershell', content: "Write-Output 'SCRIPT_OK'" }) })).json();
    assert.equal(scriptSaved.scripts.length, 1);
    const scriptRun = await (await fetch(url + '/api/scripts/run', { method: 'POST', headers, body: JSON.stringify({ id: scriptSaved.scripts[0].id }) })).json();
    assert.equal(scriptRun.success, true);
    assert.match(scriptRun.output, /SCRIPT_OK/);
    const infrastructure = await (await fetch(url + '/api/infrastructure', { headers })).json();
    assert.ok(Array.isArray(infrastructure.hypervisors));
    assert.ok(infrastructure.scannedAt);
    const system = await (await fetch(url + '/api/system', { headers })).json();
    assert.ok(system.memory);
    assert.ok(system.scannedAt);
    assert.equal((await fetch(url + '/api/notes', { headers: { ...headers, Origin: 'https://example.com' } })).status, 403);
    assert.equal((await fetch(url + '/api/notes', { method: 'PUT', headers, body: JSON.stringify({ text: 'Persistent notes ✓', file: 'notes.md' }) })).status, 200);
    assert.equal((await (await fetch(url + '/api/notes', { headers })).json()).text, 'Persistent notes ✓');
    assert.equal(fs.readFileSync(path.join(data, 'notes.md'), 'utf8'), 'Persistent notes ✓');
    const created = await (await fetch(url + '/api/notes/files', { method: 'POST', headers, body: '{}' })).json();
    assert.match(created.file, /\.txt$/);
    assert.ok(created.files.includes(created.file));
    const renamed = await (await fetch(url + '/api/notes/files', { method: 'PATCH', headers, body: JSON.stringify({ file: created.file, newName: 'renamed-note.txt' }) })).json();
    assert.equal(renamed.file, 'renamed-note.txt');
    assert.ok(renamed.files.includes('renamed-note.txt'));
    assert.equal((await fetch(url + '/api/notes/files', { method: 'DELETE', headers, body: JSON.stringify({ file: 'renamed-note.txt' }) })).status, 200);
    assert.equal((await fetch(url + '/api/notes/files', { method: 'DELETE', headers, body: JSON.stringify({ file: 'notes.md' }) })).status, 200);
    assert.ok(fs.existsSync(path.join(data, 'notes.md')));
    const sessions = await (await fetch(url + '/api/sessions', { headers })).json();
    const aiStatus = await (await fetch(url + '/api/ai/status', { headers })).json();
    assert.equal(aiStatus.cloudAi, false);
    assert.equal(aiStatus.engine, 'local');
    const kb = await (await fetch(url + '/api/ai/knowledge', { method: 'POST', headers, body: JSON.stringify({ name: 'Test KB' }) })).json();
    assert.ok(kb.id);
    const notePath = path.join(data, 'rag-note.txt');
    fs.writeFileSync(notePath, 'CrashLoopBackOff happens when a container keeps failing.');
    const docs = await (await fetch(url + `/api/ai/knowledge/${kb.id}/documents`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ paths: [notePath] }),
    })).json();
    assert.equal(docs.documents.length, 1);
    assert.ok(sessions.sessions.length >= 1);
    const sessionId = sessions.sessions[0].id;
    const usesPowerShell = /powershell/i.test(sessions.shellLabel || '');
    socket = new WebSocket(`${url.replace('http', 'ws')}/terminal?token=${token}&session=${sessionId}`, { origin: url });
    await new Promise((resolve, reject) => {
      let output = '';
      let sent = false;
      const timeout = setTimeout(() => reject(new Error(`Shell output timeout: ${output}`)), 10000);
      socket.on('error', reject);
      socket.on('open', () => socket.send(JSON.stringify({ type: 'resize', cols: 90, rows: 28 })));
      socket.on('message', raw => {
        const message = JSON.parse(raw);
        output += message.data || '';
        if (!sent && (output.includes('$') || output.includes('>'))) {
          sent = true;
          setTimeout(() => socket.send(JSON.stringify({
            type: 'input',
            data: usesPowerShell ? "Write-Output ('CHECK_' + 'SUCCESS')\r" : "printf 'CHECK_%s\\n' SUCCESS\rpwd\r",
          })), 500);
        }
        if (output.includes('CHECK_SUCCESS')) { clearTimeout(timeout); resolve(); }
      });
    });
  } finally {
    socket?.terminate();
    child.kill();
  }
});
