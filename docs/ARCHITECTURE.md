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
    ┌───────────┬───────────┬─────┴──────┬────────────┬───────────┐
 graph-mail  graph-chat  graph-people  ado-boards  github/rss   exec ──► any program, any language
```

## Packages

| Package | Contains |
|---|---|
| `@mscomms/core` | Paths, naming, the provider contract, the VFS engine, query language, the graph model and mapping surface, GraphQL projections, cache, config, notifications, watches |
| `@mscomms/cli` | The shell, commands, completion, formatting |
| `@mscomms/provider-*` | memory, rss, github, graph, ado, exec |

Runtime dependencies are kept few and chosen deliberately, not avoided on principle. Today
there is one: `@libsql/client`, which backs the local snapshot store — see **The local
snapshot** below. The small parsing this program needs (JSONC, RSS, MIME-ish headers) is
still written here, because each is a few hundred well-tested lines and a package would be
more surface than substance.

## Core, module by module

**`vpath.ts`** — path arithmetic. Always `/`-separated regardless of host OS, because a
path that changes shape on Windows would leak into names, saved queries and scripts.

**`naming.ts`** — turning a backend item into a filename. Much less trivial than it sounds,
and covered in [PLUGINS.md](PLUGINS.md#names-are-yours-to-choose-and-it-matters).

**`provider.ts`** — the plugin contract. See below.

**`vfs.ts`** — the engine: mount table, resolution, listing, reading, search fan-out.

**`query.ts`** — parse, evaluate, rank and re-serialise `from:dana is:unread after:7d`,
including the Lucene modifiers (wildcards, fuzzy, proximity, ranges, boosts).

**`graph.ts`** — the graph model: typed nodes, named edges, and the tree-shaped default
every provider gets whether or not it declared one. See below.

**`mapping.ts`** — the declarative surface an integration author uses instead of
implementing `Provider` by hand. Covered in [PLUGINS.md](PLUGINS.md#the-mapping-surface).

**`graphql.ts`** — a lexer and parser for the subset of GraphQL a projection needs; the
subset is deliberate and documented in [PROJECTIONS.md](PROJECTIONS.md).

**`projection.ts`** — evaluating a query against the graph space, and the `projection`
mount type that turns the result back into a tree.

**`cache.ts`** — TTL cache for listings and documents, with explicit invalidation.

**`sql.ts`** — the storage seam: one small async interface over libSQL or Node's built-in
SQLite. See **The local snapshot** below.

**`snapshot.ts`** — the on-disk snapshot: listings, bodies, full-text and vector indexes,
sync cursors, retention.

**`vector.ts`** — hashed lexical embeddings and cosine similarity, so `find` can match on
meaning without a model or a network round trip.

**`prefetch.ts`** — the priority queue and the transition model behind predictive
cache-ahead.

**`sync.ts`** — the background loop that keeps the snapshot current.

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

The subtlety that has caused real bugs here more than once: the engine calls the method when
the capability is declared, so an optional method that is present but cannot be honoured is
a crash, and one that is absent while the capability is declared is the same crash from the
other side. Optional methods therefore have to genuinely not be installed — which a
prototype method cannot manage, since `delete` will not remove it from an instance. The
pattern is an optional field assigned in the constructor, and the conformance suite asserts
the set and the object shape agree in both directions, because they drifted apart twice
during development and once more while the mapping surface was being written.

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

## The local snapshot

Caching in memory makes the second `ls` fast. It does nothing for the first one, and the
first one is the one people judge the tool by — a mail client that stares at you for three
seconds on launch feels broken even when it isn't.

So there is an optional local database. It is off by default and every part of it is an
accelerator: a snapshot that will not open, cannot be written or answers nothing is a
slower program, never a broken one. Nothing in the read path treats its absence as an error.

### The storage seam

`sql.ts` defines a small async interface — `all`, `get`, `run`, `batch`, `exec` — and three
implementations chosen at open time:

| Driver | Storage | Replication | Vector similarity |
|---|---|---|---|
| `libsql` | local file | embedded replica of a remote | in the database |
| `libsql-remote` | none, HTTP only | is the remote | in the database |
| `node-sqlite` | local file | none | in this process |

The seam exists because of a fact about the world, not a preference: the native libSQL
binary has no prebuilt for every platform this program runs on — win32-arm64 among them —
and the pure-JS client cannot open a local file. Neither alone covers the matrix. `auto`
takes the best available and says which one it took in `cache`; pinning one that cannot
load is a startup error with a hint, because silently handing someone a local-only file
when they asked for a replica of a shared database is the wrong kind of help.

Vector support is *probed*, not inferred from the driver name — it depends on the build
that actually loaded. Guessing would turn "your SQLite is older than you thought" into an
unexplained query failure halfway through a search.

### What it stores, and what it refuses to

Listings, item metadata, message bodies, an FTS5 index, and float32 embeddings — capped at
the `recent` most recent items per folder. Directories are exempt from that cap: evicting a
folder would make the tree itself appear to shrink.

The cap is what makes the design honest. The snapshot holds the recent past, so it is
allowed to answer questions the recent past can answer and not the others:

- An ordinary `ls` is served from it, because the newest items are exactly what it has.
- A **filtered** `ls` goes to the provider. `is:unread` answered locally could report
  nothing while an unread message from six months ago sits outside the window — a wrong
  answer wearing the costume of a right one.
- `search` treats it as one source among many and **never concludes absence from it alone**.
  Local matches appear immediately, remote ones merge in as they land, and the CLI reports
  how many came from where.

It also honours the push-down trust boundary above. The snapshot never claims an
`appliedQuery`; it returns *candidates* and `evaluateQuery` decides. One query
implementation, so a filter cannot mean two different things depending on how recently you
restarted.

### Search order

Local index first, network second, both merged. The local half is FTS5 plus cosine
similarity over hashed lexical embeddings — enough for "quarterly numbers" to find "Q3
financials" without a model, a GPU or a round trip. `--local` stops there and is the
fastest answer available; on a plane it is the only one.

### Predicting the next folder

`prefetch.ts` keeps a transition model: from here, where do people go? Navigating into a
folder schedules speculative fetches of the likeliest next ones, plus the next page of the
current listing and the bodies of the first few messages, at descending priority and
bounded concurrency.

Three rules keep speculation from becoming a liability. A guess that fails is discarded
silently — it was never asked for, so it cannot produce an error the user has to read.
Invalidation cancels in-flight work, so a refresh cannot be undone from behind by a fetch
that started before it. And the model learns only from unfiltered navigation: a filtered
`ls` is someone interrogating a folder, not moving to it, and counting it would poison the
model with places nobody went.

### AgentFS, and why the gap was the driver

[Turso AgentFS](https://github.com/tursodatabase/agentfs) specifies a filesystem *as a
SQLite schema* — inodes, dentries, chunked file data, an insert-only `tool_calls` log and a
key-value store. That is an unusually good fit here, because this program's whole premise
is that comms are already a filesystem. Its tree can be written out as an actual one.

The interesting part was making it run at all. The `agentfs-sdk` package depends on
`@tursodatabase/database`, which publishes no build for win32-arm64, so importing the
package's entry point fails with *"Cannot find native binding."* The obvious reading is
that AgentFS is unavailable on this platform.

That reading is wrong, and reading the SDK's shipped source rather than its documentation
is what showed it. `AgentFS`, `ToolCalls` and `KvStore` take the database as a
**constructor argument** and use only `exec` and `prepare`/`run`/`get`/`all`. The database
type is imported *type-only*, so it erases at compile time and the classes have no runtime
dependency on the native module whatsoever. **The missing piece is the driver, not the
filesystem** — and `sql.ts` is already a driver. A twelve-line adapter from `SqlDriver` to
the shape AgentFS expects is the entire integration:

```ts
{ exec: (sql) => driver.exec(sql),
  prepare: (sql) => ({ run: (...a) => driver.run(sql, a), /* get, all */ }) }
