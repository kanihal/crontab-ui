'use strict';

/*********** Theme ****************/

function applyTheme(mode) {
  // mode: 'light' | 'dark' | 'system'
  var resolved;
  if (mode === 'light' || mode === 'dark') {
    resolved = mode;
  } else {
    resolved = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-bs-theme', resolved);
  var iconEl = document.getElementById('theme-icon');
  if (iconEl) {
    iconEl.className = 'bi ' + (
      mode === 'light' ? 'bi-sun-fill' :
      mode === 'dark' ? 'bi-moon-fill' :
      'bi-circle-half'
    );
  }
}

function setTheme(mode) {
  try {
    if (mode === 'system') localStorage.removeItem('cui-theme');
    else localStorage.setItem('cui-theme', mode);
  } catch (_e) {}
  applyTheme(mode);
}

document.addEventListener('DOMContentLoaded', function() {
  var stored = null;
  try { stored = localStorage.getItem('cui-theme'); } catch (_e) {}
  applyTheme(stored || 'system');

  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var listener = function() {
      var s = null;
      try { s = localStorage.getItem('cui-theme'); } catch (_e) {}
      if (!s) applyTheme('system');
    };
    if (mq.addEventListener) mq.addEventListener('change', listener);
    else if (mq.addListener) mq.addListener(listener);
  }
});

/*********** MessageBox ****************/

function getModal(id) {
  return bootstrap.Modal.getOrCreateInstance(document.getElementById(id));
}

function infoMessageBox(message, title) {
  document.getElementById('info-body').innerHTML = message;
  document.getElementById('info-title').innerHTML = title;
  getModal('info-popup').show();
}

function errorMessageBox(message) {
  var msg =
    'Operation failed: ' + message + '. ' +
    'Please see error log for details.';
  infoMessageBox(msg, 'Error');
}

function messageBox(body, title, ok_text, close_text, callback) {
  var modalBody = document.getElementById('modal-body');
  if (typeof body === 'string') {
    modalBody.innerHTML = body;
  } else {
    modalBody.innerHTML = '';
    modalBody.appendChild(body);
  }
  document.getElementById('modal-title').innerHTML = title;
  if (ok_text) document.getElementById('modal-button').innerHTML = ok_text;
  if (close_text) document.getElementById('modal-close-button').innerHTML = close_text;

  var btn = document.getElementById('modal-button');
  var newBtn = btn.cloneNode(true);
  btn.parentNode.replaceChild(newBtn, btn);
  newBtn.addEventListener('click', function() {
    getModal('popup').hide();
    if (callback) callback();
  });

  getModal('popup').show();
}


/*********** crontab actions ****************/

var schedule = '';
var job_command = '';

function deleteJob(_id) {
  messageBox('<p> Do you want to delete this Job? </p>', 'Confirm delete', null, null, function() {
    $.post(routes.remove, {_id: _id}, function() {
      location.reload();
    });
  });
}

function stopJob(_id, btn) {
  setJobEnabled(_id, false, btn);
}

function startJob(_id, btn) {
  setJobEnabled(_id, true, btn);
}

function setJobEnabled(_id, enabled, btn) {
  var url = enabled ? routes.start : routes.stop;
  if (btn) btn.classList.add('disabled');
  $.post(url, {_id: _id})
    .done(function() {
      if (!btn) return;
      btn.classList.remove('disabled');
      btn.classList.toggle('toggle-on', enabled);
      btn.classList.toggle('toggle-off', !enabled);
      var icon = btn.querySelector('i.bi');
      if (icon) {
        icon.classList.toggle('bi-toggle-on', enabled);
        icon.classList.toggle('bi-toggle-off', !enabled);
      }
      var newTitle = enabled ? 'Disable' : 'Enable';
      btn.setAttribute('title', newTitle);
      btn.setAttribute('data-bs-original-title', newTitle);
      var tip = bootstrap.Tooltip.getInstance(btn);
      if (tip) { tip.hide(); tip.dispose(); }
      new bootstrap.Tooltip(btn);
      btn.onclick = enabled
        ? function() { stopJob(_id, btn); }
        : function() { startJob(_id, btn); };
      var tr = btn.closest('tr');
      if (tr) tr.classList.toggle('table-primary', !enabled);
    })
    .fail(function() {
      if (btn) btn.classList.remove('disabled');
    });
}

