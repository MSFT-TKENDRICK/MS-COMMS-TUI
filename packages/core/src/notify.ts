/**
 * Notifications.
 *
 * Two channels, always both:
 *
 * 1. A NATIVE OS NOTIFICATION, because on every platform the screen reader is already
 *    wired into the OS notification pipeline — NVDA, JAWS, Narrator, VoiceOver and Orca
 *    all announce system notifications automatically. Reimplementing that with our own
 *    terminal-drawn banner would produce something no screen reader can see.
 *
 * 2. A PERSISTENT IN-APP LOG, because a toast is a transient visual event and transient
 *    visual events are exactly what an accessible tool cannot rely on. Toasts get
 *    suppressed by Focus Assist and Do Not Disturb, they get swallowed when the screen
 *    reader is mid-sentence, and a braille user cannot glance at something that vanished
 *    after five seconds. W3C's guidance on the alert pattern makes the same point: an
 *    alert that disappears on its own can fail WCAG 2.2.3. So every notification is also
 *    an entry in a durable list reachable by a single keystroke.
 *
 * Delivery is best-effort and never fatal: a missing `notify-send`, a locked-down
 * PowerShell policy or a headless CI box degrades to the in-app log and a log line.
 *
 * This spawns the platform's own mechanism rather than using `node-notifier`, which shells
 * out to a bundled SnoreToast binary and, per its own README, needs a registered
 * AppUserModelID and a Start Menu shortcut before Windows will brand a notification
 * correctly — an install step a zero-install CLI does not have. Spawning directly is fewer
 * moving parts and works the moment the CLI is on the machine.
 */

import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname as hostDirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Logger } from './provider.js';
import { NULL_LOGGER } from './logging.js';

export type NotificationUrgency = 'low' | 'normal' | 'critical';

export interface NotificationInput {
  readonly title: string;
  readonly body: string;
  /** VFS path the notification refers to, so the user can jump straight to it. */
  readonly path?: string;
  readonly urgency?: NotificationUrgency;
  /** Grouping key; a later notification with the same key supersedes an unread earlier one. */
  readonly key?: string;
  readonly source?: string;
}

export interface Notification extends NotificationInput {
  readonly id: string;
  readonly at: string;
  read: boolean;
}

export interface NotifierOptions {
  readonly logger?: Logger;
  /** Master switch for OS-level notifications. The in-app log is always kept. */
  readonly desktop?: boolean;
  /** Emit BEL on delivery. Off by default: it is disruptive when a screen reader is speaking. */
  readonly bell?: boolean;
  /** Windows AppUserModelID. See `WINDOWS_POWERSHELL_AUMID` for why the default is what it is. */
  readonly appId?: string;
  readonly appName?: string;
  /** Where the in-app log is persisted. Omit to keep it in memory only. */
  readonly storePath?: string;
  readonly maxEntries?: number;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly write?: (text: string) => void;
}

/**
 * Windows will not show a toast from an app it has no AppUserModelID for, and registering
 * one properly means writing a Start Menu shortcut with an embedded AUMID at install
 * time — which a tool you run straight out of a terminal has no install time to do.
 * Borrowing the AUMID that Windows already registers for PowerShell means notifications
 * work on a clean machine with no setup at all; the cost is that the toast is branded
 * "Windows PowerShell". Users who install properly can point `appId` at their own AUMID.
 */
export const WINDOWS_POWERSHELL_AUMID =
  '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

export class Notifier {
  readonly #logger: Logger;
  readonly #desktop: boolean;
  readonly #bell: boolean;
  readonly #appId: string;
  readonly #appName: string;
  readonly #storePath: string | undefined;
  readonly #maxEntries: number;
  readonly #platform: NodeJS.Platform;
  readonly #env: NodeJS.ProcessEnv;
  readonly #write: (text: string) => void;

