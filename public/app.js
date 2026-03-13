/**
 * DevAgent — Claude Code-style Chat Interface
 */

class DevAgentApp {
  constructor() {
    this.token       = localStorage.getItem('devagent_token');
    this.settings    = JSON.parse(localStorage.getItem('devagent_settings') || '{}');
    this.conversations = this.loadConversations();
    this.currentConvId  = null;
    this.currentConvWorkspace = null; // server-side workspace path returned by AGENT_STARTED
    this.ws            = null;
    this.wsReconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.isAgentRunning = false;
    this.pendingAuthRequest = null;

    this.init();
  }

  // ═══════════════════════════════════════════
  // INITIALIZATION
  // ═══════════════════════════════════════════

  init() {
    if (this.token) {
      const initialToken = this.token;
      this.verifyToken().then(valid => {
        if (this.token !== initialToken) return;
        if (valid) {
          this.enterApp();
        } else {
          this.token = null;
          localStorage.removeItem('devagent_token');
          this.showScreen('login-screen');
        }
      });
    } else {
      this.showScreen('login-screen');
    }
    this.setupLoginForm();
  }

  enterApp() {
    this.showScreen('app-screen');
    this.loadSettingsFromServer();
    this.renderSidebar();
    this.connectWebSocket();
    this.setupAppListeners();
  }

