#!/usr/bin/env node
/**
 * DevAgent Bridge — run this on YOUR LOCAL PC
 *
 * Connects to the DevAgent server on Render via WebSocket and executes
 * filesystem commands locally on your behalf, so the AI agent can read
 * and write files on your machine.
 *
 * Usage:
 *   1. Copy .env.example to .env and fill in the values
 *   2. Run: node bridge/index.js   (from the devagent root)
 *      OR:  cd bridge && npm start
 *   3. Keep it running while you use DevAgent from the browser/phone
 */

'use strict';

const WebSocket     = require('ws');
const fs            = require('fs/promises');
const path          = require('path');
const { exec }      = require('child_process');
const { promisify } = require('util');

// Load .env from the bridge directory
require('dotenv').config({ path: path.join(__dirname, '.env') });

const execAsync = promisify(exec);

// ── Config (from bridge/.env) ─────────────────────────────────────────────
const SERVER_URL     = (process.env.SERVER_URL || '').replace(/\/$/, '');
const BRIDGE_SECRET  = process.env.BRIDGE_SECRET;
const WORKSPACE_ROOT = path.resolve(process.env.WORKSPACE_ROOT || process.cwd());

// ── Validate ──────────────────────────────────────────────────────────────
if (!SERVER_URL) {
  console.error('\n[Bridge] ✗  SERVER_URL is not set in bridge/.env');
  console.error('           Example: SERVER_URL=wss://devagent-xxxx.onrender.com\n');
  process.exit(1);
}
if (!BRIDGE_SECRET) {
  console.error('\n[Bridge] ✗  BRIDGE_SECRET is not set in bridge/.env');
  console.error('           Must match the BRIDGE_SECRET env var on your Render service.\n');
  process.exit(1);
}

console.log('\n╔═══════════════════════════════════════════╗');
console.log('║         DevAgent Bridge  v1.0             ║');
console.log('╚═══════════════════════════════════════════╝');
console.log(`  Workspace : ${WORKSPACE_ROOT}`);
console.log(`  Server    : ${SERVER_URL}`);
console.log('');

// ── State ─────────────────────────────────────────────────────────────────
let ws;
let reconnectTimer = null;
let isAuthenticated = false;

// ── Connection ────────────────────────────────────────────────────────────
function connect() {
  console.log('[Bridge] Connecting to server...');

  // Normalise to wss:// / ws://
  const wsUrl = SERVER_URL
    .replace(/^http:/, 'ws:')
    .replace(/^https:/, 'wss:');

  ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    console.log('[Bridge] Connected — authenticating...');
    ws.send(JSON.stringify({
      type         : 'BRIDGE_AUTH',
      secret       : BRIDGE_SECRET,
      workspaceRoot: WORKSPACE_ROOT
    }));
  });

  ws.on('message', async (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }

    switch (data.type) {
      case 'BRIDGE_AUTH_SUCCESS':
        isAuthenticated = true;
        console.log('[Bridge] ✓  Authenticated and ready');
        console.log('[Bridge]    Waiting for agent commands...\n');
        break;

      case 'BRIDGE_AUTH_FAILED':
        console.error('[Bridge] ✗  Authentication failed — check BRIDGE_SECRET in bridge/.env');
        ws.close();
        process.exit(1);
        break;

      case 'BRIDGE_PING':
        ws.send(JSON.stringify({ type: 'BRIDGE_PONG' }));
        break;

      default:
        if (!isAuthenticated) return;
        await handleCommand(data);
    }
  });

  ws.on('close', (code, reason) => {
    isAuthenticated = false;
    const msg = reason?.toString() || '';
    console.log(`\n[Bridge] Disconnected (${code}${msg ? ': ' + msg : ''})`);
    console.log('[Bridge] Reconnecting in 5 seconds...');
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 5000);
  });

  ws.on('error', (err) => {
    console.error(`[Bridge] Connection error: ${err.message}`);
  });
}

