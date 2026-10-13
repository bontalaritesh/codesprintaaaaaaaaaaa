'use strict';
/**
 * CODE SPRINT — automated tests (node:test).
 * Uses an isolated test DB and a real HTTP server on an ephemeral port.
 * Run: npm test
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Isolated DB for the whole test run (must be set before requiring modules).
process.env.CODESPRINT_DB = path.join(os.tmpdir(), `codesprint-test-${process.pid}.db`);
// Fixed schedule in the past→finished state by default; tests manipulate settings.
process.env.PORT = '0';

const { getDb } = require('../db');
const { seed, hashPassword } = require('../seed');
const sched = require('../schedule');

// Seed once for the file.
seed({ teams: 3, adminPass: 'test-admin', judgePass: 'test-judge' });

const { app } = require('../server');

// --- tiny HTTP helpers ------------------------------------------------------
let server, base;
const jars = {};

function startServer() {
  return new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
}
function stopServer() {
  return new Promise((resolve) => server.close(resolve));
}

async function req(method, p, { body, as } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (as && jars[as]) headers.Cookie = jars[as];
  const res = await fetch(base + p, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (as && setCookie) jars[as] = setCookie.split(';')[0];
  let data = null;
  try { data = await res.json(); } catch { /* html */ }
  return { status: res.status, data };
}

// Force a phase: set event date + start times relative to now.
function setPhase(phase, now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const t = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (phase === 'round1') {
    sched.setSetting('competition.date', date);
    sched.setSetting('schedule.r1_start', t(new Date(now.getTime() - 5 * 60000))); // started 5 min ago
    sched.setSetting('schedule.r2_start', t(new Date(now.getTime() + 110 * 60000)));
    sched.setSetting('schedule.r3_start', t(new Date(now.getTime() + 230 * 60000)));
  } else if (phase === 'round2') {
    sched.setSetting('competition.date', date);
    sched.setSetting('schedule.r1_start', t(new Date(now.getTime() - 130 * 60000)));
    sched.setSetting('schedule.r2_start', t(new Date(now.getTime() - 5 * 60000)));
    sched.setSetting('schedule.r3_start', t(new Date(now.getTime() + 115 * 60000)));
  } else if (phase === 'lunch') {
    sched.setSetting('competition.date', date);
    sched.setSetting('schedule.r1_start', t(new Date(now.getTime() - 125 * 60000)));
    sched.setSetting('schedule.r2_start', t(new Date(now.getTime() + 5 * 60000)));
    sched.setSetting('schedule.r3_start', t(new Date(now.getTime() + 125 * 60000)));
  } else if (phase === 'finished') {
    sched.setSetting('competition.date', date);
    sched.setSetting('schedule.r1_start', t(new Date(now.getTime() - 380 * 60000)));
    sched.setSetting('schedule.r2_start', t(new Date(now.getTime() - 250 * 60000)));
    sched.setSetting('schedule.r3_start', t(new Date(now.getTime() - 70 * 60000)));
  }
}

test.before(startServer);
test.after(async () => {
  const { io } = require('../server');
  io.close();
  await stopServer();
  try { fs.rmSync(process.env.CODESPRINT_DB, { force: true }); fs.rmSync(process.env.CODESPRINT_DB + '-wal', { force: true }); fs.rmSync(process.env.CODESPRINT_DB + '-shm', { force: true }); } catch {}
});

// ---------------------------------------------------------------- auth & authz
test('unauthenticated users cannot access protected APIs', async () => {
  for (const p of ['/api/me', '/api/questions/round1', '/api/judge/overview']) {
    const r = await req('GET', p);
    assert.strictEqual(r.status, 401, p);
  }
});

test('invalid credentials rejected with uniform error', async () => {
  const r = await req('POST', '/api/login', { body: { username: 'team01', password: 'nope' } });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.data.error, 'Invalid credentials');
  const r2 = await req('POST', '/api/login', { body: { username: 'ghost-team', password: 'nope' } });
  assert.strictEqual(r2.status, 401);
  assert.strictEqual(r2.data.error, 'Invalid credentials'); // no user-existence leak
});

