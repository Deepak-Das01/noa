const token = document.querySelector('meta[name="workspace-token"]').content;
const $ = id => document.getElementById(id);
const MAX_TABS = 5;
const REMOTE_KEY = 'workspaceRemoteConnections';

const darkTerminalTheme = {
  background: '#05080e', foreground: '#e4eaf2', cursor: '#6ecfb8', selectionBackground: '#2a3d5c',
  black: '#121a26', red: '#e07a8a', green: '#7bcfa8', yellow: '#d9b97a', blue: '#88b0f5',
  magenta: '#b89ae8', cyan: '#76c8d8', white: '#dce4f0',
};
const lightTerminalTheme = {
  background: '#f6f9fc', foreground: '#1a2838', cursor: '#0f7a66', selectionBackground: '#c5dde8',
  black: '#243449', red: '#a83240', green: '#1f6b45', yellow: '#7a5a10', blue: '#2d5f9e',
  magenta: '#6e4a98', cyan: '#226f7c', white: '#4a5f75', brightBlack: '#5a6d82', brightRed: '#a83240',
  brightGreen: '#1f6b45', brightYellow: '#7a5a10', brightBlue: '#2d5f9e', brightMagenta: '#6e4a98',
  brightCyan: '#226f7c', brightWhite: '#1a2838',
};
const glassTerminalTheme = {
  background: '#0b1018', foreground: '#eef2f8', cursor: '#8ed9c6', selectionBackground: '#3a5f78',
  black: '#121a26', red: '#e07a8a', green: '#7bcfa8', yellow: '#d9b97a', blue: '#88b0f5',
  magenta: '#b89ae8', cyan: '#76c8d8', white: '#dce4f0',
};
const gradientTerminalTheme = {
  background: '#0c1219', foreground: '#eef2f8', cursor: '#8ed9c6', selectionBackground: '#3a5f78',
  black: '#121a26', red: '#e07a8a', green: '#7bcfa8', yellow: '#d9b97a', blue: '#88b0f5',
  magenta: '#b89ae8', cyan: '#76c8d8', white: '#dce4f0',
};
const TERMINAL_THEMES = {
  dark: darkTerminalTheme,
  light: lightTerminalTheme,
  glass: glassTerminalTheme,
  gradient: gradientTerminalTheme,
};
const DEFAULT_GRADIENT = { start: '#0f2b3d', end: '#1a4d5e', accent: '#6ecfb8', angle: 135 };

const tabs = [];
let activeTabId = null;
let secondaryTabId = null;
let splitMode = false;
let focusedPane = 'primary';
let fitFrame = 0;
let saveTimer, dirty = false, saving = false, loaded = false, currentNotesFile = 'notes.md', notesDirectory = '';

function mountTabContainer(tab, host) {
  host.append(tab.container);
  tab.container.hidden = false;
}

function parkTabContainer(tab) {
  mountTabContainer(tab, $('terminal-stage'));
  tab.container.hidden = true;
}

function focusedTab() {
  if (splitMode && focusedPane === 'secondary') return tabs.find(tab => tab.id === secondaryTabId) || null;
  return activeTab();
}

function updateTerminalLayout() {
  if (!splitMode) {
    $('terminal-split').hidden = true;
    $('terminal-host').hidden = false;
    for (const tab of tabs) {
      if (tab.id === activeTabId) mountTabContainer(tab, $('terminal-host'));
      else parkTabContainer(tab);
    }
    $('split-pane-primary').classList.remove('focused');
    $('split-pane-secondary').classList.remove('focused');
  } else {
    $('terminal-host').hidden = true;
    $('terminal-split').hidden = false;
    const primary = tabs.find(tab => tab.id === activeTabId);
    const secondary = tabs.find(tab => tab.id === secondaryTabId);
    if (primary) {
      mountTabContainer(primary, $('split-host-primary'));
      $('split-label-primary').textContent = primary.label;
    }
    if (secondary) {
      mountTabContainer(secondary, $('split-host-secondary'));
      $('split-label-secondary').textContent = secondary.label;
    }
    for (const tab of tabs) {
      if (tab.id !== activeTabId && tab.id !== secondaryTabId) parkTabContainer(tab);
    }
    $('split-pane-primary').classList.toggle('focused', focusedPane === 'primary');
    $('split-pane-secondary').classList.toggle('focused', focusedPane === 'secondary');
  }
  resizeActiveTab();
}

function createTerminalPane() {
  const container = document.createElement('div');
  container.className = 'terminal-pane';
  $('terminal-stage').append(container);
  container.hidden = true;
  const terminal = new Terminal({
    cursorBlink: true,
    fontFamily: 'Cascadia Code, Cascadia Mono, JetBrains Mono, SFMono-Regular, Consolas, monospace',
    fontSize: 14,
    lineHeight: 1.3,
    scrollback: 10000,
    theme: TERMINAL_THEMES[document.documentElement.dataset.theme] || darkTerminalTheme,
  });
  const fit = new FitAddon.FitAddon();
  terminal.loadAddon(fit);
  terminal.open(container);
  new ResizeObserver(() => { if (activeTabId) resizeActiveTab(); }).observe(container);
  return { container, terminal, fit, ws: null, reconnect: null, lastSize: '', exited: false };
}

function activeTab() {
  return tabs.find(tab => tab.id === activeTabId) || null;
}

function assignTabToPane(id, pane = focusedPane) {
  if (!tabs.some(tab => tab.id === id)) return;
  if (pane === 'primary') {
    if (id === secondaryTabId) secondaryTabId = activeTabId;
    activeTabId = id;
  } else {
    if (id === activeTabId) activeTabId = secondaryTabId || activeTabId;
    secondaryTabId = id;
  }
  renderTabs();
  updateTerminalLayout();
  focusedTab()?.terminal.focus();
}

function updateTabControls() {
  $('new-tab').disabled = tabs.length >= MAX_TABS;
  $('remote-connect').disabled = tabs.length >= MAX_TABS;
  $('split-view').disabled = !splitMode && tabs.length < 2 && tabs.length >= MAX_TABS;
  const tab = focusedTab();
  $('restart').hidden = !tab?.exited;
  if (!tab) {
    $('connection').textContent = 'Connecting…';
    $('dot').classList.remove('online');
    return;
  }
  const connected = tab.ws?.readyState === WebSocket.OPEN && !tab.exited;
  $('connection').textContent = tab.exited ? 'Shell exited' : (connected ? 'Connected' : 'Connecting…');
  $('dot').classList.toggle('online', connected);
}

function renderTabs() {
  const strip = $('tab-strip');
  strip.replaceChildren(...tabs.map(tab => {
    const button = document.createElement('button');
    button.type = 'button';
    const inPrimary = tab.id === activeTabId;
    const inSecondary = splitMode && tab.id === secondaryTabId;
    button.className = 'term-tab'
      + (inPrimary ? ' active' : '')
      + (inSecondary ? ' active-secondary' : '')
      + (tab.kind === 'remote' ? ' remote' : '');
    button.role = 'tab';
    button.setAttribute('aria-selected', String(inPrimary || inSecondary));
    button.title = tab.label;
    button.dataset.id = tab.id;
    const label = document.createElement('span');
    label.className = 'term-tab-label';
    label.textContent = tab.label;
    button.append(label);
    if (tabs.length > 1) {
      const close = document.createElement('span');
      close.className = 'term-tab-close';
      close.setAttribute('aria-label', `Close ${tab.label}`);
      close.textContent = '×';
      close.onclick = event => { event.stopPropagation(); closeTab(tab.id); };
      button.append(close);
    }
    button.onclick = () => {
      if (splitMode) assignTabToPane(tab.id, focusedPane);
      else setActiveTab(tab.id);
    };
    return button;
  }));
  updateTabControls();
}

function setActiveTab(id) {
  const tab = tabs.find(item => item.id === id);
  if (!tab) return;
  activeTabId = id;
  if (splitMode && secondaryTabId === id) secondaryTabId = tabs.find(item => item.id !== id)?.id || null;
  renderTabs();
  updateTerminalLayout();
  tab.terminal.focus();
  updateTabControls();
}

function connectTab(tab) {
  clearTimeout(tab.reconnect);
  tab.ws = new WebSocket(`${location.origin.replace('http', 'ws')}/terminal?token=${token}&session=${tab.id}`);
  tab.ws.onopen = () => {
    tab.lastSize = '';
    tab.exited = false;
    tab.terminal.reset();
    resizeActiveTab();
    if (tab.id === activeTabId) tab.terminal.focus();
    updateTabControls();
  };
  tab.ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.type === 'meta') {
      tab.label = message.label;
      tab.kind = message.kind;
      tab.name = message.name;
      renderTabs();
      if (splitMode) updateTerminalLayout();
    }
    if (message.type === 'data') tab.terminal.write(message.data, () => tab.terminal.scrollToBottom());
    if (message.type === 'exit') {
      tab.exited = true;
      updateTabControls();
    }
  };
  tab.ws.onclose = () => {
    tab.ws = null;
    updateTabControls();
    tab.reconnect = setTimeout(() => connectTab(tab), 1500);
  };
  tab.ws.onerror = () => tab.ws?.close();
  tab.terminal.onData(data => {
    if (tab.ws?.readyState === WebSocket.OPEN) tab.ws.send(JSON.stringify({ type: 'input', data }));
  });
}

async function addTab(payload = { kind: 'local' }) {
  if (tabs.length >= MAX_TABS) return;
  const session = await api('/api/sessions', { method: 'POST', body: JSON.stringify(payload) });
  const pane = createTerminalPane();
  const tab = {
    id: session.id,
    label: session.label,
    kind: session.kind,
    host: session.host,
    user: session.user,
    name: session.name,
    remotePassword: payload.kind === 'remote' ? (payload.password || '') : '',
    exited: false,
    ...pane,
  };
  tabs.push(tab);
  connectTab(tab);
  setActiveTab(tab.id);
  return tab;
}

