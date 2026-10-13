'use strict';
/** Live-verify C run via HTTP. Usage: node scripts/run-c-live.js */
const base = 'http://localhost:3000';
(async () => {
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'team06', password: 'sprint06' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const code = ['#include <stdio.h>', 'int main(){', '  int n;', '  if (scanf("%d", &n) != 1) return 1;', '  printf("doubled: %d\\n", n*2);', '  return 0;', '}'].join('\n');
  const r = await fetch(base + '/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ questionId: 19, language: 'c', code, stdin: '21' }) });
  const d = await r.json();
  console.log('status:', r.status);
  console.log('stdout:', JSON.stringify(d.stdout));
  console.log('stderr:', JSON.stringify((d.stderr || '').slice(0, 100)));
  console.log(d.stdout && d.stdout.includes('doubled: 42') ? 'C LIVE RUN PASS' : 'C LIVE RUN FAIL');
  process.exit(0);
})();
