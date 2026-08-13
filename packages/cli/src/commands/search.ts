/**
 * Search: find, grep, queries.
 *
 * `find` and `grep` are split along the line that actually matters to a user: `find`
 * matches on metadata the listing already contains and is therefore fast, while `grep`
 * matches on message bodies and therefore has to download them. Merging the two into one
 * command would mean a user typing an innocent-looking query and waiting five minutes
 * while it silently fetched ten thousand message bodies.
 */

import {
  parseQuery,
  stringifyQuery,
  requiresContent,
  QUERY_FIELD_HELP,
  QUERY_SYNTAX_HELP,
  vpath,
  type SearchSourceReport,
  type VfsListResult,
  type VNode,
} from '@mscomms/core';
import { formatListing, formatRows, sanitizeForDisplay, truncateWidth } from '../format.js';
import type { Session } from '../session.js';
import {
  OUTPUT_FLAGS,
  flagBool,
  flagNumber,
  flagString,
  modeFrom,
  quoteCorrection,
  type Command,
} from './types.js';

/**
 * The path a token names, if it names an existing folder.
 *
 * Used to decide whether `find <word> <word>` means "search this folder" or "match both
 * words". Returning undefined for anything that is not a real, reachable folder keeps the
 * decision grounded in something the user can verify with `ls`, rather than in a guess
 * about what their words look like.
 */
async function resolveDirectory(session: Session, token: string): Promise<string | undefined> {
  try {
    const path = session.resolveToken(token);
    const node = await session.vfs.stat(path);
    return node.kind === 'dir' ? path : undefined;
  } catch {
    return undefined;
  }
}