async function closeTab(id) {
  if (tabs.length <= 1) return;
  const index = tabs.findIndex(tab => tab.id === id);
  if (index < 0) return;
  const tab = tabs[index];
  clearTimeout(tab.reconnect);
  tab.container.classList.add('is-closing');
  tab.container.hidden = true;
  if (tab.ws) {
    tab.ws.onclose = () => {};
    tab.ws.onerror = () => {};
    tab.ws.close();
  }
  tabs.splice(index, 1);
  if (activeTabId === id) activeTabId = tabs[Math.max(0, index - 1)].id;
  if (secondaryTabId === id) secondaryTabId = tabs.find(item => item.id !== activeTabId)?.id || null;
  if (splitMode && tabs.length < 2) {
    splitMode = false;
    secondaryTabId = null;
    $('split-view').setAttribute('aria-pressed', 'false');
  }
  if (!tabs.some(item => item.id === activeTabId)) activeTabId = tabs[0].id;
  renderTabs();
  updateTerminalLayout();
  focusedTab()?.terminal.focus();
  try { await api(`/api/sessions/${id}`, { method: 'DELETE' }); } catch {}
  requestAnimationFrame(() => {
    tab.terminal.dispose();
    tab.container.remove();
  });
}

function resizeTab(tab) {
  if (!tab || !tab.container.clientHeight) return;
  const atBottom = tab.terminal.buffer.active.viewportY >= tab.terminal.buffer.active.baseY;
  tab.fit.fit();
  const size = `${tab.terminal.cols}x${tab.terminal.rows}`;
  if (tab.ws?.readyState === WebSocket.OPEN && size !== tab.lastSize) {
    tab.ws.send(JSON.stringify({ type: 'resize', cols: tab.terminal.cols, rows: tab.terminal.rows }));
    tab.lastSize = size;
  }
  if (atBottom) tab.terminal.scrollToBottom();
}

function resizeActiveTab() {
  cancelAnimationFrame(fitFrame);
  fitFrame = requestAnimationFrame(() => {
    if ($('terminal-panel').hidden) return;
    if (splitMode) {
      resizeTab(tabs.find(tab => tab.id === activeTabId));
      resizeTab(tabs.find(tab => tab.id === secondaryTabId));
    } else {
      resizeTab(activeTab());
    }
  });
}

document.fonts.ready.then(resizeActiveTab);
new ResizeObserver(resizeActiveTab).observe($('terminal-wrapper'));

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'X-Workspace-Token': token, 'Content-Type': 'application/json', ...(options.headers || {}) } });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || `Request failed (${response.status})`);
  }
  return response.json();
}

function showReloadOverlay(message = 'Restarting Noa…', hint = 'This takes a few seconds') {
  $('reload-overlay-text').textContent = message;
  document.querySelector('.reload-overlay-hint').textContent = hint;
  $('reload-overlay').hidden = false;
  document.body.classList.add('is-reloading');
}

function hideReloadOverlay() {
  $('reload-overlay').hidden = true;
  document.body.classList.remove('is-reloading');
}

async function ensureSingleDefaultTerminal(existing) {
  if (!existing.length) return [];
  const keep = existing.find(session => session.kind === 'local') || existing[0];
  for (const session of existing) {
    if (session.id === keep.id) continue;
    try { await api(`/api/sessions/${session.id}`, { method: 'DELETE' }); } catch { /* ignore */ }
  }
  return [keep];
}

async function initTabs() {
  splitMode = false;
  secondaryTabId = null;
  focusedPane = 'primary';
  $('split-view').setAttribute('aria-pressed', 'false');
  const data = await api('/api/sessions');
  let existing = await ensureSingleDefaultTerminal(data.sessions || []);
  if (!existing.length) {
    await addTab({ kind: 'local' });
    return;
  }
  for (const session of existing) {
    const pane = createTerminalPane();
    const tab = { id: session.id, label: session.label, kind: session.kind, host: session.host, user: session.user, name: session.name, exited: session.exited, ...pane };
    tabs.push(tab);
    connectTab(tab);
  }
  setActiveTab(tabs[0].id);
}

$('new-tab').onclick = async () => {
  try { await addTab({ kind: 'local' }); }
  catch (error) { $('connection').textContent = error.message; }
};

$('split-view').onclick = async () => {
  if (splitMode) {
    splitMode = false;
    focusedPane = 'primary';
    secondaryTabId = null;
    $('split-view').setAttribute('aria-pressed', 'false');
    updateTerminalLayout();
    activeTab()?.terminal.focus();
    return;
  }
  if (tabs.length < 2) {
    if (tabs.length >= MAX_TABS) return;
    try { await addTab({ kind: 'local' }); } catch (error) { $('connection').textContent = error.message; return; }
  }
  secondaryTabId = tabs.find(tab => tab.id !== activeTabId)?.id || null;
  if (!secondaryTabId) return;
  splitMode = true;
  focusedPane = 'primary';
  $('split-view').setAttribute('aria-pressed', 'true');
  updateTerminalLayout();
  activeTab()?.terminal.focus();
};

for (const [pane, id] of [['primary', 'split-pane-primary'], ['secondary', 'split-pane-secondary']]) {
  $(id).addEventListener('mousedown', () => {
    if (!splitMode) return;
    focusedPane = pane;
    $('split-pane-primary').classList.toggle('focused', pane === 'primary');
    $('split-pane-secondary').classList.toggle('focused', pane === 'secondary');
    focusedTab()?.terminal.focus();
    updateTabControls();
  });
}

function loadRemoteConnections() {
  try { return JSON.parse(localStorage.getItem(REMOTE_KEY)) || []; } catch { return []; }
}

function connectionKey(profile) {
  return `${profile.host}|${profile.user}`;
}

function rememberRemoteConnection(profile) {
  const key = connectionKey(profile);
  const existing = loadRemoteConnections().find(item => connectionKey(item) === key);
  const list = loadRemoteConnections().filter(item => connectionKey(item) !== key);
  list.unshift({
    name: profile.name || existing?.name || '',
    host: profile.host,
    user: profile.user,
    password: profile.password || existing?.password || '',
    lastUsed: Date.now(),
    successCount: (existing?.successCount || 0) + 1,
  });
  localStorage.setItem(REMOTE_KEY, JSON.stringify(list.slice(0, 12)));
}

function removeRemoteConnection(profile) {
  const key = connectionKey(profile);
  const list = loadRemoteConnections().filter(item => connectionKey(item) !== key);
  localStorage.setItem(REMOTE_KEY, JSON.stringify(list));
  renderSavedRemoteConnections();
}

function fillRemoteForm(profile) {
  $('remote-name').value = profile.name || '';
  $('remote-host').value = profile.host || '';
  $('remote-user').value = profile.user || '';
  $('remote-password').value = profile.password || '';
  $('remote-status').textContent = '';
}

function renderSavedRemoteConnections() {
  const list = loadRemoteConnections();
  const section = $('saved-remote-section');
  const container = $('saved-remote-list');
  if (!list.length) { section.hidden = true; container.replaceChildren(); return; }
  section.hidden = false;
  container.replaceChildren(...list.map(item => {
    const card = document.createElement('div');
    card.className = 'saved-remote-card';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'saved-remote-item';
    const title = document.createElement('strong');
    title.textContent = item.name || item.host;
    const meta = document.createElement('span');
    meta.textContent = `${item.user}@${item.host}`;
    button.append(title, meta);
    button.onclick = () => fillRemoteForm(item);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'saved-remote-remove';
    remove.setAttribute('aria-label', `Remove ${item.name || item.host}`);
    remove.textContent = '×';
    remove.onclick = event => { event.stopPropagation(); removeRemoteConnection(item); };
    card.append(button, remove);
    return card;
  }));
}