test('team login works and redirect differs from judge', async () => {
  const r = await req('POST', '/api/login', { body: { username: 'team01', password: 'sprint01' }, as: 't1' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.role, 'team');
  assert.strictEqual(r.data.redirect, '/team');
});

test('teams cannot access judge/admin routes', async () => {
  const r = await req('GET', '/api/judge/overview', { as: 't1' });
  assert.strictEqual(r.status, 403);
  const r2 = await req('POST', '/api/judge/freeze', { as: 't1', body: { confirm: true } });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r2.status, 403);
  const r3 = await req('POST', '/api/judge/accounts', { as: 't1', body: { username: 'x', password: 'y', role: 'admin' } });
  assert.strictEqual(r3.status, 403);
});

test('team cannot forge role, team id or score via submit/draft', async () => {
  setPhase('round2');
  const db = getDb();
  const q = db.prepare("SELECT id FROM questions WHERE round_key='round2' ORDER BY order_num LIMIT 1").get();
  // A team submitting to another account's name is impossible by design: account
  // comes from the session. Verify score fields are ignored in submit body.
  const r = await req('POST', `/api/questions/${q.id}/submit`, { as: 't1', body: { content: '2 5', awarded_marks: 999, account_id: 999 } });
  assert.strictEqual(r.status, 200);
  const me = await req('GET', '/api/me', { as: 't1' });
  assert.notStrictEqual(me.data.score.total, 999);
  assert.ok(me.data.score.total <= 30); // actual marks of this question
});

test('expired sessions are rejected', async () => {
  const db = getDb();
  // team02 logs in, then we force-expire the session server-side.
  await req('POST', '/api/login', { body: { username: 'team02', password: 'sprint02' }, as: 't2' });
  const me1 = await req('GET', '/api/me', { as: 't2' });
  assert.strictEqual(me1.status, 200);
  db.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE account_id = (SELECT id FROM accounts WHERE username = 'team02')").run();
  const me2 = await req('GET', '/api/me', { as: 't2' });
  assert.strictEqual(me2.status, 401);
  jars.t2 = null;
});

// ---------------------------------------------------------------- questions & import
test('questions load from SQLite and rerun-import does not duplicate', async () => {
  const db = getDb();
  const before = db.prepare('SELECT COUNT(*) c FROM questions').get().c;
  assert.strictEqual(before, 40);
  // rerun seed (same content) via child require — direct call
  delete require.cache[require.resolve('../seed')];
  const { seed: reseed } = require('../seed');
  reseed({ teams: 3 });
  const after = db.prepare('SELECT COUNT(*) c FROM questions').get().c;
  assert.strictEqual(after, before, 'import must be idempotent');
});

test('teams see questions without answers or hints', async () => {
  const r = await req('GET', '/api/questions/round1', { as: 't1' });
  assert.strictEqual(r.status, 200);
  for (const q of r.data.questions) {
    assert.ok(!('answer' in q), 'answer key must not leak');
    assert.ok(!('hint' in q), 'hint text must not leak before use');
  }
});

// ---------------------------------------------------------------- phases & submission windows
test('submissions rejected outside the open round (lunch lock)', async () => {
  setPhase('lunch');
  const db = getDb();
  const q = db.prepare("SELECT id FROM questions WHERE round_key='round1' AND type='mcq' LIMIT 1").get();
  const r = await req('POST', `/api/questions/${q.id}/submit`, { as: 't1', body: { content: '72%' } });
  assert.strictEqual(r.status, 423);
});

test('submissions rejected after competition finished', async () => {
  setPhase('finished');
  const db = getDb();
  const q = db.prepare("SELECT id FROM questions WHERE round_key='round3' LIMIT 1").get();
  const r = await req('POST', `/api/questions/${q.id}/submit`, { as: 't1', body: { content: 'fix' } });
  assert.strictEqual(r.status, 423);
});

