/**
 * Speaking back, using the synthesizer the operating system already has.
 *
 * Deliberately not a cloud voice. Three reasons, in order of how much they matter:
 *
 * 1. Privacy. Confirmations quote subject lines and sender names. Sending "Reply to Anna
 *    Kowalski about the Q3 restructuring?" to a speech service, for every action, is a
 *    steady leak of mailbox contents through a channel nobody would think to audit.
 * 2. Latency. A confirmation the user is waiting on before saying "yes" has to be immediate.
 *    A round trip to a synthesis API turns a conversation into a walkie-talkie exchange.
 * 3. It already works. Screen reader users have a configured voice, at a rate they can
 *    actually follow, that they chose. Overriding it with our own is not a feature.
 *
 * Text is always passed through the environment, never interpolated into the command line.
 * These strings contain subject lines written by strangers; a subject containing a quote and
 * a semicolon must be a strange thing to hear, not a shell command.
 */

import { spawn } from 'node:child_process';

export interface SpeakOptions {
  readonly platform?: NodeJS.Platform;
  /** Wait for the speech to finish. Off by default so the UI is never blocked by audio. */
  readonly wait?: boolean;
  readonly signal?: AbortSignal;
}

interface SpeechCommand {
  readonly program: string;
  readonly args: readonly string[];
  readonly envVar: string;
}

const ENV_VAR = 'MSCOMMS_SPEAK_TEXT';

function speechCommandFor(platform: NodeJS.Platform): SpeechCommand | undefined {
  switch (platform) {
    case 'win32':
      return {
        program: 'powershell',
        args: [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          // Read from the environment so the text is data, never script.
          `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Speak($env:${ENV_VAR})`,
        ],
        envVar: ENV_VAR,
      };
    case 'darwin':
      // `say` reads stdin with `-f -`, which keeps the text off argv.
      return { program: 'say', args: ['-f', '-'], envVar: '' };
    case 'linux':
      return { program: 'spd-say', args: ['-w', '-e'], envVar: '' };
    default:
      return undefined;
  }
}

/**
 * Speak a line.
 *
 * Never throws and never rejects. A machine with no synthesizer is a completely normal
 * machine, and failing an action because its confirmation could not be read aloud would be
 * absurd. Returns whether it managed to, so callers that care can fall back to the screen.
 */
export async function speak(text: string, options: SpeakOptions = {}): Promise<boolean> {
  const trimmed = text.trim();
  if (trimmed === '') return false;
  const platform = options.platform ?? process.platform;
  const command = speechCommandFor(platform);
  if (command === undefined) return false;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (value: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let child;
    try {
      child = spawn(command.program, [...command.args], {
        stdio: ['pipe', 'ignore', 'ignore'],
        env: command.envVar === '' ? process.env : { ...process.env, [command.envVar]: trimmed },
      });
    } catch {
      settle(false);
      return;
    }

    child.on('error', () => settle(false));
    options.signal?.addEventListener('abort', () => child.kill(), { once: true });

    if (command.envVar === '') {
      child.stdin.on('error', () => settle(false));
      // `spd-say` takes its text as an argument rather than stdin; `say -f -` takes stdin.
      if (command.program === 'spd-say') {
        child.kill();
        const direct = spawn(command.program, [...command.args, trimmed], { stdio: 'ignore' });
        direct.on('error', () => settle(false));
        direct.on('close', (code) => settle(code === 0));
        if (options.wait !== true) settle(true);
        return;
      }
      child.stdin.end(trimmed);
    } else {
      child.stdin.end();
    }

    child.on('close', (code) => settle(code === 0));
    // Fire-and-forget by default: unref so a queued confirmation cannot hold the process open.
    if (options.wait !== true) {
      child.unref();
      settle(true);
    }
  });
}

/** Whether this platform has a synthesizer we know how to drive. */
export function canSpeak(platform: NodeJS.Platform = process.platform): boolean {
  return speechCommandFor(platform) !== undefined;
}