function watchRemoteLogin(tab, profile) {
  let output = '';
  let saved = false;
  const failPattern = /permission denied|authentication failed|connection refused|could not resolve hostname|host key verification failed/i;
  const onMessage = event => {
    const message = JSON.parse(event.data);
    if (message.type === 'data') output += message.data;
    if (message.type === 'exit' && failPattern.test(output)) tab.loginFailed = true;
  };
  tab.ws?.addEventListener('message', onMessage);
  const finish = success => {
    if (saved) return;
    saved = true;
    tab.ws?.removeEventListener('message', onMessage);
    if (success) rememberRemoteConnection(profile);
  };
  const check = () => {
    if (saved) return;
    if (tab.exited || tab.loginFailed || failPattern.test(output)) { finish(false); return; }
    const tail = output.slice(-240);
    if (/[\$#%>]\s*$/.test(tail) || /welcome to /i.test(tail) || /last login:/i.test(tail)) { finish(true); return; }
    if (Date.now() > tab.loginWatchUntil) finish(!tab.exited && !failPattern.test(output));
  };
  tab.loginWatchUntil = Date.now() + 12000;
  const interval = setInterval(check, 500);
  setTimeout(() => { clearInterval(interval); check(); }, 12500);
}

function openRemoteDialog() {
  $('remote-status').textContent = tabs.length >= MAX_TABS ? 'Maximum of 5 terminals open.' : '';
  $('remote-submit').disabled = tabs.length >= MAX_TABS;
  renderSavedRemoteConnections();
  if (typeof $('remote-dialog').showModal === 'function') $('remote-dialog').showModal();
}

$('remote-connect').onclick = openRemoteDialog;
$('remote-cancel').onclick = () => $('remote-dialog').close();
$('remote-dialog').addEventListener('close', () => { $('remote-status').textContent = ''; });

$('remote-form').onsubmit = async event => {
  event.preventDefault();
  const profile = {
    name: $('remote-name').value.trim(),
    host: $('remote-host').value.trim(),
    user: $('remote-user').value.trim(),
    password: $('remote-password').value,
  };
  if (!profile.host || !profile.user) { $('remote-status').textContent = 'Enter a username and server address.'; return; }
  $('remote-submit').disabled = true;
  $('remote-status').textContent = 'Connecting…';
  try {
    const tab = await addTab({ kind: 'remote', ...profile });
    watchRemoteLogin(tab, profile);
    $('remote-dialog').close();
  } catch (error) {
    $('remote-status').textContent = error.message;
  } finally {
    $('remote-submit').disabled = tabs.length >= MAX_TABS;
  }
};

$('clear').onclick = () => { focusedTab()?.terminal.clear(); focusedTab()?.terminal.focus(); };
$('restart').onclick = async () => {
  const tab = focusedTab();
  if (!tab) return;
  showReloadOverlay('Restarting shell…', 'Reconnecting your terminal');
  try {
    await api(`/api/sessions/${tab.id}/restart`, { method: 'POST' });
    tab.exited = false;
    tab.terminal.reset();
    updateTabControls();
    tab.terminal.focus();
    setTimeout(hideReloadOverlay, 600);
  } catch {
    hideReloadOverlay();
    $('connection').textContent = 'Restart failed';
  }
};

$('copy').onclick = async () => {
  const tab = focusedTab();
  if (!tab) return;
  try {
    const text = tab.terminal.getSelection();
    if (!text) {
      $('copy').textContent = 'Select text';
      setTimeout(() => { $('copy').textContent = 'Copy'; }, 1400);
      return;
    }
    await navigator.clipboard.writeText(text);
    $('copy').textContent = 'Copied';
    setTimeout(() => { $('copy').textContent = 'Copy'; }, 1400);
  } catch {
    $('copy').textContent = 'Use Ctrl Shift C';
  }
};

function terminalSize(delta) {
  const tab = focusedTab();
  if (!tab) return;
  tab.terminal.options.fontSize = Math.max(11, Math.min(30, tab.terminal.options.fontSize + delta));
  resizeActiveTab();
}
$('term-smaller').onclick = () => terminalSize(-1);
$('term-larger').onclick = () => terminalSize(1);

const WORKSPACE_VIEWS = ['terminal', 'notes', 'ai', 'infrastructure', 'settings'];

function showView(view) {
  const active = WORKSPACE_VIEWS.includes(view) ? view : 'terminal';
  const wasOnNotes = !$('notes').hidden;
  $('terminal-panel').hidden = active !== 'terminal';
  $('notes').hidden = active !== 'notes';
  $('noa-ai').hidden = active !== 'ai';
  $('infrastructure').hidden = active !== 'infrastructure';
  $('settings').hidden = active !== 'settings';
  $('terminal-tab').classList.toggle('active', active === 'terminal');
  $('terminal-tab').setAttribute('aria-pressed', String(active === 'terminal'));
  $('toggle').classList.toggle('active', active === 'notes');
  $('toggle').setAttribute('aria-pressed', String(active === 'notes'));
  $('toggle').setAttribute('aria-expanded', String(active === 'notes'));
  $('ai-tab').classList.toggle('active', active === 'ai');
  $('ai-tab').setAttribute('aria-pressed', String(active === 'ai'));
  $('infrastructure-tab').classList.toggle('active', active === 'infrastructure');
  $('infrastructure-tab').setAttribute('aria-pressed', String(active === 'infrastructure'));
  $('settings-tab').classList.toggle('active', active === 'settings');
  $('settings-tab').setAttribute('aria-pressed', String(active === 'settings'));
  localStorage.setItem('workspaceView', active);
  if (active === 'terminal') requestAnimationFrame(resizeActiveTab);
  if (wasOnNotes && active !== 'notes') save({ force: true });
  if (active === 'notes') $('editor').focus();
  else if (active === 'terminal') activeTab()?.terminal.focus();
  if (active === 'ai') loadNoaAI();
  if (active === 'infrastructure') {
    loadInfrastructure();
    loadInfraScripts();
  }
  if (active === 'settings') {
    loadReadme();
    startSystemMonitor();
    loadScriptEditor();
    loadAiSettings();
  } else {
    stopSystemMonitor();
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function inlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

function renderMarkdownTable(lines) {
  const rows = lines.filter(line => /^\|.+\|$/.test(line));
  if (rows.length < 2) return '';
  const body = rows.map((row, index) => {
    const cells = row.split('|').slice(1, -1).map(cell => cell.trim());
    if (index === 1 && cells.every(cell => /^:?-{3,}:?$/.test(cell))) return '';
    const tag = index === 0 ? 'th' : 'td';
    return `<tr>${cells.map(cell => `<${tag}>${inlineMarkdown(cell)}</${tag}>`).join('')}</tr>`;
  }).filter(Boolean).join('');
  return `<table>${body}</table>`;
}

function renderMarkdown(markdown) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const parts = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.startsWith('```')) {
      const block = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith('```')) {
        block.push(lines[index]);
        index += 1;
      }
      parts.push(`<pre><code>${escapeHtml(block.join('\n'))}</code></pre>`);
      index += 1;
      continue;
    }
    if (/^\|.+\|$/.test(line)) {
      const tableLines = [];
      while (index < lines.length && /^\|.+\|$/.test(lines[index])) {
        tableLines.push(lines[index]);
        index += 1;
      }
      parts.push(renderMarkdownTable(tableLines));
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      parts.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }
    if (/^[-*] /.test(line)) {
      const items = [];
      while (index < lines.length && /^[-*] /.test(lines[index])) {
        items.push(`<li>${inlineMarkdown(lines[index].replace(/^[-*] /, ''))}</li>`);
        index += 1;
      }
      parts.push(`<ul>${items.join('')}</ul>`);
      continue;
    }
    if (/^\d+\.\s/.test(line)) {
      const items = [];
      while (index < lines.length && /^\d+\.\s/.test(lines[index])) {
        items.push(`<li>${inlineMarkdown(lines[index].replace(/^\d+\.\s/, ''))}</li>`);
        index += 1;
      }
      parts.push(`<ol>${items.join('')}</ol>`);
      continue;
    }
    if (!line.trim()) {
      index += 1;
      continue;
    }
    parts.push(`<p>${inlineMarkdown(line)}</p>`);
    index += 1;
  }
  return parts.join('\n');
}

let readmeLoaded = false;

async function loadReadme() {
  if (readmeLoaded) return;
  $('readme-doc').textContent = 'Loading documentation…';
  try {
    const data = await api('/api/readme');
    $('readme-doc').innerHTML = renderMarkdown(data.markdown || '');
    readmeLoaded = true;
  } catch (error) {
    $('readme-doc').textContent = error.message || 'Could not load README.md';
  }
}

function formatPercent(value) {
  return value == null || Number.isNaN(value) ? '—' : `${value}%`;
}

function setSystemBar(id, percent) {
  const bar = $(id);
  const width = percent == null || Number.isNaN(percent) ? 0 : Math.max(0, Math.min(100, percent));
  bar.style.width = `${width}%`;
}

function renderSystemStats(data) {
  const cpu = data.cpu || {};
  const memory = data.memory || {};
  const gpu = data.gpu || null;
  $('cpu-usage').textContent = formatPercent(cpu.usagePercent);
  $('cpu-detail').textContent = cpu.cores ? `${cpu.cores} logical processors` : 'Processor load';
  setSystemBar('cpu-bar', cpu.usagePercent);
  $('memory-usage').textContent = formatPercent(memory.usagePercent);
  $('memory-detail').textContent = memory.totalGb != null
    ? `${memory.usedGb ?? '—'} / ${memory.totalGb} GB used`
    : 'Physical memory';
  setSystemBar('memory-bar', memory.usagePercent);
  if (gpu?.name) {
    $('gpu-usage').textContent = formatPercent(gpu.usagePercent);
    const mem = gpu.memoryUsedMb != null && gpu.memoryTotalMb != null
      ? `${Math.round(gpu.memoryUsedMb)} / ${Math.round(gpu.memoryTotalMb)} MB VRAM`
      : gpu.name;
    $('gpu-detail').textContent = mem;
    setSystemBar('gpu-bar', gpu.usagePercent);
  } else {
    $('gpu-usage').textContent = '—';
    $('gpu-detail').textContent = 'No GPU metrics available on this PC';
    setSystemBar('gpu-bar', 0);
  }
  const when = data.scannedAt ? new Date(data.scannedAt).toLocaleTimeString() : 'now';
  $('system-updated').textContent = `Updated ${when}`;
}

let systemMonitorTimer = null;

async function loadSystemStats() {
  try {
    const data = await api('/api/system?refresh=1');
    renderSystemStats(data);
  } catch (error) {
    $('system-updated').textContent = error.message || 'Monitor unavailable';
  }
}

function startSystemMonitor() {
  stopSystemMonitor();
  loadSystemStats();
  systemMonitorTimer = setInterval(loadSystemStats, 2500);
}

function stopSystemMonitor() {
  if (systemMonitorTimer) {
    clearInterval(systemMonitorTimer);
    systemMonitorTimer = null;
  }
}

$('terminal-tab').onclick = () => showView('terminal');
$('toggle').onclick = () => showView('notes');
$('ai-tab').onclick = () => showView('ai');
$('infrastructure-tab').onclick = () => showView('infrastructure');

document.addEventListener('keydown', event => {
  if (event.ctrlKey && event.shiftKey && event.code === 'KeyN') {
    event.preventDefault();
    showView($('notes').hidden ? 'notes' : 'terminal');
  }
  if (event.ctrlKey && event.code === 'KeyS' && !$('notes').hidden) { event.preventDefault(); save({ force: true }); }
});

function count() {
  const n = $('editor').value.trim().split(/\s+/).filter(Boolean).length;
  $('count').textContent = `${n} ${n === 1 ? 'word' : 'words'}`;
}

let notesFileMenuOpen = false;

function updateNotesFilenameLabel() {
  $('notes-filename').textContent = currentNotesFile;
  $('notes-file-current').textContent = currentNotesFile;
}

function closeNotesFileMenu() {
  $('notes-file-menu').hidden = true;
  $('notes-file-trigger').setAttribute('aria-expanded', 'false');
  notesFileMenuOpen = false;
}

function openNotesFileMenu() {
  $('notes-file-menu').hidden = false;
  $('notes-file-trigger').setAttribute('aria-expanded', 'true');
  notesFileMenuOpen = true;
}

function toggleNotesFileMenu() {
  if (notesFileMenuOpen) closeNotesFileMenu();
  else openNotesFileMenu();
}

function updateNotesPathLabel() {
  const fullPath = notesDirectory ? `${notesDirectory}\\${currentNotesFile}` : currentNotesFile;
  $('notes-path').textContent = fullPath;
  $('notes-path').title = fullPath;
}

function normalizeNotesFilename(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return '';
  return /\.(txt|md)$/i.test(trimmed) ? trimmed : `${trimmed}.txt`;
}

function renderNotesFileMenu(files, active) {
  $('notes-file-current').textContent = active;
  $('notes-file-menu').replaceChildren(...files.map(name => {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = `notes-file-option${name === active ? ' active' : ''}`;
    option.role = 'option';
    option.setAttribute('aria-selected', String(name === active));
    option.textContent = name;
    option.title = name;
    option.onclick = () => {
      closeNotesFileMenu();
      openNotesFile(name).catch(error => { $('saved').textContent = error.message || 'Could not open file'; });
    };
    option.addEventListener('dblclick', event => {
      event.stopPropagation();
      closeNotesFileMenu();
      if (name !== currentNotesFile) {
        openNotesFile(name).then(() => startNotesRename()).catch(error => { $('saved').textContent = error.message || 'Could not open file'; });
      } else {
        startNotesRename();
      }
    });
    return option;
  }));
}

