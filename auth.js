'use strict';
/**
 * CODE SPRINT — authentication & authorization.
 * Cookie sessions stored in SQLite. scrypt password hashing.
 */
const crypto = require('crypto');
const { getDb } = require('./db');
const { hashPassword, verifyPassword } = require('./seed');

const SESSION_COOKIE = 'cs_session';
const SESSION_TTL_HOURS = Number(process.env.SESSION_TTL_HOURS || 12);

function createSession(accountId) {
  const db = getDb();
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (token, account_id, expires_at) VALUES (?, ?, ?)').run(token, accountId, expires);
  return { token, expires };
}

function destroySession(token) {
  if (!token) return;
  const db = getDb();
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

/** Express middleware: attaches req.account or null. */
function sessionMiddleware(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE];
  req.sessionToken = token || null;
  req.account = null;
  if (token) {
    const db = getDb();
    const row = db.prepare(`
      SELECT a.id, a.username, a.role, a.team_name, s.expires_at
      FROM sessions s JOIN accounts a ON a.id = s.account_id
      WHERE s.token = ?`).get(token);
    if (row) {
      if (new Date(row.expires_at) > new Date()) {
        req.account = { id: row.id, username: row.username, role: row.role, teamName: row.team_name };
      } else {
        destroySession(token);
      }
    }
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.account) return res.status(401).json({ error: 'Authentication required' });
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.account) return res.status(401).json({ error: 'Authentication required' });
    if (!roles.includes(req.account.role)) return res.status(403).json({ error: 'Forbidden' });
    next();
  };
}

function login(req, res) {
  const { username, password } = req.body || {};
  if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Team ID / username and password are required' });
  }
  const uname = username.trim();
  if (!uname) {
    return res.status(400).json({ error: 'Team ID / username and password are required' });
  }
  const db = getDb();
  // Case-insensitive + whitespace-tolerant lookup: participants routinely type
  // "TEAM01" or "Team 01";  passwords stay exact (never trimmed).
  const acc = db.prepare('SELECT id, username, password_hash, role, team_name FROM accounts WHERE username = ? COLLATE NOCASE').get(uname);
  // Uniform error: never reveal whether the username exists.
  if (!acc || !verifyPassword(password, acc.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const { token, expires } = createSession(acc.id);
  const secure = req.secure ? '; Secure' : ''; // set when running behind an HTTPS proxy (trust proxy)
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax${secure}; Expires=${new Date(expires).toUTCString()}`);
  res.json({ ok: true, role: acc.role, username: acc.username, teamName: acc.team_name, redirect: acc.role === 'team' ? '/team' : '/judge' });
}

function logout(req, res) {
  destroySession(req.sessionToken);
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax${secure}; Max-Age=0`);
  res.json({ ok: true });
}

function audit(actor, action, detail) {
  const db = getDb();
  db.prepare('INSERT INTO audit_log (actor_id, actor_name, action, detail) VALUES (?, ?, ?, ?)')
    .run(actor ? actor.id : null, actor ? actor.username : null, action, detail || null);
}

module.exports = { SESSION_COOKIE, sessionMiddleware, requireAuth, requireRole, login, logout, audit, hashPassword };
