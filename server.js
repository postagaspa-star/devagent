import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Import modules
import { Auth, loginRateLimiter } from './lib/auth.js';
import { AutonomousAgent } from './lib/agent.js';

// ES module dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const PORT = process.env.PORT || 3000;
const DATA_DIR        = path.join(__dirname, 'data');
const CONFIG_DIR      = path.join(__dirname, 'config');
const PROJECTS_FILE   = path.join(DATA_DIR, 'projects.json');
const SETTINGS_FILE   = path.join(DATA_DIR, 'settings.json');
const GLOBAL_CONFIG_FILE = path.join(CONFIG_DIR, 'global.json');
const WORKSPACES_DIR  = path.join(DATA_DIR, 'workspaces'); // server-side per-conversation dirs

// Initialize
const app = express();
app.set('trust proxy', 1);
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Auth instance
if (!process.env.JWT_SECRET) {
  console.warn('[Auth] WARNING: JWT_SECRET not set. A random secret will be generated, invalidating all tokens on every restart. Set JWT_SECRET in environment variables for persistent sessions.');
}
const auth = await Auth.create(process.env.PASSWORD, process.env.JWT_SECRET);

// Global config
let globalConfig;

// Agent instance (singleton)
let agent = null;

// WebSocket clients
const wsClients = new Map();

// ============ MIDDLEWARE ============

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// CORS for development
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// ============ HELPER FUNCTIONS ============

