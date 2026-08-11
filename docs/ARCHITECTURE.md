# Architecture

The shape of the thing, and the reasoning behind the parts that are not obvious.

## The one idea

Mail, chats, issues and feeds are the same thing wearing different clothes: a stream of
authored, timestamped, sometimes-unread items, grouped somehow, occasionally acted upon.
Model that once and the interface is written once too. A new backend becomes a plugin
rather than a fork, and — the part that actually matters day to day — the user learns `ls`
and `cat` once instead of learning five clients.

```
        commands (ls, cat, find, do, watch)
                    │
              Session  ── format ── stdout / stderr
                    │
                   VFS  ── cache ── notify / watcher
                    │
    ┌───────────┬───┴───────┬────────────┬───────────┐
 graph-mail  graph-chat  ado-boards  github/rss   exec ──► any program, any language
```

## Packages

| Package | Contains |
|---|---|
| `@mscomms/core` | Paths, naming, the provider contract, the VFS engine, query language, cache, config, notifications, watches |
| `@mscomms/cli` | The shell, commands, completion, formatting |
| `@mscomms/provider-*` | memory, rss, github, graph, ado, exec |

No third-party runtime dependencies anywhere. For a program that reads corporate mail,
every transitive package is another party who can change what it does, and the parsing this
needs — JSONC, RSS, MIME-ish headers — is a few hundred well-tested lines each.

## Core, module by module

**`vpath.ts`** — path arithmetic. Always `/`-separated regardless of host OS, because a
path that changes shape on Windows would leak into names, saved queries and scripts.

