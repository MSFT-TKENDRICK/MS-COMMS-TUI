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
 *    just been edited.
 *
 * That second point used to be handled by compiling *before* handing over, and it was the
 * single worst thing about starting this program. `tsc --build` on an already-current tree
 * still costs the best part of ten seconds, every run, in front of a user looking at an
 * empty terminal — a fixed tax on launching, paid whether or not anything had changed, to
 * answer a question that is nearly always "no".
 *
 * So the order is inverted. A checkout that *can* run, runs immediately, and the rebuild
 * happens behind the interface it just started. It is not fire-and-forget: the child is
 * given an IPC channel and every check reports through it, so "checking dependencies" and
 * "rebuilding" appear in the pane's own startup list next to connecting sources and opening
 * the cache. One list, one place to look, whichever side of the process boundary the work
 * is on. The one thing this cannot do is swap the code out from under a running process, so
 * a rebuild that actually changed something says so and asks for a restart.
 *
 * A checkout that *cannot* run — no `node_modules`, no `dist/` — still installs and builds
 * in the foreground, because there is nothing to launch and pretending otherwise would just
 * be a crash with extra steps.
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
 * skips the sign-in step, MSCOMMS_RUN_BUILD=0 skips the rebuild, MSCOMMS_RUN_BUILD_WAIT=1
 * puts the rebuild back in front of the launch for anyone who would rather wait than
 * restart, and MSCOMMS_RUN_SCRIPT points at a file of commands to use instead of the
 * built-in transcript.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from './lib/build.mjs';
import { ROOT, flag } from './lib/npm.mjs';

const BIN = join(ROOT, 'packages', 'cli', 'dist', 'bin.js');
/**
 * The config loader, imported from the module that defines it rather than the package
 * barrel.
 *
 * Same rule, a tenth of the cost: `dist/index.js` pulls in the whole engine — the VFS, the
 * query parser, the snapshot store — and on Windows that is most of a second of module
 * loading, in the launcher, before the thing being launched has even started. The launcher
 * needs two functions out of it.
 */
const CONFIG = join(ROOT, 'packages', 'core', 'dist', 'config.js');
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
 * copy that eventually disagrees with the one users actually experience.
 *
 * A failure to load is reported as a failure and not as "nothing configured". Those two look
 * identical from here and mean opposite things, and collapsing them produced the worst message
 * this program has ever printed: a fully configured machine, with four mounts and every account
 * signed in, being told it had no sources and offered instructions for signing in.
 */
