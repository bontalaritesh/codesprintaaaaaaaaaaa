'use strict';
/**
 * CODE SPRINT — e2e verification of the host-controlled round timer.
 * Run against a live server:  node scripts/e2e-timer.js [baseUrl]
 * Requires seeded accounts: judge/test-judge and team1/<its password>.
 */
const B = process.argv[2] || 'http://127.0.0.1:3103';
let fails = 0;
const A = (c, m) => { console.log((c ? 'ok - ' : 'FAIL - ') + m); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let jar = {};
async function req(path, { body, who = 'judge' } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const c = who === 'judge' ? 'cs-judge' : 'cs-team';
  if (jar[c]) headers.Cookie = jar[c];
  const r = await fetch(B + path, {
    method: body ? 'POST' : 'GET', headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = r.headers.get('set-cookie');
  if (sc) jar[c] = sc.split(';')[0];
  return { status: r.status, data: await r.json().catch(() => null) };
}
const post = (p, b) => req(p, { body: b, who: 'judge' });

(async () => {
  let r = await req('/api/status');
  A(!!r.data?.phase, 'server reachable, phase = ' + (r.data?.phase || '?'));

  // Logging in
  r = await req('/api/login', { body: { username: 'judge', password: 'test-judge' } });
  A(r.status === 200 || r.status === 201, 'judge login (' + r.status + ')');
  if (r.status >= 400) { console.log('judge login data:', JSON.stringify(r.data)); process.exit(1); }
  r = await req('/api/login', { body: { username: 'team01', password: process.env.TEAM1_PASS || 'sprint01' }, who: 'team' });
  A(r.status === 200 || r.status === 201, 'team1 login (' + r.status + ')');
  if (r.status >= 400) console.log('> team1 login failed — §15 unauthenticated/other-team checks still run');

  // OPENING A ROUND != STARTING ITS TIMER: snapshot must be READY untouched
  let s = await req('/api/timer/round1', { who: 'team' });
  A(s.data?.state === 'ready', 'participant reads READY snapshot before any host action');

  // §15 unauthorized controls
  let t0 = await req('/api/judge/timer/round1/start', { body: {}, who: 'team' });
  A(t0.status === 403, 'team blocked from timer control (got ' + t0.status + ')');
  const un = await fetch(B + '/api/judge/timer/round1/start', { method: 'POST' });
  A(un.status === 401 || un.status === 403, 'anonymous blocked (' + un.status + ')');

  // ACCESS THROUGH LIFECYCLE
  s = await post('/api/judge/timer/round1/start', {});
  A(s.data?.timer?.state === 'running', 'START → running');
  const v1 = s.data.timer.version;
  s = await req('/api/timer/round1', { who: 'team' });
  A(s.data.state === 'running', 'participant sees running');

  s = await post('/api/judge/timer/round1/pause', { expectedVersion: v1 });
  const frozen = s.data?.timer?.remainingMs;
  A(s.data?.timer?.state === 'paused', 'PAUSE → paused, frozen at ' + frozen);
  await sleep(700);
  s = await req('/api/timer/round1', { who: 'team' });
  A(s.data.remainingMs === frozen, 'exactly frozen while paused (' + s.data.remainingMs + ')');

  s = await post('/api/judge/timer/round1/resume', {});
  A(s.data?.timer?.state === 'running', 'RESUME → running');
  await sleep(400);
  s = await req('/api/timer/round1', { who: 'team' });
  A(s.data.remainingMs < frozen, 'resumed ticking from the frozen value: ' + frozen + '→' + s.data.remainingMs);

  s = await post('/api/judge/timer/round1/stop', {});
  const stopMs = s.data?.timer?.remainingMs;
  A(s.data?.timer?.state === 'stopped', 'STOP → stopped, remaining frozen at ' + stopMs);
  await sleep(500);
  s = await req('/api/timer/round1', { who: 'team' });
  A(s.data.remainingMs === stopMs, 'stopped timer stays frozen');
  r = await req('/api/status');
  A(r.data.phase !== 'finished', 'STOP does not auto-end the round (phase still ' + r.data.phase + ')');

  // submissions while stopped obey phase policy (STOP does not grade/blackbox)
  r = await req('/api/questions/round1', { who: 'team' });
  const qid = r.data?.questions?.[0]?.id;
  if (qid) {
    const sub = await req('/api/questions/' + qid + '/submit', { body: { content: 'x' }, who: 'team' });
    A(sub.status !== 423, 'submission while STOPPED not auto-rejected as expired (' + sub.status + ')');
  } else {
    A(true, 'no questions visible in current phase — skipped stop/submit probe');
  }

  s = await post('/api/judge/timer/round1/start', {});
  A(s.data?.timer?.state === 'running', 'STOPPED → START (explicit host restart) works');
  const pre = s.data.timer.remainingMs;
  s = await post('/api/judge/timer/round1/extend', { minutes: 5 });
  A(s.data?.timer?.remainingMs > pre + 4 * 60000, 'EXTEND +5m: ' + pre + '→' + s.data.timer.remainingMs);

  await post('/api/judge/timer/round1/pause', {});
  s = await post('/api/judge/timer/round1/reset', {});
  A(s.data?.timer?.state === 'ready' && s.data.timer.remainingMs === s.data.timer.durationMs, 'RESET → ready at full duration (not started)');

  // Stale commands
  await post('/api/judge/timer/round1/start', {});
  s = await post('/api/judge/timer/round1/pause', { expectedVersion: 999999999 });
  A(s.status === 409, 'stale version rejected 409');
  s = await post('/api/judge/timer/round1/pause', {});
  const vNow = s.data.timer.version;
  s = await post('/api/judge/timer/round1/pause', { expectedVersion: vNow });
  A(s.status === 409, 'duplicate PAUSE rejected (optimistic concurrency)');

  // Duration configuration
  s = await post('/api/judge/timer/round1/duration', { minutes: 1 });
  A(s.status === 409, 'duration change while running rejected 409');
  await post('/api/judge/timer/round1/reset', {});
  s = await post('/api/judge/timer/round1/duration', { minutes: 0, seconds: 1 });
  A(s.data?.timer?.durationMs === 1000 && s.data.timer.state === 'ready', 'duration 1s configured without switching on the timer (' + s.status + ')');

  // Natural expiry
  s = await post('/api/judge/timer/round1/start', {});
  A(s.data?.timer?.state === 'running', 'start shorter countdown');
  await sleep(3600);
  s = await req('/api/timer/round1', { who: 'team' });
  A(s.data.state === 'expired' && s.data.remainingMs === 0, 'natural EXPIRED at 00:00 (sweeper)');
  s = await post('/api/judge/timer/round1/start', {});
  A(s.status === 409, 'no silent restart after expiry');
  s = await post('/api/judge/timer/round1/extend', { minutes: 5 });
  A(s.status === 409, 'extend rejects expired');

  if (qid) {
    const sub = await req('/api/questions/' + qid + '/submit', { body: { content: 'y' }, who: 'team' });
    A(sub.status === 423, 'submission after expiry rejected 423 (' + (sub.data?.error || '') + ')');
  }

  s = await post('/api/judge/timer/round1/reset', {});
  A(s.data?.timer?.state === 'ready', 'RESET after expiry allowed');
  s = await post('/api/judge/timer/round1/end', {});
  A(s.data?.timer?.state === 'ended', 'END ROUND → ended');
  if (qid) {
    const sub2 = await req('/api/questions/' + qid + '/submit', { body: { content: 'y' }, who: 'team' });
    A(sub2.status === 423, 'submission after END rejected 423 (' + (sub2.data?.error || '') + ')');
  }
  s = await post('/api/judge/timer/round1/start', {});
  A(s.status === 409, 'controls disabled after ENDED');

  s = await post('/api/judge/timer/round1/dance', {});
  A(s.status === 400 || s.status === 409, 'unknown action rejected (' + s.status + ')');
  s = await post('/api/judge/timer/round42/start', {});
  A(s.status === 404, 'unknown round 404');

  console.log(fails === 0 ? '=== ALL TIMER HTTP CHECKS PASS ===' : '=== FAILURES: ' + fails + ' ===');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('UNEXPECTED', e); process.exit(1); });
