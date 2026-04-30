'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { base_url: baseUrl, routes } = require('../routes');

const COOKIE_NAME = 'crontab_ui_token';
const DEFAULT_EXPIRES_IN = '7d';

function getSecret() {
  return process.env.JWT_SECRET;
}

function getExpiresIn() {
  return process.env.JWT_EXPIRES_IN || DEFAULT_EXPIRES_IN;
}

function cookieOptions(req) {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: !!(req && req.secure),
    path: baseUrl || '/',
  };
}

function signToken(payload) {
  return jwt.sign(payload, getSecret(), { expiresIn: getExpiresIn() });
}

function verifyTokenString(token) {
  try {
    return jwt.verify(token, getSecret());
  } catch (_e) {
    return null;
  }
}

function wantsJson(req) {
  if (req.xhr) return true;
  const xrw = req.get('X-Requested-With');
  if (xrw && xrw.toLowerCase() === 'xmlhttprequest') return true;
  const accept = req.get('Accept') || '';
  if (accept.includes('application/json') && !accept.includes('text/html')) return true;
  return false;
}

function verifyToken(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  const claims = token ? verifyTokenString(token) : null;
  if (claims) {
    req.user = claims;
    return next();
  }
  if (wantsJson(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  return res.redirect(routes.login);
}

// Per-IP login throttle: 5 attempts / 15 min.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
const loginAttempts = new Map(); // ip -> { count, resetAt }

function checkLoginThrottle(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || entry.resetAt <= now) {
    loginAttempts.set(ip, { count: 0, resetAt: now + LOGIN_WINDOW_MS });
    return true;
  }
  return entry.count < LOGIN_MAX_ATTEMPTS;
}

function recordLoginFailure(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || entry.resetAt <= now) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  } else {
    entry.count += 1;
  }
}

function clearLoginThrottle(ip) {
  loginAttempts.delete(ip);
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function loginHandler(req, res) {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  if (!checkLoginThrottle(ip)) {
    return res.status(429).json({ error: 'too many attempts, try again later' });
  }
  const { user, pwd } = req.body || {};
  const expectedUser = process.env.BASIC_AUTH_USER;
  const expectedPwd = process.env.BASIC_AUTH_PWD;
  if (!user || !pwd || !safeEqual(user, expectedUser) || !safeEqual(pwd, expectedPwd)) {
    recordLoginFailure(ip);
    return res.status(401).json({ error: 'invalid credentials' });
  }
  clearLoginThrottle(ip);
  const token = signToken({ user });
  const decoded = jwt.decode(token);
  const opts = cookieOptions(req);
  if (decoded && decoded.exp) {
    opts.maxAge = Math.max(0, decoded.exp * 1000 - Date.now());
  }
  res.cookie(COOKIE_NAME, token, opts);
  return res.json({ ok: true });
}

function logoutHandler(req, res) {
  res.clearCookie(COOKIE_NAME, { path: cookieOptions(req).path });
  return res.json({ ok: true });
}

function loginPageHandler(req, res) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (token && verifyTokenString(token)) {
    return res.redirect(routes.root);
  }
  return res.render('login', { baseUrl: baseUrl || '', routes: JSON.stringify(routes) });
}

module.exports = {
  COOKIE_NAME,
  signToken,
  verifyToken,
  loginHandler,
  logoutHandler,
  loginPageHandler,
};