async function loadSources() {
  try {
    const { resolveAppPaths, loadConfig } = await import(pathToFileURL(CONFIG).href);
    const paths = resolveAppPaths();
    const config = await loadConfig(paths.configFile, { required: false });
    return { paths, mounts: config.mounts, failure: undefined };
  } catch (error) {
    return { paths: undefined, mounts: [], failure: error instanceof Error ? error.message : String(error) };
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
 * A progress reporter aimed at whatever is running, or at the terminal when nothing is.
 *
 * The launcher's checks have to be visible in both shapes this script takes. Once a child
 * exists they belong *inside* it, in the same list as its own startup — a second progress
 * display in the scrollback underneath a full-screen pane is a display nobody can see. Until
 * then, and in the piped-transcript mode where there is no pane to put them in, the terminal
 * is the only place they can go.
 *
 * `report` is deliberately tolerant: a child that has already exited, or one started without
 * an IPC channel, must not turn a status update into a crash.
 */
function reporter() {
  let child;
  const pending = [];

  const post = (task) => {
    if (child?.connected !== true) return false;
    try {
      child.send({ type: 'mscomms:task', ...task });
      return true;
    } catch {
      return false;
    }
  };

  return {
    attach(next) {
      child = next;
      for (const task of pending.splice(0)) post(task);
    },
    report(task) {
      if (post(task)) return;
      // Nothing to send to yet. Hold it for the child, and say it out loud only when it is
      // worth interrupting for: a queued check nobody is waiting on is not.
      pending.push(task);
      if (task.state === 'failed') console.error(`${task.label}: ${task.detail ?? 'failed'}`);
    },
  };
}

/**
 * Whether this checkout can run at all without help.
 *
 * The distinction that decides everything below: a missing `dist/` cannot be worked around
 * by being clever about ordering, while a *stale* one can. Only the first justifies making
 * someone wait.
 */
function needsSetup() {
  return !existsSync(MODULES) || !existsSync(BIN);
}

/**
 * Install and build, in the foreground, because there is nothing to launch yet.
 *
 * Only reached on a checkout that has never been set up or whose `dist/` has been removed.
 */
async function setUpFirst() {
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
    console.error(`MSCOMMS_RUN_BUILD is off and there is nothing built at ${BIN}.`);
    console.error('  Run `npm run setup` first, or let this build by unsetting it.');
    return 1;
  }

  console.log('Nothing is compiled yet; building before starting.');
  const code = await build({ silent: true });
  if (code !== 0) {
    console.error('Build failed, so there is nothing to start. Fix the errors above.');
    return code;
  }
  if (!existsSync(BIN)) {
    console.error(`The build succeeded but ${BIN} is still missing.`);
    return 1;
  }
  return 0;
}

/**
 * Bring `dist/` up to date behind the running program, and report on it.
 *
 * `tsc --build` is incremental, so this is nearly always a no-op — and "nearly always a
 * no-op" is exactly why it must not be waited for. The cost of being wrong is asymmetric:
 * waiting charges every launch the full check, while not waiting charges one restart to the
 * one person who just edited a source file, and only when the edit actually compiled into
 * something different.
 *
 * Detecting *that* is what the timestamp is for. `tsc` rewrites the entry point only when
 * its inputs changed, so a newer mtime is the difference between "your edit is live" and
 * "your edit is compiled, but this process is still running the code from before it".
 *
 * Nothing here may write to the terminal: the pane owns the screen. Failed builds keep their
 * output for {@link main} to print once the pane has closed and there is a scrollback to
 * print into again.
 */
async function rebuildInBackground(report, signal) {
  if (!flag('MSCOMMS_RUN_BUILD', true)) {
    report({ id: 'build', label: 'Checking for source changes', state: 'skipped', detail: 'MSCOMMS_RUN_BUILD=0' });
    return '';
  }

  report({ id: 'build', label: 'Checking for source changes', state: 'running' });
  const before = mtimeOf(BIN);
  let output = '';
  const code = await build({ silent: true, signal, capture: (text) => (output += text) });

  // Quitting cancels the compiler mid-run. That is not a broken build, and saying so to a
  // pane that is already tearing down would be both wrong and unreadable.
  if (signal.aborted) return '';

  if (code !== 0) {
    report({
      id: 'build',
      label: 'Checking for source changes',
      state: 'failed',
      detail: 'the sources no longer compile; still running the last build that did',
    });
    return output;
  }

  const changed = mtimeOf(BIN) !== before;
  report({
    id: 'build',
    label: 'Checking for source changes',
    state: changed ? 'warn' : 'ok',
    detail: changed ? 'rebuilt — restart to run the new code' : 'up to date',
  });
  return '';
}

function mtimeOf(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
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
 *
 * Every line here is checked before it is printed. Advice that does not apply is not a
 * harmless extra: being told to run `gh auth login` when you are already signed in does not
 * read as a generic hint, it reads as the program failing to see a sign-in that works, and
 * the natural next move is to break something that was fine.
 */
function explainEmpty() {
  console.error('No sources are configured, so the pane will be empty.');
  console.error('');
  console.error('  npm start -- init          write a starter config, then uncomment a source');
  console.error('  npm start -- doctor        check the config and the connections');
  console.error('');
  if (!hasGitHubAuth()) {
    console.error('GitHub needs only GH_TOKEN or `gh auth login`; Outlook and Teams sign in');
    console.error('interactively the first time you open them.');
  }
  console.error('Set MSCOMMS_RUN_DEMO=1 to browse sample data instead.');
  console.error('');
}

/**
 * Explain that the config could not be read, which is not the same as it being empty.
 *
 * Kept apart from {@link explainEmpty} because the two need opposite advice. Someone with no
 * config needs to be told how to write one; someone whose config failed to load needs to be
 * told that, and nothing else — their sources are configured, so `init` would refuse to run
 * and every word about signing in would be a distraction from the one line that matters.
 */
function explainUnreadable(failure) {
  console.error('Your config could not be read, so the pane will be empty.');
  console.error('');
  console.error(`  ${failure}`);
  console.error('');
  console.error('  npm start -- doctor        check the config and the connections');
  console.error('');
}

/**
 * Whether GitHub already has credentials, by the same two routes the provider uses.
 *
 * `gh auth token` is asked rather than `gh auth status` because the token is the thing that
 * actually gets used, and it is the check that stays true when the answer is "signed in but
 * to the wrong host". Any failure means no, which is the safe direction here: the cost of a
 * wrong no is one extra line of advice, and the cost of a wrong yes is withholding the only
 * instruction that would have helped.
 */
function hasGitHubAuth() {
  if ((process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? '') !== '') return true;
  try {
    const probe = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', shell: process.platform === 'win32' });
    return probe.status === 0 && (probe.stdout ?? '').trim() !== '';
  } catch {
    return false;
  }
}

/**
 * Compile before handing over, for the cases that cannot use a late answer.
 */
async function buildFirst() {
  if (!flag('MSCOMMS_RUN_BUILD', true)) return 0;
  const code = await build({ silent: true });
  if (code !== 0) {
    console.error('Build failed, so this would have run stale code. Fix the errors above,');
    console.error('or set MSCOMMS_RUN_BUILD=0 to run the last successful build anyway.');
  }
  return code;
}

async function main() {
  if (needsSetup()) {
    const code = await setUpFirst();
    if (code !== 0) return code;
  }

  const args = process.argv.slice(2);
  const interactive = args.length === 0 && isInteractive();
  const waitForBuild = flag('MSCOMMS_RUN_BUILD_WAIT', false);

  // A one-shot command and a scripted transcript both print and exit, so a check that
  // finishes after them is a check nobody reads — and `npm start -- doctor` right after an
  // edit has to be testing the edit. Those keep the old order. Only the interactive launch,
  // which has a place to report into and a person waiting in front of it, starts first.
  if (!interactive || waitForBuild) {
    const code = await buildFirst();
    if (code !== 0) return code;
  }

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
    const { paths, mounts, failure } = await loadSources();
    if (failure !== undefined) explainUnreadable(failure);
    else if (mounts.length === 0) explainEmpty();
    else await signInFirst(mounts, paths);
  }

  const progress = reporter();
  const quit = new AbortController();
  // Started before the child is awaited so the compiler and the interface come up together;
  // the reporter holds anything it says until there is a channel to say it on.
  const rebuild = waitForBuild ? Promise.resolve('') : rebuildInBackground(progress.report, quit.signal);

  // The fourth stream is the whole point: it carries the launcher's checks into the same
  // startup list the session keeps for its own, so there is one place to look rather than
  // two, on either side of a process boundary the user did not ask to know about.
  const code = await spawnNode([BIN, ...launch], {
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    onSpawn: (child) => progress.attach(child),
  });

  // The pane is gone, which is both permission to give up on the rebuild and the first
  // chance since it started to print anything it had to say.
  quit.abort();
  const failure = await rebuild;
  if (failure !== '') {
    console.error('The background rebuild failed while the pane was open:');
    console.error('');
    console.error(failure.trimEnd());
    console.error('');
  }
  return code;
}

process.exitCode = await main();