  #entries: Notification[] = [];
  #loaded = false;
  #saveQueue: Promise<void> = Promise.resolve();
  readonly #listeners = new Set<(notification: Notification) => void>();

  constructor(options: NotifierOptions = {}) {
    this.#logger = options.logger ?? NULL_LOGGER;
    this.#desktop = options.desktop ?? true;
    this.#bell = options.bell ?? false;
    this.#appName = options.appName ?? 'MS-COMMS-TUI';
    this.#appId = options.appId ?? WINDOWS_POWERSHELL_AUMID;
    this.#storePath = options.storePath;
    this.#maxEntries = options.maxEntries ?? 500;
    this.#platform = options.platform ?? process.platform;
    this.#env = options.env ?? process.env;
    this.#write = options.write ?? ((text) => process.stderr.write(text));
  }

  /** Subscribe to notifications as they are raised (used by the TUI's live region). */
  onNotification(listener: (notification: Notification) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async notify(input: NotificationInput): Promise<Notification> {
    await this.#load();

    const notification: Notification = {
      ...input,
      id: randomUUID(),
      at: new Date().toISOString(),
      read: false,
    };

    // Supersede an unread notification with the same key so a chatty mailbox does not
    // bury the log under fifty "3 new messages" entries.
    if (input.key !== undefined) {
      this.#entries = this.#entries.filter((e) => !(e.key === input.key && !e.read));
    }

    this.#entries.unshift(notification);
    if (this.#entries.length > this.#maxEntries) this.#entries.length = this.#maxEntries;
    this.#persist();

    for (const listener of this.#listeners) {
      try {
        listener(notification);
      } catch {
        // A misbehaving listener must not break delivery to the others.
      }
    }

    if (this.#bell) this.#write('\u0007');
    this.#emitTerminalNotification(notification);

    if (this.#desktop) {
      // Deliberately not awaited: a slow or hung notification helper must never stall
      // the poll loop or the user's next command.
      void this.#sendDesktop(notification).catch((error: unknown) => {
        this.#logger.debug('desktop notification failed', { error: String(error) });
      });
    }

    return notification;
  }

  // -------------------------------------------------------------------------
  // The in-app log
  // -------------------------------------------------------------------------

  async list(options: { unreadOnly?: boolean; limit?: number } = {}): Promise<readonly Notification[]> {
    await this.#load();
    const filtered = options.unreadOnly === true ? this.#entries.filter((e) => !e.read) : this.#entries;
    return options.limit === undefined ? [...filtered] : filtered.slice(0, options.limit);
  }

  async unreadCount(): Promise<number> {
    await this.#load();
    return this.#entries.reduce((count, entry) => count + (entry.read ? 0 : 1), 0);
  }

  async markRead(id: string): Promise<boolean> {
    await this.#load();
    const entry = this.#entries.find((e) => e.id === id);
    if (entry === undefined) return false;
    entry.read = true;
    this.#persist();
    return true;
  }

  async markAllRead(): Promise<number> {
    await this.#load();
    let changed = 0;
    for (const entry of this.#entries) {
      if (!entry.read) {
        entry.read = true;
        changed += 1;
      }
    }
    if (changed > 0) this.#persist();
    return changed;
  }

  async clear(): Promise<void> {
    await this.#load();
    this.#entries = [];
    this.#persist();
  }

  // -------------------------------------------------------------------------
  // Delivery
  // -------------------------------------------------------------------------

  /**
   * OSC 9 asks the terminal emulator itself to raise a notification. Supported by iTerm2,
   * WezTerm and foot; ignored harmlessly elsewhere. Gated on a known-supporting terminal
   * because an emulator that does not understand the sequence may print it as garbage,
   * and garbage in the transcript is read aloud verbatim by a screen reader.
   */
  #emitTerminalNotification(notification: Notification): void {
    const program = this.#env['TERM_PROGRAM'];
    const supported = program === 'iTerm.app' || program === 'WezTerm' || this.#env['TERM'] === 'foot';
    if (!supported) return;
    const text = `${notification.title}: ${notification.body}`.replace(/[\u0000-\u001F\u007F]/g, ' ');
    this.#write(`\u001B]9;${text}\u0007`);
  }