async function loadGlobalConfig() {
  try {
    const data = await fs.readFile(GLOBAL_CONFIG_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Failed to load global config:', error);
    return {
      maxIterations: 15,
      defaultModel: 'claude-sonnet-4-5-20250929',
      defaultTimeout: 300000
    };
  }
}

async function loadProjects() {
  try {
    const data = await fs.readFile(PROJECTS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    return { projects: [], lastUpdated: null };
  }
}

async function saveProjects(data) {
  data.lastUpdated = new Date().toISOString();
  await fs.writeFile(PROJECTS_FILE, JSON.stringify(data, null, 2));
}

function generateId() {
  return `proj-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

async function loadSettings() {
  try {
    const data = await fs.readFile(SETTINGS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return { projectPath: '', deployCommand: '', deployUrl: '', testCommand: '' };
  }
}

async function saveSettings(settings) {
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

// ============ REST API ROUTES ============

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Login
app.post('/api/login', loginRateLimiter, async (req, res) => {
  try {
    const { password } = req.body;
    
    if (!password) {
      return res.status(400).json({ success: false, error: 'Password required' });
    }

    const isValid = await auth.verifyPassword(password);
    
    if (!isValid) {
      return res.status(401).json({ success: false, error: 'Invalid password' });
    }

    const token = auth.generateToken({ authenticated: true });
    
    res.json({ success: true, token });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, error: 'Login failed' });
  }
});

// Get global config (public)
app.get('/api/config', (req, res) => {
  res.json({
    success: true,
    config: {
      availableModels: globalConfig.availableModels,
      autonomyLevels: globalConfig.autonomyLevels,
      progressEmojis: globalConfig.progressEmojis
    }
  });
});

// Protected routes middleware
const authMiddleware = auth.middleware();

// List projects
app.get('/api/projects', authMiddleware, async (req, res) => {
  try {
    const data = await loadProjects();
    res.json({ success: true, projects: data.projects });
  } catch (error) {
    console.error('Error loading projects:', error);
    res.status(500).json({ success: false, error: 'Failed to load projects' });
  }
});

// Get single project
app.get('/api/projects/:id', authMiddleware, async (req, res) => {
  try {
    const data = await loadProjects();
    const project = data.projects.find(p => p.id === req.params.id);
    
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }
    
    res.json({ success: true, project });
  } catch (error) {
    console.error('Error loading project:', error);
    res.status(500).json({ success: false, error: 'Failed to load project' });
  }
});

// Create project
app.post('/api/projects', authMiddleware, async (req, res) => {
  try {
    const { name, path: projectPath, deployment, testing } = req.body;
    
    if (!name || !projectPath) {
      return res.status(400).json({ success: false, error: 'Name and path required' });
    }

    // Validate path exists
    try {
      await fs.access(projectPath);
    } catch {
      return res.status(400).json({ success: false, error: 'Project path does not exist' });
    }

    const data = await loadProjects();
    
    const project = {
      id: generateId(),
      name,
      path: projectPath,
      deployment: {
        enabled: !!deployment?.command,
        command: deployment?.command || '',
        url: deployment?.url || ''
      },
      testing: {
        enabled: !!testing?.command || !!testing?.puppeteer,
        command: testing?.command || '',
        puppeteer: testing?.puppeteer || false
      },
      history: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    data.projects.push(project);
    await saveProjects(data);

    res.json({ success: true, project });
  } catch (error) {
    console.error('Error creating project:', error);
    res.status(500).json({ success: false, error: 'Failed to create project' });
  }
});

// Update project
app.put('/api/projects/:id', authMiddleware, async (req, res) => {
  try {
    const data = await loadProjects();
    const index = data.projects.findIndex(p => p.id === req.params.id);
    
    if (index === -1) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    const { name, path: projectPath, deployment, testing } = req.body;
    
    // Update fields
    if (name) data.projects[index].name = name;
    if (projectPath) data.projects[index].path = projectPath;
    if (deployment) data.projects[index].deployment = deployment;
    if (testing) data.projects[index].testing = testing;
    
    data.projects[index].updatedAt = new Date().toISOString();

    await saveProjects(data);

    res.json({ success: true, project: data.projects[index] });
  } catch (error) {
    console.error('Error updating project:', error);
    res.status(500).json({ success: false, error: 'Failed to update project' });
  }
});

// Delete project
app.delete('/api/projects/:id', authMiddleware, async (req, res) => {
  try {
    const data = await loadProjects();
    const index = data.projects.findIndex(p => p.id === req.params.id);
    
    if (index === -1) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    data.projects.splice(index, 1);
    await saveProjects(data);

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting project:', error);
    res.status(500).json({ success: false, error: 'Failed to delete project' });
  }
});

// Get settings
app.get('/api/settings', authMiddleware, async (req, res) => {
  const settings = await loadSettings();
  res.json({ success: true, settings });
});

// Save settings
app.put('/api/settings', authMiddleware, async (req, res) => {
  try {
    const { projectPath, deployCommand, deployUrl, testCommand } = req.body;
    await saveSettings({ projectPath: projectPath || '', deployCommand: deployCommand || '', deployUrl: deployUrl || '', testCommand: testCommand || '' });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to save settings' });
  }
});

// Stop agent
app.post('/api/agent/stop', authMiddleware, (req, res) => {
  if (agent && agent.isRunning) {
    agent.stop();
    res.json({ success: true, message: 'Agent stop requested' });
  } else {
    res.json({ success: false, message: 'No agent running' });
  }
});

// Get agent status
app.get('/api/agent/status', authMiddleware, (req, res) => {
  if (agent) {
    res.json({ success: true, status: agent.getStatus() });
  } else {
    res.json({ success: true, status: { isRunning: false } });
  }
});

// List files in a workspace
app.get('/api/workspace/:convId/files', authMiddleware, async (req, res) => {
  const wsPath = path.join(WORKSPACES_DIR, req.params.convId);
  const listRecursive = async (dir, base = '') => {
    let results = [];
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const rel = base ? `${base}/${e.name}` : e.name;
        if (e.isDirectory()) results = [...results, ...await listRecursive(path.join(dir, e.name), rel)];
        else results.push(rel);
      }
    } catch {}
    return results;
  };
  try {
    await fs.access(wsPath);
    const files = await listRecursive(wsPath);
    res.json({ success: true, files });
  } catch {
    res.json({ success: true, files: [] });
  }
});

// Download workspace as tar.gz
app.get('/api/workspace/:convId/download', authMiddleware, async (req, res) => {
  const wsPath = path.join(WORKSPACES_DIR, req.params.convId);
  try { await fs.access(wsPath); } catch {
    return res.status(404).json({ success: false, error: 'Workspace not found' });
  }
  const name = req.params.convId.substring(0, 16);
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="devagent-${name}.tar.gz"`);
  const tar = spawn('tar', ['czf', '-', '-C', wsPath, '.']);
  tar.stdout.pipe(res);
  tar.stderr.on('data', d => console.error('[tar]', d.toString()));
  tar.on('error', err => { console.error('[tar error]', err); if (!res.headersSent) res.status(500).end(); });
});

