/**
 * Search: find, grep, queries.
 *
 * `find` and `grep` are split along the line that actually matters to a user: `find`
 * matches on metadata the listing already contains and is therefore fast, while `grep`
 * matches on message bodies and therefore has to download them. Merging the two into one
 * command would mean a user typing an innocent-looking query and waiting five minutes
 * while it silently fetched ten thousand message bodies.
 */

import { parseQuery, stringifyQuery, requiresContent, QUERY_FIELD_HELP, vpath, type VNode } from '@mscomms/core';
import { formatListing, formatRows, sanitizeForDisplay, truncateWidth } from '../format.js';
import {
  OUTPUT_FLAGS,
  flagBool,
  flagNumber,
  flagString,
  modeFrom,
  type Command,
} from './types.js';

export const findCommand: Command = {
  name: 'find',
  aliases: ['search'],
  group: 'search',
  summary: 'Find items by sender, subject, date or status, without downloading bodies.',
  usage: 'find [path] -q <query> [-n count] [--depth n]',
  detail: [
    'Query syntax:',
    '',
    '  from:alice            sender contains "alice"',
    '  subject:budget        subject contains "budget"',
    '  is:unread             status flag',
    '  has:attachment        has an attachment',
    '  after:2026-01-01      received on or after a date; also `after:7d`',
    '  larger:1MB            bigger than a size',
    '',
    'Terms are combined with AND unless you write OR. `NOT` and parentheses work too, and',
    'a bare word matches the title. Values with spaces need quotes: subject:"q3 planning".',
    '',
    'Sources that have their own search index use it. Sources that do not are walked',
    'breadth-first with a budget, so an unindexed feed is slow but never unbounded.',
  ].join('\n'),
  args: ['path', 'query'],
  flags: [
    { name: 'q', description: 'The query to match.', value: true, aliases: ['query'] },
    { name: 'n', description: 'Maximum results.', value: true, aliases: ['limit'] },
    { name: 'depth', description: 'How many folder levels to search. Default 4.', value: true },
    ...OUTPUT_FLAGS,
  ],
  examples: ['find -q "is:unread"', 'find /mail -q "from:alice after:7d"', 'find -q "subject:budget OR subject:forecast"'],
  async run(session, args) {
    // Everything after the path that is not a flag is treated as the query, so
    // `find is:unread` works as well as `find -q is:unread`.
    const explicit = flagString(args, 'q', 'query');
    const positional = [...args.positional];
    let path = session.cwd;
    if (positional.length > 0 && explicit !== undefined) {
      path = session.resolveToken(positional[0] as string);
    }
    const queryText = explicit ?? positional.join(' ');
    if (queryText.trim() === '') {
      throw new Error('What are you looking for? Try `find -q "is:unread"`, or `queries` for the field list.');
    }

    const query = parseQuery(queryText);
    const limit = flagNumber(args, 'n', 'limit') ?? session.pageSize;
    const mode = modeFrom(args);

    if (requiresContent(query)) {
      session.status(
        'Note: this query looks at message bodies, so it must download them. `grep` is the command built for that and will report progress.',
      );
    }

    const result = await session.vfs.search(path, query, {
      limit,
      ...(flagNumber(args, 'depth') === undefined ? {} : { maxDepth: flagNumber(args, 'depth') as number }),
    });

    session.print(formatListing(result.entries, { ...session.withMode(mode), startIndex: 1 }));
    session.setListing({
      path,
      nodes: result.entries as VNode[],
      startIndex: 1,
      source: 'find',
      query: queryText,
      ...(result.cursor === undefined ? {} : { cursor: result.cursor }),
    });

    if (mode === 'json' || mode === 'tsv') return;
    session.status(
      `${String(result.entries.length)} ${result.entries.length === 1 ? 'match' : 'matches'} for ${stringifyQuery(query)}${result.cursor === undefined ? '' : '. Type `more` for the next page'}.`,
    );
  },
};