async function refreshNotesFiles(active = currentNotesFile) {
  const data = await api('/api/notes/files');
  const files = data.files?.length ? data.files : ['notes.md'];
  notesDirectory = data.directory || notesDirectory;
  currentNotesFile = files.includes(active) ? active : (data.active || files[0]);
  renderNotesFileMenu(files, currentNotesFile);
  updateNotesFilenameLabel();
  updateNotesPathLabel();
  localStorage.setItem('notesActiveFile', currentNotesFile);
  return files;
}

async function openNotesFile(name) {
  if (name === currentNotesFile) return;
  await save({ force: true });
  const data = await api(`/api/notes?file=${encodeURIComponent(name)}`);
  currentNotesFile = data.file || name;
  $('editor').value = data.text || '';
  dirty = false;
  loaded = true;
  $('saved').textContent = 'Saved';
  updateNotesFilenameLabel();
  updateNotesPathLabel();
  localStorage.setItem('notesActiveFile', currentNotesFile);
  count();
  updateEditor();
}

async function createNotesFile() {
  await save({ force: true });
  const data = await api('/api/notes/files', { method: 'POST', body: '{}' });
  renderNotesFileMenu(data.files || [data.file], data.file);
  currentNotesFile = data.file;
  $('editor').value = '';
  dirty = false;
  loaded = true;
  $('saved').textContent = 'Saved';
  updateNotesFilenameLabel();
  updateNotesPathLabel();
  localStorage.setItem('notesActiveFile', currentNotesFile);
  count();
  updateEditor();
  $('editor').focus();
}

async function deleteNotesFile() {
  const name = currentNotesFile;
  if (!confirm(`Delete "${name}"?\n\nThis file will be permanently removed.`)) return;
  await save({ force: true });
  const data = await api('/api/notes/files', { method: 'DELETE', body: JSON.stringify({ file: name }) });
  notesDirectory = data.directory || notesDirectory;
  currentNotesFile = data.active || data.files[0];
  renderNotesFileMenu(data.files, currentNotesFile);
  const noteData = await api(`/api/notes?file=${encodeURIComponent(currentNotesFile)}`);
  $('editor').value = noteData.text || '';
  dirty = false;
  loaded = true;
  $('saved').textContent = 'Saved';
  updateNotesFilenameLabel();
  updateNotesPathLabel();
  localStorage.setItem('notesActiveFile', currentNotesFile);
  count();
  updateEditor();
}

async function renameNotesFile(newName) {
  const target = normalizeNotesFilename(newName);
  if (!target || target === currentNotesFile) return;
  await save({ force: true });
  const data = await api('/api/notes/files', { method: 'PATCH', body: JSON.stringify({ file: currentNotesFile, newName: target }) });
  notesDirectory = data.directory || notesDirectory;
  currentNotesFile = data.file || target;
  renderNotesFileMenu(data.files, currentNotesFile);
  updateNotesFilenameLabel();
  updateNotesPathLabel();
  localStorage.setItem('notesActiveFile', currentNotesFile);
  $('saved').textContent = 'Renamed';
}

function startNotesRename() {
  const label = $('notes-filename');
  if (label.dataset.renaming === 'true') return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'notes-filename-input';
  input.value = currentNotesFile;
  input.setAttribute('aria-label', 'Rename note file');
  input.spellcheck = false;
  label.dataset.renaming = 'true';
  label.replaceWith(input);
  input.focus();
  input.select();
  let finished = false;
  const finish = async (commit) => {
    if (finished) return;
    finished = true;
    const next = document.createElement('span');
    next.id = 'notes-filename';
    next.className = 'notes-filename';
    next.title = 'Double-click to rename';
    if (commit) {
      try {
        await renameNotesFile(input.value);
      } catch (error) {
        $('saved').textContent = error.message || 'Could not rename file';
      }
    }
    next.textContent = currentNotesFile;
    input.replaceWith(next);
    delete next.dataset.renaming;
    next.addEventListener('dblclick', startNotesRename);
  };
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); finish(true); }
    if (event.key === 'Escape') { event.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => { finish(true); });
}

async function save({ force = false } = {}) {
  clearTimeout(saveTimer);
  if (!loaded || saving) return;
  if (!force && !dirty) return;
  saving = true;
  const text = $('editor').value;
  $('saved').textContent = 'Saving…';
  try {
    await api('/api/notes', { method: 'PUT', body: JSON.stringify({ text, file: currentNotesFile }), keepalive: true });
    dirty = false;
    $('saved').textContent = 'Saved';
  } catch {
    dirty = true;
    $('saved').textContent = 'Save failed · retrying';
  } finally {
    saving = false;
    if (dirty) saveTimer = setTimeout(() => save(), 1500);
  }
}

$('editor').addEventListener('input', () => {
  dirty = true;
  count();
  $('saved').textContent = 'Unsaved';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 400);
});
document.addEventListener('visibilitychange', () => { if (document.hidden) save({ force: true }); });
window.addEventListener('pagehide', () => { save({ force: true }); });
window.addEventListener('beforeunload', () => { save({ force: true }); });

async function loadNotes() {
  try {
    const preferred = localStorage.getItem('notesActiveFile') || 'notes.md';
    await refreshNotesFiles(preferred);
    const data = await api(`/api/notes?file=${encodeURIComponent(currentNotesFile)}`);
    currentNotesFile = data.file || currentNotesFile;
    if (data.directory) notesDirectory = data.directory;
    $('editor').value = data.text || '';
    loaded = true;
    dirty = false;
    $('editor').disabled = false;
    $('saved').textContent = 'Saved';
    updateNotesFilenameLabel();
    updateNotesPathLabel();
    count();
    updateEditor();
  } catch {
    $('saved').textContent = 'Load failed · retrying';
    setTimeout(loadNotes, 2000);
  }
}

$('new-note-file').onclick = () => { createNotesFile().catch(error => { $('saved').textContent = error.message || 'Could not create file'; }); };
$('delete-note-file').onclick = () => { deleteNotesFile().catch(error => { $('saved').textContent = error.message || 'Could not delete file'; }); };
$('notes-file-trigger').onclick = event => { event.stopPropagation(); toggleNotesFileMenu(); };
$('notes-file-trigger').addEventListener('dblclick', event => { event.stopPropagation(); startNotesRename(); });
$('notes-filename').addEventListener('dblclick', startNotesRename);
document.addEventListener('click', event => {
  if (notesFileMenuOpen && !$('notes-file-picker').contains(event.target)) closeNotesFileMenu();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && notesFileMenuOpen) closeNotesFileMenu();
});
let noteSize = 15;
function notesSize(delta) {
  noteSize = Math.max(12, Math.min(30, noteSize + delta));
  $('editor').style.fontSize = `${noteSize}px`;
  $('gutter').style.fontSize = `${noteSize}px`;
  updateEditor();
}
$('note-smaller').onclick = () => notesSize(-1);
$('note-larger').onclick = () => notesSize(1);

function updateEditor() {
  const text = $('editor').value;
  const before = text.slice(0, $('editor').selectionStart);
  $('position').textContent = `Ln ${before.split('\n').length}, Col ${before.length - before.lastIndexOf('\n')}`;
  $('gutter').replaceChildren(...text.split('\n').map((line, i) => {
    const row = document.createElement('div');
    row.textContent = i + 1;
    const measure = document.createElement('div');
    measure.style.cssText = `position:absolute;visibility:hidden;white-space:pre-wrap;overflow-wrap:break-word;font:${noteSize}px/1.65 Consolas,monospace;width:${Math.max(1, $('editor').clientWidth - parseFloat(getComputedStyle($('editor')).paddingLeft) - parseFloat(getComputedStyle($('editor')).paddingRight))}px`;
    measure.textContent = line || ' ';
    document.body.append(measure);
    row.style.height = `${($('editor').wrap === 'off' ? noteSize * 1.65 : measure.getBoundingClientRect().height)}px`;
    measure.remove();
    return row;
  }));
  $('gutter').scrollTop = $('editor').scrollTop;
}
for (const event of ['input', 'click', 'keyup', 'select']) $('editor').addEventListener(event, updateEditor);
$('editor').addEventListener('scroll', () => { $('gutter').scrollTop = $('editor').scrollTop; });
$('wrap').onclick = () => {
  const on = $('wrap').getAttribute('aria-pressed') !== 'true';
  $('wrap').setAttribute('aria-pressed', String(on));
  $('editor').wrap = on ? 'soft' : 'off';
  updateEditor();
};
$('lines').onclick = () => {
  const on = $('lines').getAttribute('aria-pressed') !== 'true';
  $('lines').setAttribute('aria-pressed', String(on));
  $('gutter').hidden = !on;
};
function findNext() {
  const needle = $('find-text').value;
  if (!needle) return;
  const text = $('editor').value;
  let index = text.toLowerCase().indexOf(needle.toLowerCase(), $('editor').selectionEnd);
  if (index < 0) index = text.toLowerCase().indexOf(needle.toLowerCase());
  if (index >= 0) {
    $('editor').focus();
    $('editor').setSelectionRange(index, index + needle.length);
    $('editor').scrollTop = Math.max(0, (text.slice(0, index).split('\n').length - 3) * noteSize * 1.65);
    updateEditor();
    $('find').textContent = 'Find next';
  } else {
    $('find').textContent = 'Not found';
  }
}
$('find').onclick = findNext;
$('find-text').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); findNext(); } });
new ResizeObserver(() => { if (loaded && !$('notes').hidden) updateEditor(); }).observe($('editor'));

$('settings-tab').onclick = () => showView('settings');

function formatVmMetric(value, suffix) {
  return value == null || Number.isNaN(value) ? '—' : `${value}${suffix}`;
}

function formatIpList(ips) {
  if (!Array.isArray(ips) || !ips.length) return '—';
  return ips.join(', ');
}