**`naming.ts`** — turning a backend item into a filename. Much less trivial than it sounds,
and covered in [PLUGINS.md](PLUGINS.md#names-are-yours-to-choose-and-it-matters).

**`provider.ts`** — the plugin contract. See below.

**`vfs.ts`** — the engine: mount table, resolution, listing, reading, search fan-out.

**`query.ts`** — parse, evaluate, rank and re-serialise `from:dana is:unread after:7d`,
including the Lucene modifiers (wildcards, fuzzy, proximity, ranges, boosts).

**`cache.ts`** — TTL cache for listings and documents, with explicit invalidation.

**`notify.ts` / `watcher.ts`** — polling watches, desktop notifications, and the log that
outlives them.

**`config.ts`** — JSONC loading, validation, secret indirection, platform paths.

**`registry.ts`** — plugin registration and mount construction.

## Three decisions worth defending

### Providers never parse paths

Every operation takes a resolved `VNode | null`, never a string path:

```ts
list(parent: VNode | null, options: ListOptions): Promise<ListPage>
```

Five providers each parsing paths is five chances to disagree about `..`, about trailing
slashes, about where a mount ends. Users notice disagreements *between* mounts long before
they notice a bug in any one of them, and "why does `cd ..` behave differently in Teams
than in mail" is an unpleasant thing to debug. Path syntax is the engine's business and
only the engine's.

The cost is a resolution step before every call, which the cache absorbs.

### Capability declaration is authoritative, and shape must match it

A provider declares a `Set<Capability>`. The engine checks membership before offering a
feature, so a provider without `search` gets local filtering instead of an error.

The subtlety that has caused real bugs here more than once: the engine also checks
`'search' in provider`, and **an own property whose value is `undefined` still answers
true**. So optional methods must be `delete`d, not assigned `undefined`. The conformance
suite asserts the set and the object shape agree, in both directions, because they drifted
apart twice during development.

The `exec` tier adds one more rule: when a mount's config lists `capabilities`, that is a
ceiling and is intersected with what the plugin declares. Not a sandbox — the plugin is an
arbitrary program with the user's privileges — but a user who writes a read-only mount
should get one, and a config file should not say something the program contradicts.

### The push-down trust boundary

Providers may push a query down to their backend, which is the difference between a fast
search and downloading a mailbox. But a provider that *partly* applies a query and returns
what it managed silently loses mail, and a mail client that silently loses mail is worse
than one that is slow.

So: the provider echoes back an `appliedQuery`. If it is **exactly** what was sent, the
engine trusts it. Anything else — a subset, a superset, a rewording, or nothing at all — and
the engine re-filters locally. Returning too much is safe; returning too little is caught.

Exact equality, rather than "close enough", because judging equivalence between two query
ASTs is exactly the sort of thing that looks right until it silently isn't.

This is also why the Lucene modifiers had to survive `stringifyQuery` round-tripping.
A boost or a slop value that vanished on the way out would make two different queries
render identically, and the engine would then trust a filter that was never applied.
Every new AST field is therefore covered by a round-trip test.

## Searching every source at once

`Vfs.search` on a synthetic directory — the root, or any ancestor of several mounts —
fans out rather than walking. Each mount is searched through its own provider, in
parallel, and the results are merged.

The alternative, walking the synthetic tree breadth-first, is wrong in a way that is hard
to notice: one shared node budget means whichever mount sorts first consumes it, and the
rest return nothing. "No results in Teams" and "never got as far as Teams" then look
identical.

Four properties hold it together:

**Isolation.** One provider throwing must not abort the others. The whole reason to ask
four backends is that three can still answer.

**A deadline per source.** Enforced twice — an `AbortSignal` asks politely, and a race
guarantees the merge proceeds even against a provider that ignores signals. A hung tenant
must not make the tool look frozen; to someone reading one line at a time, frozen and
crashed are the same thing.

**Ranking.** Across four unrelated backends there is no shared natural order, so the query
supplies one via `scoreQuery`. Matching and scoring share a single code path — `judgeTerm`
returns a verdict *and* a quality — because a separate matcher and scorer would eventually
disagree, and put an item at the top of the results that the tool also says is not a match.
Ties break on recency, then path, so two identical runs give identical order.

**No cursor.** Resuming a merged search would mean juggling N provider cursors and
re-ranking against results the user has already seen. A cursor that quietly loses or
repeats items is worse than no cursor, so the result carries a per-source report —
including sources that failed, timed out, or were cut off — and the CLI says "showing the
top N" rather than offering `more`.

### The partial source

A source that fails is loud, and easy to report. The dangerous case is the one in between:
a source that answers normally, having skipped some of itself. A walked source absorbs a
folder it cannot list — one revoked scope should not cost you the other nine — but
absorbing it *silently* is how a partial answer comes to look like a complete one.

So `#walkSearch` counts what it skipped and returns it as `unreadable`, and
`#searchOneSource` turns a non-zero count into `status: 'partial'`. `find` then prints a
line naming the source. The same count is surfaced for a single-source search, which has
exactly the same blind spot and no federation to hide behind.

Cancellation is deliberately excluded from that absorption: the walk re-throws an abort
rather than counting it, and checks the signal each iteration rather than trusting the
provider to notice, because a Ctrl-C that only works if the backend cooperates is not a
working Ctrl-C.

## The CLI

**`session.ts`** holds mounts, cwd, the last listing, and display settings. The last listing
is what makes `cat 3` work, and its lookup order is deliberate: **names win over numbers**.
A file genuinely named `3` is reachable as `3`; the index is reachable as `#3`. The reverse
would make a legitimate filename unreachable, and the numeric form has an escape hatch while
a name does not.

**`format.ts`** renders records. Everything shown in colour is also stated in words, so
`--plain` costs appearance and never information.

**`completion.ts`** is the most accessibility-critical file in the repo, and the reasoning
is in [ACCESSIBILITY.md](ACCESSIBILITY.md).

**`shell.ts`** is the read-eval-print loop.

### stdout is data, stderr is chrome

Enforced end to end. The banner, hints, status lines, paging footers, notification
announcements, and the readline prompt itself when stdout is not a TTY, all go to stderr.

That last one was a real bug: the prompt was written to stdout, so `ls --json | jq` received
`/> [{...` and failed to parse. The rule is what makes the tool scriptable, so it is worth
stating as a rule rather than a habit.

## What is deliberately not here

**A daemon.** Every command is a cold start. Simpler to reason about, nothing to leave
running against a corporate mail account, and the cache makes it fast enough. The cost is
that watches only run while the shell is open.

**Offline sync.** The cache is a cache, not a store; there is no local mirror to fall out of
date, no reconciliation, no "why does it show a message I deleted last week". A future
offline mode would sit behind the same provider interface.

**Write-by-default.** The Graph providers ship read-only. `Mail.ReadWrite` is opt-in via
`scopes`, because a program that reads your mail and one that can alter it are different
risks and the second should be a decision.

**A full-screen TUI as the primary interface.** Opt-in, and last on the list. The reasons
are mechanical rather than aesthetic and are set out in [ACCESSIBILITY.md](ACCESSIBILITY.md).

## Testing

468 tests, no test framework — `node --test` and `node:assert`.

The load-bearing one is `packages/core/src/testing/conformance.ts`: the provider contract
expressed as an executable suite that every provider runs, including the example `exec`
plugin driven over a real child process in both transport modes. It has caught, among other
things, a provider exposing `search()` while declaring it unsupported, another exposing every
optional method regardless of capabilities, and an example plugin quietly ignoring `limit`.

`packages/cli/src/test/readline-contract.test.ts` pins an undocumented Node behaviour the
completion design depends on — that readline *replaces* the matched text rather than
appending to it. If a future Node changes that, one test fails with a clear name instead of
every quoting test failing mysteriously.

```sh
npm run build
node --test "packages/*/dist/test/*.test.js"
```