export const findCommand: Command = {
  name: 'find',
  aliases: ['search'],
  group: 'search',
  summary: 'Find items by sender, subject, date or status, across one source or all of them.',
  usage: 'find [path] -q <query> [-a] [--source ids] [-n count] [--depth n]',
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
    'Lucene modifiers are accepted:',
    '',
    '  subject:budg*         wildcard; ? matches one character',
    '  budgt~                fuzzy, for a word you are not sure how to spell',
    '  "budget review"~5     the two words within 5 words of each other, in either order',
    '  date:[2026-01 TO *]   a range; {} for exclusive ends',
    '  subject:budget^3      weigh this clause more heavily when ranking',
    '  +must -mustnot        require and exclude; && || ! also work',
    '',
    'Terms are combined with AND unless you write OR. `NOT` and parentheses work too, and',
    'a bare word matches the title. Values with spaces need quotes: subject:"q3 planning".',
    'Backslash escapes any of these, so `sub\\*ject` searches for a literal asterisk.',
    '',
    'Searching a folder that spans several sources — the root `/`, or `-a` from anywhere —',
    'queries every source at once rather than one after another, and merges the results by',
    'relevance. Sources that have their own search index use it. Sources that do not are',
    'walked breadth-first with a budget, so an unindexed feed is slow but never unbounded.',
    'A source that fails or times out is named rather than quietly dropped, because "no',
    'results" and "could not look" must never look the same.',
    '',
    'Without `-q`, a leading word is treated as the folder to search only when it really',
    'is one — `find /mail/Inbox budget` searches that folder for "budget", while',
    '`find budget review` searches from here for "budget review". Whenever a folder is',
    'inferred, it is stated back, so you can tell which reading you got. Use `-q` to',
    'settle it explicitly.',
  ].join('\n'),
  args: ['path', 'query'],
  flags: [
    { name: 'q', description: 'The query to match.', value: true, aliases: ['query'] },
    { name: 'a', description: 'Search every source, whatever the current folder.', aliases: ['all'] },
    {
      name: 'source',
      description: 'Restrict to these sources, by name. Comma-separated.',
      value: true,
      aliases: ['sources'],
    },
    { name: 'n', description: 'Maximum results.', value: true, aliases: ['limit'] },
    { name: 'depth', description: 'How many folder levels to search. Default 4.', value: true },
    {
      name: 'local',
      description: 'Answer from the local snapshot only, without contacting any source.',
      aliases: ['offline'],
    },
    { name: 'no-semantic', description: 'Skip the local vector index; match text only.' },
    ...OUTPUT_FLAGS,
  ],
  examples: [
    'find -q "is:unread"',
    'find -a -q "from:alice after:7d"',
    'find --local -q "budget"',
    'find -a --source mail,gh -q "subject:budg* OR subject:forecast^2"',
  ],
  async run(session, args) {
    const explicit = flagString(args, 'q', 'query');
    const positional = [...args.positional];
    const all = flagBool(args, 'a', 'all');
    const sources = splitSources(flagString(args, 'source', 'sources'));
    let path = all || sources !== undefined ? vpath.ROOT : session.cwd;

    if (explicit !== undefined) {
      // With -q, the query is settled and a positional can only be the path.
      if (positional.length > 0) path = session.resolveToken(positional[0] as string);
    } else if (positional.length > 1) {
      // Without -q, `find /blog deploy` used to make "/blog" a *search term*, so it
      // matched nothing and printed "(empty)". A false negative is the worst answer this
      // program can give — the user concludes the message does not exist — and it
      // contradicted the command's own `args: ['path', 'query']`, which is what Tab
      // completion has always offered. So the first word is taken as the folder when it
      // really is one, and the rest is the query.
      //
      // It is only ever inferred, never silent: the interpretation is stated back, so a
      // user who meant both words as search terms can see that and add -q.
      const candidate = positional[0] as string;
      const resolved = await resolveDirectory(session, candidate);
      if (resolved !== undefined) {
        if (!all && sources === undefined) path = resolved;
        positional.shift();
        session.status(
          `Searching ${all || sources !== undefined ? 'every source' : resolved} for "${positional.join(' ')}". Use \`-q\` to search from here instead.`,
        );
      }
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

    const local = flagBool(args, 'local', 'offline');
    if (local && session.snapshot === undefined) {
      throw new Error(
        'There is no local snapshot to search. Set "cache": { "enabled": true } in your config, or drop --local.',
      );
    }

    const result = await session.vfs.search(path, query, {
      limit,
      ...(flagNumber(args, 'depth') === undefined ? {} : { maxDepth: flagNumber(args, 'depth') as number }),
      ...(sources === undefined ? {} : { sources }),
      ...(local ? { local: true } : {}),
      ...(flagBool(args, 'no-semantic') ? { semantic: false } : {}),
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
    const count = result.entries.length;
    session.status(
      `${String(count)} ${count === 1 ? 'match' : 'matches'} for ${stringifyQuery(query)}${describeMore(result, count, limit)}.`,
    );
    for (const line of describeSources(result.sources)) session.status(line);
    if (result.sources === undefined && (result.unreadable ?? 0) > 0) {
      const skipped = result.unreadable as number;
      session.status(
        `Could not read ${String(skipped)} ${skipped === 1 ? 'folder' : 'folders'} while searching${
          result.unreadableError === undefined ? '' : ` (${sanitizeForDisplay(result.unreadableError)})`
        }, so this may not be everything.`,
      );
    }
  },
};

function splitSources(value: string | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined;
  const names = value
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  return names.length === 0 ? undefined : names;
}

/**
 * How to offer the rest of the results.
 *
 * A cross-source search has no cursor to resume — see `Vfs`. Offering `more` anyway would
 * be a lie that costs the user a command and an error to discover, so the honest advice
 * is to widen the limit instead.
 */
function describeMore(result: VfsListResult, shown: number, limit: number): string {
  if (result.cursor !== undefined) return '. Type `more` for the next page';
  const truncated = result.sources?.some((source) => source.truncated) ?? false;
  if (!truncated && result.total !== undefined && result.total <= shown) return '';
  if (!truncated && shown < limit) return '';
  return `. Showing the top ${String(shown)}; raise \`-n\` for more`;
}

/**
 * One line per source outcome, but only when there is something a user must know.
 *
 * Announcing "mail 12, teams 3" after every successful search would be noise a screen
 * reader has to read out every time. Announcing a source that failed, timed out or got
 * cut off is not noise: it is the difference between "there are no more" and "I stopped
 * looking".
 */
function describeSources(sources: readonly SearchSourceReport[] | undefined): readonly string[] {
  if (sources === undefined || sources.length === 0) return [];

  const lines: string[] = [];
  const complete = sources.filter((source) => source.status === 'ok');
  const partial = sources.filter((source) => source.status === 'partial');
  const broken = sources.filter((source) => source.status === 'failed' || source.status === 'timeout');

  if (broken.length > 0) {
    lines.push(
      `Searched ${String(complete.length + partial.length)} of ${String(sources.length)} sources. ${broken
        .map(
          (source) =>
            `${source.id} ${source.status === 'timeout' ? 'timed out' : 'failed'}${source.error === undefined ? '' : ` (${sanitizeForDisplay(source.error)})`}`,
        )
        .join('; ')}.`,
    );
  }

  if (partial.length > 0) {
    lines.push(
      `Searched only part of: ${partial
        .map(
          (source) =>
            `${source.id}${source.error === undefined ? '' : ` (${sanitizeForDisplay(source.error)})`}`,
        )
        .join('; ')}.`,
    );
  }

  const cut = [...complete, ...partial]
    .filter((source) => source.truncated && source.id !== SNAPSHOT_SOURCE_ID)
    .map((source) => source.id);
  if (cut.length > 0) {
    lines.push(`More to find in: ${cut.join(', ')}. Raise \`-n\` to see further into each source.`);
  }

  // The snapshot is always truncated by construction, so the generic "raise -n" advice
  // would be wrong for it — no page size reaches a message that was never cached. Say what
  // is actually true instead, and only when it changes what the user should conclude.
  const snapshot = sources.find((source) => source.id === SNAPSHOT_SOURCE_ID);
  if (snapshot !== undefined && snapshot.status !== 'ok') {
    lines.push(
      `The local snapshot could not be searched${snapshot.error === undefined ? '' : ` (${sanitizeForDisplay(snapshot.error)})`}, so these results came from the network alone.`,
    );
  } else if (snapshot !== undefined && snapshot.matches > 0) {
    lines.push(
      `${String(snapshot.matches)} came from the local snapshot, which holds recent items only.`,
    );
  }

  return lines;
}

/** Matches the id the engine gives its own snapshot in a {@link SearchSourceReport}. */
const SNAPSHOT_SOURCE_ID = 'snapshot';


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
    '',
    'A trailing word is treated as the folder to search only when it really is one, so',
    '`grep budget review` looks for the phrase "budget review" here, while',
    '`grep budget /mail/Inbox` looks for "budget" in that folder.',
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
    // `grep <text> [path]`: the path is trailing, so the *last* word is the path when it
    // really is a folder, and everything before it is the text. Without this,
    // `grep budget review` searched for "budget" inside a folder called "review" — which
    // does not exist — and the user was told nothing matched. Same false negative as
    // `find`, same rule, so the two commands behave alike.
    const positional = [...args.positional];
    let pathToken: string | undefined;
    if (positional.length > 1) {
      const last = positional[positional.length - 1] as string;
      const resolved = await resolveDirectory(session, last);
      if (resolved !== undefined) {
        pathToken = last;
        positional.pop();
      }
    }

    if (positional.length === 0) {
      throw new Error('What text are you looking for? Try `grep budget`.');
    }
    const pattern = positional.join(' ');
    if (positional.length > 1) {
      session.status(`Searching for "${pattern}".`);
    }

    const path = pathToken === undefined ? session.cwd : session.resolveToken(pathToken);
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
  maxPositional: 1,
  correction: quoteCorrection('queries'),
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

    session.print('');
    session.print(
      formatRows(['modifier', 'what it does'], QUERY_SYNTAX_HELP.map((pair) => [...pair]), session.withMode(mode)),
    );

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