function runJob(_id) {
  messageBox('<p> Do you want to run this Job? </p>', 'Confirm run job', null, null, function() {
    $.post(routes.run, {_id: _id}, function() {
      location.reload();
    });
  });
}

function refreshCrontab() {
  $.get(routes.import_crontab, function() {
    location.reload();
  }).fail(function(response) {
    errorMessageBox(response.statusText);
  });
}

function testRunJob() {
  var command = collapsedCommand();
  var envVars = $('#job-env-vars').val();
  if (!command || !command.trim()) {
    errorMessageBox('Enter a command before running');
    return;
  }
  var btn = document.getElementById('job-test-run');
  var wrap = document.getElementById('job-test-result-wrap');
  var pre = document.getElementById('job-test-result');
  var status = document.getElementById('job-test-status');
  btn.setAttribute('disabled', 'disabled');
  btn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status"></span> Running...';
  wrap.style.display = 'block';
  status.textContent = '';
  pre.textContent = '(running)';
  $.post(routes.test_run, { command: command, envVars: envVars || '' }, function(result) {
    var parts = [];
    if (result.stdout) parts.push('--- stdout ---\n' + result.stdout);
    if (result.stderr) parts.push('--- stderr ---\n' + result.stderr);
    if (!parts.length) parts.push('(no output)');
    pre.textContent = parts.join('\n\n');
    var label = result.timedOut ? 'timed out' : ('exit code ' + result.exitCode);
    status.textContent = '(' + label + ')';
  }).fail(function(xhr) {
    pre.textContent = (xhr.responseJSON && xhr.responseJSON.message) || xhr.statusText || 'request failed';
    status.textContent = '(error)';
  }).always(function() {
    btn.removeAttribute('disabled');
    btn.innerHTML = '<i class="bi bi-play-circle"></i> Test Run';
  });
}

function handleSaveFailure(xhr) {
  if (xhr.status === 409) {
    infoMessageBox(
      'This job was modified elsewhere. Reloading to show the latest version.',
      'Conflict'
    );
    setTimeout(function() { location.reload(); }, 1500);
    return;
  }
  errorMessageBox(xhr.statusText || 'request failed');
}

function editJob(_id) {
  var job = null;
  crontabs.forEach(function(crontab) {
    if (crontab._id == _id) job = crontab;
  });

  resetTestResult();
  if (job) {
    getModal('job').show();
    $('#job-name').val(job.name);
    $('#job-command').val(job.command);
    $('#job-env-vars').val(job.envVars || '');
    $('#job-version').val(job.version != null ? job.version : '');
    if (job.schedule.indexOf('@') !== 0) {
      var components = job.schedule.split(' ');
      $('#job-minute').val(components[0]);
      $('#job-hour').val(components[1]);
      $('#job-day').val(components[2]);
      $('#job-month').val(components[3]);
      $('#job-week').val(components[4]);
    }
    if (job.mailing) {
      $('#job-mailing').attr('data-json', JSON.stringify(job.mailing));
    }
    schedule = job.schedule;
    job_command = job.command;
    if (job.logging && job.logging != 'false')
      $('#job-logging').prop('checked', true);
    job_string();
  }

  var saveBtn = document.getElementById('job-save');
  var newSaveBtn = saveBtn.cloneNode(true);
  saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);
  newSaveBtn.addEventListener('click', function() {
    if (!schedule) schedule = '* * * * *';
    var name = $('#job-name').val();
    var mailing = JSON.parse($('#job-mailing').attr('data-json'));
    var logging = $('#job-logging').prop('checked');
    var version = $('#job-version').val();
    var envVars = $('#job-env-vars').val();
    $.post(routes.save, {name: name, command: collapsedCommand(), schedule: schedule, _id: _id, logging: logging, mailing: mailing, version: version, envVars: envVars}, function() {
      location.reload();
    }).fail(handleSaveFailure);
    getModal('job').hide();
  });
}