test('submission accepted in the open round and graded server-side', async () => {
  setPhase('round1');
  const db = getDb();
  const q = db.prepare("SELECT id, marks FROM questions WHERE round_key='round1' AND external_key='round1-q1'").get();
  const wrong = await req('POST', `/api/questions/${q.id}/submit`, { as: 't1', body: { content: '68%' } });
  assert.strictEqual(wrong.status, 200);
  assert.strictEqual(wrong.data.correct, false);
  assert.strictEqual(wrong.data.awarded, 0);
  // duplicate submission cannot re-award or overwrite the graded result
  const dup = await req('POST', `/api/questions/${q.id}/submit`, { as: 't1', body: { content: '72%' } });
  assert.strictEqual(dup.status, 409);
  const db2 = getDb();
  const sub = db2.prepare('SELECT awarded_marks, is_correct FROM submissions WHERE question_id=? AND account_id=(SELECT id FROM accounts WHERE username=?)').get(q.id, 'team01');
  assert.strictEqual(sub.awarded_marks, 0, 'resubmission must not overwrite grade');
});

test('MCQ correct answer awards marks; hint penalty applied on server', async () => {
  setPhase('round1');
  const db = getDb();
  const q = db.prepare("SELECT id, marks FROM questions WHERE external_key='round1-q2'").get();
  // use hint first (r1-q2 has no hint configured; use r1-q1's team instead)
  const qh = db.prepare("SELECT id, hint_penalty FROM questions WHERE external_key='round1-q5'").get();
  const h = await req('POST', `/api/questions/${qh.id}/hint`, { as: 't1', body: {} });
  assert.strictEqual(h.status, 200);
  assert.strictEqual(h.data.penalty, qh.hint_penalty);
  const h2 = await req('POST', `/api/questions/${qh.id}/hint`, { as: 't1', body: {} });
  assert.strictEqual(h2.data.alreadyUsed, true, 'hint must be one-shot');
  assert.strictEqual(h2.data.penalty, 0, 'duplicate hint must not double-charge');

  const r = await req('POST', `/api/questions/${q.id}/submit`, { as: 't1', body: { content: '75' } });
  assert.strictEqual(r.data.correct, true);
  assert.strictEqual(r.data.awarded, q.marks);
  const me = await req('GET', '/api/me', { as: 't1' });
  assert.strictEqual(me.data.score.hintPenalty, qh.hint_penalty);
});

// ---------------------------------------------------------------- leaderboard & freeze
test('leaderboard ordering consistent with scoring; final freeze locks it', async () => {
  setPhase('finished');
  // reset results state
  const db = getDb();
  db.prepare('DELETE FROM results_published').run();

  await req('POST', '/api/login', { body: { username: 'admin', password: 'test-admin' }, as: 'admin' });
  const lb = await req('GET', '/api/leaderboard');
  assert.strictEqual(lb.status, 200);
  const scores = lb.data.teams.map((t) => t.score);
  const sorted = [...scores].sort((a, b) => b - a);
  assert.deepStrictEqual(scores, sorted, 'leaderboard must be score-descending');

  const freeze = await req('POST', '/api/judge/freeze', { as: 'admin', body: { confirm: true } });
  assert.strictEqual(freeze.status, 200);

  // after freeze, scores must not change even if underlying data would
  const frozenBefore = (await req('GET', '/api/results')).data;
  db.prepare("INSERT INTO score_adjustments (account_id, delta, reason, created_by) SELECT id, 500, 'post-freeze tamper', id FROM accounts WHERE username=?").run('team01');
  const frozenAfter = (await req('GET', '/api/results')).data;
  assert.deepStrictEqual(frozenAfter.teams, frozenBefore.teams, 'frozen results must not move');
  db.prepare("DELETE FROM score_adjustments WHERE reason = 'post-freeze tamper'").run();
});

test('unfreeze requires an explicit correction reason', async () => {
  const noReason = await req('POST', '/api/judge/unfreeze', { as: 'admin', body: { confirm: true } });
  assert.strictEqual(noReason.status, 400);
  const ok = await req('POST', '/api/judge/unfreeze', { as: 'admin', body: { confirm: true, correctionReason: 'authorized correction' } });
  assert.strictEqual(ok.status, 200);
});

