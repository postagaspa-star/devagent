/**
 * DevAgent - Client-side Application
 * Handles authentication, project management, and WebSocket communication
 */

class DevAgentClient {
  constructor() {
    this.token = localStorage.getItem('devagent_token');
    this.ws = null;
    this.wsReconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.currentProject = null;
    this.pendingAuthRequest = null;
    
    this.init();
  }

  // ============ INITIALIZATION ============

  init() {
    // Check if we're on workspace page
    if (window.location.pathname.includes('/workspace/')) {
      this.initWorkspace();
    } else {
      this.initDashboard();
    }
  }

  initDashboard() {
    // Check authentication
    const initialToken = this.token;

    if (this.token) {
      this.verifyToken().then(valid => {
        // Abort if user already logged in while we were verifying (race condition guard)
        if (this.token !== initialToken) return;
        if (valid) {
          this.showScreen('dashboard-screen');
          this.loadProjects();
        } else {
          // Clear stale/invalid token
          this.token = null;
          localStorage.removeItem('devagent_token');
          this.showScreen('login-screen');
        }
      });
    } else {
      this.showScreen('login-screen');
    }

    // Setup event listeners
    this.setupLoginForm();
    this.setupNewProjectForm();
    this.setupEditProjectForm();
    this.setupDashboardButtons();
  }

  initWorkspace() {
    // Extract project ID from URL
    const pathParts = window.location.pathname.split('/');
    const projectId = pathParts[pathParts.length - 1];

    if (!this.token) {
      window.location.href = '/';
      return;
    }

    this.loadProject(projectId).then(project => {
      if (project) {
        this.currentProject = project;
        this.renderWorkspace(project);
        this.connectWebSocket();
        this.setupWorkspaceListeners();
      } else {
        this.showToast('Project not found', 'error');
        setTimeout(() => window.location.href = '/', 2000);
      }
    });
  }

  // ============ AUTHENTICATION ============

  async verifyToken() {
    try {
      const response = await this.apiRequest('/api/projects', 'GET');
      return response.success;
    } catch (error) {
      return false;
    }
  }

