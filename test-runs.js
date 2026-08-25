'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');

const outputLimitBytes = 10 * 1024 * 1024;
const retentionMs = 24 * 60 * 60 * 1000;
const maxRetainedRuns = 10;
const stopGraceMs = 5000;
const terminalStatuses = new Set(['completed', 'failed', 'stopped', 'interrupted']);
const runIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requestError(status, message, extra) {
  return { status, message, ...(extra || {}) };
}

function isTerminal(run) {
  return terminalStatuses.has(run.status);
}

function safeUtf8Prefix(buffer, maxBytes) {
  if (buffer.length <= maxBytes) return buffer;
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end === maxBytes ? maxBytes : end);
}

module.exports = function createTestRunManager({ folder, prepare }) {
  const runs = new Map();
  let activeRunId = null;
  let shuttingDown = false;

  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(folder, 0o700); } catch (_e) { /* best effort on non-POSIX filesystems */ }

  function runPaths(id) {
    return {
      meta: path.join(folder, `${id}.json`),
      stdout: path.join(folder, `${id}.stdout`),
      stderr: path.join(folder, `${id}.stderr`),
    };
  }

  function serializableRun(run) {
    return {
      id: run.id,
      jobId: run.jobId || null,
      runType: run.runType || 'test',
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt || null,
      exitCode: run.exitCode == null ? null : run.exitCode,
      signal: run.signal || null,
      message: run.message || '',
      stopRequested: !!run.stopRequested,
      stdoutBytes: run.stdoutBytes || 0,
      stderrBytes: run.stderrBytes || 0,
      stdoutTruncated: !!run.stdoutTruncated,
      stderrTruncated: !!run.stderrTruncated,
    };
  }

  function summary(run) {
    return serializableRun(run);
  }

  function persist(run) {
    const paths = runPaths(run.id);
    const temporary = `${paths.meta}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(serializableRun(run)), { mode: 0o600 });
      fs.renameSync(temporary, paths.meta);
      try { fs.chmodSync(paths.meta, 0o600); } catch (_e) { /* best effort */ }
      return true;
    } catch (error) {
      try { fs.rmSync(temporary, { force: true }); } catch (_e) { /* best effort */ }
      console.error(`Unable to persist test run ${run.id}`, error);
      return false;
    }
  }

  function removeRun(run) {
    const paths = runPaths(run.id);
    for (const file of [paths.meta, paths.stdout, paths.stderr]) {
      try { fs.rmSync(file, { force: true }); } catch (_e) { /* best effort */ }
    }
    runs.delete(run.id);
  }

  function cleanupRetainedRuns() {
    const now = Date.now();
    const completed = Array.from(runs.values())
      .filter(isTerminal)
      .sort((a, b) => Date.parse(b.finishedAt || b.startedAt) - Date.parse(a.finishedAt || a.startedAt));

    completed.forEach((run, index) => {
      const finished = Date.parse(run.finishedAt || run.startedAt);
      if (index >= maxRetainedRuns || !Number.isFinite(finished) || now - finished > retentionMs) {
        removeRun(run);
      }
    });
  }

  function loadPersistedRuns() {
    const files = fs.readdirSync(folder).filter((name) => name.endsWith('.json'));
    for (const name of files) {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8'));
        if (!parsed || !runIdPattern.test(parsed.id) || name !== `${parsed.id}.json`) continue;
        const paths = runPaths(parsed.id);
        const run = {
          ...parsed,
          stdoutBytes: fs.existsSync(paths.stdout) ? fs.statSync(paths.stdout).size : 0,
          stderrBytes: fs.existsSync(paths.stderr) ? fs.statSync(paths.stderr).size : 0,
        };
        if (run.status === 'running' || run.status === 'stopping') {
          run.status = 'interrupted';
          run.finishedAt = new Date().toISOString();
          run.message = 'The Crontab UI server restarted before this test run finished.';
          run.stopRequested = false;
          persist(run);
        }
        runs.set(run.id, run);
      } catch (error) {
        console.error(`Unable to load test run metadata ${name}`, error);
      }
    }
    cleanupRetainedRuns();
  }

  function openOutputFiles(run) {
    const paths = runPaths(run.id);
    run.stdoutFd = fs.openSync(paths.stdout, 'w', 0o600);
    run.stderrFd = fs.openSync(paths.stderr, 'w', 0o600);
    run.stdoutDecoder = new StringDecoder('utf8');
    run.stderrDecoder = new StringDecoder('utf8');
  }

  function appendOutput(run, streamName, text) {
    if (!text || run[`${streamName}CaptureFailed`]) return;
    const bytesKey = `${streamName}Bytes`;
    const truncatedKey = `${streamName}Truncated`;
    const fdKey = `${streamName}Fd`;
    const buffer = Buffer.from(text, 'utf8');
    const remaining = Math.max(0, outputLimitBytes - run[bytesKey]);
    const retained = safeUtf8Prefix(buffer, remaining);

    try {
      if (retained.length > 0) {
        fs.writeSync(run[fdKey], retained);
        run[bytesKey] += retained.length;
      }

      if (retained.length < buffer.length && !run[truncatedKey]) {
        run[truncatedKey] = true;
        persist(run);
      }
    } catch (error) {
      run[`${streamName}CaptureFailed`] = true;
      run[truncatedKey] = true;
      run.message = `Unable to retain all ${streamName} output: ${error.message}`;
      console.error(`Unable to capture ${streamName} for test run ${run.id}`, error);
      persist(run);
    }
  }

  function closeOutputFiles(run) {
    for (const streamName of ['stdout', 'stderr']) {
      const decoder = run[`${streamName}Decoder`];
      if (decoder) appendOutput(run, streamName, decoder.end());
      const fd = run[`${streamName}Fd`];
      if (fd != null) {
        try { fs.closeSync(fd); } catch (_e) { /* already closed */ }
      }
      delete run[`${streamName}Decoder`];
      delete run[`${streamName}Fd`];
    }
  }

  function runCleanup(run) {
    if (!run.cleanup) return;
    try { run.cleanup(); } catch (error) { console.error('Unable to clean up test run files', error); }
    run.cleanup = null;
  }

  function notifyShutdownWaiters(run) {
    const waiters = run.shutdownWaiters || [];
    run.shutdownWaiters = [];
    waiters.forEach((callback) => callback());
  }

  function finishRun(run, status, details) {
    if (isTerminal(run)) return;
    if (run.killTimer) clearTimeout(run.killTimer);
    run.killTimer = null;
    closeOutputFiles(run);
    run.status = status;
    run.finishedAt = new Date().toISOString();
    run.exitCode = details && details.exitCode != null ? details.exitCode : null;
    run.signal = details && details.signal ? details.signal : null;
    run.message = details && details.message ? details.message : (run.message || '');
    if (activeRunId === run.id) activeRunId = null;
    runCleanup(run);
    persist(run);
    cleanupRetainedRuns();
    notifyShutdownWaiters(run);
  }

  function signalRun(run, signal) {
    if (!run.child || !run.child.pid) return;
    try {
      if (process.platform === 'win32') run.child.kill(signal);
      else process.kill(-run.child.pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') console.error(`Unable to send ${signal} to test run ${run.id}`, error);
    }
  }

  function start(data, callback) {
    if (shuttingDown) {
      callback(requestError(503, 'Crontab UI is shutting down'));
      return;
    }

    const active = activeRunId && runs.get(activeRunId);
    if (active && !isTerminal(active)) {
      callback(requestError(409, 'A test run is already in progress', { activeRun: summary(active) }));
      return;
    }

    let prepared;
    try {
      prepared = prepare(data);
    } catch (error) {
      callback(error);
      return;
    }

    if (!prepared.command || !prepared.command.trim()) {
      if (prepared.cleanup) prepared.cleanup();
      callback(requestError(400, 'Command is required'));
      return;
    }

    const run = {
      id: crypto.randomUUID(),
      jobId: prepared.jobId || null,
      runType: prepared.runType === 'run-now' ? 'run-now' : 'test',
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      signal: null,
      message: '',
      stopRequested: false,
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
      cleanup: prepared.cleanup || null,
      shutdownWaiters: [],
    };

    try {
      openOutputFiles(run);
      if (!persist(run)) throw new Error('Unable to persist test run metadata');
      runs.set(run.id, run);
      activeRunId = run.id;
      run.child = spawn(prepared.command, {
        shell: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      if (!runs.has(run.id)) runs.set(run.id, run);
      finishRun(run, 'failed', { message: error.message || 'Unable to start command' });
      callback(null, summary(run));
      return;
    }

    run.child.stdout.on('data', (chunk) => {
      appendOutput(run, 'stdout', run.stdoutDecoder.write(chunk));
    });
    run.child.stderr.on('data', (chunk) => {
      appendOutput(run, 'stderr', run.stderrDecoder.write(chunk));
    });
    run.child.once('error', (error) => {
      finishRun(run, 'failed', { message: error.message || 'Unable to start command' });
    });
    run.child.once('close', (code, signal) => {
      if (isTerminal(run)) return;
      finishRun(run, run.stopRequested ? 'stopped' : 'completed', {
        exitCode: code,
        signal,
      });
    });

    callback(null, summary(run));
  }

  function validateRunId(id) {
    if (!runIdPattern.test(String(id || ''))) {
      throw requestError(400, 'Invalid test run id');
    }
  }

  function normalizeOffset(value, size) {
    if (value == null || value === '') return 0;
    const offset = Number(value);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw requestError(400, 'Invalid output offset');
    }
    return Math.min(offset, size);
  }

  function readOutput(id, streamName, offset, size) {
    if (offset >= size) return '';
    const file = runPaths(id)[streamName];
    if (!fs.existsSync(file)) return '';
    const length = size - offset;
    const buffer = Buffer.allocUnsafe(length);
    const fd = fs.openSync(file, 'r');
    try {
      const bytesRead = fs.readSync(fd, buffer, 0, length, offset);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  }

  function get(id, offsets, callback) {
    let stdoutOffset;
    let stderrOffset;
    try {
      validateRunId(id);
      const run = runs.get(id);
      if (!run) {
        callback(requestError(404, 'Test run not found'));
        return;
      }
      stdoutOffset = normalizeOffset(offsets && offsets.stdoutOffset, run.stdoutBytes);
      stderrOffset = normalizeOffset(offsets && offsets.stderrOffset, run.stderrBytes);
      callback(null, {
        ...summary(run),
        stdout: readOutput(id, 'stdout', stdoutOffset, run.stdoutBytes),
        stderr: readOutput(id, 'stderr', stderrOffset, run.stderrBytes),
        nextStdoutOffset: run.stdoutBytes,
        nextStderrOffset: run.stderrBytes,
      });
    } catch (error) {
      callback(error);
    }
  }

  function getActive() {
    const run = activeRunId && runs.get(activeRunId);
    return run && !isTerminal(run) ? summary(run) : null;
  }

  function getLatestForJob(jobId) {
    const latest = Array.from(runs.values())
      .filter((run) => run.jobId === jobId && (run.runType || 'test') === 'test')
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
    return latest ? summary(latest) : null;
  }

  function stop(id, callback) {
    try {
      validateRunId(id);
      const run = runs.get(id);
      if (!run) {
        callback(requestError(404, 'Test run not found'));
        return;
      }
      if (isTerminal(run) || run.status === 'stopping') {
        callback(null, summary(run));
        return;
      }

      run.status = 'stopping';
      run.stopRequested = true;
      persist(run);
      signalRun(run, 'SIGTERM');
      run.killTimer = setTimeout(() => signalRun(run, 'SIGKILL'), stopGraceMs);
      callback(null, summary(run));
    } catch (error) {
      callback(error);
    }
  }

  function shutdown(callback) {
    shuttingDown = true;
    const active = activeRunId && runs.get(activeRunId);
    if (!active || isTerminal(active)) {
      callback();
      return;
    }
    active.shutdownWaiters.push(callback);
    stop(active.id, (error) => {
      if (error) notifyShutdownWaiters(active);
    });
    setTimeout(() => notifyShutdownWaiters(active), stopGraceMs + 1000);
  }

  loadPersistedRuns();
  const cleanupTimer = setInterval(cleanupRetainedRuns, 60 * 60 * 1000);
  cleanupTimer.unref();

  return {
    start,
    get,
    getActive,
    getLatestForJob,
    stop,
    shutdown,
    folder,
  };
};