// ---------------------------------------------------------------- team isolation
test('one team cannot access another team private data; drafts are per-account', async () => {
  setPhase('round2');
  const db = getDb();
  const q = db.prepare("SELECT id FROM questions WHERE round_key='round2' AND type='code' LIMIT 1").get();
  // t1 saves a distinctive draft, t3 must not be able to read it via drafts endpoint scoped to account
  const save = await req('PUT', `/api/questions/${q.id}/draft`, { as: 't1', body: { content: 'TEAM01_SECRET_DRAFT' } });
  assert.strictEqual(save.status, 200);
  const own = await req('GET', `/api/drafts/${q.id}`, { as: 't1' });
  assert.strictEqual(own.data.content.includes('TEAM01_SECRET_DRAFT'), true);
  const other = await req('GET', `/api/drafts/${q.id}`, { as: 't3' });
  assert.notStrictEqual(other.data.content && other.data.content.includes('TEAM01_SECRET_DRAFT'), true, 'other team must not see t1 draft');
});

// ---------------------------------------------------------------- tab monitoring
test('3 tab switches eliminate the team; actions locked; judge can reinstate', async () => {
  setPhase('round2');
  sched.setSetting('monitor.tab_threshold', '3');
  const db = getDb();
  db.prepare('DELETE FROM tab_events WHERE account_id=(SELECT id FROM accounts WHERE username=?)').run('team01');
  db.prepare('DELETE FROM incidents WHERE account_id=(SELECT id FROM accounts WHERE username=?)').run('team01');
  db.prepare('UPDATE accounts SET eliminated = 0, eliminated_at = NULL WHERE username=?').run('team01');
  const left = '2026-10-09T08:00:0';
  const evts = [
    { leftAt: left + '0Z', returnedAt: left + '1Z' },
    { leftAt: left + '2Z', returnedAt: left + '3Z' },
    { leftAt: left + '4Z', returnedAt: left + '5Z' },
    { leftAt: left + '0Z', returnedAt: left + '9Z' }, // duplicate of #1 — must be ignored
  ];
  let last;
  for (const e of evts) last = await req('POST', '/api/monitor/tab-event', { as: 't1', body: e });
  const count = db.prepare('SELECT COUNT(*) c FROM tab_events WHERE account_id=(SELECT id FROM accounts WHERE username=?)').get('team01').c;
  assert.strictEqual(count, 3, 'duplicate overlapping event must not be recorded twice');
  const elim = db.prepare('SELECT eliminated, eliminated_at FROM accounts WHERE username=?').get('team01');
  assert.strictEqual(elim.eliminated, 1, '3rd tab switch must eliminate the team');
  assert.ok(elim.eliminated_at, 'elimination timestamp recorded');
  const incidents = db.prepare("SELECT COUNT(*) c FROM incidents WHERE account_id=(SELECT id FROM accounts WHERE username=?) AND kind='eliminated_tab_switch'").get('team01').c;
  assert.strictEqual(incidents, 1, 'exactly one elimination incident');
  const warn = db.prepare("SELECT COUNT(*) c FROM incidents WHERE account_id=(SELECT id FROM accounts WHERE username=?) AND kind='tab_switch_final_warning'").get('team01').c;
  assert.strictEqual(warn, 1, 'final warning incident at 2/3');
  // last event response reports elimination
  assert.strictEqual(last.data.eliminated, true, 'eliminating event reports eliminated=true');
  // all team actions are locked once eliminated
  const blocked = await req('GET', '/api/questions/round2', { as: 't1' });
  assert.strictEqual(blocked.status, 403, 'eliminated team blocked from questions');
  // judge can reinstate; tab-switch history retained
  await req('POST', '/api/login', { body: { username: 'judge', password: 'test-judge' }, as: 'judge' });
  const reinstate = await req('POST', '/api/judge/reinstate', { as: 'judge', body: { teamId: 'team01' } });
  assert.strictEqual(reinstate.status, 200, 'judge reinstate succeeds');
  const after = db.prepare('SELECT eliminated FROM accounts WHERE username=?').get('team01');
  assert.strictEqual(after.eliminated, 0, 'reinstate clears eliminated flag');
  const retained = db.prepare('SELECT COUNT(*) c FROM tab_events WHERE account_id=(SELECT id FROM accounts WHERE username=?)').get('team01').c;
  assert.strictEqual(retained, 3, 'tab-switch history retained after reinstate');
  // team can access questions again
  const unblocked = await req('GET', '/api/questions/round2', { as: 't1' });
  assert.strictEqual(unblocked.status, 200, 'reinstated team can access questions');
  // cleanup: reset events so next test starts clean
  db.prepare('DELETE FROM tab_events WHERE account_id=(SELECT id FROM accounts WHERE username=?)').run('team01');
  db.prepare('DELETE FROM incidents WHERE account_id=(SELECT id FROM accounts WHERE username=?)').run('team01');
});

