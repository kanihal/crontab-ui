'use strict';

/* global describe, it, expect, beforeAll, afterAll */
const request = require('supertest');
const path = require('path');
const fs = require('fs');
const os = require('os');

const testDbPath = path.join(os.tmpdir(), `crontab-ui-test-${Date.now()}`);
fs.mkdirSync(testDbPath, { recursive: true });
fs.mkdirSync(path.join(testDbPath, 'logs'), { recursive: true });

process.env.CRON_DB_PATH = testDbPath;
process.env.CRON_PATH = testDbPath;
process.env.CRONTAB_UI_CODE_PATH = path.join(testDbPath, 'code_uploads');
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
process.env.CRONTAB_UI_DISABLE_AUTH = 'true';
process.env.CRONTAB_UI_SKIP_SYSTEM_IMPORT = 'true';
process.env.CRONTAB_UI_SKIP_DEPLOY = 'true';

const app = require('../app');
const crontab = require('../crontab');

function findJobByName(name) {
  return new Promise((resolve) => {
    crontab.crontabs((docs) => {
      resolve(docs.find((doc) => doc.name === name));
    });
  });
}

describe('Crontab UI', () => {
  afterAll(() => {
    fs.rmSync(testDbPath, { recursive: true, force: true });
  });

  describe('GET /', () => {
    it('should return the main page', async () => {
      const res = await request(app).get('/');
      expect(res.status).toBe(200);
      expect(res.text).toContain('Crontab UI');
      expect(res.text).toContain('New Job');
    });
  });

  describe('POST /save', () => {
    it('should create a new job', async () => {
      const res = await request(app)
        .post('/save')
        .send({
          _id: -1,
          name: 'test-job',
          command: 'echo hello',
          schedule: '* * * * *',
          logging: 'false',
          mailing: {},
        });
      expect(res.status).toBe(200);
    });

    it('should show the new job on the main page', async () => {
      const res = await request(app).get('/');
      expect(res.status).toBe(200);
      expect(res.text).toContain('test-job');
      expect(res.text).toContain('echo hello');
    });
  });

  describe('Code jobs', () => {
    it('should create a shell job from uploaded code', async () => {
      const res = await request(app)
        .post('/save')
        .send({
          _id: -1,
          name: 'uploaded-shell-code',
          commandMode: 'code',
          codeFilename: 'backup.sh',
          codeContent: 'echo uploaded-shell-secret\n',
          codeSource: 'upload',
          schedule: '* * * * *',
          logging: 'false',
          mailing: {},
        });
      expect(res.status).toBe(200);

      const job = await findJobByName('uploaded-shell-code');
      expect(job.command).toContain('bash');
      expect(job.command).toContain('backup.sh');
      expect(fs.existsSync(path.join(
        testDbPath, 'code_uploads', 'jobs', job._id, 'versions', '1', 'backup.sh'
      ))).toBe(true);
    });

    it('should create Python and Node jobs from uploaded code', async () => {
      const py = await request(app)
        .post('/save')
        .send({
          _id: -1,
          name: 'uploaded-python-code',
          commandMode: 'code',
          codeFilename: 'sync.py',
          codeContent: 'print("uploaded-python-secret")\n',
          codeSource: 'upload',
          schedule: '* * * * *',
          logging: 'false',
          mailing: {},
        });
      expect(py.status).toBe(200);

      const js = await request(app)
        .post('/save')
        .send({
          _id: -1,
          name: 'uploaded-node-code',
          commandMode: 'code',
          codeFilename: 'report.js',
          codeContent: 'console.log("uploaded-node-secret")\n',
          codeSource: 'upload',
          schedule: '* * * * *',
          logging: 'false',
          mailing: {},
        });
      expect(js.status).toBe(200);

      const pyJob = await findJobByName('uploaded-python-code');
      const jsJob = await findJobByName('uploaded-node-code');
      expect(pyJob.command).toContain('python3');
      expect(pyJob.command).toContain('sync.py');
      expect(jsJob.command).toContain('node');
      expect(jsJob.command).toContain('report.js');
    });

    it('should create a job from pasted code', async () => {
      const res = await request(app)
        .post('/save')
        .send({
          _id: -1,
          name: 'pasted-code-job',
          commandMode: 'code',
          codeFilename: 'paste.sh',
          codeContent: 'echo pasted-page-secret\n',
          codeSource: 'paste',
          schedule: '* * * * *',
          logging: 'false',
          mailing: {},
        });
      expect(res.status).toBe(200);

      const job = await findJobByName('pasted-code-job');
      expect(job.codeUploads).toHaveLength(1);
      expect(job.codeUploads[0].source).toBe('paste');
    });

    it('should reject invalid pasted or uploaded code inputs', async () => {
      const base = {
        _id: -1,
        name: 'invalid-code-job',
        commandMode: 'code',
        schedule: '* * * * *',
        logging: 'false',
        mailing: {},
      };

      const missingName = await request(app)
        .post('/save')
        .send({ ...base, codeFilename: '', codeContent: 'echo ok\n' });
      expect(missingName.status).toBe(400);

      const unsupported = await request(app)
        .post('/save')
        .send({ ...base, codeFilename: 'task.rb', codeContent: 'puts "no"\n' });
      expect(unsupported.status).toBe(400);

      const empty = await request(app)
        .post('/save')
        .send({ ...base, codeFilename: 'empty.sh', codeContent: '' });
      expect(empty.status).toBe(400);

      const unsafe = await request(app)
        .post('/save')
        .send({ ...base, codeFilename: '../unsafe.sh', codeContent: 'echo no\n' });
      expect(unsafe.status).toBe(400);

      const oversized = await request(app)
        .post('/save')
        .send({ ...base, codeFilename: 'large.sh', codeContent: 'x'.repeat(1024 * 1024 + 1) });
      expect(oversized.status).toBe(400);
    });

    it('should append a new active version when editing a code job', async () => {
      const before = await findJobByName('pasted-code-job');
      expect(before.codeUploads).toHaveLength(1);

      const res = await request(app)
        .post('/save')
        .send({
          _id: before._id,
          version: before.version,
          name: before.name,
          commandMode: 'code',
          command: before.command,
          codeFilename: 'paste.py',
          codeContent: 'print("pasted-v2-secret")\n',
          codeSource: 'paste',
          schedule: before.schedule,
          logging: before.logging,
          mailing: before.mailing,
          envVars: before.envVars,
        });
      expect(res.status).toBe(200);

      const after = await findJobByName('pasted-code-job');
      expect(after.codeUploads).toHaveLength(2);
      expect(after.currentCodeUploadId).toBe(after.codeUploads[1].id);
      expect(after.command).toContain('python3');
      expect(after.command).toContain('paste.py');
    });

    it('should preview generated runner commands and not render script content on the page', async () => {
      const preview = await request(app).get('/preview_crontab');
      expect(preview.status).toBe(200);
      expect(preview.text).toContain('backup.sh');
      expect(preview.text).toContain('paste.py');

      const page = await request(app).get('/');
      expect(page.status).toBe(200);
      expect(page.text).toContain('pasted-code-job');
      expect(page.text).toContain('currentCodeUpload');
      expect(page.text).not.toContain('uploaded-shell-secret');
      expect(page.text).not.toContain('pasted-page-secret');
      expect(page.text).not.toContain('pasted-v2-secret');
    });
  });

  describe('POST /stop and /start', () => {
    let jobId;

    beforeAll(async () => {
      const res = await request(app).get('/');
      const match = res.text.match(/stopJob\('([^']+)'\)/);
      jobId = match ? match[1] : null;
    });

    it('should stop a job', async () => {
      if (!jobId) return;
      const res = await request(app)
        .post('/stop')
        .send({ _id: jobId });
      expect(res.status).toBe(200);
    });

    it('should start a job', async () => {
      if (!jobId) return;
      const res = await request(app)
        .post('/start')
        .send({ _id: jobId });
      expect(res.status).toBe(200);
    });
  });

  describe('GET /backup', () => {
    it('should create a backup', async () => {
      const res = await request(app).get('/backup');
      expect(res.status).toBe(200);
    });
  });

  describe('GET /export', () => {
    it('should export the database', async () => {
      const res = await request(app).get('/export');
      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toContain('crontab.db');
    });
  });

  describe('POST /save (duplicate)', () => {
    it('should duplicate an existing job', async () => {
      const page = await request(app).get('/');
      const match = page.text.match(/duplicateJob\('([^']+)'\)/);
      const jobId = match ? match[1] : null;
      if (!jobId) return;

      const jobMatch = page.text.match(/test-job/);
      expect(jobMatch).not.toBeNull();

      const res = await request(app)
        .post('/save')
        .send({
          _id: -1,
          name: 'test-job (copy)',
          command: 'echo hello',
          schedule: '* * * * *',
          logging: 'false',
          mailing: {},
        });
      expect(res.status).toBe(200);

      const afterPage = await request(app).get('/');
      expect(afterPage.text).toContain('test-job (copy)');
    });
  });

  describe('GET /preview_crontab', () => {
    it('should return the crontab preview as plain text', async () => {
      const res = await request(app).get('/preview_crontab');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.text).toContain('echo hello');
    });

    it('should include the make_command wrapper (tee pipeline)', async () => {
      const res = await request(app).get('/preview_crontab');
      expect(res.text).toContain('tee');
      expect(res.text).toContain('stderr');
    });

    it('should only include active (non-stopped) jobs', async () => {
      const page = await request(app).get('/');
      const match = page.text.match(/stopJob\('([^']+)'\)/);
      if (!match) return;

      await request(app).post('/stop').send({ _id: match[1] });

      const res = await request(app).get('/preview_crontab');
      const lines = res.text.trim().split('\n').filter((l) => l.includes('echo hello'));
      const activeEchoCount = await new Promise((resolve) => {
        crontab.crontabs((docs) => {
          resolve(docs.filter((doc) => !doc.stopped && doc.command === 'echo hello').length);
        });
      });
      expect(lines.length).toBe(activeEchoCount);

      await request(app).post('/start').send({ _id: match[1] });
    });
  });

  describe('Input validation', () => {
    it('should reject path traversal in db param', async () => {
      const res = await request(app).get('/restore?db=../../etc/passwd');
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Invalid db parameter');
    });

    it('should reject invalid characters in id param', async () => {
      const res = await request(app).get('/logger?id=../../../etc/passwd');
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Invalid id parameter');
    });

    it('should allow valid db param', async () => {
      const res = await request(app).get('/restore?db=crontab.db');
      expect(res.status).toBe(200);
    });

    it('should allow valid id param', async () => {
      const res = await request(app).get('/logger?id=abc123_test-id');
      expect(res.status).toBe(200);
    });
  });

  describe('POST /remove', () => {
    let jobId;

    beforeAll(async () => {
      const res = await request(app).get('/');
      const match = res.text.match(/deleteJob\('([^']+)'\)/);
      jobId = match ? match[1] : null;
    });

    it('should remove a job', async () => {
      if (!jobId) return;
      const res = await request(app)
        .post('/remove')
        .send({ _id: jobId });
      expect(res.status).toBe(200);
    });

    it('should remove the duplicated job too', async () => {
      const page = await request(app).get('/');
      const match = page.text.match(/deleteJob\('([^']+)'\)/);
      if (!match) return;
      const res = await request(app)
        .post('/remove')
        .send({ _id: match[1] });
      expect(res.status).toBe(200);
    });
  });

  describe('GET /logger', () => {
    it('should return no errors message when no log exists', async () => {
      const res = await request(app).get('/logger?id=nonexistent');
      expect(res.status).toBe(200);
      expect(res.text).toContain('No errors logged yet');
    });

    it('should return text/plain content type when no log exists', async () => {
      const res = await request(app).get('/logger?id=nonexistent');
      expect(res.headers['content-type']).toContain('text/plain');
    });

    it('should return text/plain and no-store when log file exists', async () => {
      const logFile = path.join(testDbPath, 'logs', 'testlog.log');
      fs.writeFileSync(logFile, 'some error output\n');
      const res = await request(app).get('/logger?id=testlog');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.text).toContain('some error output');
      fs.unlinkSync(logFile);
    });
  });

  describe('GET /stdout', () => {
    it('should return no errors message when no log exists', async () => {
      const res = await request(app).get('/stdout?id=nonexistent');
      expect(res.status).toBe(200);
      expect(res.text).toContain('No errors logged yet');
    });

    it('should return text/plain content type when no log exists', async () => {
      const res = await request(app).get('/stdout?id=nonexistent');
      expect(res.headers['content-type']).toContain('text/plain');
    });

    it('should return text/plain and no-store when stdout log exists', async () => {
      const logFile = path.join(testDbPath, 'logs', 'teststdout.stdout.log');
      fs.writeFileSync(logFile, 'some stdout output\n');
      const res = await request(app).get('/stdout?id=teststdout');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.text).toContain('some stdout output');
      fs.unlinkSync(logFile);
    });
  });

  describe('GET /import_crontab (auto-backup)', () => {
    it('should create a backup before importing', async () => {
      // ensure a job exists so crontab.db is non-empty
      await request(app).post('/save').send({
        _id: -1, name: 'backup-test', command: 'echo backup',
        schedule: '* * * * *', logging: 'false', mailing: {},
      });
      // small delay so backup filename (based on date) doesn't collide
      await new Promise((r) => setTimeout(r, 1100));
      const backupsBefore = fs.readdirSync(testDbPath)
        .filter((f) => f.startsWith('backup'));
      await request(app).get('/import_crontab');
      const backupsAfter = fs.readdirSync(testDbPath)
        .filter((f) => f.startsWith('backup'));
      expect(backupsAfter.length).toBe(backupsBefore.length + 1);
    });

    it('should not import managed logging wrappers from old temp paths', async () => {
      const crontabFile = path.join(testDbPath, 'foreign-wrapper-crontab');
      fs.writeFileSync(crontabFile, [
        '* * * * * ((({ echo backup; } | tee /var/folders/example/crontab-ui-test-old/job.stdout) 3>&1 1>&2 2>&3 | tee /var/folders/example/crontab-ui-test-old/job.stderr) 3>&1 1>&2 2>&3)',
        '',
      ].join('\n'));

      delete process.env.CRONTAB_UI_SKIP_SYSTEM_IMPORT;
      process.env.CRONTAB_UI_SYSTEM_CRONTAB_FILE = crontabFile;
      await request(app).get('/import_crontab');
      process.env.CRONTAB_UI_SKIP_SYSTEM_IMPORT = 'true';
      delete process.env.CRONTAB_UI_SYSTEM_CRONTAB_FILE;

      const res = await request(app).get('/');
      expect(res.text).not.toContain('crontab-ui-test-old');
    });
  });

  describe('POST /import (auto-backup)', () => {
    it('should create a backup before importing a db file', async () => {
      // small delay so backup filename (based on date) doesn't collide
      await new Promise((r) => setTimeout(r, 1100));
      const backupsBefore = fs.readdirSync(testDbPath)
        .filter((f) => f.startsWith('backup'));
      const dbContent = fs.readFileSync(path.join(testDbPath, 'crontab.db'));
      await request(app)
        .post('/import')
        .attach('file', dbContent, 'crontab.db');
      const backupsAfter = fs.readdirSync(testDbPath)
        .filter((f) => f.startsWith('backup'));
      expect(backupsAfter.length).toBe(backupsBefore.length + 1);
    });
  });

  describe('Command textarea', () => {
    it('should render a textarea for the command field', async () => {
      const res = await request(app).get('/');
      expect(res.text).toContain('<textarea');
      expect(res.text).toContain('id=\'job-command\'');
    });
  });
});

describe('Routes module', () => {
  it('should export routes with base_url prefix', () => {
    const { routes, base_url } = require('../routes');
    expect(routes.root).toBe(base_url + '/');
    expect(routes.save).toBe(base_url + '/save');
    expect(routes.backup).toBe(base_url + '/backup');
  });

  it('should export relative routes', () => {
    const { relative } = require('../routes');
    expect(relative.save).toBe('save');
    expect(relative.backup).toBe('backup');
  });
});
