#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const appDir = path.join(__dirname, 'app');
const dataDir = path.join(os.homedir(), 'Library', 'Application Support', 'crontab-ui', 'crontabs');
const pidFile = path.join(dataDir, '.desktop-server.pid');
let serverProc = null;
let shuttingDown = false;

function getDesktopPort() {
  const raw = process.env.CRONTAB_UI_DESKTOP_PORT || '47832';
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid CRONTAB_UI_DESKTOP_PORT: ${raw}`);
  }
  return port;
}

function collect(proc) {
  return new Promise((resolve) => {
    let stdout = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk; });
    proc.on('close', () => resolve(stdout));
  });
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_e) {
    return false;
  }
}

function readSavedPid() {
  try {
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (_e) {
    return null;
  }
}

async function commandForPid(pid) {
  const proc = spawn('/bin/ps', ['-p', String(pid), '-o', 'command='], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return (await collect(proc)).trim();
}

function isCrontabUiCommand(command) {
  return command.includes('/Crontab UI.app/Contents/Resources/')
    || command.includes('/dist/Crontab UI.app/Contents/Resources/')
    || command.includes(appDir);
}

async function findPortListeners(port) {
  const proc = spawn('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const stdout = await collect(proc);
  return stdout
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

async function stopPid(pid, label) {
  if (!isAlive(pid)) return;
  console.log(`Stopping existing Crontab UI ${label} process ${pid}`);
  try {
    process.kill(pid, 'SIGTERM');
  } catch (_e) {
    return;
  }

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (!isAlive(pid)) return;
  console.log(`Force stopping Crontab UI process ${pid}`);
  try {
    process.kill(pid, 'SIGKILL');
  } catch (_e) {
    // Process is already gone.
  }
}

async function restartExistingServer(port) {
  const pids = new Set();
  const savedPid = readSavedPid();
  if (savedPid) pids.add(savedPid);

  for (const pid of await findPortListeners(port)) {
    pids.add(pid);
  }

  for (const pid of pids) {
    if (!isAlive(pid)) continue;
    const command = await commandForPid(pid);
    if (!isCrontabUiCommand(command)) {
      throw new Error(
        `port ${port} is already used by another process:\n${pid} ${command}\n` +
        'Stop that process or set CRONTAB_UI_DESKTOP_PORT to another port.',
      );
    }
    await stopPid(pid, pid === savedPid ? 'saved' : 'listening');
  }

  try {
    fs.unlinkSync(pidFile);
  } catch (_e) {
    // Already removed.
  }
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

  const port = getDesktopPort();
  const baseUrl = (process.env.BASE_URL || '').replace(/\/+$/, '').trim();
  const url = `http://127.0.0.1:${port}${baseUrl || '/'}`;

  await restartExistingServer(port);

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
  fs.writeFileSync(pidFile, String(serverProc.pid));

  serverProc.on('exit', (code, signal) => {
    try {
      fs.unlinkSync(pidFile);
    } catch (_e) {
      // Already removed.
    }
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