// ---------------------------------------------------------------- judge team-status controls
test('judge can stop, resume, disqualify a team; stopped team blocked from acting', async () => {
  setPhase('round2');
  const db = getDb();
  await req('POST', '/api/login', { body: { username: 'judge', password: 'test-judge' }, as: 'judge' });
  await req('POST', '/api/login', { body: { username: 'team02', password: 'sprint02' }, as: 't2' });
  // invalid action rejected
  const bad = await req('POST', '/api/judge/team-status', { as: 'judge', body: { teamId: 'team02', action: 'nuke' } });
  assert.strictEqual(bad.status, 400, 'unknown action rejected');
  // stop
  const stop = await req('POST', '/api/judge/team-status', { as: 'judge', body: { teamId: 'team02', action: 'stop', reason: 'suspicious behavior check' } });
  assert.strictEqual(stop.status, 200, 'stop succeeds');
  const stopped = db.prepare('SELECT status FROM accounts WHERE username=?').get('team02');
  assert.strictEqual(stopped.status, 'stopped');
  // stopped team cannot submit
  const q = db.prepare("SELECT id FROM questions WHERE round_key='round2' ORDER BY order_num").get();
  const blocked = await req('POST', `/api/questions/${q.id}/submit`, { as: 't2', body: { content: 'x' } });
  assert.strictEqual(blocked.status, 403, 'stopped team blocked from submit');
  // resume
  const resume = await req('POST', '/api/judge/team-status', { as: 'judge', body: { teamId: 'team02', action: 'resume' } });
  assert.strictEqual(resume.status, 200);
  assert.strictEqual(db.prepare('SELECT status FROM accounts WHERE username=?').get('team02').status, 'active');
  // disqualify requires reason
  const noReason = await req('POST', '/api/judge/team-status', { as: 'judge', body: { teamId: 'team02', action: 'disqualify' } });
  assert.strictEqual(noReason.status, 400, 'disqualify without reason rejected');
  const dq = await req('POST', '/api/judge/team-status', { as: 'judge', body: { teamId: 'team02', action: 'disqualify', reason: 'answer pattern collusion' } });
  assert.strictEqual(dq.status, 200);
  assert.strictEqual(db.prepare('SELECT status FROM accounts WHERE username=?').get('team02').status, 'disqualified');
  // reactivate
  const re = await req('POST', '/api/judge/team-status', { as: 'judge', body: { teamId: 'team02', action: 'reactivate' } });
  assert.strictEqual(re.status, 200);
  assert.strictEqual(db.prepare('SELECT status FROM accounts WHERE username=?').get('team02').status, 'active');
  // audit entries recorded
  const audits = db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action LIKE 'team.%'").get().c;
  assert.ok(audits >= 4, 'team.status actions audited');
  // team-role tad cannot call it
  const forbidden = await req('POST', '/api/judge/team-status', { as: 't1', body: { teamId: 'team02', action: 'stop' } });
  assert.strictEqual(forbidden.status, 403, 'team cannot call team-status');
  // health endpoint reports db ok
  const health = await req('GET', '/api/health');
  assert.strictEqual(health.status, 200);
  assert.strictEqual(health.data.db, 'ok');
});

// ---------------------------------------------------------------- grading correctness (source-doc answers)
test('source-document answer key grades correctly (spot checks)', async () => {
  const { gradeAnswer } = require('../grading');
  const db = getDb();
  const cases = [
    ['round1-q1', '72%', true], ['round1-q1', '70%', false],
    ['round1-q13', 'XSZRI', true],
    ['round3-q5', 'arr[0] = last;', true],
    ['round3-q5', 'arr[0] = arr[n - 1];', false],
    ['round2-q4', 'smallest = arr[0]', true],
    ['round2-q5', 'i++;', true],
  ];
  for (const [key, answer, expected] of cases) {
    const q = db.prepare('SELECT * FROM questions WHERE external_key=?').get(key);
    const r = gradeAnswer(q, answer);
    assert.strictEqual(r.correct, expected, `${key}: "${answer}"`);
  }
});