function newJob() {
  schedule = '';
  job_command = '';
  $('#job-minute').val('*');
  $('#job-hour').val('*');
  $('#job-day').val('*');
  $('#job-month').val('*');
  $('#job-week').val('*');

  resetTestResult();
  getModal('job').show();
  $('#job-name').val('');
  $('#job-command').val('');
  $('#job-env-vars').val('');
  $('#job-version').val('');
  $('#job-mailing').attr('data-json', '{}');
  $('#job-logging').prop('checked', false);
  job_string();

  var saveBtn = document.getElementById('job-save');
  var newSaveBtn = saveBtn.cloneNode(true);
  saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);
  newSaveBtn.addEventListener('click', function() {
    if (!schedule) schedule = '* * * * *';
    var name = $('#job-name').val();
    var mailing = JSON.parse($('#job-mailing').attr('data-json'));
    var logging = $('#job-logging').prop('checked');
    var envVars = $('#job-env-vars').val();
    $.post(routes.save, {name: name, command: collapsedCommand(), schedule: schedule, _id: -1, logging: logging, mailing: mailing, envVars: envVars}, function() {
      location.reload();
    }).fail(handleSaveFailure);
    getModal('job').hide();
  });
}

function duplicateJob(_id) {
  var job = null;
  crontabs.forEach(function(crontab) {
    if (crontab._id == _id) job = crontab;
  });
  if (!job) return;

  var name = job.name ? job.name + ' (copy)' : '';
  var logging = (job.logging && job.logging != 'false') ? job.logging : 'false';
  var mailing = job.mailing || {};

  $.post(routes.save, {
    name: name,
    command: job.command,
    schedule: job.schedule,
    _id: -1,
    logging: logging,
    mailing: mailing,
    envVars: job.envVars || ''
  }, function() {
    location.reload();
  });
}

function resetTestResult() {
  var wrap = document.getElementById('job-test-result-wrap');
  if (wrap) wrap.style.display = 'none';
  var pre = document.getElementById('job-test-result');
  if (pre) pre.textContent = '';
  var status = document.getElementById('job-test-status');
  if (status) status.textContent = '';
}

function defaultBackupName() {
  var d = new Date();
  var pad = function(n) { return n < 10 ? '0' + n : '' + n; };
  var tzMatch = d.toString().match(/\(([^)]+)\)/);
  var tz = '';
  if (tzMatch) {
    tz = tzMatch[1].split(' ').map(function(w) { return w.charAt(0); }).join('');
  } else {
    var off = -d.getTimezoneOffset();
    var sign = off >= 0 ? '+' : '-';
    tz = 'UTC' + sign + pad(Math.floor(Math.abs(off) / 60)) + pad(Math.abs(off) % 60);
  }
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + ' ' + pad(d.getHours()) + '.' + pad(d.getMinutes()) + ' ' + tz;
}

