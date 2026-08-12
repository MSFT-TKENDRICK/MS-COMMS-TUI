/**
 * System: help, plugins, doctor, set, demo, refresh, quit.
 *
 * `help` deserves a note. Discoverability is an accessibility feature, not a nicety: a
 * sighted user can see a status bar advertising "? for help", while a screen reader user
 * encounters an empty prompt with no indication that anything exists at all. So help is
 * exhaustive, printed as linear text, reachable from `help`, `?`, and `--help`, and every
 * error message that can suggest a command does so by name.
 */

import { performance } from 'node:perf_hooks';
import { VfsError, isVfsError, QUERY_FIELD_HELP } from '@mscomms/core';
import { formatRows } from '../format.js';
import { OUTPUT_FLAGS, flagBool, modeFrom, quoteCorrection, type Command, type CommandTable } from './types.js';

export function createHelpCommand(table: CommandTable): Command {
  return {
    name: 'help',
    aliases: ['?', 'commands'],
    group: 'system',
    summary: 'List every command, or explain one in detail.',
    usage: 'help [command]',
    args: ['command'],
    flags: [...OUTPUT_FLAGS],
    async run(session, args) {
      const name = args.positional[0];
      const mode = modeFrom(args);

      if (name !== undefined) {
        const command = table.get(name);
        if (command === undefined) {
          const suggestion = suggest(name, table.names);
          throw new Error(
            `There is no command called "${name}".${suggestion === undefined ? '' : ` Did you mean "${suggestion}"?`} Type \`help\` for the full list.`,
          );
        }

        const lines = [
          `${command.name} — ${command.summary}`,
          '',
          `Usage: ${command.usage}`,
        ];
        if ((command.aliases ?? []).length > 0) lines.push(`Also called: ${(command.aliases ?? []).join(', ')}`);
        if (command.detail !== undefined) {
          lines.push('', command.detail);
        }
        if ((command.flags ?? []).length > 0) {
          lines.push('', 'Options:');
          for (const flag of command.flags ?? []) {
            const names = [flag.name, ...(flag.aliases ?? [])].map((n) => (n.length === 1 ? `-${n}` : `--${n}`));
            lines.push(`  ${names.join(', ')}${flag.value === true ? ' <value>' : ''}  ${flag.description}`);
          }
        }
        if ((command.examples ?? []).length > 0) {
          lines.push('', 'Examples:');
          for (const example of command.examples ?? []) lines.push(`  ${example}`);
        }
        session.print(lines.join('\n'));
        return;
      }

      if (mode === 'json') {
        session.print(
          JSON.stringify(
            table.all.map((command) => ({
              name: command.name,
              aliases: command.aliases ?? [],
              summary: command.summary,
              usage: command.usage,
              group: command.group,
            })),
            null,
            2,
          ),
        );
        return;
      }

      const groups: Array<[Command['group'], string]> = [
        ['navigate', 'Moving around'],
        ['read', 'Reading and acting'],
        ['search', 'Finding things'],
        ['watch', 'Watching and notifications'],
        ['system', 'Settings and diagnostics'],
      ];

      const sections: string[] = [
        'Everything here works from the keyboard. Press Tab to complete a command, a path,',
        'or a query field. Press Tab twice to see every match as a numbered list.',
        '',
        'After `ls`, act on items by number: `cat 3` reads the third, `cd 1` enters the first.',
        '',
      ];

      for (const [group, title] of groups) {
        const commands = table.byGroup(group);
        if (commands.length === 0) continue;
        sections.push(`${title}:`);
        for (const command of commands) {
          sections.push(`  ${command.name.padEnd(14)} ${command.summary}`);
        }
        sections.push('');
      }

      sections.push('Type `help <command>` for details, or `queries` for the search field list.');
      session.print(sections.join('\n'));
    },
  };
}

