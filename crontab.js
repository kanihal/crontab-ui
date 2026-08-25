'use strict';

const Datastore = require('@seald-io/nedb');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const fs = require('fs');
const { CronExpressionParser } = require('cron-parser');
const cronstrue = require('cronstrue/i18n');
const createTestRunManager = require('./test-runs');

const humanCronLocale = process.env.HUMANCRON ?? 'en';

const dbFolder = process.env.CRON_DB_PATH || path.join(__dirname, 'crontabs');
console.log(`Cron db path: ${dbFolder}`);

const logFolder = path.join(dbFolder, 'logs');
const envFile = path.join(dbFolder, 'env.db');
const crontabDbFile = path.join(dbFolder, 'crontab.db');
const maxCodeUploadBytes = 1024 * 1024;
const codeRunnerByExtension = {
  '.sh': 'bash',
  '.bash': 'bash',
  '.py': 'python3',
  '.js': 'node',
  '.mjs': 'node',
  '.cjs': 'node',
};

function isPathInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function defaultDataFolder() {
  const home = os.homedir();
  if (!home) return path.join(__dirname, 'crontabs');
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'crontab-ui');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'crontab-ui');
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'crontab-ui');
}

function resolveCodeUploadsFolder() {
  if (process.env.CRONTAB_UI_CODE_PATH) {
    return path.resolve(process.env.CRONTAB_UI_CODE_PATH);
  }

  if (isPathInside(os.tmpdir(), dbFolder)) {
    return path.join(defaultDataFolder(), 'code_uploads');
  }

  return path.join(dbFolder, 'code_uploads');
}

const codeUploadsFolder = resolveCodeUploadsFolder();
console.log(`Code uploads path: ${codeUploadsFolder}`);
// PATCH: prologue lines prepended to every deployed crontab. Used to set
// SHELL=/bin/bash so cron lines run under bash (the default /bin/sh on
// Ubuntu is dash, which has no `source` builtin). User-editable via the
// "Edit global env vars" button in the UI -> POST /globals.
const globalsFile = path.join(dbFolder, 'globals.txt');
const defaultGlobals =
  'SHELL=/bin/bash\nPATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n';
function readGlobalsSync() {
  try {
    const content = fs.readFileSync(globalsFile, 'utf8');
    return content.endsWith('\n') ? content : content + '\n';
  } catch (_e) {
    return defaultGlobals;
  }
}
exports.get_globals = () => {
  try {
    return fs.readFileSync(globalsFile, 'utf8');
  } catch (_e) {
    return defaultGlobals;
  }
};
exports.set_globals = (content, callback) => {
  const safe = (content || '').replace(/\r\n/g, '\n');
  fs.writeFile(globalsFile, safe, (err) => callback(err));
};

const db = new Datastore({ filename: crontabDbFile, autocompactionInterval: 60000 });

let cronPath = '/tmp';
if (process.env.CRON_PATH !== undefined) {
  console.log(`Path to crond files set using env variables ${process.env.CRON_PATH}`);
  cronPath = process.env.CRON_PATH;
}

db.loadDatabase((err) => {
  if (err) throw err;
});

if (!fs.existsSync(logFolder)) {
  fs.mkdirSync(logFolder);
}

if (!fs.existsSync(codeUploadsFolder)) {
  fs.mkdirSync(codeUploadsFolder, { recursive: true, mode: 0o700 });
}

