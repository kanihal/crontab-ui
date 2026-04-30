'use strict';

const Datastore = require('@seald-io/nedb');
const path = require('path');
const { exec } = require('child_process');
const fs = require('fs');
const { CronExpressionParser } = require('cron-parser');
const cronstrue = require('cronstrue/i18n');

const humanCronLocale = process.env.HUMANCRON ?? 'en';

const dbFolder = process.env.CRON_DB_PATH || path.join(__dirname, 'crontabs');
console.log(`Cron db path: ${dbFolder}`);

const logFolder = path.join(dbFolder, 'logs');
const envFile = path.join(dbFolder, 'env.db');
const crontabDbFile = path.join(dbFolder, 'crontab.db');

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

function makeCommand(tab) {
  const stderr = path.join(cronPath, `${tab._id}.stderr`);
  const stdout = path.join(cronPath, `${tab._id}.stdout`);
  const logFile = path.join(logFolder, `${tab._id}.log`);
  const logFileStdout = path.join(logFolder, `${tab._id}.stdout.log`);

  let cmd = tab.command;
  if (cmd[cmd.length - 1] !== ';') {
    cmd += ';';
  }

  let result = `({ ${cmd} } | tee ${stdout})`;
  result = `(${result} 3>&1 1>&2 2>&3 | tee ${stderr}) 3>&1 1>&2 2>&3`;
  result = `(${result})`;

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

exports.create_new = (name, command, schedule, logging, mailing, envVars, callback) => {
  const tab = buildCrontab(name, command, schedule, false, logging, mailing, envVars);
  tab.created = Date.now();
  tab.version = 0;
  db.insert(tab, (err, newDoc) => {
    if (callback) callback(err, newDoc);
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

    const updates = {
      name: data.name,
      command: data.command,
      schedule: data.schedule,
      timestamp: new Date().toString(),
      logging: data.logging,
      mailing: data.mailing || {},
      envVars: data.envVars || '',
      version: currentVersion + 1,
    };
    db.update({ _id: data._id }, { $set: updates }, {}, (uerr) => {
      if (callback) callback(uerr ? { status: 500, err: uerr } : null);
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

exports.get_crontab = (_id, callback) => {
  db.find({ _id }).exec((err, docs) => {
    callback(docs[0]);
  });
};

exports.runjob = (_id) => {
  db.find({ _id }).exec((err, docs) => {
    if (err || !docs.length) return;
    const res = docs[0];
    let cmd = makeCommand(res);
    cmd = addEnvVars(res.envVars, cmd);

    console.log('Running job');
    console.log(`ID: ${_id}`);
    console.log(`Original command: ${res.command}`);
    console.log(`Executed command: ${cmd}`);

    exec(cmd, (error) => {
      if (error) console.log(error);
    });
  });
};

exports.test_run = (command, envVars, callback) => {
  if (!command || !command.trim()) {
    return callback({ status: 400, message: 'Command is required' });
  }
  const wrapped = addEnvVars(envVars, command);
  exec(wrapped, { timeout: 30000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
    callback(null, {
      stdout: stdout || '',
      stderr: stderr || '',
      exitCode: error ? (error.code != null ? error.code : 1) : 0,
      timedOut: error && error.killed === true,
    });
  });
};

let deployInFlight = false;
let pendingDeploy = null;

function runDeploy(callback) {
  // Import any externally-added system crontab lines into the DB first, so a
  // deploy triggered by an unrelated UI action doesn't wipe lines the user
  // added directly via `crontab -e` between page loads.
  exports.import_crontab(() => {
    exports.crontabs((tabs) => {
      let crontabString = '';
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

exports.import_crontab = (callback) => {
  exec('crontab -l', (_error, stdout) => {
    const lines = (stdout || '').split('\n');
    const namePrefix = Date.now();
    const wrapperIdRegex = new RegExp(
      `${escapeRegex(cronPath)}/([A-Za-z0-9_-]+)\\.std(?:out|err)`
    );
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

      const idMatch = command.match(wrapperIdRegex);
      if (idMatch) {
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
  });
};

exports.preview_crontab = (callback) => {
  exports.crontabs((tabs) => {
    let crontabString = '';
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