```

So `agentfs.ts` imports the submodules directly (resolved via `import.meta.resolve`, which
locates the package without executing its entry point) when the public entry fails, and
falls back to it automatically when the native binding *is* present. The tests drive the
real, unmodified SDK — and check that it stamps `schema_version` itself, which is how we
know we are testing AgentFS rather than a reimplementation of it.

Two things are built on top:

**`cache export <path>`** turns the snapshot into a mountable filesystem. `NameAllocator`
matters more here than anywhere else: `fs_dentry` has `UNIQUE(parent_ino, name)`, so two
messages that collide on a name would not error — the second would silently overwrite the
first. Losing a message quietly is the worst failure this code could have. Export failures
are collected and reported rather than thrown, and rendered messages collapse newlines in
header values, because a subject containing `\r\nFrom: ceo@…` must not be able to forge a
sender in the file that comes out.

**`"audit": true`** records provider fetches in `tool_calls`. It stores paths and result
shapes — a byte count, an entry count — and never content: an audit log that became a
second copy of your mail would be worse than the problem it solves. It is off by default,
excluded from exports, and wrapped so that a failure to record can never interrupt the
sync it is recording.

## The graph model

A tree is a projection of a graph, not the other way around. A message has an author, a
thread, a folder and a set of attachments. A tree can show exactly one of those as
"contains" and has to drop the rest — which is fine right up until a user decides that the
one the provider picked is the wrong one.

So the model underneath the VFS is a graph. Every mount exposes a `GraphSource`: typed
nodes with scalar fields, named edges between them, and roots to start a walk from. The
tree you see is one traversal of that graph, along whichever edge the provider nominated as
`childEdge`. `/by-person` is a different traversal of the same data, and it is the same
kind of object — a mount, with listing, paging, caching, search and `cat`.

Three consequences are worth stating.

**Every source is projectable, including the ones that predate this.** A provider that
declares a `GraphSource` is used verbatim. A provider that has never heard of graphs gets
the graph its tree already implies — `children`, `descendants` and `parent`. Nothing opts
in, because a cross-source query that silently omitted a source would be indistinguishable
from a source with nothing in it, and that is a mail client losing mail.

**The graph space is assembled per operation, not per session.** `Vfs.graphSpace()` walks
the current mount table each time it is called, and `ProviderContext.graph` is a function
rather than a value so that a projection built before the mounts it reads still sees them.
Config order stops being load-bearing, and a mount added mid-session with `mount` shows up
in an existing projection without a restart.

**Limits are promises, not hints.** `MappingRequest.limit` is pushed down so a backend can
use it, but the engine caps the result regardless. A mapping that ignores the limit — most
will — must not be able to turn a bounded query into an unbounded fetch, and a projection
that can span every mount you own is exactly where that matters.

The query language over this is GraphQL, chosen because it is the standard notation for
"select this shape from a graph" and because users who have met it once do not need to
learn a second one. It is hand-parsed, like every other format here, and the subset is
described in [PROJECTIONS.md](PROJECTIONS.md). A projection cannot contain a mutation: it
is a view, and acting on something is `do`, which works normally on anything inside one.

## Searching every source at once

`Vfs.search` on a synthetic directory — the root, or any ancestor of several mounts —
fans out rather than walking. Each mount is searched through its own provider, in
parallel, and the results are merged.

The alternative, walking the synthetic tree breadth-first, is wrong in a way that is hard
to notice: one shared node budget means whichever mount sorts first consumes it, and the
rest return nothing. "No results in Teams" and "never got as far as Teams" then look
identical.

### Views are not sources

Fanning out assumes every mount beneath the root is an independent source. A projection
breaks that assumption twice over: it holds nothing of its own, so it returns items the
real sources already returned, and it spends a share of a bounded, ranked budget doing it.
Searching `/` across two sources and one projection over them gave back a majority of
duplicates, and the sources being duplicated were the ones squeezed out to make room.

So `Provider.derived` marks a mount whose contents come from other mounts, and an
un-narrowed fan-out skips it. It is still searched from inside (`find /by-person`) and
still searched when named (`find / --source by-person`), because at that point the user
has said which tree they mean. If everything beneath the root is derived they are kept
rather than dropped: a view of a source is a better answer than no answer.

Four properties hold the fan-out itself together:

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

## The people graph

`graph-people` is the one provider whose tree is not a containment hierarchy. Everything
else models "this item is inside that folder"; people model a *graph*, and the mount leans
into that rather than flattening it.

**The hierarchy is cyclic on purpose.** A person's folder contains `manager/`, `reports/`
and `peers/`, so your manager's `reports/` contains you, and `Me/manager/…/reports/…`
eventually comes back round. A tree would have forced a choice between "up" and "down", and
the question people actually have — *who else is in this part of the org* — needs both.
The engine tolerates it because its fallback recursive walk is depth- and node-bounded;
`Org/` exists to give the flat chain when that is what you wanted.

**Priority, not recency, is the ordering.** Both for a person's messages and for the people
themselves: unread → unanswered → mentioned → everything else → things you sent. "Unanswered"
is a property of a *thread*, so a colleague who sent four messages in a row is owed one reply
rather than flagged four times. Providers control their own listing order — the engine only
re-sorts when explicitly asked — which is what makes this expressible at all.

**Channels are merged, never grouped.** Mail and Teams land in one list per person. Grouping
by channel reproduces the exact failure the mount exists to fix: a reply is missed precisely
because it arrived in the app you were not looking at.

**Ranking people is a fixed cost, not a per-person one.** Working out what each person is
owed from their own correspondence would be one round trip per row, turning `ls Recent` into
thirty. Instead three mailbox-wide requests — unread inbox, recent sent items, the chat
roster — build a TTL-cached index keyed by every identifier a person is known by. That last
part matters: the mailbox knows an address and the chat roster knows a directory id, so the
index aliases both onto one entry or a colleague becomes two half-people, each carrying half
their unread count.

**Search is not declared, and the directory lookup says so.** `Directory` pushes a free-text
term into `$filter=startswith(…)` because `$search` on `/users` needs advanced query
capabilities many tenants have not enabled. `startswith` is a prefix match while the query
language means substring, so the provider never sets `appliedQuery` and the engine re-filters
— the push-down is an optimisation, not a claim.

**A cyclic mount made the engine's search dedupe by identity.** The fallback walk in `vfs.ts`
was bounded by depth and node count, which is enough to make a cycle terminate but not enough
to make it *useful*: one unanswered chat came back nine times, once per route the walk
happened to take, and the node budget went on re-reading folders it had already read. It now
tracks the provider's own `id` — defined as identifying the item rather than the path to it —
for both the results and the queue. Every provider gets the fix; only this one needed it. The
same applies to `provider-memory`, whose fixtures can now be graphs (`refs`) rather than
trees, so the offline demo models the real shape instead of a convenient approximation of it.

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

**Offline authoring.** The snapshot makes reading work with a slow or absent network, but
there is no outbox: composing a reply on a plane and having it send itself later would need
conflict handling and a delivery guarantee this does not have. Writes go to the provider or
they fail loudly.

**Write-by-default.** The Graph providers ship read-only. `Mail.ReadWrite` is opt-in via
`scopes`, and `graph-people`'s sending actions are opt-in via `allowSend`, because a program
that reads your mail and one that can send as you are different risks and the second should
be a decision.

**A full-screen TUI as the primary interface.** Opt-in, and last on the list. The reasons
are mechanical rather than aesthetic and are set out in [ACCESSIBILITY.md](ACCESSIBILITY.md).

## Testing

1148 tests, no test framework — `node --test` and `node:assert`.

The load-bearing one is `packages/core/src/testing/conformance.ts`: the provider contract
expressed as an executable suite that every provider runs, including the example `exec`
plugin driven over a real child process in both transport modes. It has caught, among other
things, a provider exposing `search()` while declaring it unsupported, another exposing every
optional method regardless of capabilities, an example plugin quietly ignoring `limit`, and
— because a mapping and a projection are both providers — three bugs in the graph work:
optional methods left on the prototype, search results missing `parentPath` at a mount root,
and a graph traversal that pushed `limit` down without enforcing it.

`packages/cli/src/test/readline-contract.test.ts` pins an undocumented Node behaviour the
completion design depends on — that readline *replaces* the matched text rather than
appending to it. If a future Node changes that, one test fails with a clear name instead of
every quoting test failing mysteriously.

```sh
npm run build
node --test "packages/*/dist/test/*.test.js"
```
