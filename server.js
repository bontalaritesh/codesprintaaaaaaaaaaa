'use strict';
/**
 * CODE SPRINT — main server.
 * Express API + Socket.IO live updates + static frontend.
 */
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const { getDb } = require('./db');
const auth = require('./auth');
const { verifyPassword, hashPassword, STAGE_LABELS, seed } = require('./seed');
const sched = require('./schedule');
const { gradeAnswer } = require('./grading');
const { scoreFor, standings, progressFor } = require('./scoring');
const { runCode, detectRuntime } = require('./runner');
const roundtimer = require('./roundtimer');

const PORT = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });

app.disable('x-powered-by');
app.set('trust proxy', 1); // behind Railway/Render/nginx: exposes req.secure for cookie hardening
app.use(express.json({ limit: '256kb' }));
app.use(auth.sessionMiddleware);

const db = getDb();

// First-boot bootstrap: provision the database idempotently (admin/judge
// accounts, teams, question bank, default settings). A fresh database — e.g. a
// new Railway volume — would otherwise contain zero accounts, making every
// login fail with "Invalid credentials". Re-seeding on boot is safe: existing
// accounts are never modified, and judge-edited questions are preserved.
seed({
  teams: Number(process.env.TEAMS) > 0 ? Number(process.env.TEAMS) : 36,
});

// ---------------------------------------------------------------- helpers
function getDbForEdits() { return db; }
function publicStandings(frozen) {
  if (frozen) {
    const row = db.prepare('SELECT snapshot, frozen_at FROM results_published WHERE id = 1').get();
    if (row) return { frozen: true, frozenAt: row.frozen_at, teams: JSON.parse(row.snapshot) };
  }
  return { frozen: false, frozenAt: null, teams: standings().map((r, i) => ({
    sNo: i + 1, rank: r.rank, team: r.teamName, teamId: r.username, score: r.total,
    status: r.status || 'active', eliminated: !!r.eliminated,
  })) };
}

function broadcastStandings() {
  io.to('public').emit('standings', publicStandings(false));
}

function broadcastPhase() {
  io.to('public').emit('phase', sched.currentPhase());
}

// Server-side ticker to push phase transitions to all clients.
// unref so it never keeps the process alive on its own.
setInterval(() => { broadcastPhase(); }, 30000).unref();

// ---------------- host-controlled round timers (§ master timer prompt) ------
// Broadcast the authoritative timer snapshot to everyone.
function broadcastTimer(roundKey, extra = {}) {
  io.to('public').emit('round timer', { ...roundtimer.snapshot(roundKey), online: io.engine.clientsCount, ...extra });
}

// Extend the running/paused/stopped countdown — authorized host action only.
app.post('/api/judge/timer/:roundKey/extend', auth.requireRole('judge', 'admin'), (req, res) => {
  const { roundKey } = req.params;
  if (!['round1', 'round2', 'round3'].includes(roundKey)) return res.status(404).json({ error: 'Unknown round' });
  const minutes = Number(req.body?.minutes);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 240) return res.status(400).json({ error: 'Extension must be within 1..240 minutes' });
  try {
    const snap = roundtimer.transition(roundKey, 'extend', {
      actor: req.account.username, extendMs: Math.round(minutes * 60000), expectedVersion: req.body?.expectedVersion,
    });
    auth.audit(req.account, 'timer.extend', `round ${roundKey} +${minutes}m`);
    broadcastTimer(roundKey);
    res.json({ ok: true, timer: snap });
  } catch (e) {
    if (e && e.status) return res.status(e.status).json({ error: e.error });
    throw e;
  }
});

// recover timer state after a crash before accepting_host commands
const recovered = roundtimer.recoverUptime();
if (recovered.expiredDuringDowntime > 0) console.log(`[timer] recovery: ${recovered.expiredDuringDowntime} running timer(s) expired during downtime`);

// Natural expiry sweeper (2s — cheap; one indexed SELECT per tick).
setInterval(() => {
  try {
    const expired = roundtimer.sweepExpired();
    for (const roundKey of expired) {
      auth.audit(null, 'timer.expired', `round ${roundKey} countdown reached zero`);
      io.to('public').emit('round timer', roundtimer.snapshot(roundKey));
      io.to('judges').emit('timer incident', { kind: 'timer_expired', round: roundKey, at: new Date().toISOString() });
    }
  } catch { /* never kill the sweeper */ }
}, 2000).unref();

// Timer command API — judge/admin only, idempotent via version guard.
// NOTE: the /duration route MUST be registered before this one — Express
// matches in order and '/:action' would otherwise swallow 'duration'.
app.post('/api/judge/timer/:roundKey/duration', auth.requireRole('judge', 'admin'), (req, res) => {
  const { roundKey } = req.params;
  if (!['round1', 'round2', 'round3'].includes(roundKey)) return res.status(404).json({ error: 'Unknown round' });
  const minutes = Number(req.body?.minutes) || 0;
  const seconds = Number(req.body?.seconds) || 0;
  try {
    const snap = roundtimer.setDuration(roundKey, minutes * 60000 + seconds * 1000, { actor: req.account.username });
    auth.audit(req.account, 'timer.duration', `${roundKey} = ${minutes}m ${seconds}s`);
    broadcastTimer(roundKey);
    res.json({ ok: true, timer: snap });
  } catch (e) {
    if (e && e.status) return res.status(e.status).json({ error: e.error });
    throw e;
  }
});

app.post('/api/judge/timer/:roundKey/:action', auth.requireRole('judge', 'admin'), (req, res) => {
  const { roundKey, action } = req.params;
  if (!['round1', 'round2', 'round3'].includes(roundKey)) return res.status(404).json({ error: 'Unknown round' });
  try {
    const snap = roundtimer.transition(roundKey, action, {
      actor: req.account.username,
      expectedVersion: req.body?.expectedVersion,
    });
    if (action === 'reset') auth.audit(req.account, 'timer.reset', `${roundKey} → ready (duration preserved)`);
    else if (action === 'end') auth.audit(req.account, 'timer.end', `${roundKey} → ended by host`);
    else auth.audit(req.account, `timer.${action}`, roundKey);
    broadcastTimer(roundKey);
    res.json({ ok: true, timer: snap });
  } catch (e) {
    if (e && e.status) return res.status(e.status).json({ error: e.error });
    throw e;
  }
});

// Every client (participants incl.) can read the authoritative snapshot.
app.get('/api/timer/:roundKey', auth.requireAuth, (req, res) => {
  const { roundKey } = req.params;
  if (!['round1', 'round2', 'round3'].includes(roundKey)) return res.status(404).json({ error: 'Unknown round' });
  res.json(roundtimer.snapshot(roundKey));
});

// Continuous leaderboard sync: standings broadcast every 15s even with no
// user activity, plus immediate broadcast on every score change. Ranks move
// on every screen without polling. Kept cheap: one standings query per tick.
setInterval(() => {
  try { broadcastStandings(); } catch { /* transient DB issue — next tick retrises */ }
}, 15000).unref();