function requestError(status, message, err) {
  return { status, message, err };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function sanitizeCodeJobId(rawId) {
  if (typeof rawId !== 'string' || !rawId || /[^A-Za-z0-9_-]/.test(rawId)) {
    throw requestError(400, 'Invalid job id');
  }
  return rawId;
}

function sanitizeCodeFilename(rawName) {
  const filename = String(rawName || '').trim();
  if (!filename) {
    throw requestError(400, 'Code file name is required');
  }
  if (filename !== path.basename(filename)) {
    throw requestError(400, 'Code file name must not contain a path');
  }
  if (!/^[A-Za-z0-9._-]+$/.test(filename) || filename === '.' || filename === '..') {
    throw requestError(400, 'Code file name contains unsupported characters');
  }
  if (filename.length > 128) {
    throw requestError(400, 'Code file name is too long');
  }
  return filename;
}

function runnerForCodeFilename(filename) {
  const extension = path.extname(filename).toLowerCase();
  const runner = codeRunnerByExtension[extension];
  if (!runner) {
    throw requestError(400, 'Code file must end in .sh, .bash, .py, .js, .mjs, or .cjs');
  }
  return runner;
}

function normalizeCodeContent(rawContent) {
  if (typeof rawContent !== 'string') {
    throw requestError(400, 'Code content is required');
  }
  const content = rawContent.replace(/\r\n/g, '\n');
  if (!content.trim()) {
    throw requestError(400, 'Code content is required');
  }
  if (content.includes('\0')) {
    throw requestError(400, 'Code content must be text');
  }
  const size = Buffer.byteLength(content, 'utf8');
  if (size > maxCodeUploadBytes) {
    throw requestError(400, 'Code content must be 1 MiB or smaller');
  }
  return { content, size };
}

function nextCodeVersion(uploads) {
  return (uploads || []).reduce((max, upload) => (
    Math.max(max, Number(upload.version) || 0)
  ), 0) + 1;
}

function buildCodeUpload(data, version) {
  const filename = sanitizeCodeFilename(data.codeFilename);
  const runner = runnerForCodeFilename(filename);
  const normalized = normalizeCodeContent(data.codeContent);
  const source = data.codeSource === 'upload' ? 'upload' : 'paste';

  return {
    id: `v${version}-${Date.now()}`,
    version,
    filename,
    runner,
    source,
    content: normalized.content,
    size: normalized.size,
    created: new Date().toISOString(),
  };
}

function currentCodeUpload(tab) {
  if (!Array.isArray(tab.codeUploads) || tab.codeUploads.length === 0) return null;
  if (tab.currentCodeUploadId) {
    const current = tab.codeUploads.find((upload) => upload.id === tab.currentCodeUploadId);
    if (current) return current;
  }
  return tab.codeUploads[tab.codeUploads.length - 1];
}

function codeUploadFilePath(jobId, upload) {
  const safeJobId = sanitizeCodeJobId(jobId);
  const filename = sanitizeCodeFilename(upload.filename);
  return path.join(
    codeUploadsFolder,
    'jobs',
    safeJobId,
    'versions',
    String(upload.version || 1),
    filename
  );
}

function commandForCodeUpload(jobId, upload) {
  const filename = sanitizeCodeFilename(upload.filename);
  const runner = runnerForCodeFilename(filename);
  return `${runner} ${shellQuote(codeUploadFilePath(jobId, upload))}`;
}

function materializeCodeUploadSync(jobId, upload) {
  if (!upload || typeof upload.content !== 'string') {
    return commandForCodeUpload(jobId, upload);
  }
  const filePath = codeUploadFilePath(jobId, upload);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, upload.content, { mode: 0o700 });
  fs.chmodSync(filePath, 0o700);
  return commandForCodeUpload(jobId, upload);
}

function commandForTab(tab) {
  if (tab.commandMode === 'code') {
    const upload = currentCodeUpload(tab);
    if (upload) {
      try {
        return materializeCodeUploadSync(tab._id, upload);
      } catch (e) {
        console.error(e);
      }
    }
  }
  return tab.command || '';
}

function redactedCodeUpload(upload) {
  const copy = { ...upload };
  copy.hasContent = typeof copy.content === 'string' && copy.content.length > 0;
  delete copy.content;
  return copy;
}

