/**
 * Graph: `schema` and `graphql`.
 *
 * These two exist so that a projection can be written by trying one, rather than by
 * reading a document and restarting the program. `schema` answers "what can I select?"
 * against the mounts you actually have; `graphql` answers "what would that give me?"
 * without touching the config. Once the answer looks right, the same query text goes into
 * a `projection` mount and becomes a directory tree.
 *
 * That loop matters more than it sounds. A query language whose only feedback channel is
 * "restart and look at the filesystem" is a query language nobody writes by hand.
 */

import { readFile } from 'node:fs/promises';
import {
  executeProjection,
  parseGraphQL,
  printProjectionSchema,
  VfsError,
  type GqlRuntimeValue,
} from '@mscomms/core';
import { flagBool, flagString, type Command, type CommandArgs } from './types.js';
import type { Session } from '../session.js';

export const schemaCommand: Command = {
  name: 'schema',
  aliases: ['graph'],
  group: 'system',
  summary: 'Show what a GraphQL projection can select from your sources.',
  usage: 'schema [--source <name>]',
  maxPositional: 0,
  detail:
    'Prints the schema built from every mounted source, in GraphQL SDL. Each source\n' +
    'contributes its own types and root fields; sources that never declared a graph get\n' +
    'the one their tree implies, with `children`, `descendants` and `parent` edges.\n' +
    '\n' +
    'Feed what you learn here to `graphql` to try a query, then put the query in a\n' +
    '"projection" mount to keep it as a directory tree. See docs/PROJECTIONS.md.',
  flags: [
    { name: 'source', description: 'Only show this source.', value: true, aliases: ['s'] },
  ],
  examples: ['schema', 'schema --source mail'],
  async run(session, args) {
    const space = session.vfs.graphSpace();
    const only = flagString(args, 'source', 's');
    const scoped = only === undefined ? space : space.only(only);
    if (only !== undefined && scoped.entries.length === 0) {
      throw VfsError.invalid(
        `No mounted source is called "${only}".`,
        `Mounted sources: ${space.entries.map((entry) => entry.alias).join(', ') || '(none)'}.`,
      );
    }
    session.print(await printProjectionSchema(scoped));
    if (space.entries.length === 0) {
      session.status('Nothing is mounted yet, so there is nothing to project. Try `demo`.');
    } else {
      session.status('Try a query with `graphql`, then keep it as a "projection" mount.');
    }
  },
};

export const graphqlCommand: Command = {
  name: 'graphql',
  aliases: ['gql', 'project'],
  group: 'search',
  summary: 'Run a GraphQL query across every mounted source.',
  usage: 'graphql <query> | graphql --file <path> | graphql -',
  detail:
    'Runs a projection query and prints the result as JSON. The same query, put in a\n' +
    '"projection" mount, becomes a browsable directory tree instead.\n' +
    '\n' +
    'The query can be given inline, read from a file with --file, or piped in by passing\n' +
    'a single "-" as the argument. Run `schema` first to see the fields available.\n' +
    '\n' +
    'Directives shape the tree a projection builds — @group, @flatten, @name, @sort — and\n' +
    'are accepted here too so that what you test is what you mount.',
  args: ['none'],
  flags: [
    { name: 'file', description: 'Read the query from a file.', value: true, aliases: ['f'] },
    { name: 'operation', description: 'Which named operation to run.', value: true },
    { name: 'var', description: 'Set a variable, as name=value. Repeatable.', value: true },
    { name: 'limit', description: 'Default entries per field when the query does not say.', value: true },
    { name: 'compact', description: 'Print JSON on one line.' },
  ],
  examples: [
    'graphql "{ all(filter: \\"is:unread\\") { name source } }"',
    'graphql --file ~/projections/by-person.graphql',
    'schema | less',
  ],
  async run(session, args) {
    const source = await querySource(session, args);
    const document = parseGraphQL(source);
    const variables = readVars(args);
    const limit = flagString(args, 'limit');
    const operation = flagString(args, 'operation');

    const result = await executeProjection(session.vfs.graphSpace(), document, {
      ...(operation === undefined ? {} : { operationName: operation }),
      ...(Object.keys(variables).length === 0 ? {} : { variables }),
      ...(limit === undefined ? {} : { defaultLimit: parseLimit(limit) }),
    });

    session.print(
      flagBool(args, 'compact') ? JSON.stringify(result) : JSON.stringify(result, null, 2),
    );
  },
};

/**
 * Where the query text comes from.
 *
 * Three sources rather than one because a GraphQL query is a multi-line thing being typed
 * into a single-line prompt. Inline works for a one-liner, `--file` for anything kept, and
 * `-` for a pipeline. The whole raw line is taken for the inline case — a query is full of
 * braces, colons and quotes, and re-joining tokenized arguments would mangle it.
 */
async function querySource(session: Session, args: CommandArgs): Promise<string> {
  const file = flagString(args, 'file', 'f');
  if (file !== undefined) {
    try {
      return await readFile(session.resolvePath(file), 'utf8');
    } catch {
      throw VfsError.invalid(`Could not read "${file}".`, 'Check the path and try again.');
    }
  }

  const inline = stripCommandWord(args.raw);
  if (inline === '-') return readStdin();
  if (inline !== '') return inline;

  throw VfsError.invalid(
    'No query given.',
    'Pass one inline, with --file <path>, or as "-" to read standard input. Run `schema` to see the fields.',
  );
}

/**
 * The raw line minus the command word and any flags.
 *
 * Flags are removed by name because the parser already told us which ones exist; anything
 * left is query text, braces and all.
 */
function stripCommandWord(raw: string): string {
  const withoutCommand = raw.replace(/^\s*\S+\s*/u, '');
  const withoutFlags = withoutCommand
    .replace(/--(?:file|f|operation|var|limit)(?:=|\s+)(?:"[^"]*"|'[^']*'|\S+)/gu, '')
    .replace(/--compact\b/gu, '')
    .trim();
  return unquote(withoutFlags);
}

function unquote(text: string): string {
  if (text.length >= 2) {
    const first = text[0];
    if ((first === '"' || first === "'") && text.endsWith(first)) return text.slice(1, -1);
  }
  return text;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') {
    throw VfsError.invalid('Nothing arrived on standard input.', 'Pipe a query in, or pass one inline.');
  }
  return text;
}

function readVars(args: CommandArgs): Record<string, GqlRuntimeValue> {
  const raw = args.flags['var'];
  if (raw === undefined || raw === true) return {};
  const out: Record<string, GqlRuntimeValue> = {};
  for (const pair of String(raw).split(',')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) {
      throw VfsError.invalid(`Could not read the variable "${pair}".`, 'Write variables as name=value.');
    }
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    out[name] = coerce(value);
  }
  return out;
}

/** Numbers and booleans typed at a prompt arrive as text; a variable typed `Int` needs one. */
function coerce(value: string): GqlRuntimeValue {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (value !== '' && !Number.isNaN(Number(value))) return Number(value);
  return value;
}

function parseLimit(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw VfsError.invalid(`"${value}" is not a positive whole number.`, 'Try --limit 50.');
  }
  return parsed;
}

export const graphCommands: readonly Command[] = [schemaCommand, graphqlCommand];