function doBackup() {
  var defaultName = defaultBackupName();
  var safeDefault = defaultName.replace(/"/g, '&quot;');
  var body = '<label for="backup-name-input" class="form-label small mb-1">Backup name</label>'
    + '<input type="text" class="form-control form-control-sm" id="backup-name-input" value="' + safeDefault + '" />'
    + '<div class="form-text small mt-1">Saved as <code>backup &lt;name&gt;.db</code> in the database folder. Re-using the same name overwrites the previous backup.</div>';
  messageBox(body, 'Create backup', 'Backup', null, function() {
    var input = document.getElementById('backup-name-input');
    var name = input ? input.value : '';
    $.get(routes.backup, name ? { name: name } : {}, function() {
      location.reload();
    });
  });
  setTimeout(function() {
    var input = document.getElementById('backup-name-input');
    if (input) { input.focus(); input.select(); }
  }, 200);
}

function delete_backup(db_name) {
  messageBox('<p> Do you want to delete this backup? </p>', 'Confirm delete', null, null, function() {
    $.get(routes.delete_backup, {db: db_name}, function() {
      location = routes.backups || routes.root;
    });
  });
}

function delete_all_backups() {
  messageBox(
    '<p class="mb-0">Delete <strong>all</strong> saved backups? This cannot be undone.</p>',
    'Confirm delete all', 'Delete all', null, function() {
      $.get(routes.delete_all_backups, {}, function() {
        location.reload();
      });
    }
  );
}

function restore_backup(db_name) {
  messageBox('<p> Do you want to restore this backup? </p>', 'Confirm restore', null, null, function() {
    $.get(routes.restore_backup, {db: db_name}, function() {
      location = routes.root;
    });
  });
}

function import_db() {
  var body = '<p class="mb-2">Pick a <code>crontab.db</code> file to import.</p>'
    + '<p class="text-muted small mb-3">A backup of your current jobs will be created automatically before the import completes, so you can restore from the <strong>Backups</strong> menu if anything goes wrong.</p>'
    + '<input type="file" class="form-control form-control-sm" id="import-file-modal" accept=".db,application/octet-stream" />'
    + '<div class="form-text small mt-1" id="import-file-status">Choose a file, then click Import.</div>';
  messageBox(body, 'Import database', 'Import', null, function() {
    var input = document.getElementById('import-file-modal');
    var status = document.getElementById('import-file-status');
    if (!input || !input.files || input.files.length === 0) {
      if (status) {
        status.textContent = 'Pick a file first.';
        status.classList.add('text-danger');
      }
      // Re-open the modal since messageBox auto-hid it on click.
      getModal('popup').show();
      return;
    }
    var fd = new FormData();
    fd.append('import_file', input.files[0]);
    fetch(routes.import, { method: 'POST', body: fd })
      .then(function(r) {
        if (!r.ok) throw new Error('Import failed (' + r.status + ')');
        location.reload();
      })
      .catch(function(err) {
        messageBox('<p class="text-danger mb-0">' + err.message + '</p>', 'Import failed', 'OK', null, null);
      });
  });
  setTimeout(function() {
    var input = document.getElementById('import-file-modal');
    if (input) input.focus();
  }, 200);
}

function setMailConfig(a) {
  var data = JSON.parse(a.getAttribute('data-json'));
  var container = document.createElement('div');

  var message = "<p>This is based on nodemailer. Refer <a href='http://lifepluslinux.blogspot.com/2017/03/introducing-mailing-in-crontab-ui.html'>this</a> for more details.</p>";
  container.innerHTML += message;

  var transporterLabel = document.createElement('label');
  transporterLabel.className = 'form-label';
  transporterLabel.innerHTML = 'Transporter';
  var transporterInput = document.createElement('input');
  transporterInput.type = 'text';
  transporterInput.id = 'transporterInput';
  transporterInput.setAttribute('placeholder', config.transporterStr);
  transporterInput.className = 'form-control';
  if (data.transporterStr) {
    transporterInput.setAttribute('value', data.transporterStr);
  }
  container.appendChild(transporterLabel);
  container.appendChild(transporterInput);

  container.innerHTML += '<br/>';

  var mailOptionsLabel = document.createElement('label');
  mailOptionsLabel.className = 'form-label';
  mailOptionsLabel.innerHTML = 'Mail Config';
  var mailOptionsInput = document.createElement('textarea');
  mailOptionsInput.setAttribute('placeholder', JSON.stringify(config.mailOptions, null, 2));
  mailOptionsInput.className = 'form-control';
  mailOptionsInput.id = 'mailOptionsInput';
  mailOptionsInput.setAttribute('rows', '10');
  if (data.mailOptions)
    mailOptionsInput.innerHTML = JSON.stringify(data.mailOptions, null, 2);
  container.appendChild(mailOptionsLabel);
  container.appendChild(mailOptionsInput);

  container.innerHTML += '<br/>';

  var button = document.createElement('a');
  button.className = 'btn btn-primary btn-sm';
  button.innerHTML = 'Use Defaults';
  button.onclick = function() {
    document.getElementById('transporterInput').value = config.transporterStr;
    document.getElementById('mailOptionsInput').innerHTML = JSON.stringify(config.mailOptions, null, 2);
  };
  container.appendChild(button);

  var buttonClear = document.createElement('a');
  buttonClear.className = 'btn btn-secondary btn-sm';
  buttonClear.innerHTML = 'Clear';
  buttonClear.onclick = function() {
    document.getElementById('transporterInput').value = '';
    document.getElementById('mailOptionsInput').innerHTML = '';
  };
  container.appendChild(buttonClear);

  messageBox(container, 'Mailing', null, null, function() {
    var transporterStr = document.getElementById('transporterInput').value;
    var mailOptions;
    try {
      mailOptions = JSON.parse(document.getElementById('mailOptionsInput').value);
    } catch (err) { /* ignore parse error */ }

    if (transporterStr && mailOptions) {
      a.setAttribute('data-json', JSON.stringify({transporterStr: transporterStr, mailOptions: mailOptions}));
    } else {
      a.setAttribute('data-json', JSON.stringify({}));
    }
  });
}

function setHookConfig(a) {
  messageBox('<p>Coming Soon</p>', 'Hooks', null, null, null);
}

function collapsedCommand() {
  return job_command.split(/\r?\n/).map(function(l) { return l.trim(); }).filter(Boolean).join('; ');
}

function job_string() {
  var cmd = collapsedCommand();
  $('#job-string').val(schedule + ' ' + cmd);
  updateScheduleHuman(schedule);
  return schedule + ' ' + cmd;
}

function updateScheduleHuman(s) {
  var el = document.getElementById('job-human');
  if (!el) return;
  var human = '';
  if (s === '@reboot') {
    human = 'On system startup';
  } else if (s && typeof cronstrue !== 'undefined') {
    var trimmed = s.trim();
    if (trimmed.charAt(0) === '@') {
      try { human = cronstrue.toString(trimmed); } catch (_e) { human = ''; }
    } else {
      var parts = trimmed.split(/\s+/);
      var anyEmpty = parts.length < 5 || parts.some(function(p) { return p.length === 0; });
      if (!anyEmpty) {
        try { human = cronstrue.toString(trimmed); } catch (_e) { human = ''; }
      }
    }
  }
  el.value = human;
  el.title = human;
  el.classList.remove('is-invalid');
}

function currentCronFields() {
  return [
    $('#job-minute').val().trim(),
    $('#job-hour').val().trim(),
    $('#job-day').val().trim(),
    $('#job-month').val().trim(),
    $('#job-week').val().trim(),
  ].join(' ');
}

document.addEventListener('DOMContentLoaded', function() {
  document.querySelectorAll('.cron-field').forEach(function(el) {
    el.addEventListener('input', function() {
      schedule = currentCronFields();
      job_string();
    });
  });
});

function set_schedule() {
  schedule = $('#job-minute').val() + ' ' + $('#job-hour').val() + ' ' + $('#job-day').val() + ' ' + $('#job-month').val() + ' ' + $('#job-week').val();
  job_string();
}

function quick_schedule(s) {
  schedule = s;
  var fields = {
    '* * * * *': ['*', '*', '*', '*', '*'],
    '@hourly':   ['0', '*', '*', '*', '*'],
    '@daily':    ['0', '0', '*', '*', '*'],
    '@weekly':   ['0', '0', '*', '*', '0'],
    '@monthly':  ['0', '0', '1', '*', '*'],
    '@yearly':   ['0', '0', '1', '1', '*'],
    '@reboot':   ['', '', '', '', '']
  }[s] || ['*', '*', '*', '*', '*'];
  $('#job-minute').val(fields[0]);
  $('#job-hour').val(fields[1]);
  $('#job-day').val(fields[2]);
  $('#job-month').val(fields[3]);
  $('#job-week').val(fields[4]);
  job_string();
}

function previewCrontab() {
  $.get(routes.preview_crontab, function(data) {
    document.getElementById('preview-crontab-content').textContent = data || '# (empty crontab)';
    getModal('preview-crontab-modal').show();
  });
}

function copyCrontab() {
  var text = document.getElementById('preview-crontab-content').textContent;
  navigator.clipboard.writeText(text).then(function() {
    var btn = document.querySelector('#preview-crontab-modal .btn-outline-secondary');
    btn.innerHTML = '<i class="bi bi-check2"></i> Copied!';
    setTimeout(function() {
      btn.innerHTML = '<i class="bi bi-clipboard"></i> Copy';
    }, 2000);
  });
}
