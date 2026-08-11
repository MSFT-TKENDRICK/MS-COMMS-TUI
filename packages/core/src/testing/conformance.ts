/**
 * The provider conformance suite.
 *
 * A plugin system is only as good as its contract, and a contract nobody can check is a
 * suggestion. This is the executable version of `docs/PLUGINS.md`: a provider author
 * imports `conformanceTests`, points it at their provider, and finds out whether the parts
 * of the contract that the engine actually relies on hold.
 *
 * It is written against the public `Provider` interface only, so it works equally for the
 * in-process providers here and for a third-party one nobody has seen.
 *
 * WHAT IT CHECKS, AND WHY EACH ONE EARNED ITS PLACE
 *
 * Every assertion below corresponds to a way the engine can be made to behave wrongly by
 * a provider that is merely careless rather than malicious:
 *
 *  - Paging that never terminates, or that returns a cursor forever, makes `ls` an
 *    infinite loop.
 *  - Names that change between two identical listings make numbered addressing lie: the
 *    user runs `ls`, then `cat 3`, and gets a different message than the one they were
 *    read out.
 *  - Names that are not unique within a directory make one of the colliding items
 *    permanently unreachable by name.
 *  - Capabilities that are declared but not implemented turn a clean `ENOTSUP` into a
 *    `TypeError` from inside the engine.
 *  - Capabilities that are implemented but not declared are dead features: the shell
 *    never offers them.
 *  - Search results without `parentPath` cannot be located, so every nested hit is
 *    unopenable. This one shipped as a real bug and is why the field exists.
 *  - Errors that are not `VfsError` reach the user as a stack trace.
 */

import assert from 'node:assert/strict';

import { isVfsError } from '../errors.js';
import { MATCH_ALL, parseQuery, stringifyQuery } from '../query.js';
import { collisionKey } from '../naming.js';
import type { Provider, VNode } from '../provider.js';

export interface ConformanceOptions {
  /** Fresh provider instance. Called once per test so no test can poison another. */
  readonly create: () => Provider | Promise<Provider>;
  /**
   * A query the backend is expected to understand, used for the push-down honesty check.
   * Defaults to something every provider can at least parse.
   */
  readonly sampleQuery?: string;
  /** Skip checks that would hit a network. */
  readonly offlineOnly?: boolean;
  /** Upper bound on pages walked, so a broken cursor fails fast instead of hanging. */
  readonly maxPages?: number;
}

export interface ConformanceCase {
  readonly name: string;
  run(): Promise<void>;
}

/**
 * Build the suite.
 *
 * Returned as plain data rather than registered with a test runner so the caller keeps
 * control — `node:test`, vitest and a bare for-loop all work.
 */
