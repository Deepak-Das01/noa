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
let saveTimer, dirty = false, saving = false, loaded = false;

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

async function initTabs() {
  const data = await api('/api/sessions');
  const existing = data.sessions || [];
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
  try {
    await api(`/api/sessions/${tab.id}/restart`, { method: 'POST' });
    tab.exited = false;
    tab.terminal.reset();
    updateTabControls();
    tab.terminal.focus();
  } catch {
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

const WORKSPACE_VIEWS = ['terminal', 'notes', 'infrastructure', 'settings'];

function showView(view) {
  const active = WORKSPACE_VIEWS.includes(view) ? view : 'terminal';
  $('terminal-panel').hidden = active !== 'terminal';
  $('notes').hidden = active !== 'notes';
  $('infrastructure').hidden = active !== 'infrastructure';
  $('settings').hidden = active !== 'settings';
  $('terminal-tab').classList.toggle('active', active === 'terminal');
  $('terminal-tab').setAttribute('aria-pressed', String(active === 'terminal'));
  $('toggle').classList.toggle('active', active === 'notes');
  $('toggle').setAttribute('aria-pressed', String(active === 'notes'));
  $('toggle').setAttribute('aria-expanded', String(active === 'notes'));
  $('infrastructure-tab').classList.toggle('active', active === 'infrastructure');
  $('infrastructure-tab').setAttribute('aria-pressed', String(active === 'infrastructure'));
  $('settings-tab').classList.toggle('active', active === 'settings');
  $('settings-tab').setAttribute('aria-pressed', String(active === 'settings'));
  localStorage.setItem('workspaceView', active);
  if (active === 'terminal') requestAnimationFrame(resizeActiveTab);
  if (active === 'notes') { save(); $('editor').focus(); }
  else if (active === 'terminal') activeTab()?.terminal.focus();
  if (active === 'infrastructure') loadInfrastructure();
  if (active === 'settings') {
    loadReadme();
    startSystemMonitor();
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
$('infrastructure-tab').onclick = () => showView('infrastructure');

document.addEventListener('keydown', event => {
  if (event.ctrlKey && event.shiftKey && event.code === 'KeyN') {
    event.preventDefault();
    showView($('notes').hidden ? 'notes' : 'terminal');
  }
  if (event.ctrlKey && event.code === 'KeyS' && !$('notes').hidden) { event.preventDefault(); save(); }
});

function count() {
  const n = $('editor').value.trim().split(/\s+/).filter(Boolean).length;
  $('count').textContent = `${n} ${n === 1 ? 'word' : 'words'}`;
}

async function save() {
  clearTimeout(saveTimer);
  if (!loaded || !dirty || saving) return;
  saving = true;
  dirty = false;
  $('saved').textContent = 'Saving…';
  const text = $('editor').value;
  try {
    await api('/api/notes', { method: 'PUT', body: JSON.stringify({ text }), keepalive: true });
    $('saved').textContent = dirty ? 'Unsaved' : 'Saved';
  } catch {
    dirty = true;
    $('saved').textContent = 'Save failed · retrying';
  } finally {
    saving = false;
    if (dirty) saveTimer = setTimeout(save, 1500);
  }
}

$('editor').addEventListener('input', () => {
  dirty = true;
  count();
  $('saved').textContent = 'Unsaved';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 400);
});
document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
window.addEventListener('beforeunload', event => {
  if (dirty || saving) { save(); event.preventDefault(); event.returnValue = ''; }
});

async function loadNotes() {
  try {
    const data = await api('/api/notes');
    $('editor').value = data.text;
    loaded = true;
    $('editor').disabled = false;
    $('saved').textContent = 'Saved';
    count();
    updateEditor();
  } catch {
    $('saved').textContent = 'Load failed · retrying';
    setTimeout(loadNotes, 2000);
  }
}

$('save').onclick = () => save();
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
$('download').onclick = () => {
  const url = URL.createObjectURL(new Blob([$('editor').value], { type: 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'notes.md';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
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
  if (seconds == null || seconds < 0) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
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
    $('location-status').textContent = `Current file: ${data.notesFile}`;
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
    $('location-status').textContent = `Saved. Current file: ${data.notesFile}`;
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
    await api('/api/restart-app', { method: 'POST' });
    for (const tab of tabs) { clearTimeout(tab.reconnect); tab.ws && (tab.ws.onclose = () => {}); tab.ws?.close(); }
    const deadline = Date.now() + 20000;
    const check = async () => {
      try {
        const response = await fetch('/', { cache: 'no-store' });
        const html = await response.text();
        if (response.ok && !html.includes(`content="${token}"`)) { location.reload(); return; }
      } catch {}
      if (Date.now() < deadline) setTimeout(check, 750);
      else {
        $('restart-status').textContent = 'The app has not reconnected. Run Start Workspace.cmd, then refresh this page.';
        button.disabled = false;
      }
    };
    setTimeout(check, 1000);
  } catch (error) {
    $('restart-status').textContent = error.message === 'Not found' ? 'Run Restart Workspace.cmd once to activate the new restart button.' : error.message;
    button.disabled = false;
  }
};

loadNotes();
const savedView = localStorage.getItem('workspaceView');
if (savedView && WORKSPACE_VIEWS.includes(savedView)) showView(savedView);
else showView(localStorage.getItem('notesOpen') === 'true' ? 'notes' : 'terminal');
loadSettings();
initTabs().catch(error => { $('connection').textContent = error.message || 'Could not start terminals'; });
