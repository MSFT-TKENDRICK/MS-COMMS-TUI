/**
 * Navigation: ls, more, cd, pwd, tree, mounts, back.
 */

import { isMatchAll, parseQuery, vpath, type SortSpec, type VNode } from '@mscomms/core';
import { formatListing, formatRows, sanitizeForDisplay } from '../format.js';
import type { Session } from '../session.js';
import {
  OUTPUT_FLAGS,
  flagBool,
  flagNumber,
  flagString,
  modeFrom,
  type Command,
  type CommandArgs,
} from './types.js';

function sortFrom(args: CommandArgs): SortSpec | undefined {
  const raw = flagString(args, 'sort', 's');
  if (raw === undefined) return undefined;
  const [field, direction] = raw.split(':');
  const allowed = ['name', 'date', 'author', 'size'];
  if (field === undefined || !allowed.includes(field)) {
    throw new Error(`Cannot sort by "${String(field)}". Try one of: ${allowed.join(', ')}.`);
  }
  return {
    field: field as SortSpec['field'],
    direction: direction === 'asc' ? 'asc' : direction === 'desc' ? 'desc' : field === 'name' ? 'asc' : 'desc',
  };
}

export const lsCommand: Command = {
  name: 'ls',
  aliases: ['list', 'dir'],
  group: 'navigate',
  summary: 'List what is in a folder, numbered so you can act on items by number.',
  usage: 'ls [path] [-l] [-n count] [-q query] [--sort field:direction] [--all] [--refresh]',
  detail: [
    'Every entry is numbered. Those numbers are the fastest way to act on something:',
    'after `ls`, `cat 3` reads the third item and `cd 1` enters the first.',
    '',
    'Numbers refer to the most recent listing and stay valid until you list something',
    'else or change folder. If an item is genuinely named "3", typing `3` picks the item',
    'by name; type `#3` when you mean the number.',
    '',
    'Listings are paged rather than exhaustive. A real mailbox has hundreds of thousands',
    'of messages and enumerating all of them would hang the terminal for minutes, so `ls`',
    'shows a page and `more` continues it.',
  ].join('\n'),
  args: ['path'],
  flags: [
    { name: 'l', description: 'Show extra columns: item counts, flags and sizes.' },
    { name: 'n', description: 'How many entries to show.', value: true, aliases: ['limit'] },
    { name: 'q', description: 'Only show entries matching this query.', value: true, aliases: ['query'] },
    { name: 'sort', description: 'Sort by name, date, author or size.', value: true, aliases: ['s'] },
    { name: 'all', description: 'Keep fetching pages until the folder is exhausted (up to 2000).' },
    { name: 'refresh', description: 'Ignore the cache and re-fetch from the backend.' },
    ...OUTPUT_FLAGS,
  ],
  examples: ['ls', 'ls Inbox -l', 'ls -q "is:unread"', 'ls /mail/Inbox --sort date:desc'],
  async run(session, args) {
    const path = session.positionalPath(args, 0);
    const limit = flagNumber(args, 'n', 'limit') ?? session.pageSize;
    const queryText = flagString(args, 'q', 'query');
    const query = queryText === undefined ? undefined : parseQuery(queryText);
    const sort = sortFrom(args);
    const mode = modeFrom(args);
    const long = flagBool(args, 'l');

    let nodes: VNode[] = [];
    let cursor: string | undefined;
    let total: number | undefined;
    let undecided = 0;
    let stale = false;
    let staleAgeMs: number | undefined;

    const maxAll = 2000;
    let remaining = flagBool(args, 'all') ? maxAll : limit;

    do {
      const result = await session.vfs.list(path, {
        limit: Math.min(remaining, 200),
        ...(cursor === undefined ? {} : { cursor }),
        ...(query === undefined ? {} : { query }),
        ...(sort === undefined ? {} : { sort }),
        ...(flagBool(args, 'refresh') && cursor === undefined ? { refresh: true } : {}),
      });
      nodes.push(...result.entries);
      cursor = result.cursor;
      total = result.total ?? total;
      undecided += result.undecided;
      stale = stale || result.stale;
      staleAgeMs = result.staleAgeMs ?? staleAgeMs;
      remaining -= result.entries.length;
      // A page that returns nothing but still hands back a cursor would spin forever.
      if (result.entries.length === 0) break;
    } while (flagBool(args, 'all') && cursor !== undefined && remaining > 0);

    if (sort !== undefined && nodes.length > 0) {
      const { sortNodes } = await import('@mscomms/core');
      nodes = sortNodes(nodes, sort);
    }

    if (stale) {
      session.status(
        `Warning: showing cached results${staleAgeMs === undefined ? '' : ` from ${Math.round(staleAgeMs / 1000)} seconds ago`} because the backend could not be reached.`,
      );
    }

    session.print(formatListing(nodes, { ...session.withMode(mode), startIndex: 1, long }));

    session.setListing({
      path,
      nodes,
      startIndex: 1,
      source: 'ls',
      long,
      ...(cursor === undefined ? {} : { cursor }),
      ...(queryText === undefined ? {} : { query: queryText }),
    });

    if (mode === 'json' || mode === 'tsv') return;
    session.status(summaryLine(nodes.length, total, cursor !== undefined, undecided, query !== undefined));
  },
};

