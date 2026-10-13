'use strict';
/** CODE SPRINT — 36-client load test. Usage: node scripts/loadtest.js [base] */
const base = process.argv[2] || 'http://localhost:3000';
const Teams = Array.from({ length: 36 }, (_, i) => `team${String(i + 1).padStart(2, '0')}`);
const pw = (u) => 'sprint' + u.slice(4);

(async () => {
  const mkCookie = (r) => (r.headers.get('set-cookie') || '').split(';')[0];
  // Ensure teams exist via admin API.
  const j = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
  const jC = { Cookie: mkCookie(j) };
  for (const t of Teams) {
    const r = await fetch(base + '/api/judge/teams', { method: 'POST', headers: { 'Content-Type': 'application/json', ...jC }, body: JSON.stringify({ username: t, password: pw(t), teamName: 'Team ' + t.slice(4) }) });
    if (!r.ok && r.status !== 409) console.log('create', t, '→', r.status);
  }
  console.log('[1] 36 teams ensured');

  // Open round 1 so submissions are accepted during the burst.
  const qs = await fetch(base + '/api/judge/quick-start', { method: 'POST', headers: { 'Content-Type': 'application/json', ...jC }, body: JSON.stringify({ startInMinutes: 0 }) });
  console.log('[2] quick-start issued →', qs.ok ? 'phase ' + (await qs.json()).phase.phase : 'FAIL');

  // Concurrent logins.
  const t0 = Date.now();
  const logins = await Promise.all(Teams.map((u) => fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: pw(u) }) })));
  const cookies = logins.map((r, i) => ({ team: Teams[i], cookie: mkCookie(r), ok: r.status === 200 }));
  console.log(`[3] 36 concurrent logins: ${Date.now() - t0} ms | all ok: ${cookies.every((c) => c.ok)}`);

  // Question fetch (first team) to find an MCQ.
  const ql = await fetch(base + '/api/questions/round1', { headers: { Cookie: cookies[0].cookie } }).then((r) => r.json());
  const target = ql.questions.find((x) => x.type === 'mcq');
  console.log('[4] target MCQ id', target.id, '| locked:', ql.locked);

  // Burst: 36 concurrent submissions (each team submits its own answer variant).
  const answers = ['72%', '70%', '68%', '75%'];
  const t1 = Date.now();
  const subs = await Promise.all(cookies.map((c, i) =>
    fetch(base + `/api/questions/${target.id}/submit`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: c.cookie }, body: JSON.stringify({ content: answers[i % answers.length] }) }).then((r) => r.status)
  ));
  const ms1 = Date.now() - t1;
  console.log(`[5] 36 concurrent submissions: ${ms1} ms | 200: ${subs.filter((s) => s === 200).length}/36 | 409 (already submitted): ${subs.filter((s) => s === 409).length}/36 | other: ${subs.filter((s) => s !== 200 && s !== 409).length}`);

  // Duplicate burst — idempotency: all must be 409, never re-award.
  const t2 = Date.now();
  const dups = await Promise.all(cookies.map((c) =>
    fetch(base + `/api/questions/${target.id}/submit`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: c.cookie }, body: JSON.stringify({ content: '75%' }) }).then((r) => r.status)
  ));
  console.log(`[6] duplicate burst: ${Date.now() - t2} ms | all 409: ${dups.every((s) => s === 409)}`);

  // Read load: 36 concurrent status + leaderboard.
  const t3 = Date.now();
  const st = await Promise.all(Array.from({ length: 36 }, () => fetch(base + '/api/status').then((r) => r.status)));
  console.log(`[7] 36× /api/status: ${Date.now() - t3} ms | all 200: ${st.every((s) => s === 200)}`);
  const t4 = Date.now();
  const lb = await Promise.all(Array.from({ length: 36 }, () => fetch(base + '/api/leaderboard').then((r) => r.status)));
  console.log(`[8] 36× /api/leaderboard: ${Date.now() - t4} ms | all 200: ${lb.every((s) => s === 200)}`);

  // Verify no score inflation from the duplicate burst.
  const leaders = await fetch(base + '/api/leaderboard').then((r) => r.json());
  const maxScore = Math.max(...leaders.teams.map((t) => t.score));
  console.log(`[9] leaderboard max score (must be ≤ 30): ${maxScore}`);

  const health = await fetch(base + '/api/health').then((r) => r.json());
  console.log('[10] health after load:', JSON.stringify({ ok: health.ok, memMB: health.memoryMB, teams: health.teams, uptimeS: health.uptimeSeconds }));
  process.exit(0);
})().catch((e) => { console.error('LOADTEST FAIL:', e.message); process.exit(1); });
