/**
 * Borrow the GitHub CLI's credential.
 *
 * The generated config tells people that a GitHub mount "reads GH_TOKEN or GITHUB_TOKEN
 * from the environment, or run `gh auth login`" — and until this existed only the first
 * half was true. Someone who did what the file said, signed in with `gh`, and pressed Run
 * got "Listing notifications needs a token" with nothing to suggest which of the two
 * documented options had failed them.
 *
 * `gh` keeps its token in the OS keychain rather than the environment, so there is no file
 * to read and no variable to inherit; asking the tool is the only way to get it. That makes
 * this a subprocess, which is worth being careful about:
 *
 * - **It is a last resort.** An explicit `token` in the config and both environment
 *   variables win, so this only runs for a mount that would otherwise be anonymous.
 * - **It cannot hang a session.** Providers initialise before the first frame is drawn, so
 *   a wedged subprocess here is a program that never starts. Hence the timeout and the
 *   killed-child handling rather than an open-ended await.
 * - **It cannot be redirected.** The argument vector is fixed and `shell` is false, so
 *   nothing from a config file is ever handed to a command interpreter.
 * - **It fails soft.** No `gh`, not signed in, or an error of any kind is indistinguishable
 *   from "no token available", which the caller already knows how to survive.
 */

import { execFile } from 'node:child_process';

/** Windows resolves a bare name through PATH but appends `.exe`, so a shim named `gh.cmd` needs saying. */
const CANDIDATES = process.platform === 'win32' ? ['gh.exe', 'gh.cmd'] : ['gh'];

export interface GhTokenOptions {
  readonly timeoutMs?: number;
  /** Injected by the tests so they never depend on whether the machine running them has `gh`. */
  readonly run?: (command: string, args: readonly string[], timeoutMs: number) => Promise<string | undefined>;
}

function runOnce(command: string, args: readonly string[], timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { timeout: timeoutMs, windowsHide: true, shell: false, encoding: 'utf8' },
      (error, stdout) => {
        // A non-zero exit is the normal way of saying "not signed in", not an exception.
        resolve(error === null ? stdout : undefined);
      },
    );
  });
}

/**
 * The token `gh` is currently using, or undefined if there is not one to be had.
 *
 * Never throws: every failure mode means the same thing to the caller.
 */
export async function ghToken(options: GhTokenOptions = {}): Promise<string | undefined> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const run = options.run ?? runOnce;

  for (const command of CANDIDATES) {
    let output: string | undefined;
    try {
      output = await run(command, ['auth', 'token'], timeoutMs);
    } catch {
      // A rejecting runner is still just an absent token.
      output = undefined;
    }
    if (output === undefined) continue;

    // `gh` prints the token and a newline. Anything with whitespace inside it is not a
    // token — it is a help message or an error someone routed to stdout — and sending it
    // as a bearer credential would put arbitrary text in a header.
    const token = output.trim();
    if (token.length > 0 && !/\s/.test(token)) return token;
  }

  return undefined;
}