  async #sendDesktop(notification: Notification): Promise<void> {
    switch (this.#platform) {
      case 'win32':
        return this.#sendWindows(notification);
      case 'darwin':
        return this.#sendMac(notification);
      default:
        return this.#sendLinux(notification);
    }
  }

  async #sendWindows(notification: Notification): Promise<void> {
    const xml =
      '<toast><visual><binding template="ToastGeneric">' +
      `<text>${escapeXml(notification.title)}</text>` +
      `<text>${escapeXml(notification.body)}</text>` +
      '</binding></visual></toast>';

    // The payload travels in an environment variable rather than inside the script text.
    // Message subjects are attacker-influenced strings; interpolating them into a
    // PowerShell command line is a command-injection bug waiting to happen.
    const script = `
$ErrorActionPreference = 'Stop'
[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
$doc = New-Object Windows.Data.Xml.Dom.XmlDocument
$doc.LoadXml($env:MSCOMMS_TOAST_XML)
$toast = New-Object Windows.UI.Notifications.ToastNotification $doc
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:MSCOMMS_TOAST_APPID).Show($toast)
`.trim();

    await this.#run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { MSCOMMS_TOAST_XML: xml, MSCOMMS_TOAST_APPID: this.#appId },
    );
  }

  async #sendMac(notification: Notification): Promise<void> {
    // Values arrive as `argv`, never spliced into the AppleScript source.
    const script =
      'on run argv\n' +
      'display notification (item 1 of argv) with title (item 2 of argv)\n' +
      'end run';
    await this.#run('osascript', ['-e', script, notification.body, notification.title]);
  }

  async #sendLinux(notification: Notification): Promise<void> {
    const urgency = notification.urgency === 'critical' ? 'critical' : notification.urgency === 'low' ? 'low' : 'normal';
    await this.#run('notify-send', [
      '--app-name', this.#appName,
      '--urgency', urgency,
      '--icon', 'mail-unread',
      notification.title,
      notification.body,
    ]);
  }

  /** Spawn without a shell, so no argument is ever re-parsed by a command interpreter. */
  #run(command: string, args: readonly string[], extraEnv: Record<string, string> = {}): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        if (error === undefined) resolve();
        else reject(error);
      };

      const child = spawn(command, [...args], {
        env: { ...this.#env, ...extraEnv },
        stdio: 'ignore',
        shell: false,
        windowsHide: true,
      });

      // A notification helper that hangs must not leak a process for the session's lifetime.
      const timer = setTimeout(() => {
        child.kill();
        finish(new Error(`${command} timed out`));
      }, 10_000);
      timer.unref?.();

      child.on('error', (error) => {
        clearTimeout(timer);
        finish(error);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        finish(code === 0 ? undefined : new Error(`${command} exited with code ${String(code)}`));
      });
    });
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  async #load(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    if (this.#storePath === undefined) return;
    try {
      const text = await readFile(this.#storePath, 'utf8');
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) this.#entries = parsed as Notification[];
    } catch {
      this.#entries = [];
    }
  }

  #persist(): void {
    if (this.#storePath === undefined) return;
    const path = this.#storePath;
    const snapshot = JSON.stringify(this.#entries, null, 2);
    this.#saveQueue = this.#saveQueue
      .then(async () => {
        await mkdir(hostDirname(path), { recursive: true });
        const temp = `${path}.${process.pid}.tmp`;
        await writeFile(temp, snapshot, 'utf8');
        await rename(temp, path);
      })
      .catch((error: unknown) => {
        this.#logger.debug('could not persist notifications', { error: String(error) });
      });
  }
}

export function escapeXml(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