// Fallback to index
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============ WEBSOCKET HANDLING ============

// ── Server-side keepalive: ping every 25s to survive Render's proxy timeout ──
const KEEPALIVE_MS = 25000;
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) {
      console.log('[WS] Terminating stale connection');
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, KEEPALIVE_MS);

wss.on('connection', (ws, req) => {
  const clientId = `ws-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  console.log(`[WS] Client connected: ${clientId}`);

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  wsClients.set(clientId, { ws, authenticated: false });

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());
      await handleWebSocketMessage(clientId, message, ws);
    } catch (error) {
      console.error(`[WS] Message parse error:`, error);
      ws.send(JSON.stringify({ type: 'ERROR', error: 'Invalid message format' }));
    }
  });

  ws.on('close', () => {
    console.log(`[WS] Client disconnected: ${clientId}`);
    wsClients.delete(clientId);
  });

  ws.on('error', (error) => {
    console.error(`[WS] Client error:`, error);
    wsClients.delete(clientId);
  });
});

async function handleWebSocketMessage(clientId, message, ws) {
  const client = wsClients.get(clientId);
  
  // Authenticate WebSocket connection
  if (message.type === 'AUTH') {
    const decoded = auth.verifyWebSocketToken(message.token);
    if (decoded) {
      client.authenticated = true;
      ws.send(JSON.stringify({ type: 'AUTH_SUCCESS' }));
    } else {
      ws.send(JSON.stringify({ type: 'AUTH_FAILED' }));
    }
    return;
  }

  // Check authentication for all other messages
  if (!client.authenticated && message.token) {
    const decoded = auth.verifyWebSocketToken(message.token);
    if (decoded) {
      client.authenticated = true;
    }
  }

  if (!client.authenticated) {
    ws.send(JSON.stringify({ type: 'ERROR', error: 'Not authenticated' }));
    return;
  }

  // Handle different message types
  switch (message.type) {
    case 'START_AGENT':
      // Fire without await — agent runs async in background so PING/STOP still work
      handleStartAgent(message, ws).catch(err => {
        console.error('[WS] handleStartAgent uncaught:', err);
        try { ws.send(JSON.stringify({ type: 'AGENT_ERROR', error: err.message })); } catch {}
      });
      break;

    case 'APPROVE_AUTH':
      handleApproveAuth(message);
      break;

    case 'STOP_AGENT':
      if (agent) {
        agent.stop();
        ws.send(JSON.stringify({ type: 'AGENT_STOPPED' }));
      }
      break;

    case 'PING':
      ws.send(JSON.stringify({ type: 'PONG' }));
      break;

    default:
      ws.send(JSON.stringify({ type: 'ERROR', error: 'Unknown message type' }));
  }
}

async function handleStartAgent(message, ws) {
  const { objective, autonomyLevel, model } = message;

  // Check if agent already running
  if (agent && agent.isRunning) {
    ws.send(JSON.stringify({ type: 'ERROR', error: 'Agent already running. Stop it first.' }));
    return;
  }

  // Build project config: from message, from projectId, or from saved settings
  let project;

  if (message.project) {
    // Direct project config passed from client
    project = message.project;
  } else if (message.projectId) {
    const data = await loadProjects();
    project = data.projects.find(p => p.id === message.projectId);
    if (!project) {
      ws.send(JSON.stringify({ type: 'ERROR', error: 'Project not found' }));
      return;
    }
  } else {
    // Fall back to saved settings
    const settings = await loadSettings();
    if (!settings.projectPath) {
      ws.send(JSON.stringify({ type: 'ERROR', error: 'No project path configured. Open Settings and set a project path.' }));
      return;
    }
    project = {
      id: 'default',
      name: path.basename(settings.projectPath) || 'Project',
      path: settings.projectPath,
      deployment: {
        enabled: !!settings.deployCommand,
        command: settings.deployCommand || '',
        url: settings.deployUrl || ''
      },
      testing: {
        enabled: !!settings.testCommand,
        command: settings.testCommand || '',
        puppeteer: false
      },
      history: []
    };
  }

  // Verify API key
  if (!process.env.ANTHROPIC_API_KEY) {
    ws.send(JSON.stringify({ type: 'ERROR', error: 'ANTHROPIC_API_KEY not configured on server' }));
    return;
  }

  // ── Resolve workspace path ──────────────────────────────────────────────
  // If no path is given, or a Windows path is given (local machine),
  // auto-create a server-side workspace directory for this conversation.
  const convId   = project.id || `conv-${Date.now()}`;
  const isWindows = /^[A-Za-z]:[\\\/]/.test(project.path || '');
  const needsAuto = !project.path || isWindows;

  if (needsAuto) {
    project.path = path.join(WORKSPACES_DIR, convId);
    await fs.mkdir(project.path, { recursive: true });
    console.log(`[Agent] Auto-created workspace: ${project.path}`);
  } else {
    // User supplied a Linux path — make sure it exists (create if not)
    try {
      await fs.access(project.path);
    } catch {
      try {
        await fs.mkdir(project.path, { recursive: true });
      } catch (mkErr) {
        ws.send(JSON.stringify({
          type: 'ERROR',
          error: `Cannot create/access path on server: "${project.path}". ${mkErr.message}`
        }));
        return;
      }
    }
  }
  // ────────────────────────────────────────────────────────────────────────

  // Create agent if needed
  if (!agent) {
    agent = new AutonomousAgent(process.env.ANTHROPIC_API_KEY, globalConfig);
  }

  ws.send(JSON.stringify({ type: 'AGENT_STARTED', objective, workspacePath: project.path, convId }));

  try {
    const result = await agent.run(project, objective, {
      autonomyLevel: autonomyLevel || 'full',
      model: model || globalConfig.defaultModel,
      wsClient: ws
    });

    ws.send(JSON.stringify({ type: 'AGENT_COMPLETE', result }));

  } catch (error) {
    console.error('Agent error:', error);
    ws.send(JSON.stringify({ type: 'AGENT_ERROR', error: error.message }));
  }
}

function handleApproveAuth(message) {
  if (agent) {
    agent.handleAuthorizationResponse(
      message.requestId,
      message.approved,
      message.files,
      message.feedback
    );
  }
}

// ============ SERVER STARTUP ============

async function startServer() {
  // Ensure directories exist
  await fs.mkdir(DATA_DIR,       { recursive: true });
  await fs.mkdir(CONFIG_DIR,     { recursive: true });
  await fs.mkdir(WORKSPACES_DIR, { recursive: true });

  // Initialize projects file if needed
  try {
    await fs.access(PROJECTS_FILE);
  } catch {
    await fs.writeFile(PROJECTS_FILE, JSON.stringify({ projects: [], lastUpdated: null }, null, 2));
  }

  // Load global config
  globalConfig = await loadGlobalConfig();

  // Start server
  server.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════╗
║                                                       ║
║   🤖 DevAgent Server                                  ║
║                                                       ║
║   Server running on port ${PORT}                        ║
║   http://localhost:${PORT}                              ║
║                                                       ║
║   Environment: ${process.env.NODE_ENV || 'development'}                         ║
║   API Key: ${process.env.ANTHROPIC_API_KEY ? '✓ Configured' : '✗ Missing'}                       ║
║   Password: ${process.env.PASSWORD ? '✓ Configured' : '✗ Missing'}                        ║
║                                                       ║
╚═══════════════════════════════════════════════════════╝
    `);
  });
}

// Start
startServer().catch(error => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
