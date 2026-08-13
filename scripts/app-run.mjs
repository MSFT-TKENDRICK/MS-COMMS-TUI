/**
 * Start MS-COMMS-TUI — the GitHub Copilot desktop app's Run script entry point.
 *
 * The app starts a project's `run` script through the platform shell (`cmd.exe /C` on
 * Windows, `sh -c` elsewhere), on one of two surfaces: a **terminal panel**, which is a real
 * pty you can type into, or a **log pane**, which is a one-way pipe. The script has to be
 * right on both, which is what shapes this file:
 *
 * 1. **The log pane has no typist.** `mscomms` with no arguments starts an interactive
 *    interface, which there would sit at a prompt forever with no way to answer. Its stdin
 *    still claims to be a tty, so checking stdin alone reports a typist who does not exist;
 *    stdout being a pipe is the honest signal. There, this drives the line shell from a
 *    canned script instead, so the log shows a real transcript proving the whole chain —
 *    install, build, VFS, query engine, formatter — actually works.
 * 2. **The build may be missing or stale.** The Run button can be pressed on a workspace
 *    whose Setup script never ran, and it is pressed constantly on one whose sources have
 *    just been edited. Rather than failing with a stack trace about a missing module, or
 *    quietly running last week's code, this brings `dist/` up to date first.
 *
 * In a real terminal — the app's Run panel is a genuine pty, as is any IDE or OS terminal —
 * this opens the **full-screen two-pane view**. That is the opposite of what the `mscomms`
 * binary does on its own, and the difference is deliberate rather than an oversight.
 *
 * `mscomms` defaults to the line shell because a full-screen pane is hostile to screen
 * readers (see the essay at the top of `packages/cli/src/shell.ts`), and a command someone
 * types must not ambush them with an alternate screen buffer. None of that reasoning
 * applies to a green play button in a windowed GUI: clicking it is already a sighted,
 * pointer-driven act, it says "show me the thing", and the project is called MS-COMMS-TUI.
 * So the flag the shell docs describe as "one flag away" is the one this passes. Anyone who
 * wants the line shell from the Run button gets it with MSCOMMS_RUN_TUI=0, and the binary's
 * own default is untouched — `npm start` and `mscomms` still land on the line shell.
 *
 * A pane needs something in it, but the answer to an unconfigured machine is to say so, not
 * to fill the tree with fixtures: sample data that appears without being asked for is
 * indistinguishable from real data that is wrong, and a Run button that silently shows
 * make-believe teaches you to distrust it. So this never adds `--demo` on its own. When
 * nothing is mounted it prints how to connect a real account and opens the pane anyway,
 * empty and honest. `MSCOMMS_RUN_DEMO=1` asks for the fixtures deliberately.
 *
 * Arguments are passed straight through and suppress all of the above:
 *
 *   node scripts/app-run.mjs                          the full-screen view
 *   node scripts/app-run.mjs --shell                  the line shell instead
 *   node scripts/app-run.mjs ls /mail/Inbox           one shot, then exit
 *
 * 3. **A sign-in cannot happen behind the pane.** The Microsoft device-code prompt is written
 *    to stderr, which is right for a command line and useless underneath an alternate screen
 *    buffer: the code and the URL land somewhere invisible and opening /mail looks like a
 *    hang. So on a machine that has never signed in *and* has no already-authenticated
 *    Microsoft 365 MCP server to go through, that happens here first, on an ordinary screen,
 *    before the pane is entered. With an MCP server there is nothing to do and nothing is
 *    said.
 *
 * Overrides: MSCOMMS_RUN_INTERACTIVE=0/1 forces the terminal check, MSCOMMS_RUN_TUI=0 falls
 * back to the line shell, MSCOMMS_RUN_DEMO=1 mounts the sample data, MSCOMMS_RUN_SIGNIN=0
 * skips the sign-in step, MSCOMMS_RUN_BUILD=0 skips the rebuild, and MSCOMMS_RUN_SCRIPT
 * points at a file of commands to use instead of the built-in transcript.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from './lib/build.mjs';
import { ROOT, flag } from './lib/npm.mjs';

const BIN = join(ROOT, 'packages', 'cli', 'dist', 'bin.js');
const CORE = join(ROOT, 'packages', 'core', 'dist', 'index.js');
const GRAPH = join(ROOT, 'packages', 'provider-graph', 'dist', 'index.js');
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

/**
 * Whether this machine already has real sources, so the sample data would be clutter.
 *
 * Asks the program's own config loader rather than reimplementing the search: the path is
 * platform-specific and the file is JSONC, and a second copy of either rule here would be a
 * copy that eventually disagrees with the one users actually experience. Any failure counts
 * as "nothing configured", which is the safe direction — the worst case is a hint printed
 * for someone who did not need it.
 */
async function loadSources() {
  try {
    const { resolveAppPaths, loadConfig } = await import(pathToFileURL(CORE).href);
    const paths = resolveAppPaths();
    const config = await loadConfig(paths.configFile, { required: false });
    return { paths, mounts: config.mounts };
  } catch {
    return { paths: undefined, mounts: [] };
  }
}

/** Sources that sign in interactively the first time something asks them for data. */
const INTERACTIVE_SOURCE = /^(graph-|ado-)/;