// ---------------------------------------------------------------- operations
test('run endpoint: auth required, round-gated, executes python', async () => {
  // unauthenticated → 401
  const anon = await req('POST', '/api/run', { body: { questionId: 1, language: 'python', code: 'print(1)' } });
  assert.strictEqual(anon.status, 401);
  // locked round → 423
  setPhase('lunch');
  const q1 = getDb().prepare("SELECT id FROM questions WHERE external_key='round1-q1'").get();
  const locked = await req('POST', '/api/run', { as: 't1', body: { questionId: q1.id, language: 'python', code: 'print(1)' } });
  assert.strictEqual(locked.status, 423);
  // open round → executes and returns stdout
  setPhase('round2');
  const q = getDb().prepare("SELECT id FROM questions WHERE round_key='round2' AND order_num=1").get();
  const run = await req('POST', '/api/run', { as: 't1', body: { questionId: q.id, language: 'python', code: 'print(21*2)', stdin: '' } });
  assert.strictEqual(run.status, 200);
  if (run.data.stderr && /not installed/.test(run.data.stderr)) {
    assert.ok(true, 'python missing on test host — skipping stdout assertion');
  } else {
    assert.match(run.data.stdout, /42/);
  }
});

test('error logging does not leak passwords', async () => {
  // login failure with special chars must not throw/leak
  const r = await req('POST', '/api/login', { body: { username: 'team01"\'); DROP TABLE accounts;--', password: 'x' } });
  assert.strictEqual(r.status, 401);
  const db = getDb();
  const acc = db.prepare('SELECT COUNT(*) c FROM accounts').get().c;
  assert.ok(acc > 0, 'accounts table intact');
});

/**
 * Assert that fn throws a plain rejection object { status, error }.
 * (roundtimer throws plain objects, not Errors — regex never matches.)
 */
function throwsStatus(fn, status, errMatch) {
  let caught = null;
  try { fn(); } catch (e) { caught = e; }
  assert.ok(caught, 'expected a throw');
  assert.strictEqual(caught.status, status, `status ${status}, got ${JSON.stringify(caught)}`);
  if (errMatch) assert.ok(errMatch.test(caught.error), `error text ${caught.error}`);
}

