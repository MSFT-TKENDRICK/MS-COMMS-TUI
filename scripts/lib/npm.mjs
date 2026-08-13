/**
 * Running npm from Node, on every platform, without a shell.
 *
 * Shared by the two launcher scripts. Since Node 18.20 / 20.12, `spawn` refuses to execute
 * a `.cmd` file unless `shell: true`, and turning the shell on hands the argument list back
 * to cmd.exe's quoting rules — the exact thing the launchers exist to avoid. npm ships as
 * plain JavaScript next to the Node binary, so the first choice is to run that with the
 * interpreter we are already inside. The PATH lookup stays as a fallback for layouts that
 * put npm somewhere else (nvm, Volta, Homebrew).
 *
 * Node's standard library only — this has to work before `npm install` has ever run.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root, resolved from this file rather than from the current directory. */
export const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function resolveNpm(args) {
  const bundled = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(bundled)) return { command: process.execPath, argv: [bundled, ...args], shell: false };
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', argv: args, shell: process.platform === 'win32' };
}

/**
 * Run one npm command in the repository root. Resolves to an exit code.
 *
 * By default everything the command says goes straight to this process's streams, which is
 * what a foreground step wants. `capture` redirects both the command's output and this
 * function's own echo into a callback instead — required for anything running behind a
 * full-screen interface, where a stray line of tsc output is written over whatever the user
 * is looking at and cannot be scrolled back to.
 *
 * `signal` kills the command when the caller stops caring. A background check has no right
 * to hold the terminal after the thing it was checking for has exited.
 */
export function runNpm(args, { label = args.join(' '), echo = true, capture, signal } = {}) {
  const { command, argv, shell } = resolveNpm(args);
  const write = capture ?? ((text) => console.log(text));
  if (echo) write(`$ npm ${args.join(' ')}`);
  if (signal?.aborted === true) return Promise.resolve(1);
  return new Promise((resolve) => {
    const child = spawn(command, argv, {
      cwd: ROOT,
      stdio: capture === undefined ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      shell,
    });
    const stop = () => child.kill();
    signal?.addEventListener('abort', stop, { once: true });
    child.stdout?.on('data', (chunk) => write(String(chunk)));
    child.stderr?.on('data', (chunk) => write(String(chunk)));
    child.on('error', (error) => {
      signal?.removeEventListener('abort', stop);
      write(`could not start npm for the ${label} step: ${error.message}`);
      resolve(1);
    });
    child.on('close', (code, signalName) => {
      signal?.removeEventListener('abort', stop);
      resolve(signalName === null ? (code ?? 1) : 1);
    });
  });
}

/** Read a boolean environment switch, tolerating the usual spellings. */
export function flag(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return fallback;
}