/**
 * Whether a mount will actually put a prompt on the screen.
 *
 * The Graph sources have two ways in, and only one of them prompts: when an already
 * signed-in Microsoft 365 MCP server is available they use it and no credential is ever
 * asked for. That distinction has to be made here, because the alternative is worse than a
 * wasted round trip — a machine on the MCP path never writes a token cache, so the "has this
 * machine signed in before?" check below is false *forever*, and every single run would
 * announce a sign-in that is not going to happen.
 *
 * Asks the provider's own resolver rather than re-deriving the rule; a second copy of the
 * discovery order here is a copy that eventually disagrees. Any failure counts as "yes, it
 * might prompt", which keeps the pre-step's original purpose intact.
 */
async function willPrompt(mount) {
  if (!mount.type.startsWith('graph-')) return true;
  try {
    const { resolveTransport } = await import(pathToFileURL(GRAPH).href);
    return resolveTransport(mount.options ?? {}) !== 'mcp';
  } catch {
    return true;
  }
}

/**
 * Whether a Microsoft sign-in has already been completed and cached.
 *
 * Looks for the cache rather than the config because the question is about this machine's
 * history, not its intentions. Scanning for the key beats reconstructing which mount id
 * happened to authenticate first: the file is named after whichever mount got there, and
 * that is an ordering detail no caller should have to predict.
 */
function hasCachedSignIn(stateDir) {
  try {
    return readdirSync(stateDir)
      .filter((name) => name.endsWith('.json'))
      .some((name) => readFileSync(join(stateDir, name), 'utf8').includes('"graph:tokens"'));
  } catch {
    return false;
  }
}

/**
 * Get the Microsoft sign-in over with before the full-screen view opens.
 *
 * The device-code prompt is written to stderr, which is right for a command line and fatal
 * behind an alternate screen buffer: the pane is already drawn over the whole terminal, so
 * the code and the URL land somewhere invisible and the first attempt to open /mail looks
 * like a hang with no way to discover what it wants. Doing it here means it happens once, on
 * an ordinary screen, where the code can be read and typed.
 *
 * Only for a machine that has never signed in — after that the refresh token answers and
 * this would be a network round trip for nothing. And only for a mount that will actually
 * prompt: a Graph mount going through an already signed-in MCP server needs nothing, and
 * announcing a sign-in that never comes is worse than saying nothing at all.
 */
async function signInFirst(mounts, paths) {
  if (!flag('MSCOMMS_RUN_SIGNIN', true)) return;
  if (paths === undefined || hasCachedSignIn(paths.stateDir)) return;

  let mount;
  for (const candidate of mounts.filter((entry) => INTERACTIVE_SOURCE.test(entry.type))) {
    if (await willPrompt(candidate)) {
      mount = candidate;
      break;
    }
  }
  if (mount === undefined) return;

  console.error(`Signing in before opening the pane, so the code below is visible.`);
  // Listing is the cheapest thing that needs a token. Its output scrolls away when the pane
  // opens; the sign-in it performs is the part that lasts.
  await spawnNode([BIN, 'ls', mount.path, '--plain'], { stdio: 'inherit' });
  console.error('');
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
  console.log('Open this workspace in a terminal panel for the full-screen view.');
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

/**
 * Tell someone with no sources how to get some.
 *
 * Written to stderr, which the full-screen view leaves alone: the alternate screen buffer
 * would swallow anything on stdout the moment the pane opens, so a hint printed there would
 * exist for a few milliseconds and then be gone. On stderr it stays in the scrollback and is
 * still there after quitting, which is when someone actually goes looking for it.
 */
function explainEmpty() {
  console.error('No sources are configured, so the pane will be empty.');
  console.error('');
  console.error('  npm start -- init          write a starter config, then uncomment a source');
  console.error('  npm start -- doctor        check the config and the connections');
  console.error('');
  console.error('GitHub needs only GH_TOKEN or `gh auth login`; Outlook and Teams sign in');
  console.error('interactively the first time you open them.');
  console.error('Set MSCOMMS_RUN_DEMO=1 to browse sample data instead.');
  console.error('');
}

async function main() {
  const built = await ensureBuilt();
  if (built !== 0) return built;

  const args = process.argv.slice(2);
  // An explicit command is scriptable by definition: run it as given, whatever the streams
  // look like, and with none of the choices below imposed on top of it.
  if (args.length > 0) return spawnNode([BIN, ...args], { stdio: 'inherit' });
  if (!isInteractive()) return runTranscript(transcript());

  const launch = [];
  if (flag('MSCOMMS_RUN_TUI', true)) launch.push('--tui');

  // Fixtures only on request. The config is still worth loading when they were not, because
  // both remaining questions need it: whether an empty pane deserves an explanation, and
  // whether a sign-in has to happen while its prompt can still be seen.
  if (flag('MSCOMMS_RUN_DEMO', false)) {
    launch.push('--demo');
  } else {
    const { paths, mounts } = await loadSources();
    if (mounts.length === 0) explainEmpty();
    else await signInFirst(mounts, paths);
  }

  return spawnNode([BIN, ...launch], { stdio: 'inherit' });
}

process.exitCode = await main();