function publicCrontab(doc) {
  const copy = { ...doc };
  copy.lastTestRun = testRunManager.getLatestForJob(copy._id);
  if (copy.commandMode === 'code') {
    const upload = currentCodeUpload(copy);
    if (upload) {
      try {
        copy.command = commandForCodeUpload(copy._id, upload);
        copy.currentCodeUpload = redactedCodeUpload(upload);
      } catch (e) {
        console.error(e);
      }
    }
    copy.codeUploads = (copy.codeUploads || []).map(redactedCodeUpload);
  }
  return copy;
}

function buildCrontab(name, command, schedule, stopped, logging, mailing, envVars) {
  return {
    name,
    command,
    schedule,
    ...(stopped !== null && { stopped }),
    timestamp: new Date().toString(),
    logging,
    mailing: mailing || {},
    envVars: envVars || '',
  };
}

function makeCommand(tab, preserveExitCode) {
  const stderr = path.join(cronPath, `${tab._id}.stderr`);
  const stdout = path.join(cronPath, `${tab._id}.stdout`);
  const logFile = path.join(logFolder, `${tab._id}.log`);
  const logFileStdout = path.join(logFolder, `${tab._id}.stdout.log`);

  let cmd = commandForTab(tab);
  if (cmd[cmd.length - 1] !== ';') {
    cmd += ';';
  }

  let result = `({ ${cmd} } | tee ${stdout})`;
  result = `(${result} 3>&1 1>&2 2>&3 | tee ${stderr}) 3>&1 1>&2 2>&3`;
  result = `(${result})`;
  if (preserveExitCode) result += '; crontab_ui_job_status=$?';

  if (tab.logging && tab.logging === 'true') {
    result += `; if test -f ${stderr}; then date >> "${logFile}"; cat ${stderr} >> "${logFile}"; fi`;
    result += `; if test -f ${stdout}; then date >> "${logFileStdout}"; cat ${stdout} >> "${logFileStdout}"; fi`;
  }

  if (tab.hook) {
    result += `; if test -f ${stdout}; then ${tab.hook} < ${stdout}; fi`;
  }

  if (tab.mailing && JSON.stringify(tab.mailing) !== '{}') {
    result += `; /usr/local/bin/node ${__dirname}/bin/crontab-ui-mailer.js ${tab._id} ${stdout} ${stderr}`;
  }

  if (preserveExitCode) {
    result += '; exit "$crontab_ui_job_status"';
    return `bash -o pipefail -c ${shellQuote(result)}`;
  }
  return result;
}

function addEnvVars(envVars, command) {
  if (envVars) {
    return `(${envVars.replace(/\s*\n\s*/g, ' ').trim()}; (${command}))`;
  }
  return command;
}

exports.db_folder = dbFolder;
exports.log_folder = logFolder;
exports.env_file = envFile;
exports.crontab_db_file = crontabDbFile;
exports.code_uploads_folder = codeUploadsFolder;

function normalizeCreateArgs(nameOrData, command, schedule, logging, mailing, envVars, callback) {
  if (typeof nameOrData === 'object' && nameOrData !== null) {
    return { data: nameOrData, callback: command };
  }
  return {
    data: { name: nameOrData, command, schedule, logging, mailing, envVars },
    callback,
  };
}

function baseUpdatesFromData(data, version) {
  return {
    name: data.name,
    schedule: data.schedule,
    timestamp: new Date().toString(),
    logging: data.logging,
    mailing: data.mailing || {},
    envVars: data.envVars || '',
    version,
  };
}

function hasSubmittedCode(data) {
  return Object.prototype.hasOwnProperty.call(data, 'codeContent');
}