function formatUptime(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return '—';
  const days = Math.floor(value / 86400);
  const hours = Math.floor((value % 86400) / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return '<1m';
}

function statusClass(status) {
  const value = String(status || '').toLowerCase();
  if (value.includes('run') || value.includes('powered on') || value.includes('on')) return 'running';
  if (value.includes('pause')) return 'paused';
  if (value.includes('off') || value.includes('stop')) return 'stopped';
  return 'unknown';
}

function renderInfrastructure(data) {
  const content = $('infra-content');
  content.replaceChildren();
  const hypervisors = data.hypervisors || [];
  const installed = hypervisors.filter(item => item.installed);
  if (!installed.length) {
    const empty = document.createElement('div');
    empty.className = 'infra-empty';
    const title = document.createElement('h2');
    title.textContent = 'No hypervisor detected';
    const text = document.createElement('p');
    text.textContent = 'Install Hyper-V, VirtualBox, or VMware Workstation on this PC, then click Refresh.';
    empty.append(title, text);
    content.append(empty);
    return;
  }
  for (const hypervisor of installed) {
    const block = document.createElement('section');
    block.className = 'infra-block';
    const head = document.createElement('div');
    head.className = 'infra-block-head';
    const headText = document.createElement('div');
    const title = document.createElement('h2');
    title.textContent = hypervisor.name;
    const meta = document.createElement('p');
    meta.textContent = `${hypervisor.version ? `Version ${hypervisor.version}` : 'Installed'} · ${hypervisor.vms.length} virtual machine${hypervisor.vms.length === 1 ? '' : 's'}`;
    headText.append(title, meta);
    head.append(headText);
    block.append(head);
    if (!hypervisor.vms.length) {
      const empty = document.createElement('p');
      empty.className = 'infra-empty-inline';
      empty.textContent = 'No virtual machines found for this hypervisor.';
      block.append(empty);
    } else {
      const grid = document.createElement('div');
      grid.className = 'vm-grid';
      for (const vm of hypervisor.vms) {
        const card = document.createElement('article');
        card.className = 'vm-card';
        const cardHead = document.createElement('div');
        cardHead.className = 'vm-card-head';
        const name = document.createElement('h3');
        name.textContent = vm.name;
        const status = document.createElement('span');
        status.className = `vm-status vm-status-${statusClass(vm.status)}`;
        status.textContent = vm.status || 'Unknown';
        cardHead.append(name, status);
        const body = document.createElement('div');
        body.className = 'vm-card-body';
        const resources = document.createElement('dl');
        resources.className = 'vm-metrics vm-metrics-resources';
        for (const [label, value] of [
          ['CPU', formatVmMetric(vm.cpu, vm.cpu === 1 ? ' core' : ' cores')],
          ['RAM', formatVmMetric(vm.memoryMb, ' MB')],
          ['Storage', formatVmMetric(vm.storageGb, ' GB')],
        ]) {
          const row = document.createElement('div');
          const dt = document.createElement('dt');
          dt.textContent = label;
          const dd = document.createElement('dd');
          dd.textContent = value;
          row.append(dt, dd);
          resources.append(row);
        }
        const network = document.createElement('dl');
        network.className = 'vm-metrics vm-metrics-network';
        for (const [label, value, extraClass] of [
          ['IP address', formatIpList(vm.ipAddresses), 'vm-metric-ip'],
          ['Uptime', formatUptime(vm.uptimeSeconds), 'vm-metric-uptime'],
        ]) {
          const row = document.createElement('div');
          row.className = extraClass ? `vm-metric ${extraClass}` : 'vm-metric';
          const dt = document.createElement('dt');
          dt.textContent = label;
          const dd = document.createElement('dd');
          dd.textContent = value;
          if (value !== '—') dd.title = value;
          row.append(dt, dd);
          network.append(row);
        }
        body.append(resources, network);
        card.append(cardHead, body);
        grid.append(card);
      }
      block.append(grid);
    }
    content.append(block);
  }
}

async function loadInfrastructure({ refresh = false } = {}) {
  $('infra-status').textContent = 'Scanning hypervisors…';
  $('infra-refresh').disabled = true;
  try {
    const data = await api(`/api/infrastructure${refresh ? '?refresh=1' : ''}`);
    renderInfrastructure(data);
    const when = new Date(data.scannedAt).toLocaleString();
    $('infra-status').textContent = `${data.totalVms || 0} virtual machine${data.totalVms === 1 ? '' : 's'} across ${data.hypervisors.filter(item => item.installed).length} hypervisor${data.hypervisors.filter(item => item.installed).length === 1 ? '' : 's'} · Updated ${when}`;
  } catch (error) {
    $('infra-status').textContent = error.message || 'Could not load infrastructure.';
    $('infra-content').replaceChildren();
  } finally {
    $('infra-refresh').disabled = false;
  }
}

$('infra-refresh').onclick = () => loadInfrastructure({ refresh: true });

let infraScripts = [];
let activeInfraScriptId = null;
let infraScriptMenuOpen = false;
let scriptEditorId = null;
let scriptRunState = 'idle';
let lastScriptResult = null;

function setRunButtonState(state) {
  scriptRunState = state;
  const button = $('infra-run-script');
  button.classList.remove('is-running', 'is-success', 'is-error');
  if (state === 'running') button.classList.add('is-running');
  if (state === 'success') button.classList.add('is-success');
  if (state === 'error') button.classList.add('is-error');
  button.title = state === 'success'
    ? 'Script succeeded — click to view output'
    : state === 'error'
      ? 'Script failed — click to view error'
      : 'Run selected script';
}

function resetRunButtonState() {
  lastScriptResult = null;
  setRunButtonState('idle');
}

function formatScriptOutputTimestamp(date = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

function buildScriptOutputFilename(scriptName) {
  const safeName = String(scriptName || 'script').trim()
    .replace(/[^\w.\- ]+/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 60) || 'script';
  return `${safeName}-output-${formatScriptOutputTimestamp()}.txt`;
}

function showScriptOutputDialog() {
  if (!lastScriptResult) return;
  $('script-output-title').textContent = lastScriptResult.success ? 'Script succeeded' : 'Script failed';
  $('script-output-meta').textContent = lastScriptResult.name || '';
  $('script-output-text').textContent = lastScriptResult.output || '(no output)';
  $('script-output-save-status').textContent = '';
  const dialog = $('script-output-dialog');
  dialog.classList.toggle('is-success', lastScriptResult.success);
  dialog.classList.toggle('is-error', !lastScriptResult.success);
  dialog.showModal();
}

async function saveScriptOutput() {
  if (!lastScriptResult) return;
  const button = $('script-output-save');
  const status = $('script-output-save-status');
  const file = buildScriptOutputFilename(lastScriptResult.name);
  const text = lastScriptResult.output || '';
  button.disabled = true;
  status.textContent = 'Saving…';
  try {
    const data = await api('/api/notes', { method: 'PUT', body: JSON.stringify({ text, file }) });
    const savedPath = data.path || (notesDirectory ? `${notesDirectory}\\${data.file || file}` : (data.file || file));
    status.textContent = `Saved as ${data.file || file}`;
    status.title = savedPath;
  } catch (error) {
    status.textContent = error.message || 'Could not save output.';
    status.title = '';
  } finally {
    button.disabled = false;
  }
}

function renderInfraScriptMenu(scripts, active) {
  activeInfraScriptId = active;
  const current = scripts.find(script => script.id === active);
  $('infra-script-current').textContent = current?.name || (scripts.length ? 'Select script' : 'No scripts');
  $('infra-run-script').disabled = !current;
  $('infra-script-menu').replaceChildren(...scripts.map(script => {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = `infra-script-option${script.id === active ? ' active' : ''}`;
    option.role = 'option';
    option.setAttribute('aria-selected', String(script.id === active));
    option.textContent = script.name;
    option.title = script.name;
    option.onclick = () => {
      closeInfraScriptMenu();
      selectInfraScript(script.id).catch(() => {});
    };
    return option;
  }));
}

function closeInfraScriptMenu() {
  $('infra-script-menu').hidden = true;
  $('infra-script-trigger').setAttribute('aria-expanded', 'false');
  infraScriptMenuOpen = false;
}

function openInfraScriptMenu() {
  $('infra-script-menu').hidden = false;
  $('infra-script-trigger').setAttribute('aria-expanded', 'true');
  infraScriptMenuOpen = true;
}

function toggleInfraScriptMenu() {
  if (infraScriptMenuOpen) closeInfraScriptMenu();
  else openInfraScriptMenu();
}

async function loadInfraScripts() {
  try {
    const data = await api('/api/scripts');
    infraScripts = data.scripts || [];
    renderInfraScriptMenu(infraScripts, data.active || infraScripts[0]?.id || null);
  } catch {
    $('infra-script-current').textContent = 'Scripts unavailable';
    $('infra-run-script').disabled = true;
    resetRunButtonState();
  }
}

async function selectInfraScript(id) {
  const data = await api('/api/scripts', { method: 'PUT', body: JSON.stringify({ active: id }) });
  infraScripts = data.scripts || [];
  resetRunButtonState();
  renderInfraScriptMenu(infraScripts, data.active || id);
}

async function executeInfraScript() {
  if (!activeInfraScriptId) return;
  const button = $('infra-run-script');
  setRunButtonState('running');
  button.disabled = true;
  try {
    const data = await api('/api/scripts/run', { method: 'POST', body: JSON.stringify({ id: activeInfraScriptId }) });
    lastScriptResult = {
      success: data.success,
      output: data.output || (data.success ? 'Script completed with no output.' : `Exit code ${data.exitCode}`),
      exitCode: data.exitCode,
      name: data.script?.name || $('infra-script-current').textContent,
    };
    setRunButtonState(data.success ? 'success' : 'error');
  } catch (error) {
    lastScriptResult = {
      success: false,
      output: error.message || 'Could not run script.',
      name: $('infra-script-current').textContent,
    };
    setRunButtonState('error');
  } finally {
    button.disabled = !activeInfraScriptId;
  }
}

async function handleRunButtonClick() {
  if (!activeInfraScriptId || scriptRunState === 'running') return;
  if (scriptRunState === 'success' || scriptRunState === 'error') {
    showScriptOutputDialog();
    return;
  }
  await executeInfraScript();
}

function fillScriptEditor(script) {
  scriptEditorId = script?.id || null;
  $('script-name').value = script?.name || '';
  $('script-shell').value = script?.shell === 'batch' ? 'batch' : 'powershell';
  $('script-content').value = script?.content || '';
}

function renderScriptLibrary(scripts, selectedId) {
  const select = $('script-library');
  select.replaceChildren(...scripts.map(script => {
    const option = document.createElement('option');
    option.value = script.id;
    option.textContent = script.name;
    option.selected = script.id === selectedId;
    return option;
  }));
  if (!scripts.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No saved scripts';
    select.append(option);
  }
}

async function loadScriptEditor() {
  try {
    const data = await api('/api/scripts');
    const scripts = data.scripts || [];
    infraScripts = scripts;
    const selected = scriptEditorId && scripts.some(script => script.id === scriptEditorId)
      ? scriptEditorId
      : (data.active || scripts[0]?.id || null);
    renderScriptLibrary(scripts, selected);
    fillScriptEditor(scripts.find(script => script.id === selected) || null);
    $('script-delete').disabled = !selected;
    $('script-save-status').textContent = scripts.length ? '' : 'Create your first script below.';
  } catch (error) {
    $('script-save-status').textContent = error.message || 'Could not load scripts.';
  }
}

async function saveScriptEditor() {
  const button = $('script-save');
  button.disabled = true;
  try {
    const payload = {
      id: scriptEditorId || undefined,
      name: $('script-name').value,
      shell: $('script-shell').value,
      content: $('script-content').value,
    };
    const data = await api('/api/scripts', { method: 'PUT', body: JSON.stringify(payload) });
    scriptEditorId = data.savedId || scriptEditorId;
    const saved = data.scripts.find(script => script.id === scriptEditorId) || null;
    renderScriptLibrary(data.scripts, scriptEditorId);
    fillScriptEditor(saved || null);
    $('script-delete').disabled = !scriptEditorId;
    $('script-save-status').textContent = 'Script saved.';
    if (!$('infrastructure').hidden) await loadInfraScripts();
    else {
      infraScripts = data.scripts || [];
      activeInfraScriptId = data.active || scriptEditorId;
    }
  } catch (error) {
    $('script-save-status').textContent = error.message || 'Could not save script.';
  } finally {
    button.disabled = false;
  }
}

async function deleteScriptEditor() {
  if (!scriptEditorId) return;
  const name = $('script-name').value || 'this script';
  if (!confirm(`Delete "${name}"?`)) return;
  try {
    const data = await api('/api/scripts', { method: 'DELETE', body: JSON.stringify({ id: scriptEditorId }) });
    scriptEditorId = data.active || null;
    renderScriptLibrary(data.scripts, scriptEditorId);
    fillScriptEditor(data.scripts.find(script => script.id === scriptEditorId) || null);
    $('script-delete').disabled = !scriptEditorId;
    $('script-save-status').textContent = 'Script deleted.';
    if (!$('infrastructure').hidden) await loadInfraScripts();
  } catch (error) {
    $('script-save-status').textContent = error.message || 'Could not delete script.';
  }
}

$('infra-script-trigger').onclick = event => { event.stopPropagation(); toggleInfraScriptMenu(); };
$('infra-run-script').onclick = () => { handleRunButtonClick(); };
$('script-output-save').onclick = () => { saveScriptOutput(); };
$('script-output-close').onclick = () => { $('script-output-dialog').close(); };
$('script-output-run-again').onclick = () => {
  $('script-output-dialog').close();
  resetRunButtonState();
  executeInfraScript();
};
document.addEventListener('click', event => {
  if (infraScriptMenuOpen && !$('infra-script-picker').contains(event.target)) closeInfraScriptMenu();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && infraScriptMenuOpen) closeInfraScriptMenu();
});
$('script-library').onchange = async () => {
  const id = $('script-library').value;
  scriptEditorId = id || null;
  if (!id) {
    fillScriptEditor(null);
    $('script-delete').disabled = true;
    return;
  }
  try {
    const data = await api('/api/scripts');
    infraScripts = data.scripts || [];
    fillScriptEditor(infraScripts.find(item => item.id === id) || null);
    $('script-delete').disabled = false;
  } catch (error) {
    $('script-save-status').textContent = error.message;
  }
};
$('script-new').onclick = () => {
  scriptEditorId = null;
  fillScriptEditor(null);
  $('script-library').value = '';
  $('script-delete').disabled = true;
  $('script-save-status').textContent = 'Creating new script…';
  $('script-name').focus();
};
$('script-save').onclick = () => { saveScriptEditor(); };
$('script-delete').onclick = () => { deleteScriptEditor(); };

function loadGradientPrefs() {
  return {
    start: localStorage.getItem('gradientStart') || DEFAULT_GRADIENT.start,
    end: localStorage.getItem('gradientEnd') || DEFAULT_GRADIENT.end,
    accent: localStorage.getItem('gradientAccent') || DEFAULT_GRADIENT.accent,
    angle: Number(localStorage.getItem('gradientAngle') || DEFAULT_GRADIENT.angle),
  };
}

function saveGradientPrefs(prefs) {
  localStorage.setItem('gradientStart', prefs.start);
  localStorage.setItem('gradientEnd', prefs.end);
  localStorage.setItem('gradientAccent', prefs.accent);
  localStorage.setItem('gradientAngle', String(prefs.angle));
}

function applyGradientVars(prefs) {
  const root = document.documentElement.style;
  root.setProperty('--gradient-start', prefs.start);
  root.setProperty('--gradient-end', prefs.end);
  root.setProperty('--gradient-accent', prefs.accent);
  root.setProperty('--gradient-angle', `${prefs.angle}deg`);
  $('gradient-start').value = prefs.start;
  $('gradient-end').value = prefs.end;
  $('gradient-accent').value = prefs.accent;
  $('gradient-angle').value = String(prefs.angle);
  $('gradient-angle-value').textContent = `${prefs.angle}°`;
  $('gradient-preview').style.background = `linear-gradient(${prefs.angle}deg, ${prefs.start}, ${prefs.end})`;
}

function readGradientForm() {
  return {
    start: $('gradient-start').value,
    end: $('gradient-end').value,
    accent: $('gradient-accent').value,
    angle: Number($('gradient-angle').value),
  };
}

function syncTerminalThemes(themeId) {
  const terminalTheme = { ...TERMINAL_THEMES[themeId] };
  const terminalBg = getComputedStyle(document.documentElement).getPropertyValue('--terminal-bg').trim();
  if (terminalBg) terminalTheme.background = terminalBg;
  for (const tab of tabs) tab.terminal.options.theme = terminalTheme;
}

function applyTheme(themeId) {
  const theme = TERMINAL_THEMES[themeId] ? themeId : 'dark';
  document.documentElement.dataset.theme = theme;
  $('gradient-options').hidden = theme !== 'gradient';
  document.querySelectorAll('.theme-option').forEach(button => {
    const active = button.dataset.theme === theme;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  if (theme === 'gradient') applyGradientVars(loadGradientPrefs());
  syncTerminalThemes(theme);
  localStorage.setItem('workspaceTheme', theme);
  resizeActiveTab();
}

document.querySelectorAll('.theme-option').forEach(button => {
  button.onclick = () => applyTheme(button.dataset.theme);
});

function updateGradientTheme() {
  const prefs = readGradientForm();
  saveGradientPrefs(prefs);
  applyGradientVars(prefs);
  if (document.documentElement.dataset.theme === 'gradient') syncTerminalThemes('gradient');
}

for (const id of ['gradient-start', 'gradient-end', 'gradient-accent', 'gradient-angle']) {
  $(id).addEventListener('input', updateGradientTheme);
}

applyTheme(TERMINAL_THEMES[localStorage.getItem('workspaceTheme')] ? localStorage.getItem('workspaceTheme') : 'dark');

async function loadSettings() {
  try {
    const data = await api('/api/settings');
    $('notes-directory').value = data.notesDirectory;
    $('location-status').textContent = `Current folder: ${data.notesDirectory}`;
  } catch (error) {
    $('location-status').textContent = error.message === 'Not found' ? 'Restart Workspace to enable save-folder settings.' : error.message;
  }
}
$('location-form').onsubmit = async event => {
  event.preventDefault();
  const button = $('apply-location');
  button.disabled = true;
  try {
    if (saving) throw new Error('Notes are still saving. Try again in a moment.');
    await save();
    if (dirty) throw new Error('Save your notes successfully before changing folders.');
    const data = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ notesDirectory: $('notes-directory').value }) });
    $('notes-directory').value = data.notesDirectory;
    await refreshNotesFiles(data.activeNotesFile || currentNotesFile);
    await openNotesFile(currentNotesFile);
    $('location-status').textContent = `Saved. Current folder: ${data.notesDirectory}`;
  } catch (error) {
    $('location-status').textContent = error.message;
  } finally {
    button.disabled = false;
  }
};