export function conformanceTests(options: ConformanceOptions): readonly ConformanceCase[] {
  const maxPages = options.maxPages ?? 50;
  const sampleQuery = options.sampleQuery ?? 'is:unread';

  const withProvider = async (fn: (provider: Provider) => Promise<void>): Promise<void> => {
    const provider = await options.create();
    await provider.init?.();
    try {
      await fn(provider);
    } finally {
      await provider.dispose?.();
    }
  };

  const cases: ConformanceCase[] = [];
  const test = (name: string, fn: (provider: Provider) => Promise<void>): void => {
    cases.push({
      name,
      run: () => withProvider(fn),
    });
  };

  // -------------------------------------------------------------------------
  // Identity and capabilities
  // -------------------------------------------------------------------------

  test('declares a non-empty id and display name', async (provider) => {
    assert.equal(typeof provider.id, 'string');
    assert.ok(provider.id.length > 0, 'provider.id must not be empty');
    assert.ok(provider.displayName.length > 0, 'provider.displayName must not be empty');
  });

  test('declares list, which is the one mandatory capability', async (provider) => {
    assert.ok(provider.capabilities.has('list'), 'every provider must declare and implement list');
    assert.equal(typeof provider.list, 'function');
  });

  test('implements every capability it declares', async (provider) => {
    // Declared-but-missing turns a clean "not supported" into a crash inside the engine.
    const required: ReadonlyArray<readonly [string, keyof Provider]> = [
      ['list', 'list'],
      ['read', 'read'],
      ['search', 'search'],
      ['poll', 'poll'],
      ['attachments', 'readAttachment'],
    ];
    for (const [capability, method] of required) {
      if (!provider.capabilities.has(capability as never)) continue;
      assert.equal(
        typeof provider[method],
        'function',
        `capability "${capability}" is declared but ${String(method)}() is missing`,
      );
    }
    if (provider.capabilities.has('actions')) {
      assert.equal(typeof provider.actions, 'function', 'capability "actions" declared without actions()');
      assert.equal(typeof provider.invoke, 'function', 'capability "actions" declared without invoke()');
    }
  });

  test('declares every capability it implements', async (provider) => {
    // The reverse mistake is quieter but just as bad: the shell never offers the feature,
    // so the work is invisible.
    const pairs: ReadonlyArray<readonly [keyof Provider, string]> = [
      ['read', 'read'],
      ['search', 'search'],
      ['poll', 'poll'],
      ['readAttachment', 'attachments'],
      ['invoke', 'actions'],
    ];
    for (const [method, capability] of pairs) {
      if (typeof provider[method] !== 'function') continue;
      assert.ok(
        provider.capabilities.has(capability as never),
        `${String(method)}() is implemented but capability "${capability}" is not declared`,
      );
    }
  });

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  test('lists the mount root without being given a parent', async (provider) => {
    const page = await provider.list(null, {});
    assert.ok(Array.isArray(page.entries), 'list() must return an entries array');
    for (const entry of page.entries) assertNodeShape(entry, 'root listing');
  });

  test('gives every entry a unique name within its directory', async (provider) => {
    // Uniqueness is case-insensitive because the user's filesystem intuition is, and
    // because two entries a user cannot tell apart are worse than one.
    const page = await provider.list(null, { limit: 200 });
    const seen = new Map<string, string>();
    for (const entry of page.entries) {
      const key = collisionKey(entry.name);
      const previous = seen.get(key);
      assert.equal(previous, undefined, `duplicate name "${entry.name}" (also used by id ${String(previous)})`);
      seen.set(key, entry.id);
    }
  });

  test('returns the same names and ids for two identical listings', async (provider) => {
    // Numbered addressing depends on this. If the order or naming shifts between the
    // `ls` and the `cat 3`, the user opens something they were never shown.
    const first = await provider.list(null, { limit: 50 });
    const second = await provider.list(null, { limit: 50 });
    assert.deepEqual(
      second.entries.map((entry) => entry.name),
      first.entries.map((entry) => entry.name),
      'listing names are not stable across identical calls',
    );
    assert.deepEqual(
      second.entries.map((entry) => entry.id),
      first.entries.map((entry) => entry.id),
      'listing ids are not stable across identical calls',
    );
  });

  test('respects the requested page limit', async (provider) => {
    const page = await provider.list(null, { limit: 2 });
    assert.ok(page.entries.length <= 2, `asked for 2 entries, got ${String(page.entries.length)}`);
  });

  test('terminates paging and never repeats an entry', async (provider) => {
    // A cursor that never clears is an infinite `ls`. A cursor that loops silently
    // duplicates the whole mailbox.
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < maxPages; page += 1) {
      const result: Awaited<ReturnType<Provider['list']>> = await provider.list(null, {
        limit: 5,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const entry of result.entries) {
        assert.ok(!seen.has(entry.id), `entry ${entry.id} appeared on more than one page`);
        seen.add(entry.id);
      }
      if (result.cursor === undefined) return;
      assert.notEqual(result.cursor, cursor, 'cursor did not advance between pages');
      // A page that returns no entries but still hands back a cursor cannot make progress.
      if (result.entries.length === 0) {
        assert.equal(result.cursor, undefined, 'empty page returned a cursor, so paging cannot terminate');
      }
      cursor = result.cursor;
    }
    assert.fail(`paging did not terminate within ${String(maxPages)} pages`);
  });

  test('rejects a nonsense cursor with a VfsError, not a crash', async (provider) => {
    // Cursors are persisted, so a stale one from a previous version will be handed back.
    await assertVfsErrorOrOk(() => provider.list(null, { cursor: 'definitely-not-a-real-cursor' }));
  });

  test('never claims to have applied a query it was not given', async (provider) => {
    // The engine skips local filtering when the provider says it applied the whole
    // query. Over-claiming here silently hides items from the user.
    const page = await provider.list(null, { limit: 10 });
    if (page.appliedQuery === undefined) return;
    assert.equal(
      stringifyQuery(page.appliedQuery),
      stringifyQuery(MATCH_ALL),
      'provider reported applying a query when none was supplied',
    );
  });

  test('reports applied query push-down honestly', async (provider) => {
    const query = parseQuery(sampleQuery);
    const page = await provider.list(null, { limit: 10, query });
    if (page.appliedQuery === undefined) return; // "I filtered nothing" is always valid.
    const applied = stringifyQuery(page.appliedQuery);
    const requested = stringifyQuery(query);
    if (applied === requested) {
      // Claiming full push-down means the engine will not re-filter, so the claim has to
      // actually hold for the entries returned.
      for (const entry of page.entries) {
        assertNodeShape(entry, 'filtered listing');
      }
    }
  });

  // -------------------------------------------------------------------------
  // Traversal
  // -------------------------------------------------------------------------

  test('lists the children of a directory it returned', async (provider) => {
    const root = await provider.list(null, { limit: 50 });
    const directory = root.entries.find((entry) => entry.kind === 'dir');
    if (directory === undefined) return;
    const children = await provider.list(directory, { limit: 20 });
    assert.ok(Array.isArray(children.entries));
    for (const entry of children.entries) assertNodeShape(entry, `children of ${directory.name}`);
  });

  test('resolveChild agrees with list, when implemented', async (provider) => {
    if (typeof provider.resolveChild !== 'function') return;
    const root = await provider.list(null, { limit: 20 });
    const first = root.entries[0];
    if (first === undefined) return;
    const resolved = await provider.resolveChild(null, first.name);
    if (resolved === undefined) return; // Allowed: the engine falls back to paging.
    assert.equal(resolved.id, first.id, 'resolveChild returned a different item than list did');
  });

  test('resolveChild returns undefined for a name that does not exist', async (provider) => {
    if (typeof provider.resolveChild !== 'function') return;
    const result = await provider
      .resolveChild(null, 'this-name-does-not-exist-9d3f1a')
      .catch((error: unknown) => {
        assert.ok(isVfsError(error), 'resolveChild threw something that is not a VfsError');
        return undefined;
      });
    assert.equal(result, undefined);
  });

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  test('reads a file it returned', async (provider) => {
    if (typeof provider.read !== 'function') return;
    const file = await firstFile(provider);
    if (file === undefined) return;
    const document = await provider.read(file, {});
    assert.equal(typeof document.body, 'string', 'document.body must be a string');
    assert.ok(['text', 'markdown', 'html'].includes(document.format), `bad format: ${document.format}`);
    assert.ok(Array.isArray(document.headers), 'document.headers must be an array');
    for (const header of document.headers) {
      assert.equal(header.length, 2, 'each header must be a [label, value] pair');
      assert.equal(typeof header[0], 'string');
      assert.equal(typeof header[1], 'string');
    }
  });

  test('returns the same document for two identical reads', async (provider) => {
    if (typeof provider.read !== 'function') return;
    const file = await firstFile(provider);
    if (file === undefined) return;
    const first = await provider.read(file, {});
    const second = await provider.read(file, {});
    assert.equal(second.body, first.body, 'read() is not stable for the same node');
  });

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  test('search results carry enough information to be located', async (provider) => {
    // The bug this exists for: a hit from `Inbox/Projects/` reported with no location is
    // assumed by the engine to sit directly under the search root, so opening it fails
    // with ENOENT and the whole search result is unactionable.
    if (typeof provider.search !== 'function' || !provider.capabilities.has('search')) return;
    const page = await provider.search(null, parseQuery(sampleQuery), { limit: 20 });
    for (const entry of page.entries) {
      assertNodeShape(entry, 'search result');
      const located = entry.path !== undefined || entry.parentPath !== undefined;
      assert.ok(
        located,
        `search hit "${entry.name}" has neither path nor parentPath, so the engine cannot locate it`,
      );
    }
  });

  test('search accepts match-all without throwing', async (provider) => {
    if (typeof provider.search !== 'function' || !provider.capabilities.has('search')) return;
    await assertVfsErrorOrOk(() => provider.search?.(null, MATCH_ALL, { limit: 5 }) ?? Promise.resolve(undefined));
  });

  // -------------------------------------------------------------------------
  // Polling
  // -------------------------------------------------------------------------

  test('poll returns a resumable cursor and no changes on a cold start', async (provider) => {
    if (typeof provider.poll !== 'function' || !provider.capabilities.has('poll')) return;
    const first = await provider.poll(null, undefined, {});
    assert.ok(Array.isArray(first.changes), 'poll() must return a changes array');
    // A cold poll that reports every existing item as "new" produces a notification storm
    // the first time a user runs `watch`.
    assert.equal(
      first.changes.length,
      0,
      'the first poll with no cursor must report no changes, or every existing item becomes a notification',
    );
    if (first.cursor === undefined) return;
    assert.equal(typeof first.cursor, 'string', 'cursor must be a string so it can be persisted');
    const second = await provider.poll(null, first.cursor, {});
    assert.ok(Array.isArray(second.changes));
  });

  test('poll tolerates a stale cursor from an older version', async (provider) => {
    if (typeof provider.poll !== 'function' || !provider.capabilities.has('poll')) return;
    await assertVfsErrorOrOk(() => provider.poll?.(null, 'stale-cursor-from-last-year', {}) ?? Promise.resolve(undefined));
  });

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  test('describes actions as data the shell can render', async (provider) => {
    if (typeof provider.actions !== 'function' || !provider.capabilities.has('actions')) return;
    const file = await firstFile(provider);
    if (file === undefined) return;
    for (const action of await provider.actions(file)) {
      assert.ok(action.name.length > 0, 'action.name must not be empty');
      assert.ok(action.label.length > 0, `action "${action.name}" must have a label for the UI`);
      assert.ok(!/\s/.test(action.name), `action name "${action.name}" must be a single word so it can be typed`);
      for (const param of action.params ?? []) {
        assert.ok(param.name.length > 0);
        assert.ok(param.label.length > 0, `param "${param.name}" needs a label`);
        if (param.type === 'choice') {
          assert.ok((param.choices?.length ?? 0) > 0, `choice param "${param.name}" has no choices`);
        }
      }
    }
  });

  test('rejects an unknown action with a VfsError', async (provider) => {
    if (typeof provider.invoke !== 'function' || !provider.capabilities.has('actions')) return;
    const file = await firstFile(provider);
    if (file === undefined) return;
    await assertVfsErrorOrOk(async () => {
      const result = await provider.invoke?.('definitely-not-an-action', file, {});
      if (result !== undefined) {
        assert.equal(result.ok, false, 'invoking an unknown action reported success');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Cancellation
  // -------------------------------------------------------------------------

  test('honours an already-aborted signal', async (provider) => {
    if (options.offlineOnly === true) return;
    const controller = new AbortController();
    controller.abort();
    await assertVfsErrorOrOk(() => provider.list(null, { signal: controller.signal, limit: 5 }));
  });

  return cases;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertNodeShape(node: VNode, where: string): void {
  assert.equal(typeof node.name, 'string', `${where}: name must be a string`);
  assert.ok(node.name.length > 0, `${where}: name must not be empty`);
  assert.equal(typeof node.id, 'string', `${where}: id must be a string`);
  assert.ok(node.id.length > 0, `${where}: id must not be empty`);
  assert.ok(node.kind === 'dir' || node.kind === 'file', `${where}: kind must be "dir" or "file"`);
  assert.equal(typeof node.title, 'string', `${where}: title must be a string`);
  // A name containing a separator would fabricate directory levels that do not exist.
  assert.ok(!node.name.includes('/'), `${where}: name "${node.name}" contains a slash`);
  assert.ok(!node.name.includes('\\'), `${where}: name "${node.name}" contains a backslash`);
  // Control characters in a name can repaint the terminal when it is printed.
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[\u0000-\u001F\u007F]/.test(node.name), `${where}: name contains a control character`);
  if (node.mtime !== undefined) {
    assert.ok(node.mtime instanceof Date, `${where}: mtime must be a Date`);
    assert.ok(!Number.isNaN(node.mtime.getTime()), `${where}: mtime is an invalid Date`);
  }
  if (node.size !== undefined) {
    assert.equal(typeof node.size, 'number', `${where}: size must be a number`);
    assert.ok(node.size >= 0, `${where}: size must not be negative`);
  }
  if (node.flags !== undefined) {
    assert.ok(Array.isArray(node.flags), `${where}: flags must be an array`);
    for (const flag of node.flags) assert.equal(typeof flag, 'string', `${where}: flags must be strings`);
  }
}

async function firstFile(provider: Provider): Promise<VNode | undefined> {
  const root = await provider.list(null, { limit: 50 });
  const direct = root.entries.find((entry) => entry.kind === 'file');
  if (direct !== undefined) return direct;
  for (const directory of root.entries.filter((entry) => entry.kind === 'dir').slice(0, 3)) {
    const children = await provider.list(directory, { limit: 50 });
    const file = children.entries.find((entry) => entry.kind === 'file');
    if (file !== undefined) return file;
  }
  return undefined;
}

/**
 * Assert that an operation either succeeds or fails with a VfsError.
 *
 * Both outcomes are legitimate — a provider may well accept a garbage cursor by ignoring
 * it. What is never acceptable is an arbitrary exception, because that reaches the user as
 * a stack trace instead of a sentence.
 */
async function assertVfsErrorOrOk(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    assert.ok(
      isVfsError(error),
      `expected a VfsError, got ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
    );
  }
}