export const grepCommand: Command = {
  name: 'grep',
  group: 'search',
  summary: 'Search inside message text, showing the lines that matched.',
  usage: 'grep <text> [path] [-i] [-n count] [--scan count] [--context n] [--regex]',
  detail: [
    'This downloads message bodies, which is slow and hits rate limits, so it works on a',
    'bounded number of items and tells you how many it looked at. Narrow it first with',
    '`find` when you can — `find -q from:alice` then `grep budget` is far cheaper than',
    'grepping a whole mailbox.',
    '',
    'Two separate limits, because conflating them hides real matches: `-n` caps how many',
    'results you get back, and `--scan` caps how many items are downloaded looking for',
    'them. If the scan limit is reached before the result limit, that is reported, so',
    '"no matches" never quietly means "I stopped early".',
    '',
    'Progress is printed to the error stream, so `--json` output stays clean when piped.',
  ].join('\n'),
  args: ['none', 'path'],
  flags: [
    { name: 'i', description: 'Ignore case. On by default; use --case for a case-sensitive search.' },
    { name: 'case', description: 'Match case exactly.' },
    { name: 'regex', description: 'Treat the pattern as a regular expression.', aliases: ['e'] },
    { name: 'n', description: 'Maximum results to show. Default 50.', value: true, aliases: ['limit'] },
    { name: 'scan', description: 'Maximum items to download and examine. Default 200.', value: true },
    { name: 'context', description: 'Lines of context around each match.', value: true, aliases: ['C'] },
    { name: 'q', description: 'Only examine items matching this query first.', value: true, aliases: ['query'] },
    ...OUTPUT_FLAGS,
  ],
  examples: ['grep budget', 'grep -q "from:alice" deadline', 'grep --regex "Q[34] (plan|forecast)"'],
  async run(session, args) {
    const pattern = args.positional[0];
    if (pattern === undefined) throw new Error('What text are you looking for? Try `grep budget`.');
    const path = session.positionalPath(args, 1);
    const limit = flagNumber(args, 'n', 'limit') ?? 50;
    const scanLimit = flagNumber(args, 'scan') ?? 200;
    const context = flagNumber(args, 'context', 'C') ?? 0;
    const mode = modeFrom(args);
    const caseSensitive = flagBool(args, 'case');

    let matcher: (text: string) => boolean;
    let lineMatcher: (line: string) => boolean;
    if (flagBool(args, 'regex', 'e')) {
      let regex: RegExp;
      try {
        regex = new RegExp(pattern, caseSensitive ? '' : 'i');
      } catch (error) {
        throw new Error(`That is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`);
      }
      matcher = (text) => regex.test(text);
      lineMatcher = (line) => regex.test(line);
    } else {
      const needle = caseSensitive ? pattern : pattern.toLowerCase();
      matcher = (text) => (caseSensitive ? text : text.toLowerCase()).includes(needle);
      lineMatcher = matcher;
    }

    const prefilter = flagString(args, 'q', 'query');
    const candidates = await collectFiles(session, path, scanLimit, prefilter);

    if (candidates.length === 0) {
      session.print('There are no items to search here.');
      return;
    }

    session.status(`Searching ${String(candidates.length)} item(s)…`);

    const hits: VNode[] = [];
    const lines: string[] = [];
    let examined = 0;
    let failed = 0;

    for (const node of candidates) {
      if (hits.length >= limit) break;
      const nodePath = node.path ?? vpath.join(path, node.name);
      examined += 1;
      let body: string;
      try {
        const doc = await session.vfs.read(node.path === undefined ? nodePath : node);
        body = `${doc.title}\n${doc.body}`;
      } catch {
        failed += 1;
        continue;
      }
      if (!matcher(body)) continue;

      hits.push(node);
      const index = hits.length;
      lines.push(`${String(index)}. ${sanitizeForDisplay(node.name)}`);

      const bodyLines = body.split('\n');
      let shown = 0;
      for (let i = 0; i < bodyLines.length && shown < 3; i += 1) {
        const line = bodyLines[i] as string;
        if (!lineMatcher(line)) continue;
        shown += 1;
        const from = Math.max(0, i - context);
        const to = Math.min(bodyLines.length - 1, i + context);
        for (let j = from; j <= to; j += 1) {
          const text = truncateWidth(sanitizeForDisplay((bodyLines[j] as string).trim()), session.format.width - 8);
          if (text !== '') lines.push(`     ${text}`);
        }
      }
    }

    if (mode === 'json') {
      session.print(JSON.stringify(hits, null, 2));
    } else if (mode === 'tsv') {
      session.print(formatListing(hits, { ...session.withMode('tsv'), startIndex: 1 }));
    } else {
      session.print(lines.length === 0 ? 'No matches.' : lines.join('\n'));
    }

    session.setListing({ path, nodes: hits, startIndex: 1, source: 'grep' });

    if (mode === 'json' || mode === 'tsv') return;

    // Say exactly what was and was not looked at. "No matches" that silently meant "I gave
    // up after 200 downloads" is the kind of half-truth that makes a search tool
    // untrustworthy, and it is invisible unless it is spelled out.
    const notes: string[] = [];
    if (failed > 0) notes.push(`${String(failed)} could not be read`);
    if (hits.length >= limit) notes.push(`stopped at the ${String(limit)}-result limit, so there may be more (raise it with -n)`);
    else if (examined >= scanLimit) {
      notes.push(`stopped after examining ${String(scanLimit)} items, so there may be more (raise it with --scan)`);
    }
    session.status(
      `${String(hits.length)} of ${String(examined)} item(s) matched${notes.length === 0 ? '' : `; ${notes.join('; ')}`}.`,
    );
  },
};