$('restart-app').onclick = async () => {
  if (!confirm('Restart the app? Your notes will be saved. The current terminal session and running commands will end.')) return;
  const button = $('restart-app');
  button.disabled = true;
  try {
    if (saving) throw new Error('Notes are still saving. Please try again in a moment.');
    await save();
    if (dirty) throw new Error('Notes could not be saved. Restart cancelled.');
    $('restart-status').textContent = 'Restarting…';
    showReloadOverlay('Restarting Noa…', 'Saving notes and reloading workspace');
    showView('terminal');
    sessionStorage.setItem('noaFreshStart', '1');
    localStorage.setItem('workspaceView', 'terminal');
    await api('/api/restart-app', { method: 'POST' });
    for (const tab of tabs) { clearTimeout(tab.reconnect); tab.ws && (tab.ws.onclose = () => {}); tab.ws?.close(); }
    const deadline = Date.now() + 20000;
    const check = async () => {
      try {
        const response = await fetch('/', { cache: 'no-store' });
        const html = await response.text();
        if (response.ok && !html.includes(`content="${token}"`)) {
          $('reload-overlay-text').textContent = 'Almost ready…';
          document.querySelector('.reload-overlay-hint').textContent = 'Opening terminal';
          setTimeout(() => location.reload(), 400);
          return;
        }
      } catch {}
      if (Date.now() < deadline) setTimeout(check, 750);
      else {
        hideReloadOverlay();
        $('restart-status').textContent = 'The app has not reconnected. Run Start Workspace.cmd, then refresh this page.';
        button.disabled = false;
      }
    };
    setTimeout(check, 1000);
  } catch (error) {
    hideReloadOverlay();
    $('restart-status').textContent = error.message === 'Not found' ? 'Run Restart Workspace.cmd once to activate the new restart button.' : error.message;
    button.disabled = false;
  }
};

const aiState = {
  knowledgeBases: [],
  selectedKbIds: new Set(),
  documents: [],
  conversations: [],
  conversationId: null,
  generating: false,
  indexPoll: null,
  selectedSource: null,
};

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function loadNoaAI() {
  await Promise.all([refreshAiKnowledge(), refreshAiStatus(), refreshAiConversations()]);
  if (!aiState.indexPoll) {
    aiState.indexPoll = setInterval(async () => {
      if ($('noa-ai').hidden) return;
      await pollAiIndexing();
    }, 1500);
  }
}