exports.create_new = (nameOrData, command, schedule, logging, mailing, envVars, callback) => {
  const normalized = normalizeCreateArgs(nameOrData, command, schedule, logging, mailing, envVars, callback);
  const data = normalized.data;
  const cb = normalized.callback;
  const codeMode = data.commandMode === 'code';
  let upload = null;

  if (codeMode) {
    try {
      upload = buildCodeUpload(data, 1);
    } catch (e) {
      if (cb) cb(e);
      return;
    }
  }

  const tab = buildCrontab(
    data.name,
    codeMode ? '' : data.command,
    data.schedule,
    false,
    data.logging,
    data.mailing,
    data.envVars
  );
  tab.created = Date.now();
  tab.version = 0;
  tab.commandMode = codeMode ? 'code' : 'command';
  tab.codeUploads = [];
  tab.currentCodeUploadId = '';

  db.insert(tab, (err, newDoc) => {
    if (err || !codeMode) {
      if (cb) cb(err, newDoc);
      return;
    }

    upload.command = commandForCodeUpload(newDoc._id, upload);
    try {
      materializeCodeUploadSync(newDoc._id, upload);
    } catch (e) {
      db.remove({ _id: newDoc._id }, {}, () => {});
      if (cb) cb(requestError(500, 'Unable to save code file', e));
      return;
    }

    const updates = {
      command: upload.command,
      codeUploads: [upload],
      currentCodeUploadId: upload.id,
    };
    db.update({ _id: newDoc._id }, { $set: updates }, {}, (uerr) => {
      if (cb) cb(uerr ? requestError(500, 'Unable to save code job', uerr) : null, {
        ...newDoc,
        ...updates,
      });
    });
  });
};

exports.update = (data, callback) => {
  db.findOne({ _id: data._id }, (err, doc) => {
    if (err) return callback && callback({ status: 500, err });
    if (!doc) return callback && callback({ status: 404 });

    const submittedVersion = Number(data.version);
    const currentVersion = Number(doc.version || 0);
    if (!Number.isNaN(submittedVersion) && submittedVersion !== currentVersion) {
      return callback && callback({ status: 409, doc });
    }

    const updates = baseUpdatesFromData(data, currentVersion + 1);

    if (data.commandMode === 'code') {
      const uploads = Array.isArray(doc.codeUploads) ? doc.codeUploads.slice() : [];
      let upload = null;

      if (hasSubmittedCode(data)) {
        try {
          const submittedUpload = buildCodeUpload(data, nextCodeVersion(uploads));
          const currentUpload = currentCodeUpload(doc);
          const isUnchanged = currentUpload &&
            currentUpload.filename === submittedUpload.filename &&
            currentUpload.content === submittedUpload.content;

          if (isUnchanged) {
            upload = currentUpload;
          } else {
            upload = submittedUpload;
            uploads.push(upload);
          }
          upload.command = commandForCodeUpload(data._id, upload);
          materializeCodeUploadSync(data._id, upload);
        } catch (e) {
          return callback && callback(e);
        }
      } else {
        upload = currentCodeUpload(doc);
        if (!upload) {
          return callback && callback(requestError(400, 'Code content is required'));
        }
        try {
          upload.command = commandForCodeUpload(data._id, upload);
          materializeCodeUploadSync(data._id, upload);
        } catch (e) {
          return callback && callback(requestError(500, 'Unable to save code file', e));
        }
      }

      updates.commandMode = 'code';
      updates.command = upload.command;
      updates.codeUploads = uploads;
      updates.currentCodeUploadId = upload.id;
    } else {
      updates.commandMode = 'command';
      updates.command = data.command;
      updates.codeUploads = [];
      updates.currentCodeUploadId = '';
    }

    db.update({ _id: data._id }, { $set: updates }, {}, (uerr) => {
      if (callback) callback(uerr ? requestError(500, 'Unable to update job', uerr) : null);
    });
  });
};

exports.status = (_id, stopped, callback) => {
  db.update({ _id }, { $set: { stopped } }, {}, (err) => {
    if (callback) callback(err);
  });
};

exports.remove = (_id, callback) => {
  db.remove({ _id }, {}, (err) => {
    if (callback) callback(err);
  });
};