let lastBackupAt = null;

// Health check (public, read-only, no auth — monitors only).
app.get('/api/health', (req, res) => {
  let dbOk = false, teams = 0;
  try {
    teams = db.prepare("SELECT COUNT(*) c FROM accounts WHERE role = 'team'").get().c;
    db.prepare('SELECT 1').get();
    dbOk = true;
  } catch { dbOk = false; }
  res.json({
    ok: dbOk,
    db: dbOk ? 'ok' : 'error',
    uptimeSeconds: Math.round(process.uptime()),
    teams,
    connectedSockets: io.engine.clientsCount,
    lastBackupAt,
    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
  });
});

// ---------------------------------------------------------------- auth routes
app.post('/api/login', auth.login);
app.post('/api/logout', auth.logout);

// Public competition status (no auth): used on login page.
app.get('/api/status', (req, res) => {
  const cp = sched.currentPhase();
  const frozen = db.prepare('SELECT frozen_at FROM results_published WHERE id = 1').get();
  res.json({ ...cp, resultsFrozen: !!frozen });
});

// ---------------------------------------------------------------- team APIs
app.get('/api/me', auth.requireAuth, (req, res) => {
  const a = req.account;
  const score = scoreFor(a.id);
  const table = publicStandings(false);
  const me = table.teams.find((t) => t.teamId === a.username);
  const acc = db.prepare('SELECT eliminated, eliminated_at, status FROM accounts WHERE id = ?').get(a.id);
  res.json({
    username: a.username, role: a.role, teamName: a.teamName,
    phase: sched.currentPhase(), score, rank: me ? me.rank : null,
    progress: progressFor(a.id),
    eliminated: !!acc.eliminated, eliminatedAt: acc.eliminated_at || null,
    status: acc.status || 'active',
    tabSwitchLimit: Number(sched.getSetting('monitor.tab_threshold', '3')),
    tabEvents: db.prepare('SELECT COUNT(*) AS c FROM tab_events WHERE account_id = ?').get(a.id).c,
    incidents: db.prepare("SELECT id, kind, status, created_at FROM incidents WHERE account_id = ? ORDER BY id DESC LIMIT 10").all(a.id),
    flags: db.prepare('SELECT reason, created_at FROM flags WHERE account_id = ? AND cleared_at IS NULL').all(a.id),
  });
});

// Team status guard for team actions (submit/draft/hint/run): eliminated OR
// judge-stopped OR disqualified teams cannot act.
function requireActiveTeam(req, res, next) {
  const acc = db.prepare('SELECT status, eliminated FROM accounts WHERE id = ?').get(req.account.id);
  if (!acc) return res.status(401).json({ error: 'Authentication required' });
  if (acc.eliminated) {
    return res.status(403).json({ error: 'Your team has been eliminated for leaving the competition window too many times.' });
  }
  if (acc.status === 'stopped') {
    return res.status(403).json({ error: 'A judge has paused your team. Wait for a judge to resume it.' });
  }
  if (acc.status === 'disqualified') {
    return res.status(403).json({ error: 'Your team has been disqualified by a judge.' });
  }
  next();
}
const requireNotEliminated = requireActiveTeam; // legacy alias

// Judge: read-only question review for any round — including locked ones.
// Exposes the judge's answer key so hosts can verify every question bank
// before/after the event without unlocking rounds for teams.
app.get('/api/judge/questions/:roundKey', auth.requireRole('judge', 'admin'), (req, res) => {
  // ^ legacy round-scoped read endpoint, kept for the review card (includes answer keys)
  const roundKey = req.params.roundKey;
  if (!['round1', 'round2', 'round3'].includes(roundKey)) return res.status(404).json({ error: 'Unknown round' });
  const cp = sched.currentPhase();
  const qs = db.prepare(
    'SELECT id, stage_key, order_num, title, category, marks, type, statement, options, answer, hint, hint_penalty, languages, starter_code FROM questions WHERE round_key = ?')
    .all(roundKey);
  const stageOrder = JSON.parse(db.prepare('SELECT stage_keys FROM rounds WHERE key = ?').get(roundKey)?.stage_keys || '[]');
  qs.sort((a, b) =>
    (stageOrder.indexOf(a.stage_key) - stageOrder.indexOf(b.stage_key)) || (a.order_num - b.order_num));
  res.json({
    round: roundKey,
    phase: cp.phase,
    stageOrder,
    questions: qs.map((q) => ({
      ...q,
      options: q.options ? JSON.parse(q.options) : null,
      languages: q.languages ? JSON.parse(q.languages) : null,
      type: q.type, statement: q.statement, answer: q.answer, hint: q.hint,
    })),
  });
});

// Question list for a round — hides answers/hints.
app.get('/api/questions/:roundKey', auth.requireRole('team'), requireNotEliminated, (req, res) => {
  const roundKey = req.params.roundKey;
  const cp = sched.currentPhase();
  const locked = cp.phase !== roundKey;
  const qs = db.prepare(
    `SELECT id, stage_key, order_num, title, category, difficulty, topic, marks, type, statement, options, languages, starter_code,
            code_snippet, sample_input, sample_output, constraints, answer_reveal_policy
     FROM questions WHERE round_key = ? AND enabled = 1 AND archived = 0
       AND publication_status IN ('approved', 'approved_after_correction')`)
    .all(roundKey);
  // Order by the round's official stage sequence, then question number.
  const stageOrder = JSON.parse(db.prepare('SELECT stage_keys FROM rounds WHERE key = ?').get(roundKey)?.stage_keys || '[]');
  qs.sort((a, b) =>
    (stageOrder.indexOf(a.stage_key) - stageOrder.indexOf(b.stage_key)) || (a.order_num - b.order_num));
  const subs = db.prepare('SELECT question_id, status, awarded_marks, is_correct, submitted_at, content FROM submissions WHERE account_id = ?').all(req.account.id);
  const subByQ = Object.fromEntries(subs.map((s) => [s.question_id, s]));
  const hintsUsed = new Set(db.prepare('SELECT question_id FROM hint_usage WHERE account_id = ?').all(req.account.id).map((r) => r.question_id));
  res.json({
    locked, phase: cp.phase,
    stages: JSON.parse(db.prepare('SELECT stage_keys FROM rounds WHERE key = ?').get(roundKey)?.stage_keys || '[]'),
    questions: qs.map((q) => ({
      ...q,
      options: q.options ? JSON.parse(q.options) : null,
      languages: q.languages ? JSON.parse(q.languages) : null,
      hintUsed: hintsUsed.has(q.id),
      submission: subByQ[q.id] ? {
        status: subByQ[q.id].status, awarded: subByQ[q.id].awarded_marks,
        correct: !!subByQ[q.id].is_correct, submittedAt: subByQ[q.id].submitted_at,
      } : null,
      // Correct answer / explanation deliberately excluded from question list.
      // Reveal data is delivered ONLY by /api/questions/:id/result after submit,
      // and /api/judge/* for judges, per the reveal policy (master prompt §2/§8).
      answer: undefined, answer_reveal_policy: undefined,
    })),
  });
});

