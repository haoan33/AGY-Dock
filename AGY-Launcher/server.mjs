import crypto from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AgyProcessManager } from './lib/process-manager.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(__dirname, 'ui');
const VERSION = '2.10.0';

function sendJson(res, status, payload) {
  if (res.writableEnded) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  if (res.writableEnded) return;
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function readRequestJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (Buffer.byteLength(raw, 'utf8') > 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('JSON 格式无效'));
      }
    });
    req.on('error', reject);
  });
}

function timingSafeEquals(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Validates Host, Origin, and Bearer token for mutation endpoints.
 */
export function validateRequestSecurity(req, boundPort, expectedToken) {
  const host = String(req.headers.host || '');
  const allowedHosts = new Set([`127.0.0.1:${boundPort}`, `localhost:${boundPort}`]);
  if (!allowedHosts.has(host)) {
    return { ok: false, status: 403, error: 'Invalid host' };
  }

  const origin = req.headers.origin;
  if (origin) {
    const allowedOrigins = new Set([`http://127.0.0.1:${boundPort}`, `http://localhost:${boundPort}`]);
    if (!allowedOrigins.has(origin)) {
      return { ok: false, status: 403, error: 'Origin not allowed' };
    }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const auth = String(req.headers.authorization || '');
    const provided = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!timingSafeEquals(provided, expectedToken)) {
      return { ok: false, status: 403, error: 'Unauthorized token' };
    }
  }

  return { ok: true };
}

/**
 * Creates the local AGY Dock HTTP server without binding until listen() is called.
 */
