/**
 * Start the shell — the GitHub Copilot desktop app's Run script entry point.
 *
 * The app runs a project's `run` script through the platform shell (`cmd.exe /C` on
 * Windows, `sh -c` elsewhere) and pipes its stdout into the log pane. Two consequences
 * shape this file:
 *
 * 1. **Nobody can type into it.** `mscomms` with no arguments starts an interactive shell,
 *    which under the log pane would sit at a prompt forever with no way to answer. The
 *    app's stdin still claims to be a tty, so checking stdin alone reports a typist who
 *    does not exist; stdout being a pipe is the honest signal. There, this drives the same
 *    shell from a canned script instead, so the log shows a real transcript proving the
 *    whole chain — install, build, VFS, query engine, formatter — actually works.
 * 2. **The build may be missing or stale.** The Run button can be pressed on a workspace
 *    whose Setup script never ran, and it is pressed constantly on one whose sources have
 *    just been edited. Rather than failing with a stack trace about a missing module, or
 *    quietly running last week's code, this brings `dist/` up to date first.
 *
 * In a real terminal (the app's terminal canvas, an IDE terminal, any shell) you get the
 * ordinary interactive shell, and arguments are passed straight through:
 *
 *   node scripts/app-run.mjs                          the shell
 *   node scripts/app-run.mjs --tui                    the opt-in full-screen pane
 *   node scripts/app-run.mjs ls /mail/Inbox           one shot, then exit
 *
 * Overrides: MSCOMMS_RUN_INTERACTIVE=0/1 forces the choice above, MSCOMMS_RUN_BUILD=0 skips
 * the rebuild, and MSCOMMS_RUN_SCRIPT points at a file of commands to use instead of the
 * built-in transcript.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from './lib/build.mjs';
import { ROOT, flag } from './lib/npm.mjs';

const BIN = join(ROOT, 'packages', 'cli', 'dist', 'bin.js');
const SETUP = join(ROOT, 'scripts', 'app-setup.mjs');
const MODULES = join(ROOT, 'node_modules');

/**
 * What to run when there is no terminal to type into.
 *
 * Deliberately stateful — `cat 3` only means anything after the `ls` above it — so this
 * runs as one piped session rather than a series of one-shot invocations. That also
 * exercises the numbering, which is the part of the interface most likely to break
 * unnoticed, and the demo mounts, which need no credentials and no network.
 */
const TRANSCRIPT = ['demo', 'ls /demo-mail/Inbox', 'cat 3', 'find /demo-mail -q "is:unread"', 'quit'];

/**
 * Decide whether an interactive prompt would ever be answered.
 *
 * Both directions have to be a terminal: under the app's script runner stdin answers
 * `isTTY` even though nothing is ever typed into it, and stdout being a pipe is the
 * difference that actually matters.
 */
function isInteractive() {
  return flag('MSCOMMS_RUN_INTERACTIVE', process.stdin.isTTY === true && process.stdout.isTTY === true);
}

function transcript() {
  const path = process.env.MSCOMMS_RUN_SCRIPT?.trim();
  if (path === undefined || path === '') return TRANSCRIPT;
  try {
    return readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'));
  } catch (error) {
    console.error(`could not read MSCOMMS_RUN_SCRIPT=${path}: ${error.message}`);
    console.error('  falling back to the built-in transcript');
    return TRANSCRIPT;
  }
}

function spawnNode(argv, { stdio, onSpawn }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, { cwd: ROOT, stdio });
    child.on('error', (error) => {
      console.error(`could not start node: ${error.message}`);
      resolve(1);
    });
    child.on('close', (code, signal) => {
      resolve(signal === null ? (code ?? 1) : 1);
    });
    if (onSpawn !== undefined) onSpawn(child);
  });
}

/**
 * Make `dist/` match the sources, installing first if this checkout has never been set up.
 *
 * `tsc --build` is incremental, so the steady-state cost is a no-op compile — worth paying
 * to guarantee that pressing Run after an edit runs the edit.
 */
async function ensureBuilt() {
  if (!existsSync(MODULES)) {
    console.log('This checkout has not been set up yet; running the setup script first.');
    const code = await spawnNode([SETUP], { stdio: 'inherit' });
    if (code !== 0) return code;
    if (!existsSync(BIN)) {
      console.error(`Setup finished but ${BIN} is still missing.`);
      return 1;
    }
    return 0;
  }

  if (!flag('MSCOMMS_RUN_BUILD', true)) {
    if (existsSync(BIN)) return 0;
    console.error(`MSCOMMS_RUN_BUILD is off and there is nothing built at ${BIN}.`);
    console.error('  Run `npm run setup` first, or let this build by unsetting it.');
    return 1;
  }

  const code = await build({ silent: true });
  if (code !== 0) {
    console.error('Build failed, so this would have run stale code. Fix the errors above,');
    console.error('or set MSCOMMS_RUN_BUILD=0 to run the last successful build anyway.');
  }
  return code;
}

async function runTranscript(lines) {
  console.log('No interactive terminal here, so running a scripted session instead.');
  console.log('Open a terminal and run `npm start` for the real thing.');
  console.log('');
  for (const line of lines) console.log(`  /> ${line}`);
  console.log('');

  // stdin is the only stream that has to be a pipe; letting the child own stdout and
  // stderr keeps its output byte-for-byte and its ordering intact.
  return spawnNode([BIN], {
    stdio: ['pipe', 'inherit', 'inherit'],
    onSpawn: (child) => {
      // The shell can exit first — `quit`, or a failure — and a broken pipe here is not
      // news: the child's own exit code is what gets reported.
      child.stdin?.on('error', () => {});
      child.stdin?.end(`${lines.join('\n')}\n`);
    },
  });
}

async function main() {
  const built = await ensureBuilt();
  if (built !== 0) return built;

  const args = process.argv.slice(2);
  // An explicit command is scriptable by definition: run it as given, whatever the streams
  // look like. Only the argument-free case has to guess.
  if (args.length > 0 || isInteractive()) return spawnNode([BIN, ...args], { stdio: 'inherit' });
  return runTranscript(transcript());
}

process.exitCode = await main();