exports.crontabs = (callback) => {
  db.find({}).sort({ created: -1 }).exec((err, docs) => {
    if (err) {
      console.error(err);
      return callback([]);
    }
    for (const doc of docs) {
      if (doc.schedule === '@reboot') {
        doc.next = 'Next Reboot';
      } else {
        try {
          doc.human = cronstrue.toString(doc.schedule, { locale: humanCronLocale });
          doc.next = CronExpressionParser.parse(doc.schedule).next().toString();
        } catch (e) {
          console.error(e);
          doc.next = 'invalid';
        }
      }
    }
    callback(docs);
  });
};

exports.public_crontabs = (callback) => {
  exports.crontabs((docs) => {
    callback(docs.map(publicCrontab));
  });
};

exports.get_current_code = (_id, callback) => {
  let jobId;
  try {
    jobId = sanitizeCodeJobId(_id);
  } catch (e) {
    callback(e);
    return;
  }

  db.findOne({ _id: jobId }, (err, doc) => {
    if (err) return callback(requestError(500, 'Unable to load job', err));
    if (!doc) return callback(requestError(404, 'Job not found'));
    if (doc.commandMode !== 'code') {
      return callback(requestError(400, 'Job does not use managed code'));
    }

    const upload = currentCodeUpload(doc);
    if (!upload) return callback(requestError(404, 'Managed code file not found'));

    try {
      const filePath = codeUploadFilePath(jobId, upload);
      if (!fs.existsSync(filePath)) {
        if (typeof upload.content !== 'string') {
          return callback(requestError(404, 'Managed code file not found'));
        }
        materializeCodeUploadSync(jobId, upload);
      }
      const content = fs.readFileSync(filePath, 'utf8');
      callback(null, {
        filename: upload.filename,
        version: upload.version,
        content,
      });
    } catch (e) {
      callback(requestError(500, 'Unable to read managed code file', e));
    }
  });
};

exports.get_crontab = (_id, callback) => {
  db.find({ _id }).exec((err, docs) => {
    callback(docs[0]);
  });
};

function testRunCommandFromData(data) {
  if (data.commandMode === 'code' && hasSubmittedCode(data)) {
    const upload = buildCodeUpload(data, 1);
    const testJobId = `test-${process.pid}-${Date.now()}`;
    const jobRoot = path.join(codeUploadsFolder, 'jobs', testJobId);
    upload.command = commandForCodeUpload(testJobId, upload);
    materializeCodeUploadSync(testJobId, upload);
    return {
      command: upload.command,
      cleanup: () => fs.rmSync(jobRoot, { recursive: true, force: true }),
    };
  }

  return { command: data.command || '', cleanup: null };
}

const testRunManager = createTestRunManager({
  folder: path.join(dbFolder, 'test-runs'),
  prepare(data) {
    const prepared = testRunCommandFromData(data || {});
    const jobId = data && data.jobId ? sanitizeCodeJobId(String(data.jobId)) : null;
    return {
      command: addEnvVars(data && data.envVars, prepared.command),
      cleanup: prepared.cleanup,
      jobId,
      runType: data && data.runType === 'run-now' ? 'run-now' : 'test',
    };
  },
});

exports.runjob = (_id, callback) => {
  let jobId;
  try {
    jobId = sanitizeCodeJobId(_id);
  } catch (error) {
    callback(error);
    return;
  }
  db.findOne({ _id: jobId }, (err, job) => {
    if (err) return callback(requestError(500, 'Unable to load job', err));
    if (!job) return callback(requestError(404, 'Job not found'));

    const command = makeCommand(job, true);
    return testRunManager.start({
      command,
      envVars: job.envVars,
      jobId,
      runType: 'run-now',
    }, (startError, result) => {
      if (!startError) {
        console.log('Running job');
        console.log(`ID: ${jobId}`);
        console.log(`Original command: ${job.command}`);
        console.log(`Executed command: ${addEnvVars(job.envVars, command)}`);
      }
      callback(startError, result);
    });
  });
};