  setupLoginForm() {
    const form = document.getElementById('login-form');
    if (!form) return;

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const password = document.getElementById('password').value;
      const errorEl = document.getElementById('login-error');
      const submitBtn = form.querySelector('button[type="submit"]');
      
      // Disable button and show loading
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span class="spinner"></span>';
      errorEl.textContent = '';

      try {
        const response = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password })
        });

        const data = await response.json();
        console.log('Login response:', data);

        if (data.success) {
          this.token = data.token;
          localStorage.setItem('devagent_token', data.token);
          console.log('Token saved, loading dashboard...');
          this.showScreen('dashboard-screen');
          this.loadProjects();
        } else {
          errorEl.textContent = data.error || 'Invalid password';
        }
      } catch (error) {
        errorEl.textContent = 'Connection error. Please try again.';
      } finally {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<span class="btn-text">Access Dashboard</span><span class="btn-icon">→</span>';
      }
    });
  }

  logout() {
    localStorage.removeItem('devagent_token');
    this.token = null;
    if (this.ws) {
      this.ws.close();
    }
    window.location.href = '/';
  }

  // ============ API REQUESTS ============

  async apiRequest(url, method = 'GET', body = null) {
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`
      }
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);
    return response.json();
  }

  // ============ PROJECTS ============

  async loadProjects() {
    try {
      const data = await this.apiRequest('/api/projects');
      
      if (data.success) {
        this.renderProjects(data.projects);
      }
    } catch (error) {
      this.showToast('Failed to load projects', 'error');
    }
  }

  renderProjects(projects) {
    const grid = document.getElementById('projects-grid');
    const emptyState = document.getElementById('empty-state');
    const template = document.getElementById('project-card-template');

    if (!grid) return;

    grid.innerHTML = '';

    if (!projects || projects.length === 0) {
      grid.classList.add('hidden');
      emptyState?.classList.remove('hidden');
      return;
    }

    grid.classList.remove('hidden');
    emptyState?.classList.add('hidden');

    projects.forEach(project => {
      const card = template.content.cloneNode(true);
      const cardEl = card.querySelector('.project-card');
      
      cardEl.dataset.projectId = project.id;
      card.querySelector('.project-name').textContent = project.name;
      card.querySelector('.project-path').textContent = project.path;

      // Show badges
      if (project.deployment?.enabled) {
        card.querySelector('.badge-deploy').classList.remove('hidden');
      }
      if (project.testing?.enabled) {
        card.querySelector('.badge-test').classList.remove('hidden');
      }

      // Show history
      if (project.history?.length > 0) {
        const historyEl = card.querySelector('.project-history');
        historyEl.classList.remove('hidden');
        card.querySelector('.history-objective').textContent = project.history[0].objective;
      }

      // Settings button
      card.querySelector('.project-settings').addEventListener('click', (e) => {
        e.stopPropagation();
        this.showEditProjectModal(project);
      });

      // Open workspace button
      card.querySelector('.open-workspace').addEventListener('click', () => {
        window.location.href = `/workspace/${project.id}`;
      });

      grid.appendChild(card);
    });
  }

  async loadProject(projectId) {
    try {
      const data = await this.apiRequest(`/api/projects/${projectId}`);
      return data.success ? data.project : null;
    } catch (error) {
      return null;
    }
  }

  setupNewProjectForm() {
    const form = document.getElementById('new-project-form');
    if (!form) return;

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const formData = new FormData(form);
      const project = {
        name: formData.get('name'),
        path: formData.get('path'),
        deployment: {
          command: formData.get('deployCommand'),
          url: formData.get('deployUrl')
        },
        testing: {
          command: formData.get('testCommand'),
          puppeteer: form.querySelector('#puppeteer-test').checked
        }
      };

      try {
        const data = await this.apiRequest('/api/projects', 'POST', project);
        
        if (data.success) {
          this.hideNewProjectModal();
          this.loadProjects();
          this.showToast('Project created successfully', 'success');
          form.reset();
        } else {
          this.showToast(data.error || 'Failed to create project', 'error');
        }
      } catch (error) {
        this.showToast('Failed to create project', 'error');
      }
    });
  }

  setupEditProjectForm() {
    const form = document.getElementById('edit-project-form');
    if (!form) return;

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const projectId = document.getElementById('edit-project-id').value;
      const project = {
        name: document.getElementById('edit-project-name').value,
        path: document.getElementById('edit-project-path').value,
        deployment: {
          enabled: document.getElementById('edit-deploy-enabled').checked,
          command: document.getElementById('edit-deploy-command').value,
          url: document.getElementById('edit-deploy-url').value
        },
        testing: {
          enabled: document.getElementById('edit-testing-enabled').checked,
          command: document.getElementById('edit-test-command').value,
          puppeteer: document.getElementById('edit-puppeteer-test').checked
        }
      };

      try {
        const data = await this.apiRequest(`/api/projects/${projectId}`, 'PUT', project);
        
        if (data.success) {
          this.hideEditProjectModal();
          this.loadProjects();
          this.showToast('Project updated', 'success');
        } else {
          this.showToast(data.error || 'Failed to update project', 'error');
        }
      } catch (error) {
        this.showToast('Failed to update project', 'error');
      }
    });
  }

  showEditProjectModal(project) {
    document.getElementById('edit-project-id').value = project.id;
    document.getElementById('edit-project-name').value = project.name;
    document.getElementById('edit-project-path').value = project.path;
    document.getElementById('edit-deploy-enabled').checked = project.deployment?.enabled || false;
    document.getElementById('edit-deploy-command').value = project.deployment?.command || '';
    document.getElementById('edit-deploy-url').value = project.deployment?.url || '';
    document.getElementById('edit-testing-enabled').checked = project.testing?.enabled || false;
    document.getElementById('edit-test-command').value = project.testing?.command || '';
    document.getElementById('edit-puppeteer-test').checked = project.testing?.puppeteer || false;
    
    document.getElementById('edit-project-modal').classList.add('active');
  }

  async deleteProject() {
    const projectId = document.getElementById('edit-project-id').value;
    
    try {
      const data = await this.apiRequest(`/api/projects/${projectId}`, 'DELETE');
      
      if (data.success) {
        this.hideEditProjectModal();
        this.loadProjects();
        this.showToast('Project deleted', 'success');
      } else {
        this.showToast(data.error || 'Failed to delete project', 'error');
      }
    } catch (error) {
      this.showToast('Failed to delete project', 'error');
    }
  }

  setupDashboardButtons() {
    document.getElementById('new-project-btn')?.addEventListener('click', () => {
      this.showNewProjectModal();
    });

    document.getElementById('logout-btn')?.addEventListener('click', () => {
      this.logout();
    });
  }

  // ============ WORKSPACE ============

  renderWorkspace(project) {
    document.getElementById('project-name').textContent = project.name;
    document.getElementById('project-path').textContent = project.path;
    document.title = `${project.name} - DevAgent`;
  }

  setupWorkspaceListeners() {
    // Start agent button
    document.getElementById('start-agent-btn')?.addEventListener('click', () => {
      this.startAgent();
    });

    // Stop agent button
    document.getElementById('stop-agent-btn')?.addEventListener('click', () => {
      this.stopAgent();
    });

    // Auth buttons
    document.getElementById('auth-approve-btn')?.addEventListener('click', () => {
      this.handleAuthResponse(true);
    });

    document.getElementById('auth-reject-btn')?.addEventListener('click', () => {
      this.handleAuthResponse(false);
    });

    // New task button
    document.getElementById('new-task-btn')?.addEventListener('click', () => {
      this.resetWorkspace();
    });

    // Logout
    document.getElementById('logout-btn')?.addEventListener('click', () => {
      this.logout();
    });
  }

  startAgent() {
    const objective = document.getElementById('objective').value.trim();
    const autonomyLevel = document.getElementById('autonomy-level').value;
    const model = document.getElementById('model-select').value;

    if (!objective) {
      this.showToast('Please enter an objective', 'warning');
      return;
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.showToast('WebSocket not connected', 'error');
      return;
    }

    // Clear previous progress
    this.clearProgress();

    // Send start message
    this.ws.send(JSON.stringify({
      type: 'START_AGENT',
      projectId: this.currentProject.id,
      objective,
      autonomyLevel,
      model,
      token: this.token
    }));

    // Update UI
    document.getElementById('start-agent-btn').classList.add('hidden');
    document.getElementById('stop-agent-btn').classList.remove('hidden');
    document.getElementById('objective').disabled = true;
    document.getElementById('autonomy-level').disabled = true;
    document.getElementById('model-select').disabled = true;
    
    this.setAgentStatus('running', 'Running');
  }

  stopAgent() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'STOP_AGENT' }));
    }

    this.apiRequest('/api/agent/stop', 'POST');
    this.resetAgentUI();
    this.setAgentStatus('idle', 'Stopped');
    this.addProgressEntry({ emoji: '⏹️', message: 'Agent stopped by user', timestamp: new Date().toISOString() });
  }

  resetWorkspace() {
    this.resetAgentUI();
    this.clearProgress();
    document.getElementById('objective').value = '';
    document.getElementById('completion-panel').classList.add('hidden');
    this.setAgentStatus('idle', 'Idle');
  }

  resetAgentUI() {
    document.getElementById('start-agent-btn').classList.remove('hidden');
    document.getElementById('stop-agent-btn').classList.add('hidden');
    document.getElementById('objective').disabled = false;
    document.getElementById('autonomy-level').disabled = false;
    document.getElementById('model-select').disabled = false;
  }

  // ============ WEBSOCKET ============

  connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log('[WS] Connected');
      this.wsReconnectAttempts = 0;
      this.setConnectionStatus('connected', 'Connected');
      
      // Authenticate
      this.ws.send(JSON.stringify({
        type: 'AUTH',
        token: this.token
      }));
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.handleWebSocketMessage(data);
      } catch (error) {
        console.error('[WS] Parse error:', error);
      }
    };

    this.ws.onclose = () => {
      console.log('[WS] Disconnected');
      this.setConnectionStatus('disconnected', 'Disconnected');
      this.attemptReconnect();
    };

    this.ws.onerror = (error) => {
      console.error('[WS] Error:', error);
      this.setConnectionStatus('disconnected', 'Error');
    };
  }

  attemptReconnect() {
    if (this.wsReconnectAttempts >= this.maxReconnectAttempts) {
      this.showToast('Connection lost. Please refresh the page.', 'error');
      return;
    }

    this.wsReconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.wsReconnectAttempts), 30000);
    
    this.setConnectionStatus('connecting', `Reconnecting (${this.wsReconnectAttempts}/${this.maxReconnectAttempts})...`);
    
    setTimeout(() => {
      this.connectWebSocket();
    }, delay);
  }

  handleWebSocketMessage(data) {
    console.log('[WS] Message:', data.type);

    switch (data.type) {
      case 'AUTH_SUCCESS':
        console.log('[WS] Authenticated');
        break;

      case 'AUTH_FAILED':
        this.showToast('WebSocket authentication failed', 'error');
        this.logout();
        break;

      case 'AGENT_STARTED':
        this.addProgressEntry({
          emoji: '🚀',
          message: 'Agent started',
          timestamp: data.timestamp || new Date().toISOString()
        });
        break;

      case 'PROGRESS':
        this.addProgressEntry(data);
        break;

      case 'REQUEST_AUTH':
        this.showAuthRequest(data);
        break;

      case 'READY_FOR_HUMAN':
        this.showCompletion(data.summary);
        break;

      case 'AGENT_COMPLETE':
        this.handleAgentComplete(data.result);
        break;

      case 'AGENT_ERROR':
        this.handleAgentError(data.error);
        break;

      case 'AGENT_STOPPED':
        this.resetAgentUI();
        this.setAgentStatus('idle', 'Stopped');
        break;

      case 'PONG':
        // Heartbeat response
        break;

      case 'ERROR':
        this.showToast(data.error, 'error');
        break;
    }
  }

  setConnectionStatus(status, text) {
    const statusEl = document.getElementById('connection-status');
    if (!statusEl) return;

    statusEl.className = `connection-status ${status}`;
    statusEl.querySelector('.connection-text').textContent = text;
  }

  setAgentStatus(status, text) {
    const statusEl = document.getElementById('agent-status');
    if (!statusEl) return;

    statusEl.className = `status-badge status-${status}`;
    statusEl.querySelector('.status-text').textContent = text;
  }

  // ============ PROGRESS ============

  clearProgress() {
    const timeline = document.getElementById('progress-timeline');
    if (timeline) {
      timeline.innerHTML = '';
    }
  }

  addProgressEntry(data) {
    const timeline = document.getElementById('progress-timeline');
    if (!timeline) return;

    // Remove empty state
    const emptyState = timeline.querySelector('.timeline-empty');
    if (emptyState) {
      emptyState.remove();
    }

    const template = document.getElementById('timeline-entry-template');
    const entry = template.content.cloneNode(true);

    entry.querySelector('.timeline-entry').dataset.stage = data.stage || '';
    entry.querySelector('.marker-emoji').textContent = data.emoji || '📌';
    entry.querySelector('.timeline-message').textContent = data.message;
    entry.querySelector('.timeline-time').textContent = this.formatTime(data.timestamp);

    timeline.insertBefore(entry, timeline.firstChild);

    // Scroll to top
    timeline.scrollTop = 0;
  }

  formatTime(timestamp) {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    return date.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  // ============ AUTHORIZATION ============

  showAuthRequest(data) {
    this.pendingAuthRequest = data;

    const authEl = document.getElementById('auth-request');
    const filesEl = document.getElementById('auth-files');
    const template = document.getElementById('auth-file-template');

    if (!authEl || !filesEl) return;
    if (!data.files || !Array.isArray(data.files)) return;

    filesEl.innerHTML = '';

    data.files.forEach(file => {
      const fileEl = template.content.cloneNode(true);
      
      fileEl.querySelector('.auth-file').dataset.path = file.path;
      fileEl.querySelector('.auth-file-path').textContent = file.path;
      fileEl.querySelector('.auth-file-action').textContent = file.action;

      // Toggle diff
      const toggleBtn = fileEl.querySelector('.auth-file-toggle');
      const diffEl = fileEl.querySelector('.auth-file-diff');
      const diffContent = fileEl.querySelector('.diff-content');

      if (file.diff?.preview) {
        diffContent.textContent = file.diff.preview;
        if (file.diff.truncated) {
          diffContent.textContent += `\n\n... (${file.diff.totalLines} total lines)`;
        }
        
        toggleBtn.addEventListener('click', () => {
          const isHidden = diffEl.classList.contains('hidden');
          diffEl.classList.toggle('hidden');
          toggleBtn.textContent = isHidden ? 'Hide diff' : 'Show diff';
        });
      } else {
        toggleBtn.classList.add('hidden');
      }

      filesEl.appendChild(fileEl);
    });

    authEl.classList.remove('hidden');
    this.setAgentStatus('waiting', 'Waiting for approval');
  }

  handleAuthResponse(approved) {
    const authEl = document.getElementById('auth-request');
    const feedback = document.getElementById('auth-feedback-input')?.value || '';

    if (!this.pendingAuthRequest) return;

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.showToast('Connection lost. Please refresh the page.', 'error');
      return;
    }

    // Get selected files
    const selectedFiles = [];
    authEl.querySelectorAll('.auth-file').forEach(fileEl => {
      const checkbox = fileEl.querySelector('.auth-file-checkbox');
      if (checkbox?.checked) {
        selectedFiles.push(fileEl.dataset.path);
      }
    });

    // Send response
    this.ws.send(JSON.stringify({
      type: 'APPROVE_AUTH',
      requestId: this.pendingAuthRequest.requestId,
      approved,
      files: approved ? selectedFiles : [],
      feedback
    }));

    // Hide auth panel
    authEl.classList.add('hidden');
    document.getElementById('auth-feedback-input').value = '';
    this.pendingAuthRequest = null;

    this.setAgentStatus('running', 'Running');
    this.addProgressEntry({
      emoji: approved ? '✅' : '❌',
      message: approved ? `Approved ${selectedFiles.length} file(s)` : 'Changes rejected',
      timestamp: new Date().toISOString()
    });
  }

  // ============ COMPLETION ============

  showCompletion(summary) {
    this.resetAgentUI();
    this.setAgentStatus('success', 'Complete');

    const panel = document.getElementById('completion-panel');
    if (!panel) return;

    // Stats
    document.getElementById('stat-iterations').textContent = summary.iterations || '-';
    document.getElementById('stat-files').textContent = summary.filesChanged?.length || '-';

    // Files list
    const filesEl = document.getElementById('completion-files');
    if (filesEl && summary.filesChanged?.length > 0) {
      filesEl.innerHTML = summary.filesChanged.map(f => `<p>📄 ${f}</p>`).join('');
    }

    // Deploy link
    const deployEl = document.getElementById('completion-deploy');
    const deployLink = document.getElementById('deploy-link');
    if (summary.deployUrl) {
      deployLink.href = summary.deployUrl;
      deployEl.classList.remove('hidden');
    } else {
      deployEl.classList.add('hidden');
    }

    panel.classList.remove('hidden');
  }

  handleAgentComplete(result) {
    if (result.success) {
      this.showCompletion(result);
    } else {
      this.addProgressEntry({
        emoji: '⚠️',
        message: `Agent finished: ${result.reason || 'Unknown'}`,
        timestamp: new Date().toISOString()
      });
      this.resetAgentUI();
      this.setAgentStatus('idle', 'Finished');
    }
  }

  handleAgentError(error) {
    this.addProgressEntry({
      emoji: '❌',
      message: `Error: ${error}`,
      timestamp: new Date().toISOString()
    });
    this.resetAgentUI();
    this.setAgentStatus('error', 'Error');
    this.showToast(error, 'error');
  }

  // ============ UI HELPERS ============

  showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(screen => {
      screen.classList.remove('active');
    });
    document.getElementById(screenId)?.classList.add('active');
  }

  showNewProjectModal() {
    document.getElementById('new-project-modal')?.classList.add('active');
  }

  hideNewProjectModal() {
    document.getElementById('new-project-modal')?.classList.remove('active');
    document.getElementById('new-project-form')?.reset();
  }

  hideEditProjectModal() {
    document.getElementById('edit-project-modal')?.classList.remove('active');
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
    
    const icons = {
      success: '✅',
      error: '❌',
      warning: '⚠️',
      info: 'ℹ️'
    };

    toast.innerHTML = `
      <span class="toast-icon">${icons[type] || icons.info}</span>
      <span class="toast-message">${message}</span>
      <button class="toast-close">×</button>
    `;

    toast.querySelector('.toast-close').addEventListener('click', () => {
      this.removeToast(toast);
    });

    container.appendChild(toast);

    // Auto remove after 5 seconds
    setTimeout(() => {
      this.removeToast(toast);
    }, 5000);
  }

  removeToast(toast) {
    toast.classList.add('toast-out');
    setTimeout(() => {
      toast.remove();
    }, 300);
  }
}

// Global functions for onclick handlers
function showNewProjectModal() {
  window.devAgent?.showNewProjectModal();
}

function hideNewProjectModal() {
  window.devAgent?.hideNewProjectModal();
}

function hideEditProjectModal() {
  window.devAgent?.hideEditProjectModal();
}

function confirmDeleteProject() {
  if (confirm('Are you sure you want to delete this project? This action cannot be undone.')) {
    window.devAgent?.deleteProject();
  }
}

// Initialize workspace (called from workspace.html)
function initWorkspace() {
  if (!window.devAgent) {
    window.devAgent = new DevAgentClient();
  }
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  window.devAgent = new DevAgentClient();
});
