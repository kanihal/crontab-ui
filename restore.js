'use strict';

const Datastore = require('@seald-io/nedb');
const path = require('path');
const fs = require('fs');
const crontab = require('./crontab');

exports.crontabs = (dbName, callback) => {
  const db = new Datastore({ filename: path.join(crontab.db_folder, dbName) });
  db.loadDatabase(() => {});
  db.find({}).sort({ created: -1 }).exec((err, docs) => {
    callback(docs);
  });
};

exports.delete = (dbName) => {
  fs.unlink(path.join(crontab.db_folder, dbName), (err) => {
    if (err) {
      console.log(`Delete error: ${err}`);
    } else {
      console.log('Backup deleted');
    }
  });
};

exports.deleteAll = (callback) => {
  const files = fs.readdirSync(crontab.db_folder)
    .filter((f) => f.indexOf('backup') === 0);
  let remaining = files.length;
  if (remaining === 0) return callback && callback();
  for (const f of files) {
    fs.unlink(path.join(crontab.db_folder, f), (err) => {
      if (err) console.log(`Delete error: ${err}`);
      remaining -= 1;
      if (remaining === 0 && callback) callback();
    });
  }
};