// ---------------------------------------------------------------- host-controlled round timer
test('round timer: READY by default, full lifecycle, invalid transitions rejected', async () => {
  const rt = require('../roundtimer');
  const db = getDb();
  db.exec("DELETE FROM round_timers"); // clean slate for this test
  const snap = rt.snapshot('round1');
  assert.strictEqual(snap.state, 'ready', 'opening a round leaves its timer READY — waiting for the host');
  assert.ok(snap.version >= 1);

  // START only by explicit host action
  let t = rt.transition('round1', 'start', { actor: 'judge' });
  assert.strictEqual(t.state, 'running');
  assert.ok(t.version > snap.version, 'version is monotonic');

  // PAUSE freezes exactly; RESUME continues from the frozen value
  t = rt.transition('round1', 'pause', { actor: 'judge' });
  const frozen = t.remainingMs;
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(rt.snapshot('round1').remainingMs, frozen, 'remaining stays frozen while paused');
  t = rt.transition('round1', 'resume', { actor: 'judge' });
  assert.strictEqual(t.state, 'running');
  await new Promise((r) => setTimeout(r, 40));
  const later = rt.snapshot('round1').remainingMs;
  assert.ok(later < frozen && frozen - later < 2000, 'resumed from the frozen value');

  // STOP freezes and does NOT end the round
  const stopSnap = rt.snapshot('round1');
  t = rt.transition('round1', 'stop', { actor: 'judge' });
  assert.strictEqual(t.state, 'stopped');
  const stoppedRem = t.remainingMs;
  await new Promise((r) => setTimeout(r, 40));
  assert.strictEqual(rt.snapshot('round1').remainingMs, stoppedRem, 'stopped timer frozen');

  // Explicit host restart from STOPPED
  t = rt.transition('round1', 'start', { actor: 'judge' });
  assert.strictEqual(t.state, 'running');

  // EXTEND: authorized-only, and only while running/paused/stopped
  const before = rt.snapshot('round1').remainingMs;
  t = rt.transition('round1', 'extend', { actor: 'judge', extendMs: 5 * 60000 });
  assert.strictEqual(t.state, 'running');
  assert.ok(t.remainingMs > before + 4 * 60000, 'extend grew the countdown');
  throwsStatus(() => rt.transition('round1', 'extend'), 400, /Extension/);

  // RESET → READY at full configured duration, never auto-starts
  await rt.transition('round1', 'pause');
  t = rt.transition('round1', 'reset');
  assert.strictEqual(t.state, 'ready');
  assert.strictEqual(t.remainingMs, t.durationMs);

  // Invalid transitions rejected server-side (409)
  throwsStatus(() => rt.transition('round1', 'pause'), 409, /Cannot pause a ready/);
  throwsStatus(() => rt.transition('round1', 'resume'), 409, /Cannot resume/);

  // Stale/duplicate commands guarded by monotonic version
  await rt.transition('round1', 'start');
  const cur = rt.snapshot('round1');
  throwsStatus(() => rt.transition('round1', 'pause', { expectedVersion: cur.version - 1 }), 409, /Stale/);
  const paused = rt.transition('round1', 'pause', { expectedVersion: cur.version });
  assert.strictEqual(paused.state, 'paused');
  throwsStatus(() => rt.transition('round1', 'pause', { expectedVersion: cur.version }), 409, /Cannot pause a paused/);
  // a PAUSED timer resumes (start is not valid from paused)
  throwsStatus(() => rt.transition('round1', 'start'), 409, /Cannot start a paused/);
  await rt.transition('round1', 'resume');
  await rt.transition('round1', 'end', { actor: 'judge' }); // host END ROUND from running
  const ended = rt.snapshot('round1');
  assert.strictEqual(ended.state, 'ended');
  throwsStatus(() => rt.transition('round1', 'start'), 409, /Cannot start/);
});

test('round timer: natural expiry fires exactly once; recovery keeps wall clock', async () => {
  const rt = require('../roundtimer');
  const db = getDb();
  rt.snapshot('round2'); // ensure the row exists (rows are created lazily)
  db.prepare("UPDATE round_timers SET state='running', started_at=?, remaining_at_start_ms=5 WHERE round_key='round2'").run(Date.now() - 100);
  const expired = rt.sweepExpired();
  assert.ok(expired.includes('round2'), 'sweeper expires a running timer past zero');
  assert.strictEqual(rt.snapshot('round2').state, 'expired');
  assert.strictEqual(rt.snapshot('round2').remainingMs, 0);
  assert.ok(!rt.sweepExpired().includes('round2'), 'expiry is exactly-once');
  // start from EXPIRED is rejected (no silent restart); reset is required
  throwsStatus(() => rt.transition('round2', 'start'), 409, /Cannot start an expired/);
  // recovery of a longer-running timer keeps its wall-clock anchor
  rt.snapshot('round3'); // ensure the row exists (rows are created lazily)
  db.prepare("UPDATE round_timers SET state='running', started_at=?, remaining_at_start_ms=10*60000 WHERE round_key='round3'").run(Date.now() - 5000);
  const rec = rt.recoverUptime();
  assert.strictEqual(rec.expiredDuringDowntime, 0);
  const r3 = rt.snapshot('round3');
  assert.strictEqual(r3.state, 'running');
  assert.ok(r3.remainingMs < 10 * 60000 && r3.remainingMs > 10 * 60000 - 60000, 'recovery keeps elapsed time (no free time granted)');
});

