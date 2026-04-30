'use strict';

const basicAuth = require('express-basic-auth');
const { verifyToken } = require('./jwt');

function resolveMode() {
  if (process.env.CRONTAB_UI_DISABLE_AUTH === 'true') return 'none';

  if (process.env.ENABLE_AUTH === 'true') {
    const missing = [];
    if (!process.env.JWT_SECRET) missing.push('JWT_SECRET');
    if (!process.env.BASIC_AUTH_USER) missing.push('BASIC_AUTH_USER');
    if (!process.env.BASIC_AUTH_PWD) missing.push('BASIC_AUTH_PWD');
    if (missing.length) {
      console.error(
        'ENABLE_AUTH=true requires the following env var(s) to be set:',
        missing.join(', ')
      );
      process.exit(1);
    }
    return 'jwt';
  }

  if (process.env.BASIC_AUTH_USER && process.env.BASIC_AUTH_PWD) return 'basic';

  return 'none';
}

let cachedMode = null;
function getAuthMode() {
  if (cachedMode === null) cachedMode = resolveMode();
  return cachedMode;
}

function applyProtection(app) {
  const mode = getAuthMode();
  if (mode === 'basic') {
    app.use((req, res, next) => {
      res.setHeader('WWW-Authenticate', 'Basic realm="Restricted Area"');
      next();
    });
    app.use(basicAuth({
      users: { [process.env.BASIC_AUTH_USER]: process.env.BASIC_AUTH_PWD },
    }));
  } else if (mode === 'jwt') {
    app.use(verifyToken);
  }
}

module.exports = { getAuthMode, applyProtection };