  setupAppListeners() {
    // Sidebar buttons
    document.getElementById('new-chat-btn')
      .addEventListener('click', () => this.newChat());
    document.getElementById('welcome-new-chat')
      ?.addEventListener('click', () => this.newChat());

    // Settings
    document.getElementById('settings-btn')
      .addEventListener('click', () => this.openSettings());
    document.getElementById('settings-close')
      .addEventListener('click', () => this.closeSettings());
    document.getElementById('settings-cancel')
      .addEventListener('click', () => this.closeSettings());
    document.getElementById('settings-overlay')
      .addEventListener('click', () => this.closeSettings());
    document.getElementById('settings-form')
      .addEventListener('submit', e => { e.preventDefault(); this.saveSettings(); });

    // Logout / Stop / Download
    document.getElementById('logout-btn')
      .addEventListener('click', () => this.logout());
    document.getElementById('stop-agent-btn')
      .addEventListener('click', () => this.stopAgent());
    document.getElementById('download-workspace-btn')
      .addEventListener('click', () => this.downloadWorkspace());

    // Path input — sync to conversation on change
    const pathInput = document.getElementById('chat-path-input');
    pathInput?.addEventListener('change', () => {
      const conv = this.getCurrentConv();
      if (conv) {
        conv.projectPath = pathInput.value.trim();
        this.saveConversations();
        document.getElementById('chat-project-path').textContent =
          conv.projectPath ? `📁 ${conv.projectPath}` : '⚠️ No project path set';
      }
    });

    // Input
    const textarea = document.getElementById('chat-input');
    const sendBtn  = document.getElementById('send-btn');
    textarea.addEventListener('input', () => this.autoResizeTextarea(textarea));
    textarea.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });
    sendBtn.addEventListener('click', () => this.sendMessage());
  }

  // ═══════════════════════════════════════════
  // AUTH
  // ═══════════════════════════════════════════

  async verifyToken() {
    try {
      const res  = await fetch('/api/projects', {
        headers: { Authorization: `Bearer ${this.token}` }
      });
      const data = await res.json();
      return data.success;
    } catch { return false; }
  }

  setupLoginForm() {
    const form = document.getElementById('login-form');
    if (!form) return;

    form.addEventListener('submit', async e => {
      e.preventDefault();
      const password  = document.getElementById('password').value;
      const errorEl   = document.getElementById('login-error');
      const submitBtn = form.querySelector('button[type="submit"]');

      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span class="spinner"></span>';
      errorEl.textContent = '';

      try {
        const res  = await fetch('/api/login', {
          method : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body   : JSON.stringify({ password })
        });
        const data = await res.json();
        console.log('Login response:', data);

        if (data.success) {
          this.token = data.token;
          localStorage.setItem('devagent_token', data.token);
          this.enterApp();
        } else {
          errorEl.textContent = data.error || 'Invalid password';
        }
      } catch {
        errorEl.textContent = 'Connection error. Please try again.';
      } finally {
        submitBtn.disabled = false;
        submitBtn.innerHTML =
          '<span class="btn-text">Access DevAgent</span><span class="btn-icon">→</span>';
      }
    });
  }

  logout() {
    this.token = null;
    localStorage.removeItem('devagent_token');
    if (this.ws) this.ws.close();
    this.showScreen('login-screen');
  }

  // ═══════════════════════════════════════════
  // SETTINGS
  // ═══════════════════════════════════════════

  async loadSettingsFromServer() {
    try {
      const res  = await fetch('/api/settings', {
        headers: { Authorization: `Bearer ${this.token}` }
      });
      const data = await res.json();
      if (data.success) {
        this.settings = data.settings;
        localStorage.setItem('devagent_settings', JSON.stringify(data.settings));
      }
    } catch {
      this.settings = JSON.parse(localStorage.getItem('devagent_settings') || '{}');
    }
  }

  openSettings() {
    const s = this.settings || {};
    document.getElementById('settings-path').value = s.projectPath || '';
    document.getElementById('settings-modal').classList.add('active');
  }

  closeSettings() {
    document.getElementById('settings-modal').classList.remove('active');
  }

  async saveSettings() {
    const settings = {
      projectPath: document.getElementById('settings-path').value.trim()
    };
    try {
      const res  = await fetch('/api/settings', {
        method : 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
        body   : JSON.stringify(settings)
      });
      const data = await res.json();
      if (data.success) {
        this.settings = settings;
        localStorage.setItem('devagent_settings', JSON.stringify(settings));
        this.closeSettings();
        this.showToast('Settings saved', 'success');
      } else {
        this.showToast('Failed to save settings', 'error');
      }
    } catch {
      this.settings = settings;
      localStorage.setItem('devagent_settings', JSON.stringify(settings));
      this.closeSettings();
      this.showToast('Settings saved locally', 'info');
    }
  }

  // ═══════════════════════════════════════════
  // CONVERSATIONS
  // ═══════════════════════════════════════════

  loadConversations() {
    try { return JSON.parse(localStorage.getItem('devagent_conversations') || '[]'); }
    catch { return []; }
  }

  saveConversations() {
    localStorage.setItem('devagent_conversations', JSON.stringify(this.conversations));
  }

  newChat() {
    const conv = {
      id         : `conv-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      title      : 'New conversation',
      createdAt  : new Date().toISOString(),
      projectPath: this.settings?.projectPath || '',
      messages   : []
    };
    this.conversations.unshift(conv);
    this.saveConversations();
    this.renderSidebar();
    this.openConversation(conv.id);
    document.getElementById('chat-input').focus();
  }

  openConversation(id) {
    this.currentConvId = id;

    document.querySelectorAll('.chat-item').forEach(el =>
      el.classList.toggle('active', el.dataset.convId === id)
    );

    const conv = this.conversations.find(c => c.id === id);
    if (!conv) return;

    // Show chat layout
    document.getElementById('welcome-view').style.display = 'none';
    document.getElementById('chat-view').style.display    = 'flex';
    document.getElementById('input-area').style.display   = 'block';

    // Populate per-chat path input
    const pathInput = document.getElementById('chat-path-input');
    if (pathInput) pathInput.value = conv.projectPath || '';

    // Header path — prefer the resolved workspace path saved on the conv
    const displayPath = conv.workspacePath || conv.projectPath || '';
    document.getElementById('chat-project-path').textContent =
      displayPath ? `📁 ${displayPath}` : '⚠️ No workspace yet';

    // Show/hide download button
    const dlBtn = document.getElementById('download-workspace-btn');
    if (dlBtn) dlBtn.style.display = conv.workspacePath ? 'inline-flex' : 'none';

    // Render messages
    const container = document.getElementById('messages-container');
    container.innerHTML = '';
    conv.messages.forEach(msg => this.renderMessage(msg, container));
    container.scrollTop = container.scrollHeight;
  }

  getCurrentConv() {
    return this.conversations.find(c => c.id === this.currentConvId);
  }

  updateConvTitle(conv, text) {
    if (conv.title === 'New conversation') {
      conv.title = text.length > 50 ? text.substring(0, 50) + '…' : text;
      this.renderSidebar();
      document.querySelectorAll('.chat-item').forEach(el =>
        el.classList.toggle('active', el.dataset.convId === this.currentConvId)
      );
    }
  }

  renderSidebar() {
    const list  = document.getElementById('chat-list');
    const empty = document.getElementById('chat-list-empty');

    if (this.conversations.length === 0) {
      list.innerHTML = '';
      if (empty) empty.style.display = 'block';
      return;
    }
    if (empty) empty.style.display = 'none';

    list.innerHTML = this.conversations.map(conv => `
      <div class="chat-item ${conv.id === this.currentConvId ? 'active' : ''}"
           data-conv-id="${conv.id}">
        <div class="chat-item-title">${this.escHtml(conv.title)}</div>
        <div class="chat-item-meta">
          <span class="chat-item-date">${this.relativeTime(conv.createdAt)}</span>
          <button class="chat-item-delete" data-conv-id="${conv.id}" title="Delete">×</button>
        </div>
      </div>
    `).join('');

    list.querySelectorAll('.chat-item').forEach(el => {
      el.addEventListener('click', e => {
        if (e.target.classList.contains('chat-item-delete')) return;
        this.openConversation(el.dataset.convId);
      });
    });
    list.querySelectorAll('.chat-item-delete').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        this.deleteConversation(btn.dataset.convId);
      });
    });
  }

  deleteConversation(id) {
    this.conversations = this.conversations.filter(c => c.id !== id);
    this.saveConversations();
    if (this.currentConvId === id) {
      this.currentConvId = null;
      document.getElementById('welcome-view').style.display = '';
      document.getElementById('chat-view').style.display    = 'none';
      document.getElementById('input-area').style.display   = 'none';
    }
    this.renderSidebar();
  }

  // ═══════════════════════════════════════════
  // MESSAGES
  // ═══════════════════════════════════════════

  sendMessage() {
    if (this.isAgentRunning) {
      this.showToast('Agent is already running', 'warning');
      return;
    }
    const textarea = document.getElementById('chat-input');
    const text     = textarea.value.trim();
    if (!text) return;

    if (!this.currentConvId) this.newChat();

    const conv = this.getCurrentConv();
    if (!conv) return;

    // Read per-chat project path (optional — empty → server auto-creates workspace)
    const pathInput   = document.getElementById('chat-path-input');
    const projectPath = pathInput?.value.trim() || conv.projectPath || '';

    // Persist path to conversation (may be empty — that's fine)
    conv.projectPath = projectPath;

    // Update header (will be replaced with real workspace path once AGENT_STARTED arrives)
    document.getElementById('chat-project-path').textContent =
      projectPath ? `📁 ${projectPath}` : '⏳ Creating workspace…';

    this.updateConvTitle(conv, text);

    const userMsg = {
      id       : `msg-${Date.now()}`,
      role     : 'user',
      type     : 'text',
      content  : text,
      timestamp: new Date().toISOString()
    };
    conv.messages.push(userMsg);
    this.saveConversations();

    const container = document.getElementById('messages-container');
    this.renderMessage(userMsg, container);
    container.scrollTop = container.scrollHeight;

    textarea.value        = '';
    textarea.style.height = 'auto';

    const model    = document.getElementById('model-select').value;
    const autonomy = document.getElementById('autonomy-select').value;
    this.startAgent(text, model, autonomy, projectPath);
  }

  addAgentMessage(type, content, data = {}) {
    const conv = this.getCurrentConv();
    if (!conv) return null;

    const msg = {
      id       : `msg-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      role     : 'assistant',
      type,
      content,
      data,
      timestamp: new Date().toISOString()
    };
    conv.messages.push(msg);
    this.saveConversations();

    const container = document.getElementById('messages-container');
    const el = this.renderMessage(msg, container);
    container.scrollTop = container.scrollHeight;
    return el;
  }

  renderMessage(msg, container) {
    const el = document.createElement('div');
    el.dataset.msgId = msg.id;

    if (msg.role === 'user') {
      el.className = 'message-user';
      el.innerHTML = `
        <div class="message-bubble">${this.escHtml(msg.content)}</div>`;

    } else if (msg.type === 'progress') {
      el.className = 'message-assistant';
      el.innerHTML = `
        <div class="progress-entry">
          <span class="progress-emoji">${this.escHtml(msg.data?.emoji || '·')}</span>
          <span class="progress-text">${this.escHtml(msg.content)}</span>
        </div>`;

    } else if (msg.type === 'tool-block') {
      const iconMap = { write: '📝', read: '👁', bash: '⚡', delete: '🗑' };
      const icon    = iconMap[msg.data?.action] || '📄';
      el.className  = 'message-assistant';
      el.innerHTML  = `
        <div class="tool-block">
          <div class="tool-block-header">
            <span class="tool-block-icon">${icon}</span>
            <span class="tool-block-path">${this.escHtml(msg.data?.path || '')}</span>
            <span class="tool-block-action">${this.escHtml(msg.data?.action || '')}</span>
          </div>
          ${msg.data?.preview
            ? `<div class="tool-block-content">${this.escHtml(msg.data.preview)}</div>`
            : ''}
        </div>`;

    } else if (msg.type === 'auth-request') {
      el.className = 'message-assistant';
      const files  = msg.data?.files || [];
      const reqId  = msg.data?.requestId || '';
      el.innerHTML = `
        <div class="auth-panel">
          <div class="auth-panel-header">🔐 Authorization Required</div>
          <p style="font-size:.85rem;color:var(--text-secondary);margin-bottom:10px;">
            The agent wants to modify ${files.length} file(s):
          </p>
          <div class="auth-files-list">
            ${files.map(f => `
              <div class="auth-file-item">
                <input type="checkbox" class="auth-file-check" data-path="${this.escHtml(f.path)}" checked>
                <span class="auth-file-path">${this.escHtml(f.path)}</span>
                <span class="auth-file-action">${this.escHtml(f.action || '')}</span>
              </div>`).join('')}
          </div>
          <textarea class="auth-feedback" placeholder="Feedback (optional)" rows="2"></textarea>
          <div class="auth-actions">
            <button class="btn btn-danger btn-sm auth-reject-btn">✗ Reject</button>
            <button class="btn btn-primary btn-sm auth-approve-btn">✓ Approve</button>
          </div>
        </div>`;

      setTimeout(() => {
        el.querySelector('.auth-approve-btn')
          ?.addEventListener('click', () => this.handleAuthResponse(true, el, reqId));
        el.querySelector('.auth-reject-btn')
          ?.addEventListener('click', () => this.handleAuthResponse(false, el, reqId));
      }, 0);

    } else if (msg.type === 'completion') {
      const s         = msg.data?.summary || msg.data || {};
      const iters     = s.iterations    ?? '—';
      const files     = s.filesChanged?.length ?? '—';
      const deployUrl = s.deployUrl || msg.data?.deployUrl;
      const convId    = this.currentConvId;
      el.className    = 'message-assistant';
      el.innerHTML    = `
        <div class="completion-card">
          <div class="completion-card-header">✅ Task Complete</div>
          <div class="completion-stats">
            <div class="completion-stat">
              <div class="completion-stat-value">${iters}</div>
              <div class="completion-stat-label">Iterations</div>
            </div>
            <div class="completion-stat">
              <div class="completion-stat-value">${files}</div>
              <div class="completion-stat-label">Files</div>
            </div>
          </div>
          <div class="completion-actions">
            ${convId ? `<button class="btn btn-primary btn-sm completion-download-btn" data-conv-id="${convId}">⬇ Download files</button>` : ''}
            ${deployUrl ? `<a href="${deployUrl}" target="_blank" rel="noopener" class="btn btn-ghost btn-sm">🌐 View Site</a>` : ''}
          </div>
          <div class="completion-note">Files are stored on the server — download before the server restarts.</div>
        </div>`;

      // Wire up inline download button
      setTimeout(() => {
        el.querySelector('.completion-download-btn')
          ?.addEventListener('click', () => this.downloadWorkspace());
      }, 0);

    } else if (msg.type === 'error') {
      el.className = 'message-assistant';
      el.innerHTML = `<div class="error-card">❌ ${this.escHtml(msg.content)}</div>`;

    } else {
      // Generic text message
      el.className = 'message-assistant';
      el.innerHTML = `
        <div class="message-bubble-assistant">${this.escHtml(msg.content)}</div>
        <span class="message-time">${this.formatTime(msg.timestamp)}</span>`;
    }

    container.appendChild(el);
    return el;
  }

  // ═══════════════════════════════════════════
  // AGENT
  // ═══════════════════════════════════════════

  startAgent(objective, model, autonomy, projectPath) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.showToast('Not connected to server', 'error');
      this.connectWebSocket();
      return;
    }
    this.isAgentRunning = true;
    this.setAgentStatus('running', 'Running');
    document.getElementById('stop-agent-btn').style.display = 'inline-flex';
    document.getElementById('send-btn').disabled = true;
    document.getElementById('chat-input').disabled = true;
    this.showTypingIndicator();

    this.ws.send(JSON.stringify({
      type        : 'START_AGENT',
      objective,
      autonomyLevel: autonomy,
      model,
      token       : this.token,
      project     : {
        id        : this.currentConvId || 'default',
        name      : projectPath ? projectPath.split(/[\\/]/).pop() || 'Project' : 'Project',
        path      : projectPath,
        deployment: { enabled: false, command: '', url: '' },
        testing   : { enabled: false, command: '', puppeteer: false },
        history   : []
      }
    }));
  }

  stopAgent() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'STOP_AGENT' }));
    }
    fetch('/api/agent/stop', {
      method : 'POST',
      headers: { Authorization: `Bearer ${this.token}` }
    }).catch(() => {});
    this.resetAgentUI();
    this.addAgentMessage('progress', 'Agent stopped by user.', { emoji: '⏹' });
    this.setAgentStatus('idle', 'Idle');
  }

  async downloadWorkspace() {
    const conv = this.getCurrentConv();
    const convId = conv?.id || this.currentConvId;
    if (!convId) { this.showToast('No workspace to download', 'warning'); return; }
    try {
      this.showToast('Preparing download…', 'info');
      const res = await fetch(`/api/workspace/${convId}/download`, {
        headers: { Authorization: `Bearer ${this.token}` }
      });
      if (!res.ok) { this.showToast('Workspace not found on server', 'error'); return; }
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `devagent-workspace.tar.gz`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      this.showToast('Download started', 'success');
    } catch (err) {
      this.showToast('Download failed: ' + err.message, 'error');
    }
  }

  resetAgentUI() {
    this.isAgentRunning = false;
    this.removeTypingIndicator();
    document.getElementById('stop-agent-btn').style.display = 'none';
    document.getElementById('send-btn').disabled = false;
    document.getElementById('chat-input').disabled = false;
    document.getElementById('chat-input').focus();
  }

  setAgentStatus(status, label) {
    const el = document.getElementById('agent-status');
    if (!el) return;
    el.className = `agent-status ${status}`;
    el.querySelector('.status-label').textContent = label;
  }

  showTypingIndicator() {
    this.removeTypingIndicator();
    const container = document.getElementById('messages-container');
    if (!container) return;
    const el = document.createElement('div');
    el.id = 'typing-indicator';
    el.className = 'message-assistant';
    el.innerHTML = `
      <div class="typing-indicator">
        <div class="typing-dot"></div>
        <div class="typing-dot"></div>
        <div class="typing-dot"></div>
      </div>`;
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
  }

  removeTypingIndicator() {
    document.getElementById('typing-indicator')?.remove();
  }

  // ═══════════════════════════════════════════
  // WEBSOCKET
  // ═══════════════════════════════════════════

  connectWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(`${protocol}//${location.host}`);

    this.ws.onopen = () => {
      console.log('[WS] Connected');
      this.wsReconnectAttempts = 0;
      this.ws.send(JSON.stringify({ type: 'AUTH', token: this.token }));
    };

    this.ws.onmessage = ev => {
      try { this.handleWebSocketMessage(JSON.parse(ev.data)); }
      catch (e) { console.error('[WS] parse error', e); }
    };

    this.ws.onclose = () => {
      console.log('[WS] Disconnected');
      this.attemptReconnect();
    };

    this.ws.onerror = () => console.error('[WS] Error');
  }

  attemptReconnect() {
    if (this.wsReconnectAttempts >= this.maxReconnectAttempts) {
      this.showToast('Connection lost. Please refresh the page.', 'error');
      return;
    }
    this.wsReconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.wsReconnectAttempts), 30000);
    setTimeout(() => this.connectWebSocket(), delay);
  }

  handleWebSocketMessage(data) {
    console.log('[WS]', data.type);

    switch (data.type) {

      case 'AUTH_SUCCESS': break;
      case 'AUTH_FAILED':  this.logout(); break;

      case 'AGENT_STARTED': {
        this.removeTypingIndicator();
        // Server tells us the real workspace path (auto-created or user-supplied)
        if (data.workspacePath) {
          this.currentConvWorkspace = data.workspacePath;
          const conv = this.getCurrentConv();
          if (conv) {
            conv.workspacePath = data.workspacePath;
            this.saveConversations();
          }
          // Update header + path bar (always reflect the real server workspace)
          document.getElementById('chat-project-path').textContent = `📁 ${data.workspacePath}`;
          const pi = document.getElementById('chat-path-input');
          if (pi) pi.value = data.workspacePath; // overwrite Windows paths etc.
          // Show download button
          const dlBtn = document.getElementById('download-workspace-btn');
          if (dlBtn) dlBtn.style.display = 'inline-flex';
        }
        break;
      }

      case 'PROGRESS': {
        this.removeTypingIndicator();
        const stage = data.stage || '';
        if (['file_write', 'file_read', 'bash', 'file_delete'].includes(stage)) {
          this.addAgentMessage('tool-block', data.message, {
            path   : data.path || data.message,
            action : stage === 'bash'        ? 'bash'
                   : stage === 'file_write'  ? 'write'
                   : stage === 'file_delete' ? 'delete'
                   : 'read',
            preview: data.preview || data.data?.preview
          });
        } else {
          this.addAgentMessage('progress', data.message, { emoji: data.emoji || '·' });
        }
        this.showTypingIndicator();
        break;
      }

      case 'REQUEST_AUTH':
        this.removeTypingIndicator();
        this.setAgentStatus('waiting', 'Awaiting approval');
        this.pendingAuthRequest = data;
        this.addAgentMessage('auth-request', '', {
          files    : data.files,
          requestId: data.requestId
        });
        break;

      case 'READY_FOR_HUMAN':
        this.removeTypingIndicator();
        this.resetAgentUI();
        this.setAgentStatus('success', 'Complete');
        this.addAgentMessage('completion', '', { summary: data.summary });
        break;

      case 'AGENT_COMPLETE':
        this.removeTypingIndicator();
        this.resetAgentUI();
        if (data.result?.success) {
          this.setAgentStatus('success', 'Complete');
          this.addAgentMessage('completion', '', { summary: data.result });
        } else {
          this.setAgentStatus('idle', 'Finished');
          this.addAgentMessage('progress', `Finished: ${data.result?.reason || 'done'}`, { emoji: '✔' });
        }
        break;

      case 'AGENT_ERROR':
        this.removeTypingIndicator();
        this.resetAgentUI();
        this.setAgentStatus('error', 'Error');
        this.addAgentMessage('error', data.error || 'An error occurred');
        break;

      case 'AGENT_STOPPED':
        this.removeTypingIndicator();
        this.resetAgentUI();
        this.setAgentStatus('idle', 'Stopped');
        break;

      case 'ERROR':
        this.removeTypingIndicator();
        this.resetAgentUI();
        this.showToast(data.error, 'error');
        this.addAgentMessage('error', data.error);
        break;

      case 'PONG': break;
    }
  }

  // ═══════════════════════════════════════════
  // AUTH RESPONSE
  // ═══════════════════════════════════════════

  handleAuthResponse(approved, panelEl, requestId) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.showToast('Connection lost. Please refresh the page.', 'error');
      return;
    }

    const checkedFiles = [];
    panelEl.querySelectorAll('.auth-file-check:checked')
      .forEach(cb => checkedFiles.push(cb.dataset.path));

    const feedback = panelEl.querySelector('.auth-feedback')?.value || '';

    this.ws.send(JSON.stringify({
      type     : 'APPROVE_AUTH',
      requestId: requestId || this.pendingAuthRequest?.requestId,
      approved,
      files    : approved ? checkedFiles : [],
      feedback
    }));

    // Replace auth panel inline with a status line
    const result = document.createElement('div');
    result.className = 'message-assistant';
    result.innerHTML = `
      <div class="progress-entry">
        <span class="progress-emoji">${approved ? '✅' : '❌'}</span>
        <span class="progress-text">
          ${approved ? `Approved ${checkedFiles.length} file(s)` : 'Changes rejected'}
        </span>
      </div>`;
    panelEl.closest('.message-assistant')?.replaceWith(result);
    this.pendingAuthRequest = null;

    if (approved) {
      this.setAgentStatus('running', 'Running');
      this.showTypingIndicator();
    } else {
      this.resetAgentUI();
      this.setAgentStatus('idle', 'Idle');
    }
  }

  // ═══════════════════════════════════════════
  // UI HELPERS
  // ═══════════════════════════════════════════

  showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(screenId)?.classList.add('active');
  }

  autoResizeTextarea(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }

  escHtml(str) {
    if (typeof str !== 'string') return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  formatTime(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleTimeString('it-IT',
      { hour: '2-digit', minute: '2-digit' });
  }

  relativeTime(ts) {
    if (!ts) return '';
    const diff    = Date.now() - new Date(ts).getTime();
    const minutes = Math.floor(diff / 60000);
    const hours   = Math.floor(diff / 3600000);
    const days    = Math.floor(diff / 86400000);
    if (minutes < 1)  return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24)   return `${hours}h ago`;
    return `${days}d ago`;
  }

  showToast(message, type = 'info') {
    let container = document.querySelector('.toast-container');
    if (!container) {
      container = document.createElement('div');
      container.className = 'toast-container';
      document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
    toast.innerHTML = `
      <span class="toast-icon">${icons[type] || icons.info}</span>
      <span class="toast-message">${message}</span>
      <button class="toast-close">×</button>`;
    toast.querySelector('.toast-close')
      .addEventListener('click', () => {
        toast.classList.add('toast-out');
        setTimeout(() => toast.remove(), 300);
      });
    container.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('toast-out');
      setTimeout(() => toast.remove(), 300);
    }, 5000);
  }
}

// ─── Boot ───
document.addEventListener('DOMContentLoaded', () => {
  window.devAgent = new DevAgentApp();
});
