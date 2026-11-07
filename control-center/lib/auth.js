'use strict';
/**
 * auth.js — administrator sessions (user "hasberd"), scrypt-hashed passphrase,
 * expiring tokens, persisted audit journal for every privileged action.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const dataDir = () => process.env.ECC_DATA || path.join(__dirname, '..', 'data');
const auditPath = () => path.join(dataDir(), 'audit.json');
const credsPath = () => path.join(dataDir(), 'admin.json');

const SESSION_TTL_MS = 8 * 3600 * 1000;
const sessions = new Map(); // token -> {user, expires}

function ensureCreds() {
  // Default: user "hasberd", passphrase "ardor-3327" — forced rotation flag on first login.
  if (!fs.existsSync(credsPath())) {
    fs.mkdirSync(dataDir(), { recursive: true });
    setCreds('hasberd', 'ardor-3327');
  }
}
function setCreds(user, passphrase) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(passphrase, salt, 32);
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(credsPath(), JSON.stringify({
    user, salt: salt.toString('hex'), hash: hash.toString('hex'),
    mustRotate: passphrase === 'ardor-3327', created: Date.now()
  }, null, 2));
}
function verifyCreds(user, passphrase) {
  ensureCreds();
  try {
    const c = JSON.parse(fs.readFileSync(credsPath(), 'utf8'));
    const salt = Buffer.from(c.salt, 'hex');
    const hash = crypto.scryptSync(passphrase, salt, 32);
    const ok = crypto.timingSafeEqual(hash, Buffer.from(c.hash, 'hex')) && c.user === user;
    return { ok, mustRotate: ok && !!c.mustRotate };
  } catch { return { ok: false }; }
}
function login(user, passphrase) {
  const v = verifyCreds(user, passphrase);
  if (!v.ok) { audit('auth.fail', `user=${user}`, false); return null; }
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { user, expires: Date.now() + SESSION_TTL_MS });
  audit('auth.login', `user=${user}`, true);
  return { token, user, expiresAt: sessions.get(token).expires, mustRotate: v.mustRotate };
}
function checkToken(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expires) { sessions.delete(token); return null; }
  return s;
}
function logout(token) { sessions.delete(token); audit('auth.logout', '', true); }

function audit(action, detail = '', privileged = false) {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    const list = fs.existsSync(auditPath()) ? JSON.parse(fs.readFileSync(auditPath(), 'utf8')) : [];
    list.unshift({ ts: Date.now(), action, detail, privileged });
    fs.writeFileSync(auditPath(), JSON.stringify(list.slice(0, 500), null, 2));
  } catch { }
}
function auditLog() {
  try { return JSON.parse(fs.readFileSync(auditPath(), 'utf8')); } catch { return []; }
}

/** Express-less middleware: returns session or null; writes 401 when needed. */
function requireAdmin(req, res) {
  const token = req.headers['x-auth-token'] || (req.headers.cookie || '').match(/ecc_token=([a-f0-9]+)/)?.[1];
  const s = checkToken(token);
  if (!s) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'administrator session required' })); return null; }
  return s;
}

module.exports = { login, logout, checkToken, requireAdmin, audit, auditLog, setCreds, ensureCreds, SESSION_TTL_MS };
