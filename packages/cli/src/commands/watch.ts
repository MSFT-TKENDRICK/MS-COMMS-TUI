/**
 * Watching and notifications: watch, watches, unwatch, poll, notifications.
 *
 * The research on prior art was unambiguous here: notifications are the feature people
 * install these tools for and the feature that makes them uninstall them. Two rules follow
 * from that and are enforced by the watcher rather than left to the user:
 *
 *   - The first poll after a watch is created is silent. It seeds the cursor. Otherwise
 *     watching an inbox announces every message already in it.
 *   - Bursts are coalesced into one summary. Fifteen toasts from a mailing list in one
 *     minute is how people learn to turn notifications off permanently.
 *
 * The in-app log exists because desktop notifications are unreliable by design: Focus
 * Assist, Do Not Disturb and headless SSH sessions all silently swallow them.
 */

import { parseQuery, stringifyQuery, vpath } from '@mscomms/core';
import { formatRows, relativeTime, sanitizeForDisplay } from '../format.js';
import {
  OUTPUT_FLAGS,
  flagBool,
  flagNumber,
  flagString,
  modeFrom,
  quoteCorrection,
  type Command,
} from './types.js';

export const watchCommand: Command = {
  name: 'watch',
  group: 'watch',
  summary: 'Get notified when new items appear in a folder.',
  usage: 'watch [path] [-q query] [--every seconds] [--id name] [--updates]',
  detail: [
    'The first check is silent: it records where things stand so you are told about what',
    'arrives next, not about everything already there.',
    '',
    'Only sources that support change detection can be watched, and `watch` fails straight',
    'away if the source cannot, rather than appearing to work and never firing.',
    '',
    'Watches only run while the shell is open. Add them to your config file to have them',
    'start automatically.',
  ].join('\n'),
  args: ['path'],
  maxPositional: 1,
  correction: quoteCorrection('watch'),
  flags: [
    { name: 'q', description: 'Only notify about items matching this query.', value: true, aliases: ['query'] },
    { name: 'every', description: 'Seconds between checks. Default 120.', value: true, aliases: ['interval'] },
    { name: 'id', description: 'A name for this watch, so you can remove it later.', value: true },
    { name: 'updates', description: 'Also notify about changed and deleted items.' },
    { name: 'label', description: 'Text to use in the notification.', value: true },
  ],
  examples: ['watch', 'watch /mail/Inbox -q "is:unread" --every 60', 'watch /gh/notifications --id gh'],
  async run(session, args) {
    const path = session.positionalPath(args, 0);
    const queryText = flagString(args, 'q', 'query');
    const everySeconds = flagNumber(args, 'every', 'interval');
    const id = flagString(args, 'id') ?? (path.replace(/^\//, '').replace(/\//g, '.') || 'root');

    // The help above promises that `watch` fails straight away rather than appearing to work
    // and never firing. That promise was only kept for sources that cannot poll at all — a
    // typo'd or missing path was accepted happily and then reported `state ok` forever,
    // which is the exact failure the promise is about. Checking the path costs one request
    // now and saves a silent watch that never fires.
    await session.vfs.stat(path);

    const status = await session.watcher.add({
      id,
      path,
      ...(queryText === undefined ? {} : { query: parseQuery(queryText) }),
      ...(everySeconds === undefined ? {} : { intervalMs: Math.max(15, everySeconds) * 1000 }),
      ...(flagBool(args, 'updates') ? { includeUpdates: true } : {}),
      ...(flagString(args, 'label') === undefined ? {} : { label: flagString(args, 'label') as string }),
    });

    session.print(
      `Watching ${path} every ${String(Math.round(status.intervalMs / 1000))} seconds as "${id}".` +
        (queryText === undefined ? '' : ` Only items matching ${stringifyQuery(parseQuery(queryText))}.`),
    );
    session.status('The first check is silent so you are only told about new arrivals.');
  },
};

export const watchesCommand: Command = {
  name: 'watches',
  group: 'watch',
  summary: 'List what is being watched and when each was last checked.',
  usage: 'watches',
  maxPositional: 0,
  flags: [...OUTPUT_FLAGS],
  async run(session, args) {
    const statuses = session.watcher.statuses;
    if (statuses.length === 0) {
      session.print('Nothing is being watched. Use `watch` to start.');
      return;
    }

    session.print(
      formatRows(
        ['id', 'path', 'every', 'last checked', 'seen', 'state'],
        statuses.map((status) => [
          status.id,
          status.path,
          `${String(Math.round(status.intervalMs / 1000))}s`,
          status.lastPollAt === undefined ? 'not yet' : relativeTime(status.lastPollAt),
          String(status.changesSeen),
          status.lastError === undefined
            ? 'ok'
            : `failing (${String(status.consecutiveFailures)}x): ${sanitizeForDisplay(status.lastError)}`,
        ]),
        session.withMode(modeFrom(args)),
      ),
    );
  },
};

export const unwatchCommand: Command = {
  name: 'unwatch',
  group: 'watch',
  summary: 'Stop watching something.',
  usage: 'unwatch <id or path>',
  detail:
    'Takes either the watch id or the path you originally passed to `watch`. You created it\n' +
    'by typing a path, so removing it by that same path has to work — being told to go and\n' +
    'look up a derived id is friction that nobody has a reason to accept.',
  args: ['watch'],
  maxPositional: 1,
  correction: quoteCorrection('unwatch'),
  async run(session, args) {
    const target = args.positional[0];
    if (target === undefined) throw new Error('Which watch? Run `watches` to see the ids.');
    if (target === 'all') {
      const count = session.watcher.statuses.length;
      for (const status of session.watcher.statuses) session.watcher.remove(status.id);
      session.print(`Stopped ${String(count)} watch(es).`);
      return;
    }

    if (session.watcher.remove(target)) {
      session.print(`Stopped watching "${target}".`);
      return;
    }

    // Not an id. `watch /mail/Inbox` names the watch `mail.Inbox`, so the path the user
    // typed to create it is not the string they would have to type to remove it. Accept it
    // anyway, resolving it the same way `cd` would so a relative path works too.
    const wanted = vpath.resolve(session.cwd, target);
    const byPath = session.watcher.statuses.filter((status) => status.path === wanted);

    if (byPath.length === 0) {
      throw new Error(
        `There is no watch called "${target}", and nothing is watching that path. Run \`watches\` to see them.`,
      );
    }

    for (const status of byPath) session.watcher.remove(status.id);
    const names = byPath.map((status) => `"${status.id}"`).join(', ');
    session.print(
      byPath.length === 1
        ? `Stopped watching ${names} on ${wanted}.`
        : `Stopped ${String(byPath.length)} watches on ${wanted}: ${names}.`,
    );
  },
};

export const pollCommand: Command = {
  name: 'poll',
  group: 'watch',
  summary: 'Check watches right now instead of waiting for their next check.',
  usage: 'poll [id]',
  detail:
    'With no id, every watch is checked. That is almost always what you want, and having\n' +
    'to name a watch just to say "check now" is friction for no benefit.',
  args: ['watch'],
  maxPositional: 1,
  correction: quoteCorrection('poll'),
  flags: [...OUTPUT_FLAGS],
  async run(session, args) {
    const id = args.positional[0];
    const ids = id !== undefined ? [id] : session.watcher.statuses.map((watch) => watch.id);

    if (ids.length === 0) {
      session.print('There are no watches. Use `watch /mail/Inbox` to add one.');
      return;
    }

    const changes = (await Promise.all(ids.map(async (each) => session.watcher.pollNow(each)))).flat();

    if (changes.length === 0) {
      session.print(`Nothing new${ids.length === 1 ? '' : ` across ${String(ids.length)} watches`}.`);
      return;
    }
    session.print(
      formatRows(
        ['change', 'item', 'when'],
        changes.map((change) => [
          change.type,
          sanitizeForDisplay(change.node?.title ?? change.path),
          relativeTime(change.at),
        ]),
        session.withMode(modeFrom(args)),
      ),
    );
  },
};

export const notificationsCommand: Command = {
  name: 'notifications',
  aliases: ['notes', 'inbox'],
  group: 'watch',
  summary: 'Show notifications you have received, including ones the desktop swallowed.',
  usage: 'notifications [--all] [--clear] [--read]',
  maxPositional: 0,
  detail:
    'Desktop notifications are unreliable: Focus Assist, Do Not Disturb and remote sessions\n' +
    'all suppress them silently. This log always records them, so nothing is ever lost to a\n' +
    'setting you forgot you turned on.',
  flags: [
    { name: 'all', description: 'Include notifications you have already read.', aliases: ['a'] },
    { name: 'clear', description: 'Delete every notification.' },
    { name: 'read', description: 'Mark them all as read.' },
    { name: 'n', description: 'How many to show.', value: true, aliases: ['limit'] },
    ...OUTPUT_FLAGS,
  ],
  async run(session, args) {
    if (flagBool(args, 'clear')) {
      await session.notifier.clear();
      session.print('Cleared.');
      return;
    }
    if (flagBool(args, 'read')) {
      const count = await session.notifier.markAllRead();
      session.print(`Marked ${String(count)} notification(s) as read.`);
      return;
    }

    const limit = flagNumber(args, 'n', 'limit') ?? 20;
    const all = await session.notifier.list({ unreadOnly: !flagBool(args, 'all', 'a'), limit });

    if (all.length === 0) {
      session.print(flagBool(args, 'all', 'a') ? 'No notifications yet.' : 'No unread notifications.');
      return;
    }

    const mode = modeFrom(args);
    if (mode === 'json') {
      session.print(JSON.stringify(all, null, 2));
      return;
    }

    session.print(
      formatRows(
        ['#', 'when', 'what', 'where'],
        all.map((notification, index) => [
          String(index + 1),
          relativeTime(new Date(notification.at)),
          `${notification.read ? '' : '* '}${sanitizeForDisplay(notification.title)}: ${sanitizeForDisplay(notification.body)}`,
          notification.path ?? '',
        ]),
        session.withMode(mode),
      ),
    );

    const withPaths = all.filter((notification) => notification.path !== undefined);
    if (withPaths.length > 0) {
      session.status('Use `cd <path>` to go to one of these.');
    }
  },
};

export const watchCommands: readonly Command[] = [
  watchCommand,
  watchesCommand,
  unwatchCommand,
  pollCommand,
  notificationsCommand,
];
