/**
 * "Something is happening" for the line shell.
 *
 * The line shell is the default interface, and until now it printed absolutely nothing
 * between the moment a command was typed and the moment its output appeared. For a local
 * command that is correct — noise about work that took four milliseconds is worse than
 * silence. For a mailbox listing that takes several seconds it is indistinguishable from a
 * hang, and the honest reading of a program that has stopped responding is that it crashed.
 *
 * Three rules keep this from becoming the noise it is meant to replace:
 *
 * 1. **Nothing for the first {@link DELAY_MS}.** Most commands finish inside it and print
 *    nothing extra, so the shell stays quiet for the common case.
 * 2. **Never when the output is not a terminal.** Progress is chrome. A pipe gets data.
 * 3. **Erased before the answer.** The indicator occupies one line, rewritten in place, and
 *    is removed the instant real output arrives — so it never survives into scrollback and
 *    never interleaves with the thing the user asked for.
 *
 * In `announce` mode it is suppressed entirely: a spinner redrawn eight times a second is,
 * to a screen reader, eight announcements of nothing.
 */

/** How long a command may run before it owes the user an explanation. */
export const DELAY_MS = 400;

/** How often the indicator is redrawn once it is showing. */
export const INTERVAL_MS = 120;

/** Braille frames; see the note on the TUI spinner for why not `|/-\`. */
const FRAMES = ['\u280B', '\u2819', '\u2839', '\u2838', '\u283C', '\u2834', '\u2826', '\u2827', '\u2807', '\u280F'];

const CLEAR = '\r\u001B[K';

/**
 * The text of one frame, or `undefined` while the command is still too young to report on.
 *
 * Pure, and exported, because this is the part with the decisions in it — when to speak,
 * what to say, whether to include the elapsed count — and none of that should need a
 * terminal and a stopwatch to test.
 */
export function progressFrame(label: string, elapsedMs: number, tick: number): string | undefined {
  if (elapsedMs < DELAY_MS) return undefined;
  const frame = FRAMES[tick % FRAMES.length] ?? '';
  const seconds = Math.floor(elapsedMs / 1000);
  // The elapsed count starts at two seconds for the same reason the TUI's does: below that
  // it is a flicker, above it it is the only thing separating "slow" from "stuck".
  const suffix = seconds >= 2 ? ` ${String(seconds)}s` : '';
  return `${frame} ${label}…${suffix}`;
}

export interface ProgressOptions {
  /** Where the indicator is drawn. stderr, so a redirected stdout stays clean. */
  readonly write: (text: string) => void;
  /** Suppressed entirely when false. Not a terminal, or announce mode. */
  readonly enabled: boolean;
  readonly now?: () => number;
  readonly intervalMs?: number;
}

/**
 * A single-line, self-erasing progress indicator.
 *
 * Deliberately not reference-counted or nestable. One shell runs one command at a time, and
 * a progress widget that can be started twice is a progress widget that can be left behind
 * once.
 */
export class Progress {
  readonly #write: (text: string) => void;
  readonly #enabled: boolean;
  readonly #now: () => number;
  readonly #intervalMs: number;

  #timer: NodeJS.Timeout | undefined;
  #startedAt = 0;
  #tick = 0;
  /** Whether anything is currently on screen that needs erasing. */
  #visible = false;

  constructor(options: ProgressOptions) {
    this.#write = options.write;
    this.#enabled = options.enabled;
    this.#now = options.now ?? Date.now;
    this.#intervalMs = options.intervalMs ?? INTERVAL_MS;
  }

  /** True once something has actually been drawn. For tests, and for {@link clear}. */
  get visible(): boolean {
    return this.#visible;
  }

  start(label: string): void {
    if (!this.#enabled) return;
    this.stop();
    this.#startedAt = this.#now();
    this.#tick = 0;
    this.#timer = setInterval(() => {
      this.#draw(label);
    }, this.#intervalMs);
    // A spinner is never a reason for a process to stay alive.
    this.#timer.unref?.();
  }

  /**
   * Take the indicator off the screen but keep running.
   *
   * Called immediately before the command's own output, so the answer is never printed
   * underneath a spinner that is about to be overwritten anyway.
   */
  clear(): void {
    if (!this.#visible) return;
    this.#visible = false;
    this.#write(CLEAR);
  }

  /** Erase and stop. Safe to call when never started, and safe to call twice. */
  stop(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    this.clear();
  }

  #draw(label: string): void {
    const text = progressFrame(label, this.#now() - this.#startedAt, this.#tick);
    this.#tick += 1;
    if (text === undefined) return;
    this.#visible = true;
    this.#write(`${CLEAR}${text}`);
  }
}

/**
 * What to call the running command.
 *
 * The verb the user typed, rather than a generic "working": when the wait is long enough to
 * need an explanation, *which* thing is slow is most of the information.
 */
export function progressLabel(line: string): string {
  const word = line.trim().split(/\s+/u)[0] ?? '';
  return word === '' ? 'working' : word;
}