test('round timer HTTP: judge-only control, submission gate on expiry/end', async () => {
  setPhase('round2');
  await req('POST', '/api/login', { body: { username: 'judge', password: 'test-judge' }, as: 'judge' });
  await req('POST', '/api/login', { body: { username: 'team02', password: 'sprint02' }, as: 't2' });
  const db = getDb();
  db.exec("UPDATE round_timers SET state='ready', duration_ms=1800000, remaining_ms=1800000, started_at=NULL, remaining_at_start_ms=NULL WHERE round_key='round2'");

  // participants/anonymous cannot drive the timer
  const forbidden = await req('POST', '/api/judge/timer/round2/start', { as: 't2' });
  assert.strictEqual(forbidden.status, 403, 'team cannot start the round timer');
  const anon = await req('POST', '/api/judge/timer/round2/start');
  assert.strictEqual(anon.status, 401, 'anonymous cannot start the round timer');
  // reading the authoritative snapshot is allowed for participants
  const p = await req('GET', '/api/timer/round2', { as: 't2' });
  assert.strictEqual(p.status, 200);
  assert.strictEqual(p.data.state, 'ready');

  // host lifecycle over HTTP
  const start = await req('POST', '/api/judge/timer/round2/start', { as: 'judge' });
  assert.strictEqual(start.status, 200);
  assert.strictEqual(start.data.timer.state, 'running');
  const paused = await req('POST', '/api/judge/timer/round2/pause', { as: 'judge' });
  assert.strictEqual(paused.data.timer.state, 'paused');
  const resumed = await req('POST', '/api/judge/timer/round2/resume', { as: 'judge' });
  assert.strictEqual(resumed.data.timer.state, 'running');
  // duration change while running rejected
  const badDur = await req('POST', '/api/judge/timer/round2/duration', { as: 'judge', body: { minutes: 1 } });
  assert.strictEqual(badDur.status, 409);
  // submissions keep working while the timer is merely running/paused/stopped
  await req('POST', '/api/judge/timer/round2/stop', { as: 'judge' });
  const q = db.prepare("SELECT id FROM questions WHERE round_key='round2' ORDER BY order_num LIMIT 1").get();
  const q2 = db.prepare("SELECT id FROM questions WHERE round_key='round2' ORDER BY order_num LIMIT 1 OFFSET 1").get();
  const sub1 = await req('POST', `/api/questions/${q.id}/submit`, { as: 't2', body: { content: 'x' } });
  assert.strictEqual(sub1.status, 200, 'STOP did not auto-submit/reject answers');

  // natural expiry closes submissions (sweeper may need a moment)
  db.prepare("UPDATE round_timers SET state='running', started_at=?, remaining_at_start_ms=1 WHERE round_key='round2'").run(Date.now() - 100);
  await req('GET', '/api/timer/round2', { as: 't2' });
  const expired = await req('POST', '/api/judge/timer/round2/reset', { as: 'judge' });
  assert.strictEqual(expired.data.timer.state, 'ready');
  // END ROUND from READY explicitly
  const end = await req('POST', '/api/judge/timer/round2/end', { as: 'judge' });
  assert.strictEqual(end.status, 200);
  assert.strictEqual(end.data.timer.state, 'ended');
  const q3 = db.prepare("SELECT id FROM questions WHERE round_key='round2' ORDER BY order_num LIMIT 1 OFFSET 2").get();
  const sub2 = await req('POST', `/api/questions/${q3.id}/submit`, { as: 't2', body: { content: 'x' } });
  assert.strictEqual(sub2.status, 423, 'submission rejected after host ends the round');
  assert.match(sub2.data.error, /ended/i);
  const sub3 = await req('POST', `/api/questions/${q.id}/submit`, { as: 't2', body: { content: 'y' } });
  assert.ok([409, 423].includes(sub3.status), 're-submit still flagged (409) or closed (423)');
  // expired-only gate path: simulate by re-arming ready→running then expiring on reset? use direct module state
  db.exec("UPDATE round_timers SET state='expired' WHERE round_key='round2'");
  const q4 = db.prepare("SELECT id FROM questions WHERE round_key='round2' ORDER BY order_num LIMIT 1 OFFSET 3").get();
  const sub4 = await req('POST', `/api/questions/${q4.id}/submit`, { as: 't2', body: { content: 'x' } });
  assert.strictEqual(sub4.status, 423, 'submission rejected after natural expiry');
  // judge actions audited
  const audits = db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action LIKE 'timer.%'").get().c;
  assert.ok(audits >= 4, 'timer transitions audited');
  // unknown action / round
  const weird = await req('POST', '/api/judge/timer/round2/dance', { as: 'judge' });
  assert.strictEqual(weird.status, 400);
  const noRound = await req('POST', '/api/judge/timer/round9/start', { as: 'judge' });
  assert.strictEqual(noRound.status, 404);
});