function suggest(input: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestScore = Infinity;
  for (const candidate of candidates) {
    const score = distance(input.toLowerCase(), candidate.toLowerCase());
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return bestScore <= Math.max(2, Math.floor(input.length / 3)) ? best : undefined;
}

function distance(a: string, b: string): number {
  if (a === b) return 0;
  const rows: number[][] = [Array.from({ length: b.length + 1 }, (_, i) => i)];
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row.push(Math.min((row[j - 1] as number) + 1, ((rows[i - 1] as number[])[j] as number) + 1, ((rows[i - 1] as number[])[j - 1] as number) + cost));
    }
    rows.push(row);
  }
  return (rows[a.length] as number[])[b.length] as number;
}

export const pluginsCommand: Command = {
  name: 'plugins',
  group: 'system',
  summary: 'List the source types available to mount.',
  usage: 'plugins',
  maxPositional: 0,
  flags: [...OUTPUT_FLAGS],
  async run(session, args) {
    const rows = session.registry.all.map((plugin) => [
      plugin.type,
      plugin.displayName,
      plugin.description ?? '',
    ]);
    session.print(formatRows(['type', 'name', 'description'], rows, session.withMode(modeFrom(args))));
    session.status('Add one with a "mounts" entry in your config. See `doctor` for where that file lives.');
  },
};

export const doctorCommand: Command = {
  name: 'doctor',
  group: 'system',
  summary: 'Check the setup and report anything wrong, with a suggested fix for each.',
  usage: 'doctor',
  maxPositional: 0,
  flags: [...OUTPUT_FLAGS],
  detail:
    'Checks config, mounts, notifications and terminal capabilities. Every problem it\n' +
    'reports comes with the specific thing to do about it.',
  async run(session, args) {
    const checks: Array<{ name: string; status: 'ok' | 'warn' | 'fail'; detail: string }> = [];

    checks.push({
      name: 'config',
      status: session.config.sourcePath === undefined ? 'warn' : 'ok',
      detail:
        session.config.sourcePath === undefined
          ? `No config file. Expected at ${session.paths.configFile}. Run \`mscomms init\` to create one.`
          : session.config.sourcePath,
    });

    checks.push({
      name: 'sources',
      status: session.vfs.mounts.length === 0 ? 'warn' : 'ok',
      detail:
        session.vfs.mounts.length === 0
          ? 'Nothing is mounted. Add a "mounts" entry to your config, or run `demo`.'
          : `${String(session.vfs.mounts.length)} mounted: ${session.vfs.mounts.map((mount) => mount.path).join(', ')}`,
    });

    for (const broken of session.brokenMounts) {
      checks.push({
        name: `source ${broken.config.path}`,
        status: 'fail',
        detail: `${broken.error?.message ?? 'failed'}${broken.error?.hint === undefined ? '' : ` — ${broken.error.hint}`}`,
      });
    }

    // Reachability, one mount at a time, so a single dead backend is attributed correctly
    // instead of making the whole tool look broken.
    for (const mount of session.vfs.mounts) {
      const started = performance.now();
      try {
        await session.vfs.list(mount.path, { limit: 1 });
        checks.push({
          name: `reach ${mount.path}`,
          status: 'ok',
          detail: `responded in ${String(Math.round(performance.now() - started))} ms`,
        });
      } catch (error) {
        const vfsError = isVfsError(error) ? error : undefined;
        checks.push({
          name: `reach ${mount.path}`,
          status: 'fail',
          detail: `${error instanceof Error ? error.message : String(error)}${vfsError?.hint === undefined ? '' : ` — ${vfsError.hint}`}`,
        });
      }
    }

    checks.push({
      name: 'output mode',
      status: 'ok',
      detail: `${session.format.mode}, colour ${session.format.color ? 'on' : 'off'}, ${String(session.format.width)} columns. Override with --plain, --announce, or NO_COLOR.`,
    });

    checks.push({
      name: 'notifications',
      status: session.config.notifications.desktop === false ? 'warn' : 'ok',
      detail:
        session.config.notifications.desktop === false
          ? 'Desktop notifications are turned off in your config; the in-app log still records everything.'
          : `Desktop notifications enabled on ${process.platform}. ${
              process.platform === 'win32'
                ? 'Windows shows these as "Windows PowerShell" unless you set notifications.appId. Focus Assist can suppress them; `notifications` always has the full log.'
                : 'If nothing appears, check Do Not Disturb.'
            }`,
    });

    checks.push({
      name: 'watches',
      status: 'ok',
      detail:
        session.watcher.statuses.length === 0
          ? 'None active.'
          : session.watcher.statuses
              .map((status) => `${status.id}${status.lastError === undefined ? '' : ` (failing: ${status.lastError})`}`)
              .join(', '),
    });

    const mode = modeFrom(args);
    if (mode === 'json') {
      session.print(JSON.stringify(checks, null, 2));
      return;
    }

    session.print(
      formatRows(
        ['check', 'status', 'detail'],
        checks.map((check) => [check.name, check.status.toUpperCase(), check.detail]),
        session.withMode(mode),
      ),
    );

    const failures = checks.filter((check) => check.status === 'fail').length;
    session.status(
      failures === 0 ? 'No problems found.' : `${String(failures)} problem(s) need attention; each row says what to do.`,
    );
  },
};