// ---------------------------------------------------------------- JUDGE QUESTION BANK MANAGEMENT (master prompt §4)
// List the full bank with filters. Returns ALL questions (incl. disabled/
// archived/needs_review) plus submission counts, for management UI.
app.get('/api/judge/bank', auth.requireRole('judge', 'admin'), (req, res) => {
  const { round = '', stage = '', q = '', review = '' } = req.query;
  let rows = db.prepare('SELECT * FROM questions ORDER BY round_key, stage_key, order_num').all();
  if (round) rows = rows.filter((r) => r.round_key === round);
  if (stage) rows = rows.filter((r) => r.stage_key === stage);
  if (review) rows = rows.filter((r) => r.review_status === review);
  if (q) {
    const needle = String(q).toLowerCase();
    rows = rows.filter((r) =>
      r.title.toLowerCase().includes(needle) || (r.category || '').toLowerCase().includes(needle) ||
      (r.topic || '').toLowerCase().includes(needle) || (r.difficulty || '').toLowerCase().includes(needle) ||
      String(r.order_num) === needle || (r.statement || '').toLowerCase().includes(needle));
  }
  const counts = Object.fromEntries(db.prepare('SELECT question_id, COUNT(*) c FROM submissions GROUP BY question_id').all().map((r) => [r.question_id, r.c]));
  res.json({ questions: rows.map((r) => ({
    ...r,
    options: r.options ? JSON.parse(r.options) : null,
    languages: r.languages ? JSON.parse(r.languages) : null,
    submissions: counts[r.id] || 0,
  })) });
});

// Create a new question.
app.post('/api/judge/bank', auth.requireRole('judge', 'admin'), (req, res) => {
  const b = req.body || {};
  if (!b.round_key || !b.stage_key || !b.statement || !b.title) return res.status(400).json({ error: 'round_key, stage_key, title and statement are required' });
  if (!['mcq', 'short', 'code'].includes(b.type)) return res.status(400).json({ error: 'type must be mcq|short|code' });
  const maxOrder = db.prepare('SELECT COALESCE(MAX(order_num),0) m FROM questions WHERE round_key = ?').get(b.round_key).m;
  const key = `${b.round_key}-custom-${Date.now()}`;
  try {
    db.prepare(`INSERT INTO questions (external_key, round_key, stage_key, order_num, title, category, difficulty, topic, marks, type, statement, options, answer, hint, hint_penalty, languages, starter_code, code_snippet, sample_input, sample_output, constraints, explanation, source_ref, review_status, publication_status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'custom', ?, 'approved', datetime('now'))`)
      .run(key, b.round_key, b.stage_key, b.order_num || maxOrder + 1, b.title, b.category || null, b.difficulty || null, b.topic || b.category || null,
        Number(b.marks) || 10, b.type, b.statement,
        b.options ? JSON.stringify(b.options) : null,
        typeof b.answer === 'object' && b.answer !== null ? JSON.stringify(b.answer) : String(b.answer ?? ''),
        b.hint || null, Number(b.hint_penalty) || 0,
        b.languages ? JSON.stringify(b.languages) : null, b.starter_code || null,
        b.code_snippet || null, b.sample_input || null, b.sample_output || null, b.constraints || null, b.explanation || null,
        b.review_status || 'verified');
  } catch (e) { return res.status(400).json({ error: e.message }); }
  auth.audit(req.account, 'question.create', `${key}`);
  res.json({ ok: true, key });
});