exports.test_run = (data, callback) => testRunManager.start({
  ...(data || {}),
  runType: 'test',
}, callback);
exports.get_test_run = testRunManager.get;
exports.get_active_test_run = testRunManager.getActive;
exports.get_latest_test_run = (_id, callback) => {
  let jobId;
  try {
    jobId = sanitizeCodeJobId(_id);
  } catch (error) {
    callback(error);
    return;
  }
  const latest = testRunManager.getLatestForJob(jobId);
  if (!latest) {
    callback(requestError(404, 'No test run found for this job'));
    return;
  }
  testRunManager.get(latest.id, {}, callback);
};
exports.stop_test_run = testRunManager.stop;
exports.shutdown_test_runs = testRunManager.shutdown;
exports.test_runs_folder = testRunManager.folder;

let deployInFlight = false;
let pendingDeploy = null;

function runDeploy(callback) {
  // Import any externally-added system crontab lines into the DB first, so a
  // deploy triggered by an unrelated UI action doesn't wipe lines the user
  // added directly via `crontab -e` between page loads.
  exports.import_crontab(() => {
    exports.crontabs((tabs) => {
      // PATCH: prepend user-editable global env vars (see readGlobalsSync above)
      let crontabString = readGlobalsSync();
      for (const tab of tabs) {
        if (!tab.stopped) {
          const wrapped = addEnvVars(tab.envVars, makeCommand(tab));
          crontabString += `${tab.schedule} ${wrapped}\n`;
        }
      }
      const fileName = process.env.CRON_IN_DOCKER !== undefined ? 'root' : 'crontab';
      const filePath = path.join(cronPath, fileName);
      fs.writeFile(filePath, crontabString, (err) => {
        if (err) {
          console.error(err);
          return callback(err);
        }
        if (process.env.CRONTAB_UI_SKIP_DEPLOY === 'true') {
          return callback();
        }
        exec(`crontab ${filePath}`, (execErr) => {
          if (execErr) {
            console.error(execErr);
            return callback(execErr);
          }
          callback();
        });
      });
    });
  });
}

exports.deploy = (callback) => {
  const cb = callback || (() => {});
  if (deployInFlight) {
    if (!pendingDeploy) pendingDeploy = { callbacks: [] };
    pendingDeploy.callbacks.push(cb);
    return;
  }
  deployInFlight = true;
  runDeploy((err) => {
    deployInFlight = false;
    cb(err);
    if (pendingDeploy) {
      const cbs = pendingDeploy.callbacks;
      pendingDeploy = null;
      exports.deploy((err2) => cbs.forEach((c) => c(err2)));
    }
  });
};

exports.get_backup_names = () => {
  const backups = fs.readdirSync(dbFolder)
    .filter((file) => file.indexOf('backup') === 0);

  // Sort by file mtime, newest first. This is more reliable than parsing
  // a timestamp out of the filename because (a) custom-named backups have
  // no timestamp in the name and (b) re-using a name overwrites the file,
  // which should bump it to the top of the dropdown.
  const mtime = (name) => {
    try {
      return fs.statSync(path.join(dbFolder, name)).mtime.valueOf();
    } catch (_e) {
      return 0;
    }
  };
  backups.sort((a, b) => mtime(b) - mtime(a));
  return backups;
};

exports.get_backup_details = () => {
  return exports.get_backup_names().map((file) => {
    let mtime = 0;
    try {
      mtime = fs.statSync(path.join(dbFolder, file)).mtime.valueOf();
    } catch (_e) { /* missing/unreadable — surface as 0 */ }
    return {
      file,
      name: file.replace(/^backup /, '').replace(/\.db$/, ''),
      mtime,
    };
  });
};

function sanitizeBackupName(raw) {
  if (!raw) return '';
  return String(raw).replace(/[^A-Za-z0-9 _.-]/g, '').trim().slice(0, 64);
}