/** Gather files below `path`, breadth-first, stopping at `limit`. */
async function collectFiles(
  session: { vfs: { list: (path: string, options: object) => Promise<{ entries: readonly VNode[]; cursor?: string }> } },
  path: string,
  limit: number,
  prefilter: string | undefined,
): Promise<VNode[]> {
  const query = prefilter === undefined ? undefined : parseQuery(prefilter);
  const files: VNode[] = [];
  const queue: string[] = [path];
  let visited = 0;

  while (queue.length > 0 && files.length < limit && visited < 200) {
    const current = queue.shift() as string;
    visited += 1;
    let cursor: string | undefined;
    do {
      const result = await session.vfs.list(current, {
        limit: Math.min(100, limit - files.length),
        ...(cursor === undefined ? {} : { cursor }),
        ...(query === undefined ? {} : { query }),
      });
      for (const entry of result.entries) {
        if (entry.kind === 'dir') queue.push(entry.path ?? vpath.join(current, entry.name));
        else if (files.length < limit) files.push(entry);
      }
      cursor = result.cursor;
      if (result.entries.length === 0) break;
    } while (cursor !== undefined && files.length < limit);
  }

  return files;
}

export const queriesCommand: Command = {
  name: 'queries',
  aliases: ['fields'],
  group: 'search',
  summary: 'List the query fields you can search on, and your saved queries.',
  usage: 'queries [name]',
  detail: 'With a name, runs the saved query of that name from your config.',
  args: ['query'],
  flags: [...OUTPUT_FLAGS],
  async run(session, args) {
    const name = args.positional[0];
    const mode = modeFrom(args);

    if (name !== undefined) {
      const saved = session.config.queries.find((candidate) => candidate.name === name);
      if (saved === undefined) {
        const known = session.config.queries.map((candidate) => candidate.name);
        throw new Error(
          `There is no saved query called "${name}".${known.length === 0 ? ' You have not saved any yet.' : ` You have: ${known.join(', ')}.`}`,
        );
      }
      const scope = saved.scope?.[0] ?? session.cwd;
      await findCommand.run(session, {
        positional: [],
        flags: { q: saved.query, ...(mode === undefined ? {} : { [mode]: true }) },
        raw: `find -q "${saved.query}"`,
      });
      session.status(`Ran saved query "${name}" over ${scope}.`);
      return;
    }

    session.print(formatRows(['field', 'what it matches'], QUERY_FIELD_HELP.map((pair) => [...pair]), session.withMode(mode)));

    if (session.config.queries.length > 0) {
      session.print('');
      session.print(
        formatRows(
          ['saved query', 'expression'],
          session.config.queries.map((saved) => [saved.name, saved.query]),
          session.withMode(mode),
        ),
      );
    }
  },
};

export const searchCommands: readonly Command[] = [findCommand, grepCommand, queriesCommand];