async function refreshAiStatus() {
  try {
    const status = await api('/api/ai/status');
    $('ai-model-label').textContent = `Model: ${status.llmModel || 'not set'}`;
    $('ai-internet-label').textContent = 'Internet: OFF';
    if (!status.ollamaAvailable) {
      $('ai-model-label').textContent = 'Local AI engine unavailable';
    } else if (!status.llmInstalled) {
      $('ai-model-label').textContent = 'Select a model in Settings → Noa AI';
    }
  } catch { /* ignore */ }
}

async function refreshAiKnowledge() {
  const data = await api('/api/ai/knowledge');
  aiState.knowledgeBases = data.knowledgeBases || [];
  if (!aiState.selectedKbIds.size && aiState.knowledgeBases.length) {
    const first = aiState.knowledgeBases.find(kb => kb.enabled) || aiState.knowledgeBases[0];
    if (first) aiState.selectedKbIds.add(first.id);
  }
  renderAiKnowledgeBases();
  const kbId = [...aiState.selectedKbIds][0];
  if (kbId) await refreshAiDocuments(kbId);
}

function renderAiKnowledgeBases() {
  const list = $('ai-kb-list');
  list.innerHTML = '';
  if (!aiState.knowledgeBases.length) {
    list.innerHTML = '<p class="ai-empty">No knowledge added yet. Create a knowledge base to start.</p>';
    return;
  }
  for (const kb of aiState.knowledgeBases) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `ai-kb-item${aiState.selectedKbIds.has(kb.id) ? ' active' : ''}${kb.enabled ? '' : ' disabled'}`;
    btn.innerHTML = `<span>●</span><span>${escapeHtml(kb.name)}</span>`;
    btn.title = `${kb.document_count} documents, ${kb.chunk_count} chunks`;
    btn.onclick = () => {
      aiState.selectedKbIds.clear();
      aiState.selectedKbIds.add(kb.id);
      renderAiKnowledgeBases();
      refreshAiDocuments(kb.id);
    };
    btn.oncontextmenu = event => {
      event.preventDefault();
      const action = prompt('Rename knowledge base, or type DELETE to remove:', kb.name);
      if (!action) return;
      if (action.toUpperCase() === 'DELETE') {
        api(`/api/ai/knowledge/${kb.id}`, { method: 'DELETE' }).then(() => refreshAiKnowledge());
      } else {
        api(`/api/ai/knowledge/${kb.id}`, { method: 'PATCH', body: JSON.stringify({ name: action }) }).then(() => refreshAiKnowledge());
      }
    };
    list.appendChild(btn);
  }
}

function documentStatusLabel(doc) {
  if (doc.status === 'indexing') return '◌ Indexing';
  if (doc.status === 'error' || doc.status === 'scanned_ocr_required') return '⚠ Failed';
  if (doc.status === 'pending' || !doc.indexed_at) return '○ Not indexed';
  if ((doc.chunk_count ?? 0) === 0) return '⚠ Failed';
  return '● Ready';
}

function documentStatusTitle(doc, embeddingModel) {
  const lines = [
    `status: ${doc.status}`,
    `chunks: ${doc.chunk_count ?? 0}`,
    `indexed: ${doc.indexed_at || 'never'}`,
    `embedding model: ${embeddingModel || 'not set'}`,
  ];
  if (doc.error_message) lines.push(`error: ${doc.error_message}`);
  return lines.join('\n');
}

async function refreshAiDocuments(kbId) {
  const data = await api(`/api/ai/knowledge/${kbId}/documents`);
  aiState.documents = data.documents || [];
  aiState.embeddingModel = data.embeddingModel || '';
  const list = $('ai-doc-list');
  if (!aiState.documents.length) {
    list.innerHTML = '<p class="ai-empty">Add documents or a folder to teach Noa about your files.</p>';
    return;
  }
  list.innerHTML = aiState.documents.map(doc => `
    <div class="ai-doc-item">
      <span class="ai-doc-status" title="${escapeHtml(documentStatusTitle(doc, aiState.embeddingModel))}">${documentStatusLabel(doc)} ${escapeHtml(doc.filename)}</span>
      <button type="button" data-doc-id="${escapeHtml(doc.id)}">Remove</button>
    </div>`).join('');
  list.querySelectorAll('button[data-doc-id]').forEach(button => {
    button.onclick = async () => {
      await api(`/api/ai/documents/${button.dataset.docId}`, { method: 'DELETE' });
      await refreshAiDocuments(kbId);
      await refreshAiKnowledge();
    };
  });
}

async function pollAiIndexing() {
  const progress = await api('/api/ai/indexing/status');
  const box = $('ai-index-progress');
  if (!progress.indexing?.running) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const pct = progress.indexing.total ? Math.round((progress.indexing.current / progress.indexing.total) * 100) : 0;
  $('ai-index-label').textContent = `${progress.indexing.phase || 'Indexing'} — ${progress.indexing.filename || ''} (${progress.indexing.current}/${progress.indexing.total})`;
  $('ai-index-bar').style.width = `${pct}%`;
}

async function ensureKnowledgeBase() {
  if (aiState.knowledgeBases.length) return [...aiState.selectedKbIds][0] || aiState.knowledgeBases[0].id;
  const name = prompt('Knowledge base name:', 'My knowledge');
  if (!name) return null;
  const kb = await api('/api/ai/knowledge', { method: 'POST', body: JSON.stringify({ name }) });
  await refreshAiKnowledge();
  aiState.selectedKbIds.add(kb.id);
  return kb.id;
}

$('ai-kb-add').onclick = async () => {
  const name = prompt('Knowledge base name:');
  if (!name) return;
  await api('/api/ai/knowledge', { method: 'POST', body: JSON.stringify({ name }) });
  await refreshAiKnowledge();
};

const aiFileInput = document.createElement('input');
aiFileInput.type = 'file';
aiFileInput.multiple = true;
aiFileInput.accept = '.pdf,.txt,.md,.docx,.json,.yaml,.yml,.js,.mjs,.ts,.py,.ps1,.sh,.css,.html,.xml';
aiFileInput.hidden = true;
document.body.appendChild(aiFileInput);

$('ai-add-files').onclick = async () => {
  const kbId = await ensureKnowledgeBase();
  if (!kbId) return;
  aiFileInput.onchange = async () => {
    const files = [...aiFileInput.files];
    if (!files.length) return;
    const payload = { files: [] };
    for (const file of files) {
      payload.files.push({ name: file.name, data: await fileToBase64(file) });
    }
    await api(`/api/ai/knowledge/${kbId}/documents`, { method: 'POST', body: JSON.stringify(payload) });
    aiFileInput.value = '';
    await refreshAiDocuments(kbId);
    await refreshAiKnowledge();
    pollAiIndexing();
  };
  aiFileInput.click();
};

$('ai-add-folder').onclick = async () => {
  const kbId = await ensureKnowledgeBase();
  if (!kbId) return;
  const folder = prompt('Enter full folder path on this computer:');
  if (!folder) return;
  await api(`/api/ai/knowledge/${kbId}/documents`, { method: 'POST', body: JSON.stringify({ path: folder }) });
  await refreshAiDocuments(kbId);
  await refreshAiKnowledge();
  pollAiIndexing();
};

$('ai-reindex').onclick = async () => {
  const kbId = [...aiState.selectedKbIds][0];
  if (!kbId) return;
  await api(`/api/ai/knowledge/${kbId}/index`, { method: 'POST', body: JSON.stringify({ reindexAll: true }) });
  pollAiIndexing();
};

async function refreshAiConversations() {
  const data = await api('/api/ai/conversations');
  aiState.conversations = data.conversations || [];
  const menu = $('ai-conv-menu');
  menu.innerHTML = '';
  for (const conv of aiState.conversations) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = conv.title;
    btn.onclick = () => openAiConversation(conv.id);
    menu.appendChild(btn);
  }
  if (!aiState.conversationId && aiState.conversations[0]) {
    await openAiConversation(aiState.conversations[0].id);
  }
}

async function openAiConversation(id) {
  aiState.conversationId = id;
  const data = await api(`/api/ai/conversations/${id}`);
  $('ai-conv-current').textContent = data.conversation.title;
  $('ai-conv-menu').hidden = true;
  renderAiMessages(data.messages || []);
}

function renderAiMessages(messages) {
  const chat = $('ai-chat');
  chat.innerHTML = '';
  for (const message of messages) {
    appendAiMessage(message.role, message.content, message.sources || [], message.meta || {});
  }
}

function groundingBadgeClass(badge) {
  const map = {
    DOCUMENTS: 'documents',
    'DOCUMENTS + MODEL': 'documents-model',
    'MODEL KNOWLEDGE': 'model',
    UNVERIFIED: 'unverified',
    INSUFFICIENT: 'insufficient',
  };
  return map[badge] || 'model';
}

function applyAiGroundingBadge(node, meta = {}) {
  if (!meta.groundingBadge) return;
  let badge = node.querySelector('.ai-grounding-badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'ai-grounding-badge';
    const contentEl = node.querySelector('.ai-message-content');
    node.insertBefore(badge, contentEl || node.firstChild);
  }
  badge.textContent = meta.groundingBadge;
  badge.className = `ai-grounding-badge ai-badge-${groundingBadgeClass(meta.groundingBadge)}`;
}

function appendAiMessage(role, content, sources = [], meta = {}) {
  const node = document.createElement('div');
  node.className = `ai-message ${role}`;
  const contentEl = document.createElement('div');
  contentEl.className = 'ai-message-content';
  contentEl.textContent = content;
  node.appendChild(contentEl);
  if (role === 'assistant') {
    applyAiGroundingBadge(node, meta);
    const actions = document.createElement('div');
    actions.className = 'ai-message-actions';
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.textContent = 'Copy';
    copyBtn.onclick = () => navigator.clipboard.writeText(contentEl.textContent);
    actions.appendChild(copyBtn);
    node.appendChild(actions);
    if (sources.length) renderAiCitations(node, sources);
  }
  $('ai-chat').appendChild(node);
  $('ai-chat').scrollTop = $('ai-chat').scrollHeight;
  return node;
}