export const setCommand: Command = {
  name: 'set',
  group: 'system',
  summary: 'Change a display setting for this session.',
  usage: 'set [name] [value]',
  maxPositional: 2,
  detail: [
    'With no arguments, lists the current settings.',
    '',
    'Settings:',
    '  mode        table, plain, announce, json or tsv',
    '  color       on or off',
    '  width       terminal width in columns',
    '  pagesize    how many items `ls` shows at once',
    '  dates       relative, absolute or iso',
    '  bell        on or off — an audible beep on notification',
    '',
    '`announce` mode prints one sentence per item instead of aligned columns. Column',
    'alignment is a purely visual affordance; through speech it is just padding.',
  ].join('\n'),
  args: ['setting'],
  async run(session, args) {
    const name = args.positional[0];
    const value = args.positional[1];

    if (name === undefined) {
      session.print(
        formatRows(
          ['setting', 'value'],
          [
            ['mode', session.format.mode],
            ['color', session.format.color ? 'on' : 'off'],
            ['width', String(session.format.width)],
            ['pagesize', String(session.pageSize)],
            ['dates', session.format.dateStyle],
          ],
          session.format,
        ),
      );
      return;
    }
    if (value === undefined) throw new Error(`What should "${name}" be set to? Try \`help set\`.`);

    switch (name) {
      case 'mode': {
        const allowed = ['table', 'plain', 'announce', 'json', 'tsv'];
        if (!allowed.includes(value)) throw new Error(`Mode must be one of: ${allowed.join(', ')}.`);
        session.format = { ...session.format, mode: value as typeof session.format.mode };
        break;
      }
      case 'color':
        session.format = { ...session.format, color: value === 'on' || value === 'true' };
        break;
      case 'width': {
        const width = Number(value);
        if (!Number.isFinite(width) || width < 20) throw new Error('Width must be a number of at least 20.');
        session.format = { ...session.format, width };
        break;
      }
      case 'pagesize': {
        const size = Number(value);
        if (!Number.isInteger(size) || size < 1) throw new Error('Page size must be a whole number of at least 1.');
        session.pageSize = size;
        break;
      }
      case 'dates': {
        const allowed = ['relative', 'absolute', 'iso'];
        if (!allowed.includes(value)) throw new Error(`Dates must be one of: ${allowed.join(', ')}.`);
        session.format = { ...session.format, dateStyle: value as typeof session.format.dateStyle };
        break;
      }
      default:
        throw new Error(`There is no setting called "${name}". Run \`set\` to see them all.`);
    }

    session.print(`${name} is now ${value}.`);
  },
};

export const refreshCommand: Command = {
  name: 'refresh',
  group: 'system',
  summary: 'Discard cached listings so the next command fetches fresh data.',
  usage: 'refresh [path]',
  args: ['path'],
  maxPositional: 1,
  correction: quoteCorrection('refresh'),
  async run(session, args) {
    const path = session.positionalPath(args, 0);
    session.vfs.invalidate(path);
    session.lastListing = undefined;
    session.print(`Refreshed ${path}.`);
  },
};

