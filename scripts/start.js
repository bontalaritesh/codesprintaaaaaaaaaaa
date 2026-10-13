'use strict';
/**
 * CODE SPRINT — launcher.
 * Prepends the local MinGW toolchain to PATH so the C/C++ Run button works,
 * then starts server.js. Toolchain candidates, in order:
 *   1. $MINGW_BIN (explicit override)
 *   2. D:\mingw64\mingw64\bin  (this machine)
 *   3. C:\mingw64\bin, C:\ProgramData\mingw64\bin (common layouts)
 *   4. any gcc already on PATH (no-op)
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const candidates = [
  process.env.MINGW_BIN,
  'D:\\mingw64\\mingw64\\bin',
  'C:\\mingw64\\bin',
  'C:\\ProgramData\\mingw64\\bin',
].filter(Boolean);

function haveGcc(bin) {
  try {
    fs.accessSync(path.join(bin, process.platform === 'win32' ? 'gcc.exe' : 'gcc'), fs.constants.X_OK);
    return true;
  } catch { return false; }
}

let extra = '';
for (const bin of candidates) {
  if (fs.existsSync(bin) && haveGcc(bin)) { extra = bin; break; }
}

const env = { ...process.env };
if (extra) env.PATH = extra + path.delimiter + (env.PATH || '');
else console.log('[start] no local gcc dir found — relying on system PATH (C/C++ Run button hidden if missing)');

const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env, stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 0));
