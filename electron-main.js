'use strict';

const { app, BrowserWindow, dialog, shell, Menu } = require('electron');
const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const path = require('path');
const fs = require('fs');

let serverProc = null;
let win = null;
let isQuitting = false;

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function startServer(port) {
  const appDir = app.isPackaged
    ? path.join(process.resourcesPath, 'app')
    : __dirname;
  const dataDir = path.join(app.getPath('userData'), 'crontabs');
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });

  serverProc = spawn(process.execPath, [path.join(appDir, 'app.js')], {
    cwd: appDir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(port),
      HOST: '127.0.0.1',
      CRON_DB_PATH: dataDir,
      NODE_ENV: 'production',
      CRONTAB_UI_DISABLE_AUTH: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProc.stdout.on('data', (d) => process.stdout.write(`[srv] ${d}`));
  serverProc.stderr.on('data', (d) => process.stderr.write(`[srv] ${d}`));
  serverProc.on('exit', (code, signal) => {
    process.stderr.write(`[srv] exited code=${code} signal=${signal}\n`);
    serverProc = null;
    if (!isQuitting) app.quit();
  });
}

function waitReady(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(
        { host: '127.0.0.1', port, path: '/', timeout: 1000 },
        (res) => {
          res.resume();
          resolve();
        }
      );
      req.on('error', () => {
        if (Date.now() > deadline) {
          reject(new Error(`server did not start on 127.0.0.1:${port} within ${timeoutMs}ms`));
        } else {
          setTimeout(tick, 150);
        }
      });
      req.on('timeout', () => req.destroy());
    };
    tick();
  });
}

function killServer() {
  if (!serverProc) return;
  const p = serverProc;
  serverProc = null;
  try { p.kill('SIGTERM'); } catch { /* noop */ }
  setTimeout(() => {
    try { p.kill('SIGKILL'); } catch { /* noop */ }
  }, 3000).unref();
}

function splashHtml() {
  return (
    '<!doctype html><html><head><meta charset="utf-8"><title>Starting…</title>' +
    '<style>html,body{margin:0;height:100%;background:#1f2436;color:#e6e8ef;' +
    'font:14px -apple-system,BlinkMacSystemFont,sans-serif;' +
    'display:flex;align-items:center;justify-content:center}' +
    '.s{text-align:center}.s h1{font-size:18px;margin:0 0 8px;font-weight:500}' +
    '.s p{margin:0;color:#8a91a8;font-size:12px}</style></head>' +
    '<body><div class="s"><h1>Starting Crontab UI…</h1><p>Spawning local server</p></div></body></html>'
  );
}

async function createWindow() {
  const port = await getFreePort();
  startServer(port);

  win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'Crontab UI',
    backgroundColor: '#1f2436',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(splashHtml()));

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => {
    win = null;
  });

  try {
    await waitReady(port);
    await win.loadURL(`http://127.0.0.1:${port}/`);
  } catch (e) {
    dialog.showErrorBox('Crontab UI failed to start', String(e && e.stack || e));
    app.quit();
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(createWindow);
}

app.on('before-quit', () => { isQuitting = true; killServer(); });
app.on('window-all-closed', () => { isQuitting = true; killServer(); app.quit(); });
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

process.on('exit', killServer);
process.on('SIGINT',  () => { killServer(); process.exit(0); });
process.on('SIGTERM', () => { killServer(); process.exit(0); });
process.on('uncaughtException', (e) => {
  console.error('[electron-main] uncaught:', e);
  killServer();
  process.exit(1);
});