export const cacheCommand: Command = {
  name: 'cache',
  group: 'system',
  summary: 'Show how much is cached and how well the cache is working.',
  usage: 'cache [clear|sync]',
  args: ['action'],
  maxPositional: 1,
  flags: [...OUTPUT_FLAGS],
  async run(session, args) {
    const action = args.positional[0];

    if (action === 'clear') {
      session.vfs.invalidate('/');
      await session.vfs.flush();
      await session.snapshot?.clear();
      session.lastListing = undefined;
      session.print(session.snapshot === undefined ? 'Cleared the in-memory cache.' : 'Cleared the cache and the local snapshot.');
      return;
    }

    if (action === 'sync') {
      if (session.sync === undefined) {
        throw VfsError.invalid(
          'Background sync is not running.',
          'Set "cache": { "enabled": true } in your config to keep a local snapshot.',
        );
      }
      const status = await session.sync.runOnce();
      session.print(
        `Synced ${count(status.directories, 'folder')} and ${count(status.items, 'item')}` +
          `${status.bodies === 0 ? '' : `, with ${count(status.bodies, 'body', 'bodies')}`}` +
          `${status.evicted === 0 ? '' : `, evicting ${String(status.evicted)} past retention`}.`,
      );
      for (const error of status.errors) session.writeError(`Warning: ${error}\n`);
      return;
    }

    if (action !== undefined) {
      throw VfsError.invalid(`Unknown action "${action}".`, 'Use "cache", "cache clear" or "cache sync".');
    }

    const stats = session.vfs.cacheStats;
    const rows: string[][] = [
      ['listings', String(stats.directories.size), String(stats.directories.hits), String(stats.directories.misses), rate(stats.directories.hits, stats.directories.misses)],
      ['documents', String(stats.documents.size), String(stats.documents.hits), String(stats.documents.misses), rate(stats.documents.hits, stats.documents.misses)],
    ];

    if (session.snapshot !== undefined) {
      const snapshot = await session.snapshot.stats();
      rows.push([
        'snapshot',
        `${String(snapshot.nodes)} items`,
        String(snapshot.hits),
        String(snapshot.misses),
        rate(snapshot.hits, snapshot.misses),
      ]);
    }

    const prefetch = session.vfs.prefetchStats;
    if (prefetch !== undefined) {
      rows.push([
        'prefetch',
        `${String(prefetch.queued)} queued`,
        String(prefetch.completed),
        String(prefetch.failed),
        `${String(prefetch.canceled)} cancelled`,
      ]);
    }

    session.print(formatRows(['cache', 'entries', 'hits', 'misses', 'hit rate'], rows, session.withMode(modeFrom(args))));

    // The state of the snapshot belongs on stderr, not in the table: the table is data
    // someone may be piping, and "your cache is off" is chrome about the run.
    if (session.cacheError !== undefined) {
      session.writeError(`The local snapshot is not running: ${session.cacheError}\n`);
    } else if (session.snapshot === undefined) {
      session.writeError('No local snapshot. Set "cache": { "enabled": true } in your config to keep one.\n');
    } else {
      const snapshot = await session.snapshot.stats();
      const size = snapshot.bytes === undefined ? '' : ` (${formatBytes(snapshot.bytes)})`;
      session.writeError(
        `Snapshot: ${count(snapshot.nodes, 'item')} in ${count(snapshot.directories, 'folder')}, ` +
          `${String(snapshot.documents)} with bodies, ${String(snapshot.vectors)} indexed for semantic search${size}.\n`,
      );
      // Which backend opened matters: the three differ in whether they replicate and
      // whether similarity is computed in the database. Someone wondering why semantic
      // search is slower here than on their laptop deserves to see the answer.
      const driver = session.snapshot.driver;
      session.writeError(
        `Storage: ${driver.description}` +
          `${driver.nativeVector ? ', vector search in the database' : ', vector search in this process'}.\n`,
      );
    }
  },
};