exports.backup = (nameOrCallback, callback) => {
  let name = '';
  let cb = callback;
  if (typeof nameOrCallback === 'function') {
    cb = nameOrCallback;
  } else {
    name = sanitizeBackupName(nameOrCallback);
  }
  const filename = name
    ? `backup ${name}.db`
    : `backup ${new Date().toString().replace('+', ' ')}.db`;
  const dest = path.join(dbFolder, filename);
  fs.copyFile(crontabDbFile, dest, (err) => {
    if (err) {
      console.error(err);
      return cb(err);
    }
    cb();
  });
};

exports.restore = (dbName) => {
  fs.createReadStream(path.join(dbFolder, dbName))
    .pipe(fs.createWriteStream(crontabDbFile));
  db.loadDatabase();
};

exports.reload_db = () => {
  db.loadDatabase();
};

exports.get_env = () => {
  if (fs.existsSync(envFile)) {
    return fs.readFileSync(envFile, 'utf8').replace('\n', '\n');
  }
  return '';
};

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isManagedWrapperCommand(command) {
  const currentPathRegex = new RegExp(
    `${escapeRegex(cronPath)}/([A-Za-z0-9_-]+)\\.std(?:out|err)`
  );
  if (currentPathRegex.test(command)) return true;

  return (
    /\|\s*tee\s+\S+\.stdout\b/.test(command) &&
    /\|\s*tee\s+\S+\.stderr\b/.test(command) &&
    /3>&1\s+1>&2\s+2>&3/.test(command)
  );
}

exports.import_crontab = (callback) => {
  if (process.env.CRONTAB_UI_SKIP_SYSTEM_IMPORT === 'true') {
    return process.nextTick(() => callback && callback());
  }

  const handleCrontab = (stdout) => {
    const lines = (stdout || '').split('\n');
    const namePrefix = Date.now();
    const lineRegex = /^((@[a-zA-Z]+\s+)|(([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+))/;

    const tasks = lines.map((rawLine, index) => new Promise((resolve) => {
      const line = rawLine.replace(/\t+/g, ' ').trim();
      if (!line || line.startsWith('#')) return resolve();

      const command = line.replace(lineRegex, '').trim();
      const schedule = line.replace(command, '').trim();

      let isValid = false;
      try {
        isValid = CronExpressionParser.parse(schedule) !== null;
      } catch (_e) { /* ignore */ }

      if (!command || !schedule || !isValid) return resolve();

      if (isManagedWrapperCommand(command)) {
        // Wrapper line — either managed (skip) or orphan (skip; next deploy cleans).
        return resolve();
      }

      db.findOne({ command, schedule }, (err, doc) => {
        if (err || doc) return resolve();
        const name = `${namePrefix}_${index}`;
        exports.create_new(name, command, schedule, null, null, () => resolve());
      });
    }));

    Promise.all(tasks).then(() => callback && callback());
  };

  if (process.env.CRONTAB_UI_SYSTEM_CRONTAB_FILE) {
    return fs.readFile(process.env.CRONTAB_UI_SYSTEM_CRONTAB_FILE, 'utf8', (_err, stdout) => {
      handleCrontab(stdout);
    });
  }

  exec('crontab -l', (_error, stdout) => handleCrontab(stdout));
};

exports.preview_crontab = (callback) => {
  exports.crontabs((tabs) => {
    // PATCH: force bash for every cron line (POSIX /bin/sh has no `source`)
      let crontabString = 'SHELL=/bin/bash\nPATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n';
    for (const tab of tabs) {
      if (!tab.stopped) {
        const wrapped = addEnvVars(tab.envVars, makeCommand(tab));
        crontabString += `${tab.schedule} ${wrapped}\n`;
      }
    }
    callback(crontabString);
  });
};

exports.autosave_crontab = (callback) => exports.deploy(callback);
