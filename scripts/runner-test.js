'use strict';
/** Direct runner smoke test: node scripts/runner-test.js */
const { runCode, detectRuntime } = require('../runner');

(async () => {
  for (const [lang, code, stdin, want] of [
    ['c', '#include <stdio.h>\nint main(){int n;if(scanf("%d",&n)!=1)return 1;printf("doubled: %d\\n", n*2);return 0;}', '21', 'doubled: 42'],
    ['c', 'int main(}{ broken', '', 'Compile error'],
    ['cpp', '#include <iostream>\nusing namespace std;\nint main(){string s;getline(cin,s);cout<<"hi "<<s<<endl;}', 'sprint', 'hi sprint'],
    ['python', 'import sys\nn=int(sys.stdin.readline())\nprint("doubled:", n*2)', '21', 'doubled: 42'],
  ]) {
    const r = await runCode({ language: lang, code, stdin });
    const ok = want === 'Compile error' ? r.stderr.includes('Compile error') : r.stdout.includes(want);
    console.log(`${lang.padEnd(7)} ${ok ? 'PASS' : 'FAIL'} | stdout=${JSON.stringify(r.stdout.slice(0, 40))} | stderr=${JSON.stringify((r.stderr || '').slice(0, 60))}`);
  }
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