// ── Command dispatcher ────────────────────────────────────────────────────
async function handleCommand(data) {
  const { type, requestId } = data;
  if (!requestId) return;

  const label = data.path || data.command || '';
  console.log(`[Bridge] ← ${type.padEnd(14)} ${label}`);

  try {
    let result;
    switch (type) {
      case 'READ_FILE'   : result = await cmdReadFile(data);    break;
      case 'WRITE_FILE'  : result = await cmdWriteFile(data);   break;
      case 'LIST_DIR'    : result = await cmdListDir(data);     break;
      case 'DELETE_FILE' : result = await cmdDeleteFile(data);  break;
      case 'SEARCH_FILES': result = await cmdSearchFiles(data); break;
      case 'EXEC_COMMAND': result = await cmdExecCommand(data); break;
      default: throw new Error(`Unknown command: ${type}`);
    }
    console.log(`[Bridge] ✓  ${type}`);
    ws.send(JSON.stringify({ type: 'BRIDGE_RESPONSE', requestId, success: true,  result }));
  } catch (err) {
    console.error(`[Bridge] ✗  ${type}: ${err.message}`);
    ws.send(JSON.stringify({ type: 'BRIDGE_RESPONSE', requestId, success: false, error: err.message }));
  }
}

// ── Security helper ───────────────────────────────────────────────────────
function safePath(filePath) {
  if (!filePath || filePath === '.') return WORKSPACE_ROOT;
  const resolved = path.resolve(WORKSPACE_ROOT, filePath);
  if (!resolved.startsWith(WORKSPACE_ROOT + path.sep) && resolved !== WORKSPACE_ROOT) {
    throw new Error(`Access denied: path "${filePath}" is outside the configured workspace`);
  }
  return resolved;
}

// ── Tool implementations ──────────────────────────────────────────────────

async function cmdReadFile({ path: filePath }) {
  const full = safePath(filePath);
  try {
    return await fs.readFile(full, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return `File not found: ${filePath}`;
    throw err;
  }
}

async function cmdWriteFile({ path: filePath, content }) {
  const full = safePath(filePath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, 'utf-8');
  return { success: true, path: filePath, bytes: content?.length || 0 };
}

async function cmdListDir({ path: dirPath, recursive }) {
  const full = safePath(dirPath || '.');
  return await listRecursive(full, recursive || false);
}

async function listRecursive(dir, recursive, base = '') {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch { return []; }

  const result = [];
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) {
      result.push({ name: rel, type: 'directory' });
      if (recursive) result.push(...await listRecursive(path.join(dir, e.name), true, rel));
    } else {
      result.push({ name: rel, type: 'file' });
    }
  }
  return result;
}

async function cmdDeleteFile({ path: filePath }) {
  const full = safePath(filePath);
  await fs.unlink(full);
  return { success: true, deleted: filePath };
}

async function cmdSearchFiles({ pattern, path: dirPath }) {
  const full = safePath(dirPath || '.');
  const results = [];
  await searchInDir(full, pattern, results);
  return results.slice(0, 50);
}

async function searchInDir(dir, pattern, results) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      await searchInDir(full, pattern, results);
    } else {
      try {
        const content = await fs.readFile(full, 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(pattern)) {
            results.push({
              file   : path.relative(WORKSPACE_ROOT, full),
              line   : i + 1,
              content: lines[i].trim().slice(0, 100)
            });
          }
        }
      } catch { /* skip binary/unreadable files */ }
    }
  }
}

async function cmdExecCommand({ command }) {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd      : WORKSPACE_ROOT,
      timeout  : 60000,
      maxBuffer: 1024 * 512
    });
    return {
      stdout : stdout.substring(0, 3000),
      stderr : stderr.substring(0, 500),
      success: true
    };
  } catch (error) {
    return {
      error  : error.message,
      stdout : (error.stdout || '').substring(0, 1000),
      stderr : (error.stderr || '').substring(0, 500),
      success: false
    };
  }
}

// ── Start ─────────────────────────────────────────────────────────────────
connect();

process.on('SIGINT',  () => { console.log('\n[Bridge] Shutting down...'); ws?.close(); process.exit(0); });
process.on('SIGTERM', () => { ws?.close(); process.exit(0); });
