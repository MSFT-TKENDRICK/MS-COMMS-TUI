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
| `@mscomms/core` | Paths, naming, the provider contract, the VFS engine, query language, the graph model and mapping surface, GraphQL projections, cache, config, notifications, watches, the interaction journal |
| `@mscomms/cli` | The shell, commands, completion, formatting |
| `@mscomms/voice` | Speech capture, transcription, the phrase grammar, speech output |
| `@mscomms/provider-*` | memory, rss, github, graph, ado, exec |

Runtime dependencies are kept few and chosen deliberately, not avoided on principle. Today
there are two, both behind the local snapshot store: `@libsql/client`, the database driver,
and `agentfs-sdk`, which presents that database as a filesystem — see **The local snapshot**
below. The small parsing this program needs (JSONC, RSS, MIME-ish headers) is still written
here, because each is a few hundred well-tested lines and a package would be more surface
than substance.

## Core, module by module

**`vpath.ts`** — path arithmetic. Always `/`-separated regardless of host OS, because a
path that changes shape on Windows would leak into names, saved queries and scripts.

**`naming.ts`** — turning a backend item into a filename. Much less trivial than it sounds,
and covered in [PLUGINS.md](PLUGINS.md#names-are-yours-to-choose-and-it-matters).

**`provider.ts`** — the plugin contract. See below.

**`vfs.ts`** — the engine: mount table, resolution, listing, reading, search fan-out, and
filling in unread counts where a provider reported none.

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

**`journal.ts`** — the record of what happened: each interaction as a value with the command
that repeats it and, where one exists, the inverse that reverses it. Also `ChangeBus`, which
announces changes so views can follow them. See below.

**`registry.ts`** — plugin registration and mount construction.

## Interactions are values

The requirement that everything be undoable and the requirement that everything be
commandable are the same requirement wearing two hats. Both are impossible while an
interaction is a side effect inside a key handler, and both are nearly free once an
interaction is a *value*: a name, the command line that would repeat it, and optionally the
command line that would reverse it.

```ts
interface Interaction {
  label: string;         // "Marked 'FY26 budget review' as read"
  command: string;       // do read 3
  source: 'shell' | 'tui' | 'voice' | 'script';
  undo?: UndoSpec;       // the inverse, when one exists
}
```

Three things fall out of that, none of which needed their own machinery:

- **Undo** is a stack of these, and `undo` runs the inverse through the ordinary dispatcher.
- **The audit log** is the same list, printed. It records `source`, which is what lets you
  answer "did I do that, or did the recognizer mishear me?"
- **Voice** is just another producer of `command`. `@mscomms/voice` knows nothing about
  sessions, providers or the VFS — it turns audio into a string. `cli/voice-service.ts` is
  the only place the two meet, and it hands that string to the same dispatcher a typed line
  goes to. A spoken command therefore cannot do anything a typed one cannot, and inherits
  confirmation, journalling and undo without asking for them.

The inverse comes from the provider, not from the core, because only the provider knows
whether an action was actually reversible — and, importantly, whether it changed anything at
all. Marking an already-read message as read offers no undo, because reversing it would mark
unread something that was never unread.

**Undo refuses rather than skipping.** If the newest change cannot be reversed it stops and
says what is in the way. Reaching past it would mean the visible result of `undo` was
something two steps back that the user was no longer thinking about — the worst possible
behaviour for the one command whose entire promise is predictability.

## Views follow the world, they do not track it

`ChangeBus` exists so the full-screen pane never maintains a parallel idea of where it is.
Anything that changes the world emits an event; the pane folds events into its state. There
is exactly one direction of flow, so a state that disagrees with the VFS is not a bug to be
found and fixed — it is unrepresentable.

This is what makes arrow keys undoable. Pressing Enter on a folder does not assign to a
field; it runs the same journaled navigation a typed `cd` does, which is why `u` in the pane
and `undo` in the shell are the same operation.

## Four decisions worth defending

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

### The unread count belongs to the provider

A folder's unread count decides where people go next, so it has to be a number they can act
on without checking it. That makes it a trust question rather than a display one, and the
answer is the same shape as the push-down boundary above: **the engine never adjusts a count
a provider reported.** If a source says `9`, the row says `9`.

The alternative — the engine totalling a folder's cached children and adding them on — was
built, and it failed in the only test that counts. `demo-mail` read `21` at the root and `26`
a moment later, because browsing into `Inbox` had filled the cache the total was derived
from. A number that grows while you look at it is a number people stop reading, and it also
double-counts the moment a provider starts totalling its own subtree, which is precisely what
a provider whose children are all folders has to do.

What the count *means* is therefore the provider's decision, and it differs by source for
good reason. A mail folder reports its own level, because that is what Outlook and Gmail show
and what users already expect. A chat roster reports its subtree, because the folder is only
a container and a `0` on it would be a lie. Both are right; only the provider can tell which
case it is in.

The engine's remaining job is narrow: where a provider reported *nothing*, fill a number in
from directories already listed and cached, so a parent is not blank while its children are
visibly counted. That derivation never fetches — it runs with a user waiting on a listing,
and turning one `ls` of eight mounts into eight round trips for a decoration is not a trade
worth making — and it is bounded to a few levels because the people graph is genuinely
cyclic.

Where it has only seen part of a folder, it offers a floor rather than a total: `26+`, not
`26`. The first rule written here was the opposite — a partly-paged directory contributed
nothing, on the grounds that a floor presented as a total is worse than no total. That
reasoning was right about the risk and wrong about the remedy, and the cost was severe. A
mount root is handed over one page at a time and warmed one page deep, so on a real mailbox,
a real Teams roster and a real people directory the root keeps a cursor for the entire
session; under the old rule those rows were never going to show a number. Not slowly —
never. Marking the floor keeps the honesty and drops the silence: `26+` says what is known
and admits what is not. `unreadPartial` on the node carries it, the engine sets it and
providers do not, and it clears itself when the rest of the listing arrives.

Silence is preserved throughout. `undefined` means "nobody could count", `0` means "somebody
counted and found nothing", and the engine will not convert the first into the second.
GitHub is the case that forces this: its API has no notion of whether you have seen an issue,
so those rows wear no counter rather than claiming everything is read. A floor of zero is not
a floor either — an incomplete listing of a source with no read state stays silent.

For the counter to be there on the *first* listing, the derivation needs warm prefetch work
to survive navigation, which it now does — warm tasks are the lowest-ranked work in the
queue, and a foreground request holds the queue for as long as it is outstanding, so keeping
them costs nothing in contention.

That still leaves a window, and it is the one the user is actually in. The synthetic root
paints instantly; the sources behind it have not answered yet; a count derived from an empty
cache is therefore correctly absent, and becomes correct a moment later. The missing half was
that nothing told the screen. So when a listing lands, the engine walks up from it and
announces any ancestor whose counters have moved, over the same `onListingChanged` the
full-screen view was already subscribed to. Three details make it quiet rather than annoying:
an ancestor is only eligible once somebody has actually listed it, so resolving a deep path
does not announce directories nobody is looking at; the comparison is over the counts alone,
not the whole listing, so a relative timestamp ticking over a minute boundary does not
repaint a list somebody is reading; and the listing fingerprint had to start including
`unreadCount`, or a corrected number was computed, compared, found "unchanged" and dropped.

Where the derivation genuinely cannot be made correct, it defers. Adding up the top-level
folders of a mount assumes they are disjoint, which is false for any source shaped like a
graph — see the people directory below — so `Provider.unreadTotal()` lets a source state its
own whole-mount figure, and the engine prefers it. It must answer without I/O, and must say
`undefined` rather than `0` when it has no basis, which keeps both rules above intact.

## The local snapshot

Caching in memory makes the second `ls` fast. It does nothing for the first one, and the
first one is the one people judge the tool by — a mail client that stares at you for three
seconds on launch feels broken even when it isn't.

So there is an optional local database. It is off by default and every part of it is an
accelerator: a snapshot that will not open, cannot be written or answers nothing is a
slower program, never a broken one. Nothing in the read path treats its absence as an error.

### The storage seam

`sql.ts` defines a small async interface — `all`, `get`, `run`, `batch`, `exec` — and two
implementations chosen at open time:

| Driver | Storage | Vector similarity |
|---|---|---|
| `libsql` | local file | in the database |
| `node-sqlite` | local file | in this process |

The seam exists because of a fact about the world, not a preference: the native libSQL
binary has no prebuilt for every platform this program runs on — win32-arm64 among them —
and on those platforms importing it throws at load. `auto` takes the best available and
says which one it took in `cache`; pinning one that cannot load is a startup error with a
hint, because a stack trace at startup is a worse answer than a working local cache.

**The snapshot never leaves the machine.** libSQL will replicate a local file to a hosted
Turso database by setting one key, `syncUrl`, and this layer deliberately does not offer
it. The snapshot holds subjects, participants and message bodies, so a replica is an
export of corporate mail to somebody else's server, and one config line is too short a
distance between "cache" and "exfiltration". The capability is *absent* rather than
discouraged: `createClient` is handed a file URL and nothing else, and `cache.syncUrl` and
`cache.authToken` are rejected by the config validator rather than ignored — a setting
that looks accepted and silently does nothing would leave somebody believing their mail is
somewhere it is not.

Vector support is *probed*, not inferred from the driver name — it depends on the build
that actually loaded. Guessing would turn "your SQLite is older than you thought" into an
unexplained query failure halfway through a search.

FTS5 is probed the same way, and for a reason found by running the code rather than
reasoning about it: Node did not bundle the extension in `node:sqlite` until v23, so on
Node 22 — an LTS, inside the supported range — creating the index raises "no such module:
fts5". That used to abort `SnapshotStore.open`, which meant the entire snapshot silently
did not work on a supported runtime. Now the index is created separately from the rest of
the schema and its absence is recorded, so text search degrades to a LIKE scan while
listings, retention, prefetch and vector similarity carry on unaffected. The probe runs on
every open rather than once, because FTS5 is a property of the SQLite build and the same
file can be opened by two different Nodes.

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

A fourth rule was missing, and it was the one people actually felt. Priority orders the
queue; it does not make the queue get out of the way. Once a speculative fetch has been
handed to a transport that serialises everything down a single pipe — which is what MCP is,
and what `/mail`, `/teams` and `/people` all run over — the user's own request queues behind
it, priority no longer applies because the work has already left, and cancelling does not
help because a request that has been sent cannot be unsent. Navigating into a folder took
2.6 seconds against a provider that answers in 0.9.

So speculation yields twice. Every non-speculative `list` and `read` takes a
`PrefetchQueue.hold()` for as long as it is outstanding, which stops anything new from
starting; and speculation runs one request at a time, which bounds what can already be in
flight. That second number is not a tuning constant — it *is* the foreground's worst-case
wait, measured in whole provider round trips, and at two it was putting 1.6 seconds of
guesswork in front of a keypress. Together they take the same navigation to 1.65 seconds, of
which 0.9 is the request the user actually asked for. On a serialised transport that is the
floor.

Holds are reference-counted and speculative callers do not take one — a prefetch task runs
*inside* the queue, so a hold taken from there would stop the queue from starting anything
else until that task finished, quietly reducing concurrency to nothing.

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

**And it made the unread counter dedupe too, in two different places.** The number on a
folder is derived by adding up what is beneath it, which is only valid if "beneath it" is a
tree. Here the same person is under `Org`, `Recent`, `Colleagues` and the `Directory` they
are defined in, and the demo org chart's six unread messages were being reported as
thirty-three on the row standing for the whole mount. Inside a subtree the engine can fix
this itself, and does: the walk in `#unreadBeneath` counts each `id` once however many routes
reach it. There is a condition on that, and it is a condition on the provider rather than the
engine: the walk stops at any node that states a count of its own, because that count is
final, so it only dedupes over nodes it actually reaches. Sections that each state a total
are summed as if disjoint. Putting the count on the person, under an id naming the person
rather than the route to them, is what makes the walk work — which is what `graph-people`
does. Between the top-level sections the engine cannot fix it at all — each has handed over
an opaque total and nothing in it says which of them overlap — so `Provider.unreadTotal()`
exists for a source to state its own, and the engine takes it in preference to its own
arithmetic. Providers that do not implement it keep the derived number, which is every
provider until one has a reason not to.

## Two ways into Microsoft 365

The three Graph providers reach Microsoft the same way, through one narrow interface in
`provider-graph/src/client.ts`:

```ts
interface GraphApi {
  get<T>(path): Promise<T>;
  getPage<T>(path): Promise<GraphPage<T>>;
  getBytes(path): Promise<{ bytes: Uint8Array; contentType: string }>;
  post<T>(path, body): Promise<T>;
  patch<T>(path, body): Promise<T>;
}
```

Five methods, and `mail.ts`, `chat.ts` and `people.ts` know nothing else about how a request
is made. There are two implementations behind it, and `createClient` in `shared.ts` is the
single place that chooses:

**`GraphClient` — HTTPS with a device-code token.** The original path. Prints a URL and a
code, caches the refresh token in the data directory, and talks to `graph.microsoft.com`.

**`McpGraphApi` — an already-authenticated MCP server over stdio.** Spawns a Microsoft 365
MCP server, speaks JSON-RPC 2.0 over newline-delimited stdio, and maps each `GraphApi` call
onto a tool: `get`/`getPage` → `fetch`, `getBytes` → `fetch_blob`, `post` → `do_action`,
`patch` → `update_entity`. **The server holds the identity**, which is the whole point: on a
machine where the user is already signed into M365, asking them to sign in again is not a
security property, it is a second credential to manage and a prompt to dismiss.

`resolveTransport` picks: an explicit `transport` wins, then a non-blank
`MSCOMMS_GRAPH_TOKEN` (already promptless, and it names an exact audience), then an MCP
server if one can be discovered, then device code. Discovery is **by name**, never by
guessing which installed server looks mail-capable.

Three things about this were only learnt by running it, and are worth not rediscovering:

**Relative paths, absolute next links.** The MCP server requires relative entity paths, but
`@odata.nextLink` is always absolute. Without `toRelativeGraphPath` stripping the origin,
page one works and page two silently returns nothing — the failure appears as a short list,
not as an error. A mutation test guards it.

**The payload is not where the protocol says it is.** `tools/call` returns `content: []` and
puts the real body in `structuredContent`. The parser prefers `structuredContent` and falls
back to a JSON block in `content[].text`, so the day a server does the conventional thing it
keeps working.

**A child process is three handles, not one.** The child *and each of its stdio pipes* keep
the libuv loop alive, so a one-shot command like `mscomms ls /mail` printed its answer and
then hung forever. `unref()` on all four fixes it; an in-flight request holds the loop open
via its own timeout timer. Shutdown ends stdin first and only then kills, because on Windows
the direct child is `cmd.exe` and killing it would orphan the real server.

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

1395 tests, no test framework — `node --test` and `node:assert`.

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
