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

/** Run one npm command in the repository root, inheriting stdio. Resolves to an exit code. */
export function runNpm(args, { label = args.join(' '), echo = true } = {}) {
  const { command, argv, shell } = resolveNpm(args);
  if (echo) console.log(`$ npm ${args.join(' ')}`);
  return new Promise((resolve) => {
    const child = spawn(command, argv, { cwd: ROOT, stdio: 'inherit', shell });
    child.on('error', (error) => {
      console.error(`could not start npm for the ${label} step: ${error.message}`);
      resolve(1);
    });
    child.on('close', (code, signal) => {
      resolve(signal === null ? (code ?? 1) : 1);
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
