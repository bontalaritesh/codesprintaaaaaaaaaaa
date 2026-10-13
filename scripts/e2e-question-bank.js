'use strict';
/** E2E — question bank management lifecycle through the real HTTP API. */
const BASE = 'http://localhost:3000';
let cookie = '';
function cookieFrom(res) { return (res.headers.get('set-cookie') || '').split(';')[0]; }
async function req(method, path, body) {
  const opt = { method, headers: { 'Content-Type': 'application/json', Cookie: cookie } };
  if (body !== undefined) opt.body = JSON.stringify(body);
  const res = await fetch(BASE + path, opt);
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data, res };
}
const ok = [], fail = [];
function check(name, cond, detail) { (cond ? ok : fail).push(name + (cond ? '' : ` — ${JSON.stringify(detail)}`)); }

(async () => {
  let r = await req('POST', '/api/login', { username: 'judge', password: 'judge123' });
  cookie = cookieFrom(r.res);
  if (!cookie) { console.log('login cookie missing', r.status); process.exit(1); }
  r = await req('GET', '/api/judge/bank?q=percentages');
  check('bank search', r.status === 200 && r.data.questions.length >= 1, r.data);

  // CREATE
  r = await req('POST', '/api/judge/bank', {
    round_key: 'round1', stage_key: 'gate', title: 'E2E Test Question',
    statement: 'What is 2+2?', type: 'mcq', options: ['3', '4', '5', '6'],
    marks: 5, difficulty: 'Easy', category: 'Arithmetic',
  });
  check('create', r.status === 200 && r.data.key, r.data);

  // find its numeric id
  r = await req('GET', '/api/judge/bank?q=e2e test question');
  const created = r.data.questions[0];
  check('created visible', !!created && created.enabled === 1, created);

  // team visibility before/after disable
  let t = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'team11', password: 'sprint11' }) });
  const teamCookie = cookieFrom(t);
  let tq = await fetch(`${BASE}/api/questions/round1`, { headers: { Cookie: teamCookie } });
  let tqj = await tq.json();
  const visibleBefore = tqj.questions.some((q) => q.id === created.id);
  check('custom question live for team', visibleBefore, tqj.questions.length);

  // EDIT: disable it
  r = await req('POST', '/api/login', { username: 'judge', password: 'judge123' });
  cookie = cookieFrom(r.res);
  r = await req('PUT', `/api/judge/bank/${created.id}`, { enabled: 0 });
  check('disable', r.status === 200 && r.data.changes.includes('enabled'), r.data);
  tq = await fetch(`${BASE}/api/questions/round1`, { headers: { Cookie: teamCookie } });
  tqj = await tq.json();
  check('disabled question hidden from team', !tqj.questions.some((q) => q.id === created.id));

  // DUPLICATE
  r = await req('POST', `/api/judge/bank/${created.id}/duplicate`, {});
  check('duplicate', r.status === 200 && r.data.key, r.data);

  // ARCHIVE + RESTORE
  r = await req('POST', `/api/judge/bank/${created.id}/archive`, {});
  check('archive', r.status === 200, r.data);
  tq = await fetch(`${BASE}/api/questions/round1`, { headers: { Cookie: teamCookie } });
  tqj = await tq.json();
  check('archived stays hidden', !tqj.questions.some((q) => q.id === created.id));
  r = await req('POST', `/api/judge/bank/${created.id}/restore`, {});
  check('restore', r.status === 200, r.data);

  // REORDER: move created question to front
  const ids = [created.id, ...tqj.questions.filter((q) => q.id !== created.id).slice(0, 4).map((q) => q.id)];
  r = await req('POST', '/api/judge/bank/reorder', { ids });
  check('reorder', r.status === 200, r.data);
  const after = await (await req('GET', '/api/judge/bank?q=e2e test question')).data;
  check('order persisted', after.questions[0].order_num === 1, after.questions[0]);

  // needs_review stays hidden from teams
  tq = await fetch(`${BASE}/api/questions/round1`, { headers: { Cookie: teamCookie } });
  tqj = await tq.json();
  check('needs_review hidden from team', tqj.questions.length === 13 && !tqj.questions.some((q) => q.external_key === 'round1-q4' || q.external_key === 'round1-q13'), tqj.questions.length);

  // unauthorized: team cannot use bank API
  const tRes = await fetch(BASE + '/api/judge/bank', { headers: { Cookie: teamCookie } });
  check('team blocked from bank API', tRes.status === 403, tRes.status);

  console.log(`PASS ${ok.length}: ${ok.join(' | ')}`);
  if (fail.length) { console.log(`FAIL ${fail.length}: ${fail.join(' | ')}`); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('E2E ERROR', e); process.exit(1); });
