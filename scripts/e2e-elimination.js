'use strict';
/**
 * E2E check — eliminated team lifecycle through the real HTTP API:
 *  1. team03 logs in and is active
 *  2. 3 tab events → eliminated
 *  3. refresh (GET /api/me + /api/questions/roundN) still responds 200 but the
 *     client shows the hold screen (team.js logic) — the session is NOT killed
 *  4. team actions return 403 while eliminated
 *  5. judge reinstates → team active again and can act
 */
const BASE = 'http://localhost:3000';

async function req(session, method, path, body) {
  const opt = { method, headers: { 'Content-Type': 'application/json' } };
  if (session) opt.headers.Cookie = `cs_session=${session}`;
  if (body !== undefined) opt.body = JSON.stringify(body);
  const res = await fetch(BASE + path, opt);
  let data = null;
  try { data = await res.json(); } catch { /* html */ }
  return { status: res.status, data, setCookie: res.headers.get('set-cookie') };
}

(async () => {
  // 1. login team03
  let r = await req(null, 'POST', '/api/login', { username: 'team03', password: 'sprint03' });
  if (r.status !== 200) { console.log('LOGIN FAIL', r.status, r.data); process.exit(1); }
  const cookie = (r.setCookie.match(/cs_session=([^;]+)/) || [])[1];
  console.log('1. team03 login OK');

  // 2. tab events up to the limit
  for (let i = 0; i < 3; i++) r = await req(cookie, 'POST', '/api/monitor/tab-event', { leftAt: new Date().toISOString() });
  console.log('2. after 3 tab events → eliminated =', r.data.eliminated, `(${r.data.count}/${r.data.limit})`);

  // 3. refresh: the eliminated team's session still resolves — /api/me 200 with eliminated:true
  r = await req(cookie, 'GET', '/api/me');
  console.log('3. refresh /api/me →', r.status, '| eliminated =', r.data.eliminated);

  // 4. team action blocked while eliminated
  const db = (await import('node:sqlite')).DatabaseSync;
  const sdb = new db(require('path').join(__dirname, '..', 'codesprint.db'));
  const q = sdb.prepare("SELECT id, round_key FROM questions WHERE round_key='round1' ORDER BY order_num LIMIT 1").get();
  r = await req(cookie, 'POST', `/api/questions/${q.id}/submit`, { content: '72%' });
  console.log('4. submit while eliminated →', r.status, JSON.stringify(r.data?.error || '').slice(0, 60));

  // 5. judge reinstates
  r = await req(null, 'POST', '/api/login', { username: 'judge', password: 'judge123' });
  const jcookie = (r.setCookie.match(/cs_session=([^;]+)/) || [])[1];
  r = await req(jcookie, 'POST', '/api/judge/reinstate', { teamId: 'team03' });
  console.log('5. judge reinstate →', r.status, JSON.stringify(r.data));

  // 6. team active again
  r = await req(cookie, 'GET', '/api/me');
  console.log('6. after reinstate /api/me → eliminated =', r.data.eliminated, '| status =', r.data.status);
  console.log(r.data.eliminated === false && r.data.status === 'active' ? 'E2E ELIMINATION FLOW PASS' : 'E2E FAIL');
  process.exit(r.data.eliminated === false ? 0 : 1);
})().catch((e) => { console.error('E2E ERROR', e); process.exit(1); });