function summaryLine(
  shown: number,
  total: number | undefined,
  hasMore: boolean,
  undecided: number,
  filtered: boolean,
): string {
  const parts: string[] = [`${String(shown)} ${shown === 1 ? 'item' : 'items'}`];
  if (total !== undefined && total > shown) parts.push(`of about ${String(total)}`);
  if (filtered) parts.push('matching your query');
  let line = parts.join(' ');
  if (hasMore) line += '. Type `more` for the next page';
  // Honesty about what could not be decided without fetching bodies. Silently dropping
  // these would make `-q body:x` quietly lose messages.
  if (undecided > 0) {
    line += `. ${String(undecided)} ${undecided === 1 ? 'item was' : 'items were'} skipped because deciding would need to download the full text; use \`grep\` to search bodies`;
  }
  return `${line}.`;
}

export const moreCommand: Command = {
  name: 'more',
  aliases: ['next'],
  group: 'navigate',
  summary: 'Show the next page of the last listing, continuing the numbering.',
  usage: 'more [-n count]',
  detail:
    'Numbering continues rather than restarting, so item 26 stays item 26 for as long as\n' +
    'the listing is on screen. Restarting at 1 on every page would silently change what a\n' +
    'number means, which is the fastest way to make someone open the wrong message.',
  flags: [
    { name: 'n', description: 'How many more entries to show.', value: true, aliases: ['limit'] },
    ...OUTPUT_FLAGS,
  ],
  async run(session, args) {
    const listing = session.lastListing;
    if (listing === undefined) throw new Error('There is nothing to continue. Run `ls` first.');
    if (listing.cursor === undefined) {
      session.print('That was the whole listing; there is no more.');
      return;
    }

    const limit = flagNumber(args, 'n', 'limit') ?? session.pageSize;
    const mode = modeFrom(args);
    const query = listing.query === undefined ? undefined : parseQuery(listing.query);

    const result = await session.vfs.list(listing.path, {
      cursor: listing.cursor,
      limit,
      ...(query === undefined || isMatchAll(query) ? {} : { query }),
    });

    const startIndex = listing.startIndex + listing.nodes.length;
    session.print(
      formatListing(result.entries, {
        ...session.withMode(mode),
        startIndex,
        ...(listing.long === undefined ? {} : { long: listing.long }),
      }),
    );

    session.setListing({
      path: listing.path,
      nodes: [...listing.nodes, ...result.entries],
      startIndex: listing.startIndex,
      source: listing.source,
      ...(listing.long === undefined ? {} : { long: listing.long }),
      ...(listing.query === undefined ? {} : { query: listing.query }),
      ...(result.cursor === undefined ? {} : { cursor: result.cursor }),
    });

    if (mode === 'json' || mode === 'tsv') return;
    const shownTo = startIndex + result.entries.length - 1;
    session.status(
      result.cursor === undefined
        ? `Items ${String(startIndex)} to ${String(shownTo)}. That is the end of the listing.`
        : `Items ${String(startIndex)} to ${String(shownTo)}. Type \`more\` again for the next page.`,
    );
  },
};

export const cdCommand: Command = {
  name: 'cd',
  aliases: ['open'],
  group: 'navigate',
  summary: 'Change to a different folder, by path or by number from the last listing.',
  usage: 'cd [path|number]',
  detail:
    'With no argument, goes to the root. `cd ..` goes up, `cd -` goes back to where you\n' +
    'were, and `cd 2` enters the second item of the last listing.',
  args: ['path'],
  examples: ['cd Inbox', 'cd ..', 'cd -', 'cd 3'],
  async run(session, args) {
    const token = args.positional[0];
    const path = token === undefined ? vpath.ROOT : session.resolveToken(token);

    const node = await session.vfs.stat(path);
    if (node.kind !== 'dir') {
      throw new Error(`"${sanitizeForDisplay(node.name)}" is not a folder. Use \`cat\` to read it.`);
    }

    session.setCwd(path);
    session.print(path);
  },
};

export const pwdCommand: Command = {
  name: 'pwd',
  group: 'navigate',
  summary: 'Print the folder you are currently in.',
  usage: 'pwd',
  async run(session) {
    session.print(session.cwd);
  },
};