export function createManagerServer({
  manager = new AgyProcessManager(),
  token = crypto.randomBytes(24).toString('hex'),
  uiDir = UI_DIR,
} = {}) {
  const startedAt = Date.now();

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');

    const boundPort = server.address()?.port;
    const sec = validateRequestSecurity(req, boundPort, token);
    if (!sec.ok) {
      sendJson(res, sec.status, { error: sec.error });
      return;
    }

    const reqUrl = new URL(req.url, `http://127.0.0.1:${boundPort}`);
    const pathname = reqUrl.pathname;

    try {
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        const htmlPath = path.join(uiDir, 'index.html');
        let html = readFileSync(htmlPath, 'utf8');
        html = html.replace(
          '</head>',
          `  <meta name="agy-manager-token" content="${token}">\n</head>`
        );
        sendText(res, 200, html, 'text/html; charset=utf-8');
        return;
      }

      if (req.method === 'GET' && pathname === '/styles.css') {
        sendText(res, 200, readFileSync(path.join(uiDir, 'styles.css'), 'utf8'), 'text/css; charset=utf-8');
        return;
      }

      if (req.method === 'GET' && pathname === '/app.js') {
        sendText(
          res,
          200,
          readFileSync(path.join(uiDir, 'app.js'), 'utf8'),
          'application/javascript; charset=utf-8'
        );
        return;
      }

      if (req.method === 'GET' && pathname === '/favicon.svg') {
        sendText(res, 200, readFileSync(path.join(uiDir, 'favicon.svg'), 'utf8'), 'image/svg+xml; charset=utf-8');
        return;
      }

      if (req.method === 'GET' && pathname === '/favicon.ico') {
        res.writeHead(200, {
          'Content-Type': 'image/x-icon',
          'Cache-Control': 'no-store',
        });
        res.end(readFileSync(path.join(uiDir, 'app.ico')));
        return;
      }

      if (req.method === 'GET' && pathname === '/health') {
        sendJson(res, 200, {
          service: 'agy-plugin-manager',
          version: VERSION,
          pid: process.pid,
          port: boundPort,
          uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/overview') {
        sendJson(res, 200, await manager.getOverview());
        return;
      }

      if (req.method === 'GET' && pathname === '/api/native-plugins') {
        sendJson(res, 200, { plugins: manager.listNativePlugins() });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/update-check') {
        sendJson(res, 200, await manager.checkForUpdates());
        return;
      }

      if (req.method === 'GET' && pathname === '/api/logs') {
        const id = reqUrl.searchParams.get('id') || 'launcher';
        const tail = reqUrl.searchParams.get('tail') || '150';
        sendJson(res, 200, manager.readLogTail(id, tail));
        return;
      }

      if (req.method === 'GET' && pathname === '/api/logs/stream') {
        const id = reqUrl.searchParams.get('id') || 'launcher';
        const tail = reqUrl.searchParams.get('tail') || '150';
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        let lastPayload = '';
        const push = () => {
          try {
            const logData = manager.readLogTail(id, tail);
            const serialized = JSON.stringify(logData);
            if (serialized !== lastPayload) {
              lastPayload = serialized;
              res.write(`data: ${serialized}\n\n`);
            }
          } catch (err) {
            res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
          }
        };

        push();
        const timer = setInterval(push, 1200);
        req.on('close', () => clearInterval(timer));
        return;
      }

      if (req.method === 'POST' && pathname === '/api/antigravity/launch') {
        const result = await manager.launchAntigravityAndAttach();
        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/antigravity/quick-launch') {
        const result = await manager.launchAntigravityAndAttach({ focusIfRunning: true });
        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/shortcuts/create') {
        const agy = await manager.createDesktopShortcut();
        const mgr = await manager.createManagerAppShortcut();
        sendJson(res, 200, {
          agyShortcut: agy.shortcutPath,
          managerShortcut: mgr.shortcutPath,
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/antigravity/attach') {
        const result = await manager.attachEnabledPlugins();
        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/plugins/action') {
        const body = await readRequestJson(req);
        const id = String(body.id || '').trim();
        const action = String(body.action || '').trim();
        if (!id) throw new Error('缺少插件 id');

        let result;
        if (action === 'start') result = await manager.startPlugin(id, 'attach');
        else if (action === 'stop') result = await manager.stopPlugin(id);
        else if (action === 'restart') result = await manager.restartPlugin(id);
        else if (action === 'toggle') result = await manager.togglePlugin(id, body.enabled);
        else throw new Error(`不支持的操作: ${action}`);

        sendJson(res, 200, { result, overview: await manager.getOverview() });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/plugins/stop-all') {
        const results = await manager.stopAllPlugins();
        sendJson(res, 200, { results, overview: await manager.getOverview() });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/plugins/save') {
        const body = await readRequestJson(req);
        const mode = body.mode === 'edit' ? 'edit' : 'create';
        const saved = manager.savePluginEntry(mode, body.plugin || body);
        sendJson(res, 200, { plugin: saved, overview: await manager.getOverview() });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/plugins/delete') {
        const body = await readRequestJson(req);
        const deleted = await manager.deletePluginEntry(String(body.id || '').trim());
        sendJson(res, 200, { ...deleted, overview: await manager.getOverview() });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/plugins/install') {
        const body = await readRequestJson(req);
        const installed = await manager.installPluginPackage(
          String(body.packagePath || '').trim(),
          body.overwrite !== false
        );
        sendJson(res, 200, { ...installed, overview: await manager.getOverview() });
        return;
      }

      if ((req.method === 'GET' || req.method === 'POST') && pathname === '/api/antigravity/detect') {
        const result = await manager.detectAntigravity();
        if (req.method === 'POST') {
          const body = await readRequestJson(req);
          if (body.save === true && result.found && result.path) {
            manager.saveAntigravityExe(result.path);
            sendJson(res, 200, { ...result, saved: true, overview: await manager.getOverview() });
            return;
          }
        }
        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/antigravity/save') {
        const body = await readRequestJson(req);
        const saved = manager.saveAntigravityExe(body.antigravityExe || '');
        sendJson(res, 200, { ...saved, overview: await manager.getOverview() });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/proxy/save') {
        const body = await readRequestJson(req);
        const proxy = manager.saveProxyConfig(body.proxy || body);
        sendJson(res, 200, { proxy, overview: await manager.getOverview() });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/proxy/detect') {
        const body = await readRequestJson(req);
        if (body.save === false) {
          const detection = await manager.detectSystemProxy();
          sendJson(res, 200, {
            detected: detection.detected,
            saved: false,
            detection,
            overview: await manager.getOverview(),
          });
        } else {
          const result = await manager.autoDetectAndSaveProxy();
          sendJson(res, 200, { ...result, overview: await manager.getOverview() });
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/api/logs/clear') {
        const body = await readRequestJson(req);
        const cleared = manager.clearLog(String(body.id || 'launcher').trim());
        sendJson(res, 200, cleared);
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      sendJson(res, 400, { error: err.message || 'Request failed' });
    }
  });

  return { server, token, manager };
}

export function getStateFilePath(manager) {
  return path.join(manager.logsDir, '.manager-state.json');
}

async function isExistingManagerHealthy(port) {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!resp.ok) return false;
    const data = await resp.json();
    return data?.service === 'agy-plugin-manager';
  } catch {
    return false;
  }
}

async function main() {
  const manager = new AgyProcessManager();
  const config = manager.loadConfig();
  const port = Number(process.env.AGY_MANAGER_PORT || config.managerPort || 12400);

  if (await isExistingManagerHealthy(port)) {
    console.log(`[AGY-Manager] Service already running on http://127.0.0.1:${port}`);
    return;
  }

  const { server, token } = createManagerServer({ manager });
  const statePath = getStateFilePath(manager);

  const cleanup = () => {
    try {
      if (existsSync(statePath)) {
        const current = JSON.parse(readFileSync(statePath, 'utf8'));
        if (current.pid === process.pid) unlinkSync(statePath);
      }
    } catch {
      // Ignore cleanup failures
    }
  };

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  const actualPort = server.address().port;
  writeFileSync(
    statePath,
    JSON.stringify({ port: actualPort, token, pid: process.pid, startedAt: new Date().toISOString() }, null, 2),
    'utf8'
  );
  manager.log(`AGY-Manager 控制中心已启动: http://127.0.0.1:${actualPort}`);
  console.log(`[AGY-Manager] Listening on http://127.0.0.1:${actualPort}`);

  const shutdown = () => {
    cleanup();
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.once('exit', cleanup);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error('[AGY-Manager]', err.message);
    process.exitCode = 1;
  });
}
