/**
 * Entry point: argument parsing, wiring, and the split between one-shot and shell mode.
 *
 * Every command works both ways — `mscomms ls /mail/Inbox --json` and `ls /mail/Inbox
 * --json` inside the shell run the identical code path. That is not just tidiness: it
 * means the tool is scriptable, and scriptability is an accessibility feature. A user who
 * finds any interactive interface tiring can build exactly the workflow they want out of
 * one-shot invocations and a shell alias.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  ConsoleLogger,
  NULL_LOGGER,
  PluginRegistry,
  isVfsError,
  loadConfig,
  resolveAppPaths,
  type AppConfig,
  type Logger,
} from '@mscomms/core';
import { memoryPlugin } from '@mscomms/provider-memory';
import { rssPlugin } from '@mscomms/provider-rss';
import { githubPlugin } from '@mscomms/provider-github';
import { graphMailPlugin, graphChatPlugin } from '@mscomms/provider-graph';
import { execPlugin } from '@mscomms/provider-exec';
import { Session } from './session.js';
import { Shell } from './shell.js';
import { CommandTable, parseLine, tokenize } from './commands/types.js';
import { navigationCommands } from './commands/navigate.js';
import { readCommands } from './commands/read.js';
import { searchCommands } from './commands/search.js';
import { watchCommands } from './commands/watch.js';
import { systemCommands } from './commands/system.js';
import { STARTER_CONFIG } from './starter-config.js';
import type { OutputMode } from './format.js';

export interface CliOptions {
  readonly argv: readonly string[];
  readonly write?: (text: string) => void;
  readonly writeError?: (text: string) => void;
}

export function buildCommandTable(): CommandTable {
  const table = new CommandTable();
  table.registerAll(navigationCommands);
  table.registerAll(readCommands);
  table.registerAll(searchCommands);
  table.registerAll(watchCommands);
  table.registerAll(systemCommands(table));
  return table;
}

export function builtinRegistry(logger: Logger = NULL_LOGGER): PluginRegistry {
  const registry = new PluginRegistry(logger);
  registry.register(memoryPlugin);
  registry.register(rssPlugin);
  registry.register(githubPlugin);
  registry.register(graphMailPlugin);
  registry.register(graphChatPlugin);
  registry.register(execPlugin);
  return registry;
}

interface GlobalFlags {
  readonly help: boolean;
  readonly version: boolean;
  readonly shell: boolean;
  readonly init: boolean;
  readonly configPath: string | undefined;
  readonly mode: OutputMode | undefined;
  readonly verbose: boolean;
  readonly noConfig: boolean;
  readonly rest: readonly string[];
}

function parseGlobals(argv: readonly string[]): GlobalFlags {
  let help = false;
  let version = false;
  let shell = false;
  let init = false;
  let verbose = false;
  let noConfig = false;
  let configPath: string | undefined;
  let mode: OutputMode | undefined;
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    switch (arg) {
      case '--help':
      case '-h':
        help = true;
        break;
      case '--version':
      case '-V':
        version = true;
        break;
      case '--shell':
      case '-i':
        shell = true;
        break;
      case 'init':
        // Only a subcommand when it is the very first word.
        if (rest.length === 0) init = true;
        else rest.push(arg);
        break;
      case '--config':
      case '-c':
        configPath = argv[i + 1];
        i += 1;
        break;
      case '--no-config':
        noConfig = true;
        break;
      case '--verbose':
        verbose = true;
        break;
      case '--json':
        mode = 'json';
        rest.push(arg);
        break;
      case '--tsv':
        mode = 'tsv';
        rest.push(arg);
        break;
      case '--announce':
        mode = 'announce';
        rest.push(arg);
        break;
      case '--plain':
        mode = 'plain';
        rest.push(arg);
        break;
      default:
        rest.push(arg);
    }
  }

  return { help, version, shell, init, configPath, mode, verbose, noConfig, rest };
}

const VERSION = '0.1.0';

const USAGE = `mscomms — browse messages as folders and files.

Usage:
  mscomms                        start the interactive shell
  mscomms <command> [args]       run one command and exit
  mscomms init                   write a starter config file
  msh                            short alias for the shell

Global options:
  -c, --config <file>   use a specific config file
      --no-config       ignore config files entirely
  -i, --shell           force the interactive shell
      --json            machine-readable output
      --tsv             tab-separated output
      --announce        one spoken sentence per item
      --plain           no alignment or colour
      --verbose         log diagnostics to the error stream
  -h, --help            this message
  -V, --version         print the version

Everything works from the keyboard. Inside the shell, Tab completes commands, paths
and query fields; pressing it twice prints a numbered list of the choices.

After a listing, act on items by number:
  ls
  cat 3
  cd 1

Examples:
  mscomms ls /mail/Inbox -l
  mscomms find -q "is:unread from:alice" --json
  mscomms cat "/mail/Inbox/2026-08-11 FY26 budget review.eml"
  mscomms watch /mail/Inbox -q is:unread

Run \`help\` inside the shell, or \`mscomms help <command>\`, for full documentation.`;

export async function main(options: CliOptions): Promise<number> {
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const writeError = options.writeError ?? ((text: string) => process.stderr.write(text));
  const globals = parseGlobals(options.argv);

  if (globals.version) {
    write(`${VERSION}\n`);
    return 0;
  }
  if (globals.help && globals.rest.length === 0) {
    write(`${USAGE}\n`);
    return 0;
  }

  const paths = resolveAppPaths();

  if (globals.init) {
    return initConfig(globals.configPath ?? paths.configFile, write, writeError);
  }

  const logger: Logger = globals.verbose ? new ConsoleLogger({ level: 'debug', write: writeError }) : NULL_LOGGER;

  let config: AppConfig;
  try {
    config = globals.noConfig
      ? { plugins: [], mounts: [], queries: [], watches: [], ui: {}, notifications: {}, keymap: {} }
      : await loadConfig(globals.configPath ?? paths.configFile, { required: globals.configPath !== undefined });
  } catch (error) {
    writeError(`${error instanceof Error ? error.message : String(error)}\n`);
    if (isVfsError(error) && error.hint !== undefined) writeError(`${error.hint}\n`);
    return 2;
  }

  const registry = builtinRegistry(logger);
  if (config.plugins.length > 0) {
    const { failed } = await registry.loadAll(config.plugins);
    for (const specifier of failed) {
      writeError(`Warning: could not load the plugin "${specifier}". Mounts using it will not work.\n`);
    }
  }

  const session = new Session({
    config,
    registry,
    logger,
    paths,
    write,
    writeError,
    ...(globals.mode === undefined ? {} : { mode: globals.mode }),
  });

  const table = buildCommandTable();

  try {
    await session.start();

    // No arguments, or an explicit --shell: interactive.
    if (globals.rest.length === 0 || globals.shell) {
      const shell = new Shell({ session, table });
      return await shell.run();
    }

    return await runOneShot(session, table, globals, writeError);
  } finally {
    await session.dispose();
  }
}

async function runOneShot(
  session: Session,
  table: CommandTable,
  globals: GlobalFlags,
  writeError: (text: string) => void,
): Promise<number> {
  const name = globals.rest[0] as string;
  const command = table.get(name);

  if (command === undefined) {
    writeError(`There is no command called "${name}". Run \`mscomms --help\` for the list.\n`);
    return 127;
  }

  if (globals.help) {
    const help = table.get('help');
    await help?.run(session, { positional: [name], flags: {}, raw: `help ${name}` });
    return 0;
  }

  // Re-quote so the shared parser sees exactly what the shell would have seen.
  const line = globals.rest.map(quoteArg).join(' ');
  const { args } = parseLine(line, command);

  try {
    await command.run(session, args);
    // A watch started from a one-shot invocation would exit immediately, which looks like
    // it silently failed. Keep the process alive and say so.
    if (name === 'watch') {
      session.status('Watching. Press Ctrl+C to stop.');
      await new Promise<void>((resolve) => {
        process.once('SIGINT', () => resolve());
      });
    }
    return 0;
  } catch (error) {
    if (isVfsError(error)) {
      writeError(`${error.message}\n`);
      if (error.hint !== undefined) writeError(`${error.hint}\n`);
      return error.code === 'ENOENT' ? 4 : error.code === 'EAUTH' ? 77 : 1;
    }
    writeError(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function quoteArg(arg: string): string {
  return /[\s"']/.test(arg) ? `"${arg.replace(/"/g, '')}"` : arg;
}

async function initConfig(
  target: string,
  write: (text: string) => void,
  writeError: (text: string) => void,
): Promise<number> {
  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, STARTER_CONFIG, { encoding: 'utf8', flag: 'wx' });
    write(`Wrote a starter config to ${target}.\n`);
    write('It is commented throughout. Uncomment the source you want and run `mscomms doctor`.\n');
    return 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      writeError(`${target} already exists; leaving it alone.\n`);
      return 1;
    }
    writeError(`Could not write ${target}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export { Session, Shell, CommandTable, tokenize };
