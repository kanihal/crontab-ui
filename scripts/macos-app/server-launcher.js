#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const appDir = path.join(__dirname, 'app');
const dataDir = path.join(os.homedir(), 'Library', 'Application Support', 'crontab-ui', 'crontabs');
let serverProc = null;
let shuttingDown = false;

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

function waitReady(port, baseUrl, timeoutMs = 15000) {
  const startedAt = Date.now();
  const readyPath = baseUrl || '/';

  return new Promise((resolve, reject) => {
    const tick = () => {
      if (serverProc && serverProc.exitCode !== null) {
        reject(new Error(`server exited before becoming ready with code ${serverProc.exitCode}`));
        return;
      }

      const req = http.get(
        { host: '127.0.0.1', port, path: readyPath, timeout: 1000 },
        (res) => {
          res.resume();
          resolve();
        },
      );

      req.on('error', () => {
        if (Date.now() - startedAt > timeoutMs) {
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

function stopServer(signal = 'SIGTERM') {
  if (!serverProc || shuttingDown) return;
  shuttingDown = true;

  try {
    serverProc.kill(signal);
  } catch (_e) {
    // Process is already gone.
  }

  setTimeout(() => {
    if (!serverProc || serverProc.exitCode !== null) return;
    try {
      serverProc.kill('SIGKILL');
    } catch (_e) {
      // Process is already gone.
    }
  }, 3000).unref();
}

async function main() {
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });

  const port = await getFreePort();
  const baseUrl = (process.env.BASE_URL || '').replace(/\/+$/, '').trim();
  const url = `http://127.0.0.1:${port}${baseUrl || '/'}`;

  serverProc = spawn(process.execPath, [path.join(appDir, 'app.js')], {
    cwd: appDir,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      CRON_DB_PATH: dataDir,
      NODE_ENV: 'production',
      CRONTAB_UI_DISABLE_AUTH: 'true',
      SSL_CERT: '',
      SSL_KEY: '',
    },
    stdio: 'inherit',
  });

  serverProc.on('exit', (code, signal) => {
    serverProc = null;
    if (!shuttingDown) {
      console.error(`Crontab UI server exited with code=${code} signal=${signal}`);
    }
    process.exit(code ?? 0);
  });

  await waitReady(port, baseUrl);

  console.log(`Opening ${url}`);
  const openProc = spawn('open', [url], { detached: true, stdio: 'ignore' });
  openProc.unref();
}

process.on('SIGINT', () => stopServer('SIGINT'));
process.on('SIGTERM', () => stopServer('SIGTERM'));
process.on('exit', () => stopServer('SIGTERM'));

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  stopServer('SIGTERM');
  process.exit(1);
});