function renderAiCitations(node, sources) {
  const block = document.createElement('div');
  block.className = 'ai-citations';
  block.innerHTML = '<strong>Sources</strong>';
  sources.forEach((source, index) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ai-citation';
    btn.innerHTML = `[${index + 1}] ${escapeHtml(source.filename || 'document')}<br><small>${escapeHtml(source.section || '')}${source.page_number ? ` · Page ${source.page_number}` : ''}</small>`;
    btn.onclick = () => showAiSourceDetail(source);
    block.appendChild(btn);
  });
  node.appendChild(block);
  renderAiSourcesPanel(sources);
}

function renderAiSourcesPanel(sources, { groundingMode, groundingBadge, freshnessSensitive } = {}) {
  const panel = $('ai-sources');
  panel.innerHTML = '';
  if (groundingMode === 'model-only') {
    const block = document.createElement('div');
    block.className = 'ai-sources-grounding';
    const badge = document.createElement('p');
    badge.className = 'ai-sources-badge';
    badge.textContent = groundingBadge === 'UNVERIFIED' ? 'UNVERIFIED' : 'MODEL KNOWLEDGE';
    block.appendChild(badge);
    const note = document.createElement('p');
    note.className = 'ai-empty';
    note.textContent = 'No document sources used';
    block.appendChild(note);
    if (groundingBadge === 'UNVERIFIED' || freshnessSensitive) {
      const warn = document.createElement('p');
      warn.className = 'ai-freshness-warning';
      warn.textContent = '⚠ Current information not verified';
      block.appendChild(warn);
    }
    panel.appendChild(block);
    return;
  }
  if (!sources?.length) {
    panel.innerHTML = '<p class="ai-empty">No document sources used.</p>';
    return;
  }
  const grouped = new Map();
  for (const source of sources) {
    const key = source.filename || 'document';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(source);
  }
  let index = 1;
  for (const [filename, items] of grouped) {
    const group = document.createElement('div');
    group.className = 'ai-source-group';
    const heading = document.createElement('p');
    heading.className = 'ai-source-group-title';
    heading.textContent = `${filename} — ${items.length} passage${items.length === 1 ? '' : 's'}`;
    group.appendChild(heading);
    for (const source of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ai-citation';
      const label = source.section || (source.page_number ? `Page ${source.page_number}` : `Passage ${index}`);
      btn.innerHTML = `[${index}] ${escapeHtml(label)}`;
      btn.onclick = () => showAiSourceDetail(source);
      group.appendChild(btn);
      index += 1;
    }
    panel.appendChild(group);
  }
}

function showAiSourceDetail(source) {
  aiState.selectedSource = source;
  $('ai-source-detail').hidden = false;
  $('ai-source-meta').innerHTML = `
    <dt>Document</dt><dd>${escapeHtml(source.filename || '')}</dd>
    <dt>Page</dt><dd>${source.page_number || '—'}</dd>
    <dt>Section</dt><dd>${escapeHtml(source.section || '—')}</dd>
    <dt>Relevance</dt><dd>${typeof source.score === 'number' ? source.score.toFixed(2) : '—'}</dd>`;
  $('ai-source-text').textContent = source.content || '';
}

$('ai-source-copy').onclick = () => {
  if (aiState.selectedSource?.content) navigator.clipboard.writeText(aiState.selectedSource.content);
};

$('ai-conv-trigger').onclick = () => {
  $('ai-conv-menu').hidden = !$('ai-conv-menu').hidden;
};

$('ai-conv-new').onclick = async () => {
  aiState.conversationId = null;
  $('ai-conv-current').textContent = 'New conversation';
  $('ai-chat').innerHTML = '';
  $('ai-sources').innerHTML = '<p class="ai-empty">Retrieved sources appear here.</p>';
};

$('ai-local-badge').onclick = async () => {
  const status = await api('/api/ai/status');
  alert(`AI engine: Local (Ollama)\nEmbedding model: ${status.embeddingModel || 'not set'}\nKnowledge database: Local\nCloud AI: Disabled\nInternet required: No`);
};

$('ai-chat-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (aiState.generating) return;
  const message = $('ai-input').value.trim();
  if (!message) return;
  const kbIds = [...aiState.selectedKbIds];
  appendAiMessage('user', message);
  $('ai-input').value = '';
  aiState.generating = true;
  $('ai-stop').hidden = false;
  const assistantNode = appendAiMessage('assistant', 'Generating…');
  const assistantMeta = {};
  let fullText = '';
  try {
    const response = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'X-Workspace-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stream: true,
        message,
        conversationId: aiState.conversationId,
        knowledgeBaseIds: kbIds,
        answerMode: $('ai-answer-mode').value,
      }),
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const assistantContent = assistantNode.querySelector('.ai-message-content');
    if (assistantContent) assistantContent.textContent = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';
      for (const part of parts) {
        const lines = part.split('\n');
        let event = 'message';
        let data = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) event = line.slice(7);
          if (line.startsWith('data: ')) data += line.slice(6);
        }
        if (!data) continue;
        const payload = JSON.parse(data);
        if (event === 'meta') {
          aiState.conversationId = payload.conversationId;
          aiState.groundingMode = payload.groundingMode;
          assistantMeta.groundingBadge = payload.groundingBadge;
          assistantMeta.freshnessSensitive = payload.freshnessSensitive;
          assistantMeta.possiblyStale = payload.possiblyStale;
          applyAiGroundingBadge(assistantNode, assistantMeta);
          renderAiSourcesPanel(payload.sources || [], {
            groundingMode: payload.groundingMode,
            groundingBadge: payload.groundingBadge,
            freshnessSensitive: payload.freshnessSensitive,
          });
        }
        if (event === 'token') {
          fullText += payload.text || '';
          const contentEl = assistantNode.querySelector('.ai-message-content');
          if (contentEl) contentEl.textContent = fullText;
          $('ai-chat').scrollTop = $('ai-chat').scrollHeight;
        }
        if (event === 'done') {
          aiState.groundingMode = payload.groundingMode;
          assistantMeta.groundingBadge = payload.groundingBadge || assistantMeta.groundingBadge;
          assistantMeta.freshnessSensitive = payload.freshnessSensitive ?? assistantMeta.freshnessSensitive;
          assistantMeta.possiblyStale = payload.possiblyStale ?? assistantMeta.possiblyStale;
          applyAiGroundingBadge(assistantNode, assistantMeta);
          if (payload.sources?.length) renderAiCitations(assistantNode, payload.sources);
          else {
            renderAiSourcesPanel([], {
              groundingMode: payload.groundingMode,
              groundingBadge: payload.groundingBadge,
              freshnessSensitive: payload.freshnessSensitive,
            });
          }
          refreshAiConversations();
        }
        if (event === 'error') {
          const contentEl = assistantNode.querySelector('.ai-message-content');
          if (contentEl) contentEl.textContent = payload.error || 'Generation failed.';
        }
      }
    }
  } catch (error) {
    const contentEl = assistantNode.querySelector('.ai-message-content');
    if (contentEl) contentEl.textContent = error.message || 'Could not reach local AI.';
  } finally {
    aiState.generating = false;
    $('ai-stop').hidden = true;
  }
});

$('ai-input').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    $('ai-chat-form').requestSubmit();
  }
});

$('ai-stop').onclick = async () => {
  await api('/api/ai/chat/cancel', { method: 'POST', body: '{}' });
  aiState.generating = false;
  $('ai-stop').hidden = true;
};

async function loadAiSettings() {
  try {
    const [settings, status] = await Promise.all([api('/api/ai/settings'), api('/api/ai/status')]);
    $('ai-settings-ollama').value = settings.ollamaBaseUrl || 'http://127.0.0.1:11434';
    $('ai-settings-citations').checked = Boolean(settings.showCitations);
    $('ai-settings-require-sources').checked = Boolean(settings.requireSources);
    $('ai-settings-data-path').textContent = settings.dataLocation || '—';
    const llm = $('ai-settings-llm');
    const embed = $('ai-settings-embed');
    const chatModels = status.chatModels || status.models || [];
    const embeddingModels = status.embeddingModels || [];
    llm.innerHTML = '<option value="">Select a chat model…</option>' + chatModels.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
    embed.innerHTML = '<option value="">Select an embedding model…</option>' + embeddingModels.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
    if (settings.llmModel) llm.value = settings.llmModel;
    const embedValue = status.resolvedEmbeddingModel || settings.embeddingModel;
    if (embedValue) embed.value = embedValue;
    const lines = [];
    if (!status.ollamaAvailable) lines.push('Ollama is not running. Install Ollama and start it on this PC.');
    else {
      lines.push(`LLM: ${status.llmInstalled ? 'Installed' : 'Not installed'}`);
      if (!status.embedModelValid) lines.push('Embedding model invalid — choose nomic-embed-text');
      else lines.push(`Embeddings: ${status.embedInstalled ? 'Installed' : 'Not installed'}`);
      if (status.embeddingSmokeTest?.ok) lines.push(`${status.embeddingSmokeTest.dimensions}-dim vectors OK`);
      else if (status.embeddingSmokeTest?.error) lines.push(`Embedding test failed: ${status.embeddingSmokeTest.error}`);
    }
    $('ai-settings-status').textContent = lines.join(' · ');
  } catch {
    $('ai-settings-status').textContent = 'Could not load AI settings.';
  }
}

async function saveAiSettings() {
  await api('/api/ai/settings', {
    method: 'PUT',
    body: JSON.stringify({
      ollamaBaseUrl: $('ai-settings-ollama').value.trim(),
      llmModel: $('ai-settings-llm').value,
      embeddingModel: $('ai-settings-embed').value,
      showCitations: $('ai-settings-citations').checked,
      requireSources: $('ai-settings-require-sources').checked,
      answerMode: $('ai-answer-mode').value,
    }),
  });
  await refreshAiStatus();
}

['ai-settings-llm', 'ai-settings-embed', 'ai-settings-ollama', 'ai-settings-citations', 'ai-settings-require-sources'].forEach(id => {
  $(id)?.addEventListener('change', () => saveAiSettings().catch(() => {}));
});

loadNotes();
if (sessionStorage.getItem('noaFreshStart')) {
  sessionStorage.removeItem('noaFreshStart');
  localStorage.setItem('workspaceView', 'terminal');
  showView('terminal');
} else {
  const savedView = localStorage.getItem('workspaceView');
  if (savedView && WORKSPACE_VIEWS.includes(savedView)) showView(savedView);
  else showView(localStorage.getItem('notesOpen') === 'true' ? 'notes' : 'terminal');
}
loadSettings();
loadInfraScripts();
initTabs().catch(error => { $('connection').textContent = error.message || 'Could not start terminals'; });