function rate(hits: number, misses: number): string {
  const total = hits + misses;
  return total === 0 ? 'n/a' : `${String(Math.round((hits / total) * 100))}%`;
}

function count(value: number, singular: string, plural = `${singular}s`): string {
  return `${String(value)} ${value === 1 ? singular : plural}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const quitCommand: Command = {
  name: 'quit',
  aliases: ['exit', 'q'],
  group: 'system',
  summary: 'Leave the shell.',
  usage: 'quit',
  maxPositional: 0,
  async run(session) {
    session.exiting = true;
  },
};

export const demoCommand: Command = {
  name: 'demo',
  group: 'system',
  summary: 'Mount sample data so you can try everything without connecting an account.',
  usage: 'demo [--reset]',
  maxPositional: 0,
  detail:
    'The sample mailbox deliberately contains awkward names — duplicate subjects, slashes,\n' +
    'emoji, right-to-left overrides, a 190-character subject — because those are exactly\n' +
    'the cases that break tools like this one.',
  flags: [{ name: 'reset', description: 'Remove the demo mounts again.' }],
  async run(session, args) {
    if (flagBool(args, 'reset')) {
      for (const path of ['/demo-mail', '/demo-chat', '/demo-issues', '/demo-people']) {
        await session.vfs.unmount(path);
      }
      session.print('Removed the demo mounts.');
      return;
    }

    if (!session.registry.has('memory')) {
      throw new VfsError('ECONFIG', 'The sample data provider is not available.', {
        hint: 'It ships with the CLI; this build appears to be incomplete.',
      });
    }

    const { FileStateStore, stateFileFor, buildMounts } = await import('@mscomms/core');
    const built = await buildMounts(
      [
        { path: '/demo-mail', type: 'memory', options: { fixture: 'mail' }, description: 'Sample mailbox' },
        { path: '/demo-chat', type: 'memory', options: { fixture: 'chat' }, description: 'Sample chats' },
        { path: '/demo-issues', type: 'memory', options: { fixture: 'issues' }, description: 'Sample issues' },
        { path: '/demo-people', type: 'memory', options: { fixture: 'people' }, description: 'Sample org chart' },
      ],
      {
        registry: session.registry,
        logger: session.logger,
        stateFor: (mountId) => new FileStateStore(stateFileFor(session.paths.stateDir, mountId)),
        cacheDirFor: (mountId) => `${session.paths.cacheDir}/${mountId}`,
      },
    );

    for (const result of built) {
      if (result.mount !== undefined) session.vfs.mount(result.mount);
    }
    // Confirmation, not data: `demo` produces no records, so this belongs on the same
    // stream as the hint that follows it.
    session.status('Mounted /demo-mail, /demo-chat, /demo-issues and /demo-people.');
    session.status('Try: `cd /demo-mail` then `ls`, then `cat 3`.');
    session.status('Or walk the org chart: `cd /demo-people/Me` then `ls`, then `cd manager`.');
  },
};

export const fieldsCommand: Command = {
  name: 'syntax',
  group: 'system',
  summary: 'Show the query syntax with examples.',
  usage: 'syntax',
  maxPositional: 0,
  async run(session) {
    session.print(
      [
        'Query syntax',
        '',
        ...QUERY_FIELD_HELP.map(([field, description]) => `  ${field.padEnd(22)} ${description}`),
        '',
        'Combining:',
        '  from:alice is:unread     both must be true (AND is implied)',
        '  budget OR forecast       either',
        '  NOT from:noreply         exclude',
        '  (a OR b) AND c           parentheses group',
        '  "exact phrase"           quote anything containing spaces',
      ].join('\n'),
    );
  },
};

export function systemCommands(table: CommandTable): readonly Command[] {
  return [
    createHelpCommand(table),
    pluginsCommand,
    doctorCommand,
    setCommand,
    refreshCommand,
    cacheCommand,
    demoCommand,
    fieldsCommand,
    quitCommand,
  ];
}
