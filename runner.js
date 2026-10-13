'use strict';
/**
 * CODE SPRINT — sandboxed code runner.
 * Executes participant code in an OS temp dir with hard timeouts, output caps,
 * and no network/environment isolation beyond process-level limits. This is a
 * competition convenience (Run button), NOT a security sandbox: only enable it
 * on a trusted LAN where participants are accountable (documented in README).
 *
 * Supported runtimes are detected at startup:
 *   python (python/py), java (javac+java), c/cpp (gcc/g++/clang if installed).
 */
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const TIMEOUT_MS = Number(process.env.RUNNER_TIMEOUT_MS || 5000);
const MAX_OUTPUT = 10000; // bytes of stdout/stderr returned
const MAX_CODE = 50000;

const toolCache = {};
function findTool(names, args = ['--version']) {
  for (const name of names) {
    if (toolCache[name] !== undefined) return toolCache[name] ? name : null;
  }
  for (const name of names) {
    try {
      const out = execFileSyncSafe(name, args);
      if (out) { toolCache[name] = true; return name; }
    } catch { /* not found */ }
  }
  for (const name of names) toolCache[name] = false;
  return null;
}

function execFileSyncSafe(cmd, args) {
  try {
    const { execFileSync } = require('child_process');
    return execFileSync(cmd, args, { timeout: 10000, windowsHide: true }).toString();
  } catch { return null; }
}

/** Detect one runtime. Returns {available, version} */
function detectRuntime(lang) {
  if (lang === 'python') {
    const tool = findTool(['python', 'python3', 'py']);
    return { available: !!tool, version: tool ? execFileSyncSafe(tool, ['--version']).trim() : null };
  }
  if (lang === 'java') {
    const javac = findTool(['javac']);
    return { available: !!javac, version: javac ? execFileSyncSafe('javac', ['-version']).trim() : null };
  }
  if (lang === 'c' || lang === 'cpp') {
    const names = lang === 'c' ? ['gcc', 'clang', 'cc'] : ['g++', 'clang++'];
    const tool = findTool(names);
    return { available: !!tool, version: tool ? execFileSyncSafe(tool, ['--version']).split('\n')[0].trim() : null };
  }
  return { available: false, version: null };
}

function runPython(tool, code, stdin, workDir) {
  return new Promise((resolve) => {
    const file = path.join(workDir, 'main.py');
    fs.writeFileSync(file, code);
    const child = spawn(tool, ['-I', file], { windowsHide: true });
    pipeStdin(child, stdin);
    collect(child, resolve);
  });
}

function runJava(code, stdin, workDir) {
  return new Promise((resolve) => {
    // Extract the public class name; require one.
    const m = code.match(/public\s+class\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (!m) return resolve({ stdout: '', stderr: 'Java submission must contain a public class with a main method.' });
    const cls = m[1];
    const file = path.join(workDir, `${cls}.java`);
    fs.writeFileSync(file, code);
    execFile('javac', ['-d', workDir, file], { timeout: TIMEOUT_MS, windowsHide: true }, (cerr, _o, cErrOut) => {
      if (cerr) {
        if (cerr.killed) return resolve({ stdout: '', stderr: `Compile time limit exceeded`, timedOut: true });
        return resolve({ stdout: '', stderr: clip(`Compile error:\n${cErrOut || cerr.message}`) });
      }
      const child = spawn('java', ['-cp', workDir, cls], { windowsHide: true });
      pipeStdin(child, stdin);
      collect(child, resolve);
    });
  });
}

function runClike(tool, code, stdin, workDir, outExe) {
  return new Promise((resolve) => {
    const srcExt = tool.startsWith('g++') || tool.startsWith('clang++') ? 'cpp' : 'c';
    const src = path.join(workDir, `main.${srcExt}`);
    fs.writeFileSync(src, code);
    const exe = path.join(workDir, outExe);
    execFile(tool, [src, '-o', exe, '-O0'], { timeout: TIMEOUT_MS, windowsHide: true }, (cerr, _o, cErrOut) => {
      if (cerr) {
        if (cerr.killed) return resolve({ stdout: '', stderr: 'Compile time limit exceeded', timedOut: true });
        return resolve({ stdout: '', stderr: clip(`Compile error:\n${cErrOut || cerr.message}`) });
      }
      const child = spawn(exe, { windowsHide: true });
      pipeStdin(child, stdin);
      collect(child, resolve);
    });
  });
}

function pipeStdin(child, stdin) {
  if (stdin) {
    child.stdin.write(stdin.endsWith('\n') ? stdin : stdin + '\n');
  }
  child.stdin.end();
}

function collect(child, resolve) {
  let stdout = '', stderr = '';
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    resolve({ stdout: clip(stdout), stderr: clip(stderr) + `\nTime limit exceeded (${TIMEOUT_MS / 1000}s)`, timedOut: true });
  }, TIMEOUT_MS);
  child.stdout.on('data', (d) => { if (stdout.length < MAX_OUTPUT * 2) stdout += d; });
  child.stderr.on('data', (d) => { if (stderr.length < MAX_OUTPUT * 2) stderr += d; });
  child.on('error', (e) => { clearTimeout(timer); resolve({ stdout: '', stderr: e.message }); });
  child.on('close', (code) => {
    clearTimeout(timer);
    resolve({ stdout: clip(stdout), stderr: clip(stderr) + (code !== 0 && !stderr ? `\n(exit code ${code})` : '') });
  });
}

function clip(s) {
  s = String(s || '');
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + '\n…output truncated…' : s;
}

/** Run code: { language, code, stdin } → { stdout, stderr, timedOut, language } */
async function runCode({ language, code, stdin }) {
  if (!code || typeof code !== 'string') return { stdout: '', stderr: 'No code provided' };
  if (code.length > MAX_CODE) return { stdout: '', stderr: 'Code too large' };
  if (typeof (stdin || '') !== 'string' || stdin.length > 10000) return { stdout: '', stderr: 'Invalid stdin' };

  const workDir = path.join(os.tmpdir(), `codesprint-run-${crypto.randomBytes(8).toString('hex')}`);
  fs.mkdirSync(workDir, { recursive: true });
  try {
    if (language === 'python') {
      const tool = findTool(['python', 'python3', 'py']);
      if (!tool) return { stdout: '', stderr: 'Python is not installed on the server.' };
      return await runPython(tool, code, stdin, workDir);
    }
    if (language === 'java') {
      if (!findTool(['javac'])) return { stdout: '', stderr: 'Java (JDK) is not installed on the server.' };
      return await runJava(code, stdin, workDir);
    }
    if (language === 'c' || language === 'cpp') {
      const tool = language === 'c' ? findTool(['gcc', 'clang', 'cc']) : findTool(['g++', 'clang++']);
      if (!tool) return { stdout: '', stderr: `A ${language.toUpperCase()} compiler (gcc) is not installed on the server.` };
      return await runClike(tool, code, stdin, workDir, 'prog.exe');
    }
    return { stdout: '', stderr: `Running ${language} is not supported.` };
  } finally {
    // Best-effort cleanup; the OS temp dir is swept periodically anyway.
    fs.rm(workDir, { recursive: true, force: true }, () => {});
  }
}

module.exports = { runCode, detectRuntime, TIMEOUT_MS };