// Edit a question — records version history so an active question can be
// updated without corrupting existing submissions (submissions keep their
// graded state; regrade remains available).
app.put('/api/judge/bank/:id', auth.requireRole('judge', 'admin'), (req, res) => {
  const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Question not found' });
  const b = req.body || {};
  const EDITABLE = ['title', 'category', 'difficulty', 'topic', 'marks', 'type', 'statement', 'answer', 'hint', 'hint_penalty', 'starter_code', 'code_snippet', 'sample_input', 'sample_output', 'constraints', 'explanation', 'review_status', 'publication_status'];
  const changes = {};
  for (const f of EDITABLE) if (f in b) {
    let v = b[f];
    if (f === 'options' || f === 'languages') v = JSON.stringify(v);
    if (f === 'marks' || f === 'hint_penalty') v = Number(v) || 0;
    if (f === 'review_status' || f === 'publication_status') { if (!['verified', 'needs_review', 'approved', 'approved_after_correction', 'draft', 'archived'].includes(v)) continue; }
    if (String(q[f]) !== String(v)) changes[f] = v;
  }
  if (b.options !== undefined) changes.options = JSON.stringify(b.options);
  if (b.languages !== undefined) changes.languages = JSON.stringify(b.languages);
  if (b.enabled !== undefined) changes.enabled = b.enabled ? 1 : 0;
  if (b.archived !== undefined) changes.archived = b.archived ? 1 : 0;
  if (!Object.keys(changes).length) return res.json({ ok: true, note: 'No changes' });
  const sets = Object.keys(changes).map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE questions SET ${sets}, revision = revision + 1, updated_at = datetime('now') WHERE id = ?`).run(...Object.values(changes), q.id);
  getDbForEdits().prepare(`INSERT INTO question_edits (question_key, edited_by, summary)
    VALUES (?, ?, ?)
    ON CONFLICT(question_key) DO UPDATE SET edited_by = excluded.edited_by,
      edited_at = datetime('now'), summary = excluded.summary`)
    .run(q.external_key, req.account.id, JSON.stringify(Object.keys(changes)));
  db.prepare('INSERT INTO question_history (question_id, actor, changes_json) VALUES (?, ?, ?)').run(q.id, req.account.username, JSON.stringify(changes));
  auth.audit(req.account, 'question.edit', `${q.external_key}: ${Object.keys(changes).join(',')}`);
  broadcastStandings();
  res.json({ ok: true, changes: Object.keys(changes) });
});

// Duplicate a question (new disabled draft by default).
app.post('/api/judge/bank/:id/duplicate', auth.requireRole('judge', 'admin'), (req, res) => {
  const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Question not found' });
  const maxOrder = db.prepare('SELECT COALESCE(MAX(order_num),0) m FROM questions WHERE round_key = ? AND stage_key = ?').get(q.round_key, q.stage_key).m;
  const key = `${q.external_key}-copy-${Date.now()}`;
  db.prepare(`INSERT INTO questions (external_key, round_key, stage_key, order_num, title, category, difficulty, topic, marks, type, statement, options, answer, hint, hint_penalty, languages, starter_code, code_snippet, sample_input, sample_output, constraints, explanation, source_ref, review_status, publication_status, enabled, archived)
    SELECT ?, round_key, stage_key, ?, title || ' (copy)', category, difficulty, topic, marks, type, statement, options, answer, hint, hint_penalty, languages, starter_code, code_snippet, sample_input, sample_output, constraints, explanation, source_ref, 'needs_review', 'draft', 0, 0 FROM questions WHERE id = ?`)
    .run(key, maxOrder + 1, q.id);
  auth.audit(req.account, 'question.duplicate', `${q.external_key} → ${key}`);
  res.json({ ok: true, key });
});

// Archive (soft delete) / restore.
app.post('/api/judge/bank/:id/archive', auth.requireRole('judge', 'admin'), (req, res) => {
  const q = db.prepare('SELECT id, external_key FROM questions WHERE id = ?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Question not found' });
  db.prepare('UPDATE questions SET archived = 1, enabled = 0, updated_at = datetime(%now%) WHERE id = ?'.replace('%now%', String.fromCharCode(39) + 'now' + String.fromCharCode(39))).run(q.id);
  auth.audit(req.account, 'question.archive', q.external_key);
  res.json({ ok: true });
});
app.post('/api/judge/bank/:id/restore', auth.requireRole('judge', 'admin'), (req, res) => {
  const q = db.prepare('SELECT id, external_key FROM questions WHERE id = ?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Question not found' });
  db.prepare("UPDATE questions SET archived = 0, updated_at = datetime('now') WHERE id = ?").run(q.id);
  auth.audit(req.account, 'question.restore', q.external_key);
  res.json({ ok: true });
});

// Reorder questions. `ids` = the subset of questions to MOVE, in their desired
// relative order; they are moved to the FRONT of their own (round, stage)
// group, and every affected group is renumbered 1..N so the UNIQUE
// (round_key, stage_key, order_num) constraint cannot collide.
app.post('/api/judge/bank/reorder', auth.requireRole('judge', 'admin'), (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
  const idList = ids.map(Number).filter(Number.isInteger);
  const wanted = new Set(idList);

  // Group all affected questions by (round_key, stage_key).
  const placeholders = idList.map(() => '?').join(',');
  const affected = db.prepare(`SELECT id, round_key, stage_key, order_num FROM questions WHERE id IN (${placeholders})`).all(...idList);
  const groups = [...new Set(affected.map((q) => `${q.round_key}|${q.stage_key}`))];

  db.exec('BEGIN');
  try {
    for (const g of groups) {
      const [roundKey, stageKey] = g.split('|');
      const all = db.prepare(
        'SELECT id FROM questions WHERE round_key = ? AND stage_key = ? ORDER BY order_num').all(roundKey, stageKey);
      // New ordering: requested ids first (request order), then the rest as before.
      const front = idList.filter((id) => all.some((a) => a.id === id));
      const rest = all.map((a) => a.id).filter((id) => !wanted.has(id));
      const final = [...front, ...rest];
      // Phase 1: push every member of the group far beyond any existing value.
      const reserve = db.prepare(`UPDATE questions
        SET order_num = order_num + 1000000 WHERE round_key = ? AND stage_key = ?`);
      reserve.run(roundKey, stageKey);
      // Phase 2: renumber 1..N.
      const assign = db.prepare('UPDATE questions SET order_num = ? WHERE id = ?');
      final.forEach((id, i) => assign.run(i + 1, id));
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return res.status(400).json({ error: `Reorder failed: ${e.message}` });
  }
  auth.audit(req.account, 'question.reorder', `${idList.length} questions in ${groups.length} stage group(s)`);
  res.json({ ok: true, groups });
});

// Question edit history (audit of content changes).
app.get('/api/judge/bank/:id/history', auth.requireRole('judge', 'admin'), (req, res) => {
  res.json({ history: db.prepare('SELECT * FROM question_history WHERE question_id = ? ORDER BY id DESC').all(req.params.id) });
});

// Frame one submission (judge detail view).
app.get('/api/judge/submission/:id', auth.requireRole('judge', 'admin'), (req, res) => {
  const s = db.prepare(`SELECT s.*, q.title, q.answer, q.type, q.marks, a.username AS team_id, a.team_name
    FROM submissions s JOIN questions q ON q.id = s.question_id JOIN accounts a ON a.id = s.account_id WHERE s.id = ?`).get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Submission not found' });
  res.json({ submission: s });
});

// Draft save/load (autosave) — stored in submissions table with status 'pending'.
app.put('/api/questions/:id/draft', auth.requireRole('team'), requireNotEliminated, (req, res) => {
  const q = db.prepare('SELECT id, round_key FROM questions WHERE id = ?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Question not found' });
  const cp = sched.currentPhase();
  if (cp.phase !== q.round_key) return res.status(423).json({ error: 'Round is not open' });
  const content = String(req.body?.content ?? '');
  if (content.length > 20000) return res.status(413).json({ error: 'Draft too large' });
  db.prepare(`
    INSERT INTO submissions (question_id, account_id, content, status)
    VALUES (?, ?, ?, 'pending')
    ON CONFLICT(question_id, account_id) DO UPDATE SET content = excluded.content
    WHERE (SELECT status FROM submissions WHERE question_id = ? AND account_id = ?) = 'pending'
  `).run(q.id, req.account.id, content, q.id, req.account.id);
  res.json({ ok: true, savedAt: new Date().toISOString() });
});

// Fetch own draft (pending submission content) for a question.
app.get('/api/drafts/:id', auth.requireRole('team'), requireNotEliminated, (req, res) => {
  const row = db.prepare("SELECT content FROM submissions WHERE question_id = ? AND account_id = ? AND status = 'pending'")
    .get(req.params.id, req.account.id);
  res.json({ content: row ? row.content : null });
});

// Run code (Run button). Team-only, round-gated, rate-limited per session.
const runCounts = new Map(); // accountId -> {count, windowStart}
const RUN_LIMIT = 30;        // runs per 5 minutes per team
app.post('/api/run', auth.requireRole('team'), requireNotEliminated, (req, res) => {
  const q = db.prepare('SELECT id, round_key FROM questions WHERE id = ?').get(req.body?.questionId);
  if (!q) return res.status(404).json({ error: 'Question not found' });
  const cp = sched.currentPhase();
  if (cp.phase !== q.round_key) return res.status(423).json({ error: 'Round is not open' });

  const now = Date.now();
  let rc = runCounts.get(req.account.id);
  if (!rc || now - rc.windowStart > 5 * 60 * 1000) { rc = { count: 0, windowStart: now }; }
  if (rc.count >= RUN_LIMIT) return res.status(429).json({ error: 'Run limit reached (30 per 5 minutes). Wait and try again.' });
  rc.count++; runCounts.set(req.account.id, rc);

  const { language, code, stdin } = req.body || {};
  runCode({ language, code: String(code || ''), stdin: String(stdin || '') })
    .then((r) => res.json({ ...r, language }))
    .catch(() => res.status(500).json({ error: 'Execution failed' }));
});

// Which runtimes does this server support? (for hiding the Run button)
app.get('/api/runtimes', auth.requireAuth, (req, res) => {
  res.json({
    python: detectRuntime('python'),
    c: detectRuntime('c'),
    cpp: detectRuntime('cpp'),
    java: detectRuntime('java'),
  });
});

// Submit an answer. One graded submission per question per team (UNIQUE constraint).
app.post('/api/questions/:id/submit', auth.requireRole('team'), requireNotEliminated, (req, res) => {
  const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Question not found' });
  const cp = sched.currentPhase();
  if (cp.phase !== q.round_key) {
    return res.status(423).json({ error: 'Submissions for this round are not open', phase: cp.phase });
  }
  // Host-controlled round timer gate: once the host EXPIRED or ENDED this
  // round's timer, submissions close for that round. A default READY/PAUSED/
  // STOPPED timer is NOT expiry — the phase gate above remains the policy.
  const ts = roundtimer.snapshot(q.round_key);
  if (ts.state === 'expired') return res.status(423).json({ error: 'Time expired — this round\'s timer reached zero' });
  if (ts.state === 'ended') return res.status(423).json({ error: 'Round ended by host' });
  const content = String(req.body?.content ?? '').trim();
  if (!content) return res.status(400).json({ error: 'Answer is empty' });
  if (content.length > 20000) return res.status(413).json({ error: 'Answer too large' });

  const existing = db.prepare('SELECT status FROM submissions WHERE question_id = ? AND account_id = ?').get(q.id, req.account.id);
  if (existing && existing.status === 'graded') {
    return res.status(409).json({ error: 'Question already submitted. Resubmission is not allowed.' });
  }

  const result = gradeAnswer(q, content);
  const manualReview = result.feedback === 'Correct' && /judgeNote/.test(q.answer);
  const tx = db.prepare(`
    INSERT INTO submissions (question_id, account_id, content, language, status, awarded_marks, is_correct, feedback)
    VALUES (?, ?, ?, ?, 'graded', ?, ?, ?)
    ON CONFLICT(question_id, account_id) DO UPDATE SET
      content = excluded.content, language = excluded.language, status = 'graded',
      awarded_marks = excluded.awarded_marks, is_correct = excluded.is_correct, feedback = excluded.feedback,
      submitted_at = datetime('now')
  `);
  tx.run(q.id, req.account.id, content, req.body?.language || null,
    result.awarded, result.correct ? 1 : 0, result.feedback + (manualReview ? ' (subject to judge review)' : ''));
  auth.audit(req.account, 'submit', `question ${q.id} (${q.external_key}) awarded ${result.awarded}`);

  const score = scoreFor(req.account.id);
  broadcastStandings();
  res.json({ ok: true, correct: result.correct, awarded: result.awarded, feedback: result.feedback, score });
});

// Request a hint (penalty applied server-side, once per question).
app.post('/api/questions/:id/hint', auth.requireRole('team'), requireNotEliminated, (req, res) => {
  if (sched.getSetting('hints.enabled', '1') !== '1') return res.status(403).json({ error: 'Hints are disabled' });
  const q = db.prepare('SELECT id, hint, hint_penalty, round_key FROM questions WHERE id = ?').get(req.params.id);
  if (!q || !q.hint) return res.status(404).json({ error: 'No hint available for this question' });
  const cp = sched.currentPhase();
  if (cp.phase !== q.round_key) return res.status(423).json({ error: 'Round is not open' });
  const used = db.prepare('SELECT 1 FROM hint_usage WHERE question_id = ? AND account_id = ?').get(q.id, req.account.id);
  if (used) {
    return res.json({ ok: true, hint: q.hint, penalty: 0, alreadyUsed: true });
  }
  db.prepare('INSERT INTO hint_usage (question_id, account_id, penalty_applied) VALUES (?, ?, ?)')
    .run(q.id, req.account.id, q.hint_penalty);
  auth.audit(req.account, 'hint', `question ${q.id}, penalty ${q.hint_penalty}`);
  broadcastStandings();
  res.json({ ok: true, hint: q.hint, penalty: q.hint_penalty, alreadyUsed: false });
});

// Tab visibility monitoring.
// Rule (configurable via monitor.tab_threshold, default 3): a team gets that
// many tab-switch ATTEMPTS during the competition. Exceeding the limit
// eliminates the team — all team actions return 403 until a judge clears it.
app.post('/api/monitor/tab-event', auth.requireRole('team'), (req, res) => {
  const acc = db.prepare('SELECT eliminated FROM accounts WHERE id = ?').get(req.account.id);
  if (acc && acc.eliminated) {
    return res.status(403).json({ error: 'Eliminated', eliminated: true, used: Number(sched.getSetting('monitor.tab_threshold', '3')), limit: Number(sched.getSetting('monitor.tab_threshold', '3')) });
  }
  const leftAt = String(req.body?.leftAt || new Date().toISOString());
  const returnedAt = req.body?.returnedAt ? String(req.body.returnedAt) : null;
  const durationS = returnedAt ? Math.max(0, Math.round((Date.parse(returnedAt) - Date.parse(leftAt)) / 1000)) : null;
  try {
    db.prepare('INSERT INTO tab_events (account_id, left_at, returned_at, duration_s) VALUES (?, ?, ?, ?)')
      .run(req.account.id, leftAt, returnedAt, durationS);
  } catch (e) {
    // UNIQUE(account_id, left_at): duplicate overlapping event — ignore.
    return res.json({ ok: true, duplicate: true, count: db.prepare('SELECT COUNT(*) AS c FROM tab_events WHERE account_id = ?').get(req.account.id).c });
  }
  const limit = Number(sched.getSetting('monitor.tab_threshold', '3'));
  const count = db.prepare('SELECT COUNT(*) AS c FROM tab_events WHERE account_id = ?').get(req.account.id).c;

  if (count >= limit) {
    // Eliminate: only once (guard on eliminated flag).
    const r = db.prepare("UPDATE accounts SET eliminated = 1, eliminated_at = datetime('now') WHERE id = ? AND eliminated = 0").run(req.account.id);
    if (r.changes > 0) {
      db.prepare('INSERT INTO incidents (account_id, kind, detail) VALUES (?, ?, ?)')
        .run(req.account.id, 'eliminated_tab_switch', `Eliminated: ${count} tab switches (limit ${limit})`);
      auth.audit(req.account, 'elimination', `tab switches ${count}/${limit} — team eliminated`);
      io.to('judges').emit('incident', { teamId: req.account.username, teamName: req.account.teamName, kind: 'eliminated_tab_switch', count, limit, at: new Date().toISOString() });
    }
    return res.json({ ok: false, eliminated: true, count, limit });
  }

  // Warning at the last attempt.
  if (count === limit - 1) {
    db.prepare('INSERT INTO incidents (account_id, kind, detail) VALUES (?, ?, ?)')
      .run(req.account.id, 'tab_switch_final_warning', `${count}/${limit} tab switches — next one eliminates the team`);
    io.to('judges').emit('incident', { teamId: req.account.username, teamName: req.account.teamName, kind: 'tab_switch_final_warning', count, limit, at: new Date().toISOString() });
  }
  res.json({ ok: true, count, limit, remaining: limit - count });
});

// Judge: set a team's status — stop/pause, resume, disqualify.
// Valid transitions: active→stopped (pause), stopped→active (resume),
// stopped|active→disqualified, disqualified→active (reversal, audited).
app.post('/api/judge/team-status', auth.requireRole('judge', 'admin'), (req, res) => {
  const { teamId, action, reason } = req.body || {};
  const VALID = { stop: 'stopped', pause: 'stopped', resume: 'active', disqualify: 'disqualified', reactivate: 'active', active: 'active' };
  const newStatus = VALID[String(action || '').trim()];
  if (!teamId || !newStatus) return res.status(400).json({ error: 'teamId and a valid action (stop|pause|resume|disqualify|reactivate) are required' });
  if (newStatus === 'disqualified' && (!reason || !String(reason).trim())) return res.status(400).json({ error: 'A reason is mandatory' });
  const acc = db.prepare("SELECT id, username FROM accounts WHERE username = ? AND role = 'team'").get(String(teamId).trim());
  if (!acc) return res.status(404).json({ error: 'Team not found' });
  const cur = db.prepare('SELECT status, eliminated FROM accounts WHERE id = ?').get(acc.id);
  if (cur.eliminated && newStatus !== 'active') {
    return res.status(409).json({ error: 'Team is eliminated — use Re-instate first' });
  }
  if (cur.status === newStatus) return res.json({ ok: true, note: 'Status unchanged' });
  db.prepare('UPDATE accounts SET status = ? WHERE id = ?').run(newStatus, acc.id);
  const actName = { stopped: 'team.stop', active: 'team.resume', disqualified: 'team.disqualify' }[newStatus] || action;
  auth.audit(req.account, actName, `${acc.username} → ${newStatus}${reason ? ' — ' + String(reason).trim() : ''}`);
  io.to(`team:${acc.id}`).emit('team status', { status: newStatus });
  broadcastStandings();
  res.json({ ok: true, status: newStatus });
});

// Participant: post-submit result detail governed by the question's reveal
// policy (master prompt §2). Policies:
//   immediately — result shown right after this team's own submission
//   round_default / judge_triggered — only the verdict (correct + marks); the
//     full explanation surfaces when the judge broadcasts 'answers revealed'.
app.get('/api/questions/:id/result', auth.requireRole('team'), requireNotEliminated, (req, res) => {
  const q = db.prepare('SELECT id, answer, explanation, marks, answer_reveal_policy, type FROM questions WHERE id = ?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Question not found' });
  const sub = db.prepare("SELECT awarded_marks, is_correct, content, feedback FROM submissions WHERE question_id = ? AND account_id = ? AND status = 'graded'").get(q.id, req.account.id);
  if (!sub) return res.status(404).json({ error: 'No submission yet' });
  const policy = q.answer_reveal_policy && q.answer_reveal_policy !== 'round_default'
    ? q.answer_reveal_policy : (sched.getSetting('reveal.policy', 'immediately') || 'immediately');
  const revealed = sub.is_correct ? { answer: q.type === 'mcq' ? undefined : String(q.answer), explanation: q.explanation || null, policy } : { explanation: q.explanation || null, policy };
  // Wrong MCQ: reveal the correct option text (grading value), not the key index.
  let correctAnswer = null;
  if (q.type === 'mcq' && revealed !== null) {
    try { const opts = JSON.parse(db.prepare('SELECT options FROM questions WHERE id = ?').get(q.id).options || 'null');
      correctAnswer = opts && opts.includes(String(q.answer)) ? String(q.answer) : null;
    } catch { correctAnswer = null; }
  }
  res.json({ correct: !!sub.is_correct, awarded: sub.awarded_marks, policy, correctAnswer, explanation: q.explanation || null });
});

// Judge: trigger an immediate backup (same engine as scripts/backup.js).
const fs = require('fs');
const backupDir = path.join(__dirname, 'backups');
function runBackup() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  fs.mkdirSync(backupDir, { recursive: true });
  const target = path.join(backupDir, `codesprint-${stamp}.db`);
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  fs.writeFileSync(path.join(backupDir, `results-${stamp}.json`), JSON.stringify(publicStandings(false), null, 2));
  // Retention: keep the newest 20 backups.
  const files = fs.readdirSync(backupDir).filter((f) => f.startsWith('codesprint-') && f.endsWith('.db')).sort();
  for (const old of files.slice(0, Math.max(0, files.length - 20))) fs.rmSync(path.join(backupDir, old), { force: true });
  lastBackupAt = new Date().toISOString();
  return { ok: true, file: path.basename(target), lastBackupAt };
}
app.post('/api/judge/backup-now', auth.requireRole('judge', 'admin'), (req, res) => {
  try { res.json(runBackup()); }
  catch (e) { res.status(500).json({ error: `Backup failed: ${e.message}` }); }
});
// Health & recovery timer: auto-backup every 10 minutes during round phases.
setInterval(() => {
  try {
    const cp = sched.currentPhase();
    if (cp.phase.startsWith('round')) runBackup();
  } catch { /* never crash the ticker */ }
}, 10 * 60 * 1000).unref();

// Judge: reinstate an eliminated team.
app.post('/api/judge/reinstate', auth.requireRole('judge', 'admin'), (req, res) => {
  const acc = db.prepare("SELECT id, username FROM accounts WHERE username = ? AND role = 'team'").get(req.body?.teamId);
  if (!acc) return res.status(404).json({ error: 'Team not found' });
  const r = db.prepare('UPDATE accounts SET eliminated = 0, eliminated_at = NULL WHERE id = ? AND eliminated = 1').run(acc.id);
  if (r.changes > 0) {
    auth.audit(req.account, 'reinstate', `${acc.username} reinstated by ${req.account.username}; tab-switch history retained`);
    io.to(`team:${acc.id}`).emit('team status', { status: 'active', reinstated: true });
    res.json({ ok: true });
  } else {
    res.json({ ok: true, note: 'Team was not eliminated' });
  }
});

// ---------------------------------------------------------------- leaderboard
app.get('/api/leaderboard', (req, res) => {
  res.json(publicStandings(false));
});
app.get('/api/results', (req, res) => {
  const frozen = db.prepare('SELECT frozen_at, snapshot, corrected, published_by FROM results_published WHERE id = 1').get();
  res.json({
    frozen: !!frozen,
    frozenAt: frozen ? frozen.frozen_at : null,
    corrected: frozen ? !!frozen.corrected : false,
    provisional: !frozen,
    teams: frozen ? JSON.parse(frozen.snapshot) : publicStandings(false).teams,
    top: (() => {
      const t = frozen ? JSON.parse(frozen.snapshot) : publicStandings(false).teams;
      return { winner: t[0] || null, runnerUp: t[1] || null, secondRunnerUp: t[2] || null };
    })(),
  });
});

// ---------------------------------------------------------------- judge/admin APIs
const judgeOnly = auth.requireRole('judge', 'admin');

app.get('/api/judge/overview', judgeOnly, (req, res) => {
  const teams = standings();
  const recentSubs = db.prepare(`
    SELECT s.id, s.question_id, s.account_id, a.username AS team_id, a.team_name, q.title, q.external_key,
           s.status, s.awarded_marks, s.is_correct, s.submitted_at, s.content, q.answer, q.type
    FROM submissions s
    JOIN accounts a ON a.id = s.account_id
    JOIN questions q ON q.id = s.question_id
    WHERE s.status = 'graded'
    ORDER BY s.submitted_at DESC LIMIT 100`).all();
  const pending = db.prepare(`
    SELECT s.id, s.account_id, a.username AS team_id, q.title, s.submitted_at
    FROM submissions s JOIN accounts a ON a.id = s.account_id JOIN questions q ON q.id = s.question_id
    WHERE s.status = 'pending' ORDER BY s.submitted_at DESC LIMIT 50`).all();
  res.json({
    phase: sched.currentPhase(),
    settings: sched.allSettings(),
    teamCount: teams.length,
    teams: teams.map((t) => ({ ...t, eliminated: !!db.prepare('SELECT eliminated FROM accounts WHERE id = ?').get(t.accountId).eliminated, hints: db.prepare('SELECT COUNT(*) AS c FROM hint_usage WHERE account_id = ?').get(t.accountId).c,
      tabEvents: db.prepare('SELECT COUNT(*) AS c FROM tab_events WHERE account_id = ?').get(t.accountId).c,
      flagged: db.prepare('SELECT COUNT(*) AS c FROM flags WHERE account_id = ? AND cleared_at IS NULL').get(t.accountId).c > 0,
      progress: progressFor(t.accountId) })),
    recentSubs, pending,
    incidents: db.prepare(`SELECT i.*, a.username AS team_id, a.team_name FROM incidents i JOIN accounts a ON a.id = i.account_id ORDER BY i.id DESC LIMIT 100`).all(),
    flags: db.prepare(`SELECT f.*, a.username AS team_id, a.team_name FROM flags f JOIN accounts a ON a.id = f.account_id WHERE f.cleared_at IS NULL ORDER BY f.id DESC`).all(),
    hintUsage: db.prepare(`SELECT h.*, a.username AS team_id, q.title FROM hint_usage h JOIN accounts a ON a.id = h.account_id JOIN questions q ON q.id = h.question_id ORDER BY h.used_at DESC LIMIT 100`).all(),
    audit: db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 100').all(),
  });
});

// Schedule configuration
// Quick-start: begin the competition NOW (or in N minutes) without touching durations.
app.post('/api/judge/quick-start', judgeOnly, (req, res) => {
  const startIn = Math.max(0, Math.round(Number(req.body?.startInMinutes ?? 0)) || 0);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const r1 = new Date(now.getTime() + startIn * 60000);
  const r1Min = Number(sched.getSetting('schedule.r1_minutes', '120'));
  const r2 = new Date(r1.getTime() + r1Min * 60000 + 60 * 60000); // R1 + 1h lunch
  const r2Min = Number(sched.getSetting('schedule.r2_minutes', '120'));
  const r3 = new Date(r2.getTime() + r2Min * 60000);
  sched.setSetting('competition.date', date);
  sched.setSetting('schedule.r1_start', hm(r1));
  sched.setSetting('schedule.r2_start', hm(r2));
  sched.setSetting('schedule.r3_start', hm(r3));
  auth.audit(req.account, 'competition.quick_start', `R1 ${hm(r1)}, R2 ${hm(r2)}, R3 ${hm(r3)} on ${date}`);
  broadcastPhase();
  res.json({ ok: true, phase: sched.currentPhase() });
});

// Hold / postpone: put the competition back into "Not Started" — everything locks.
app.post('/api/judge/hold', judgeOnly, (req, res) => {
  sched.setSetting('competition.date', `${new Date().getFullYear() + 1}-01-01`);
  sched.setSetting('schedule.r1_start', '10:00');
  sched.setSetting('schedule.r2_start', '13:00');
  sched.setSetting('schedule.r3_start', '15:00');
  auth.audit(req.account, 'competition.hold', 'competition set to Not Started — all rounds locked');
  broadcastPhase();
  res.json({ ok: true, phase: sched.currentPhase() });
});

app.put('/api/judge/settings', judgeOnly, (req, res) => {
  const allowed = ['competition.date', 'schedule.r1_start', 'schedule.r2_start', 'schedule.r3_start',
    'schedule.r1_minutes', 'schedule.r2_minutes', 'schedule.r3_minutes',
    'monitor.tab_threshold', 'hints.enabled'];
  const changes = {};
  for (const [k, v] of Object.entries(req.body || {})) {
    if (!allowed.includes(k)) continue;
    sched.setSetting(k, String(v));
    changes[k] = String(v);
  }
  auth.audit(req.account, 'settings.update', JSON.stringify(changes));
  broadcastPhase();
  res.json({ ok: true, changes });
});

// Team management
app.post('/api/judge/teams', judgeOnly, (req, res) => {
  const { username, password, teamName } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  try {
    db.prepare('INSERT INTO accounts (username, password_hash, role, team_name) VALUES (?, ?, ?, ?)')
      .run(String(username).trim(), hashPassword(String(password)), 'team', teamName || String(username));
  } catch (e) {
    return res.status(409).json({ error: 'Team ID already exists' });
  }
  auth.audit(req.account, 'team.create', String(username));
  res.json({ ok: true });
});
app.post('/api/judge/accounts', auth.requireRole('admin'), (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !password || !['judge', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'username, password and role (judge|admin) required' });
  }
  try {
    db.prepare('INSERT INTO accounts (username, password_hash, role) VALUES (?, ?, ?)')
      .run(String(username).trim(), hashPassword(String(password)), role);
  } catch {
    return res.status(409).json({ error: 'Username already exists' });
  }
  auth.audit(req.account, 'account.create', `${role}:${username}`);
  res.json({ ok: true });
});

// Manual score adjustment (mandatory reason, audited)
app.post('/api/judge/score-adjust', judgeOnly, (req, res) => {
  const { teamId, delta, reason } = req.body || {};
  const acc = db.prepare("SELECT id, username FROM accounts WHERE username = ? AND role = 'team'").get(teamId);
  if (!acc) return res.status(404).json({ error: 'Team not found' });
  const d = Number(delta);
  if (!Number.isInteger(d) || d === 0) return res.status(400).json({ error: 'delta must be a non-zero integer' });
  if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'A reason is mandatory' });
  db.prepare('INSERT INTO score_adjustments (account_id, delta, reason, created_by) VALUES (?, ?, ?, ?)')
    .run(acc.id, d, String(reason).trim(), req.account.id);
  auth.audit(req.account, 'score.adjust', `${acc.username} ${d >= 0 ? '+' : ''}${d} — ${String(reason).trim()}`);
  broadcastStandings();
  res.json({ ok: true });
});

// Re-grade a submission (judge override)
app.post('/api/judge/submissions/:id/regrade', judgeOnly, (req, res) => {
  const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(req.params.id);
  if (!sub) return res.status(404).json({ error: 'Submission not found' });
  const awarded = Number(req.body?.awarded);
  const q = db.prepare('SELECT marks FROM questions WHERE id = ?').get(sub.question_id);
  if (!Number.isInteger(awarded) || awarded < 0 || awarded > q.marks) {
    return res.status(400).json({ error: `awarded must be an integer 0..${q.marks}` });
  }
  db.prepare('UPDATE submissions SET awarded_marks = ?, is_correct = ?, feedback = ? WHERE id = ?')
    .run(awarded, awarded > 0 ? 1 : 0, `Judge override by ${req.account.username}`, sub.id);
  auth.audit(req.account, 'submission.regrade', `submission ${sub.id} → ${awarded} marks`);
  broadcastStandings();
  res.json({ ok: true });
});

// Flags
app.post('/api/judge/flag', judgeOnly, (req, res) => {
  const { teamId, reason } = req.body || {};
  const acc = db.prepare("SELECT id FROM accounts WHERE username = ? AND role = 'team'").get(teamId);
  if (!acc) return res.status(404).json({ error: 'Team not found' });
  if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'A reason is mandatory' });
  db.prepare('INSERT INTO flags (account_id, reason, created_by) VALUES (?, ?, ?)').run(acc.id, String(reason).trim(), req.account.id);
  auth.audit(req.account, 'flag.create', `${acc.username}: ${String(reason).trim()}`);
  res.json({ ok: true });
});
app.post('/api/judge/flags/:id/clear', judgeOnly, (req, res) => {
  db.prepare('UPDATE flags SET cleared_at = datetime(\'now\'), cleared_by = ? WHERE id = ? AND cleared_at IS NULL').run(req.account.id, req.params.id);
  auth.audit(req.account, 'flag.clear', `flag ${req.params.id}`);
  res.json({ ok: true });
});
app.post('/api/judge/incidents/:id/clear', judgeOnly, (req, res) => {
  db.prepare("UPDATE incidents SET status = 'cleared' WHERE id = ?").run(req.params.id);
  auth.audit(req.account, 'incident.clear', `incident ${req.params.id}`);
  res.json({ ok: true });
});

// Freeze final leaderboard (admin only). Requires confirmation flag from client.
app.post('/api/judge/freeze', auth.requireRole('admin'), (req, res) => {
  if (!req.body?.confirm) return res.status(400).json({ error: 'confirm:true required — this freezes all scores' });
  const existing = db.prepare('SELECT id FROM results_published WHERE id = 1').get();
  if (existing) return res.status(409).json({ error: 'Results are already frozen. Use /api/judge/unfreeze then republish after an authorized correction.' });
  const snapshot = publicStandings(false).teams;
  db.prepare('INSERT INTO results_published (id, frozen_at, published_by, snapshot) VALUES (1, datetime(\'now\'), ?, ?)')
    .run(req.account.id, JSON.stringify(snapshot));
  auth.audit(req.account, 'results.freeze', `${snapshot.length} teams frozen`);
  io.to('public').emit('standings', publicStandings(true));
  res.json({ ok: true });
});
app.post('/api/judge/unfreeze', auth.requireRole('admin'), (req, res) => {
  if (!req.body?.confirm) return res.status(400).json({ error: 'confirm:true required' });
  if (!req.body?.correctionReason || !String(req.body.correctionReason).trim()) {
    return res.status(400).json({ error: 'correctionReason is mandatory to unfreeze published results' });
  }
  db.prepare('DELETE FROM results_published WHERE id = 1');
  auth.audit(req.account, 'results.unfreeze', `authorized correction: ${String(req.body.correctionReason).trim()}`);
  broadcastStandings();
  res.json({ ok: true });
});

// ---------------------------------------------------------------- socket.io
// Authenticated sockets: parse the session cookie from the handshake.
io.use((socket, next) => {
  try {
    const header = socket.request.headers.cookie || '';
    const cookies = {};
    for (const part of header.split(';')) {
      const idx = part.indexOf('=');
      if (idx > 0) cookies[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    }
    const token = cookies[auth.SESSION_COOKIE];
    if (!token) return next(); // anonymous: public rooms only
    const row = db.prepare(`
      SELECT a.id, a.username, a.role FROM sessions s JOIN accounts a ON a.id = s.account_id
      WHERE s.token = ?`).get(token);
    if (row && new Date(db.prepare('SELECT expires_at FROM sessions WHERE token = ?').get(token).expires_at) > new Date()) {
      socket.data.account = row;
    }
    next();
  } catch (e) {
    next();
  }
});
io.on('connection', (socket) => {
  socket.join('public');
  const acc = socket.data.account;
  if (acc && (acc.role === 'judge' || acc.role === 'admin')) socket.join('judges');
  if (acc && acc.role === 'team') socket.join(`team:${acc.id}`);
  socket.on('phase:subscribe', () => socket.emit('phase', sched.currentPhase()));
});

// ---------------------------------------------------------------- static
// `/` routes by role: logged-in users land on their dashboard, others on login.
app.get('/', (req, res) => {
  if (req.account && req.account.role === 'team') return res.redirect('/team');
  if (req.account && (req.account.role === 'judge' || req.account.role === 'admin')) return res.redirect('/judge');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Favicon: browsers request /favicon.ico by default; serve the SVG there too.
app.get('/favicon.ico', (req, res) => res.sendFile(path.join(__dirname, 'public', 'favicon.svg')));

app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

// Clean URLs matching the login redirects.
const pageRoutes = {
  '/team': 'team.html',
  '/judge': 'judge.html',
  '/workspace': 'workspace.html',
  '/leaderboard': 'leaderboard.html',
  '/results': 'results.html',
};
for (const [route, file] of Object.entries(pageRoutes)) {
  app.get(route, (req, res) => res.sendFile(path.join(__dirname, 'public', file)));
}

// JSON 404 for unknown API paths
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
// Error handler — logs without leaking secrets.
app.use((err, req, res, next) => {
  console.error(`[error] ${req.method} ${req.path}: ${err.message}`);
  res.status(500).json({ error: 'Internal server error' });
});

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`CODE SPRINT running on http://localhost:${PORT} (LAN: http://<this-machine-ip>:${PORT})`);
  });
}

module.exports = { app, server, io };
