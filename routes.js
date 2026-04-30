'use strict';

const baseUrl = (process.env.BASE_URL || '').replace(/\/+$/, '').trim();

const routes = {
  root: '/',
  save: '/save',
  run: '/runjob',
  test_run: '/test_run',
  stop: '/stop',
  start: '/start',
  remove: '/remove',
  backup: '/backup',
  backups: '/backups',
  restore: '/restore',
  delete_backup: '/delete',
  delete_all_backups: '/delete_all_backups',
  restore_backup: '/restore_backup',
  export: '/export',
  import: '/import',
  import_crontab: '/import_crontab',
  logger: '/logger',
  stdout: '/stdout',
  preview_crontab: '/preview_crontab',
  login: '/login',
  logout: '/logout',
};

exports.base_url = baseUrl;

exports.routes = Object.fromEntries(
  Object.entries(routes).map(([k, v]) => [k, baseUrl + v])
);

exports.relative = Object.fromEntries(
  Object.entries(routes).map(([k, v]) => [k, v.replace(/^\//, '')])
);
exports.relative.root = baseUrl;