export const backCommand: Command = {
  name: 'back',
  group: 'navigate',
  summary: 'Return to the folder you were in before the last `cd`.',
  usage: 'back',
  async run(session) {
    const previous = session.history.pop();
    if (previous === undefined) throw new Error('There is nowhere to go back to.');
    session.cwd = previous;
    session.lastListing = undefined;
    session.print(previous);
  },
};

export const treeCommand: Command = {
  name: 'tree',
  group: 'navigate',
  summary: 'Show the folder structure below here, without listing individual items.',
  usage: 'tree [path] [--depth n] [--files]',
  detail:
    'Folders only by default. A tree that includes every message is not a tree, it is a\n' +
    'listing with extra punctuation, and indentation is announced character by character\n' +
    'by a screen reader. Use `--files` if you really want them.',
  args: ['path'],
  flags: [
    { name: 'depth', description: 'How many levels deep to go. Default 3.', value: true, aliases: ['d'] },
    { name: 'files', description: 'Include files, not just folders.' },
    ...OUTPUT_FLAGS,
  ],
  async run(session, args) {
    const root = session.positionalPath(args, 0);
    const maxDepth = flagNumber(args, 'depth', 'd') ?? 3;
    const includeFiles = flagBool(args, 'files');
    const mode = modeFrom(args) ?? session.format.mode;

    const lines: string[] = [];
    const collected: VNode[] = [];
    let budget = 500;

    const walk = async (path: string, depth: number, prefix: string): Promise<void> => {
      if (depth > maxDepth || budget <= 0) return;
      let entries: readonly VNode[];
      try {
        const result = await session.vfs.list(path, { limit: 100 });
        entries = result.entries;
      } catch (error) {
        lines.push(`${prefix}(could not read: ${error instanceof Error ? error.message : String(error)})`);
        return;
      }

      const visible = includeFiles ? entries : entries.filter((entry) => entry.kind === 'dir');
      for (const entry of visible) {
        if (budget <= 0) {
          lines.push(`${prefix}… (stopped after 500 entries)`);
          return;
        }
        budget -= 1;
        collected.push(entry);
        const label = `${sanitizeForDisplay(entry.name)}${entry.kind === 'dir' ? '/' : ''}`;
        const count =
          entry.unreadCount !== undefined && entry.unreadCount > 0
            ? ` (${String(entry.unreadCount)} unread)`
            : '';
        // The path is printed in full in announce and plain modes, because indentation
        // conveys nothing at all through speech.
        lines.push(
          mode === 'announce' || mode === 'plain'
            ? `${String(collected.length)}. ${entry.path ?? vpath.join(path, entry.name)}${count}`
            : `${String(collected.length).padStart(3)}. ${prefix}${label}${count}`,
        );
        if (entry.kind === 'dir') await walk(entry.path ?? vpath.join(path, entry.name), depth + 1, `${prefix}  `);
      }
    };

    await walk(root, 1, '');

    if (mode === 'json') {
      session.print(JSON.stringify(collected, null, 2));
      return;
    }
    session.print(lines.length === 0 ? '(no subfolders)' : lines.join('\n'));
    session.setListing({ path: root, nodes: collected, startIndex: 1, source: 'other' });
  },
};

export const mountsCommand: Command = {
  name: 'mounts',
  group: 'navigate',
  summary: 'List the configured sources and what each one can do.',
  usage: 'mounts',
  detail:
    'Capabilities are listed honestly. If a source cannot search, it says so rather than\n' +
    'quietly walking every folder and appearing to hang.',
  flags: [...OUTPUT_FLAGS],
  async run(session, args) {
    const mode = modeFrom(args);
    const rows = session.vfs.mounts.map((mount) => [
      mount.path,
      mount.provider.displayName,
      [...mount.provider.capabilities].sort().join(', '),
      mount.description ?? '',
    ]);

    for (const broken of session.brokenMounts) {
      rows.push([broken.config.path, `${broken.config.type} (FAILED)`, '', broken.error?.message ?? 'unknown error']);
    }

    if (rows.length === 0) {
      session.print(
        'No sources are configured yet.\nRun `mscomms init` to write a starter config, or `demo` to mount sample data.',
      );
      return;
    }

    session.print(formatRows(['path', 'source', 'can', 'notes'], rows, session.withMode(mode)));

    for (const broken of session.brokenMounts) {
      if (broken.error?.hint !== undefined) session.status(`${broken.config.path}: ${broken.error.hint}`);
    }
  },
};

export const navigationCommands: readonly Command[] = [
  lsCommand,
  moreCommand,
  cdCommand,
  pwdCommand,
  backCommand,
  treeCommand,
  mountsCommand,
];
