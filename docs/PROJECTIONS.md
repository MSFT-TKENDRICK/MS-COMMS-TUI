# Projections

The tree a source ships with is one opinion about navigation, not the only possible one.

`graph-mail` gives you folders because Outlook has folders. GitHub gives you repositories
because GitHub has repositories. Neither of them knows that you think in people, or in
weeks, or in "things I have not replied to". A projection is how you say so — a GraphQL
query over every mapped source, mounted back as an ordinary directory tree.

```jsonc
{
  "path": "/by-person",
  "type": "projection",
  "options": {
    "query": "{ all @flatten @group(by: \"author\") { name mtime } }"
  }
}
```

That mount is a real mount. It lists, pages, caches, searches, completes, and `cat` on a
message inside it opens the actual message. It is not a report.

## Why the mapping is a graph

Trees are a projection of a graph, not the other way around. A message has an author, a
thread, a folder and a set of attachments; a tree can only show you one of those as
"contains" and has to drop the rest. Since the whole point here is letting you pick a
different containment, the underlying model has to keep the relationships a tree throws
away.

So every mounted source is exposed as a graph: typed nodes with fields and named edges.
A provider that declares one gets used verbatim. A provider that has never heard of graphs
gets the graph its tree already implies — `children`, `descendants` and `parent` — so it is
projectable anyway. Nothing has to opt in, because a projection over "all sources" that
silently omitted one would be indistinguishable from a source with nothing in it.

## The loop

Write a projection by trying one, not by reading a document.

```sh
mscomms schema                      # what can I select?
mscomms schema --source mail        # just one source
mscomms graphql '{ all(filter: "is:unread") { name source } }'
```

`schema` prints SDL built from the mounts you actually have, so it cannot go out of date.
`graphql` runs a query and prints JSON. When the answer looks right, the same query text
goes into a `projection` mount and becomes a tree.

Queries get long, so `graphql` also reads from a file or a pipe:

```sh
mscomms graphql --file ~/projections/by-person.graphql
cat query.graphql | mscomms graphql -
```

## What you can select

### Root fields

| Field | Meaning |
|---|---|
| `nodes`, `all` | Everything in every mapped source. |
| `<source>` | Everything in one source — `mail`, `tickets`. |
| `<source>_<root>` | One named entry point — `mail_messages`. |

`nodes` and `all` are the same field under two names, because both readings are natural.

Source names are the mount ids, rewritten to be legal GraphQL names: `demo-mail` becomes
`demo_mail`. `schema` prints the rewritten name, and `mounts` prints the original.

### Arguments

| Argument | Applies to | Meaning |
|---|---|---|
| `filter` | any field | A query in the same language as `find`: `"from:dana is:unread"`. |
| `first` / `limit` | any field | Maximum entries. |
| `orderBy` | any field | `name`, `date`, `author` or `size`, plus `asc`/`desc`. |
| `source` | `nodes` / `all` | Restrict the fan-out to one source. |
| `type` | `nodes` / `all` | Restrict to one node type. |

`filter` is re-applied locally after the source has answered, whether or not the source
claimed to have applied it. That is the same push-down trust boundary the VFS applies to
`list`, and for the same reason: filtering twice is cheap, and silently dropping a message
is not.

### Fields on a node

Every node has the built-ins, whatever its source:

`name`, `title`, `kind`, `id`, `author`, `mtime`, `size`, `summary`, `flags`, `path`,
`source`, `type`, `childCount`, `unreadCount`.

Sources add their own — `folder` on a mail message, `state` on an issue. `schema` lists
them per type. A source's metadata is also readable by its bare key, so `meta_project` and
`project` both work; a built-in name always wins, so a source cannot shadow `name`.

## Directives — how a query becomes a tree

A GraphQL result is nested JSON. These four say how that nesting turns into directories.

### `@group(by:, name:)`

Builds one directory per distinct value.

```graphql
{ all @group(by: "author") { name mtime } }
```

```
/by-person/all/alice/
/by-person/all/bob/
```

`name:` templates the label, with `{value}` standing for the group:

```graphql
{ all @group(by: "author", name: "from {value}") { name } }
```

Nodes with no value for the field land in `(none)` rather than disappearing.

### `@flatten`

Removes a level, lifting a field's entries into its parent.

```graphql
{ mail @flatten { name } }          # messages directly at the mount root
```

Without it, `{ mail { name } }` gives you `/view/mail/<messages>`. With it, `/view/<messages>`.

This is what most single-field projections want, since the mount path already names the
thing. Combined with `@group` it is the difference between `/by-person/all/alice` and
`/by-person/alice`:

```graphql
{ all @flatten @group(by: "author") { name mtime } }
```

### `@name(field:, template:)`

Renames entries.

```graphql
{ tickets @name(template: "{author} - {title}") { name } }
```

Collisions still get a `~2` suffix, because sibling names have to be unique.

### `@sort(by:, order:)`

Orders entries within a directory.

```graphql
{ mail @sort(by: "mtime", order: "desc") { name } }
```

### `@as(kind:)`

Forces `dir` or `file`, for the rare case where the source's own answer is unhelpful.

## The fall-through rule

An entry the projection stops describing keeps its own children.

```graphql
{ folders { name } }
```

This says nothing about what is inside a folder, so the folder still opens and still shows
the source's messages. The alternative — folders that exist but cannot be opened — looks
exactly like the mail having gone, and a projection re-organizes data rather than deleting
it.

Selecting a sub-field is how you take control of a level:

```graphql
{ folders { name messages @sort(by: "mtime", order: "desc") { name } } }
```

## Aliases, fragments and variables

Standard GraphQL, and they all do something useful here.

An alias renames a directory:

```graphql
{ Correspondence: mail { name } }
```

A fragment stops you repeating a field list:

```graphql
{ mail { ...card } tickets { ...card } }
fragment card on Node { name author mtime }
```

Variables keep a projection general, and are supplied by the mount:

```jsonc
{
  "path": "/mine",
  "type": "projection",
  "options": {
    "query": "query Mine($who: String!) { all(filter: $who) { name } }",
    "variables": { "who": "from:me" }
  }
}
```

At the prompt, `graphql --var who="from:me"` does the same thing.

A variable that is never supplied is an error naming the variable, not an empty result.

## Mount options

| Key | Type | Meaning |
|---|---|---|
| `query` | string | The projection, as GraphQL. |
| `queryFile` | string | Read it from a file instead. Relative paths resolve next to the config file. |
| `operation` | string | Which named operation to run, when the document has more than one. |
| `variables` | object | Values for the query's variables. |
| `defaultLimit` | number | Entries fetched per field when the query does not say. Defaults to 200. |

`queryFile` is worth using once a projection outgrows a JSON string, since escaping quotes
inside JSONC gets unpleasant fast.

Errors surface when the mount is built, not on first `ls`: a syntax error, an unknown
operation name or a missing variable all fail at startup with the position in the query.

## Things that will not work, and why

**A projection cannot contain a mutation.** It is a view. Acting on an item is `do`, which
works normally on anything inside a projection — the action runs against the real source,
and both the projected path and the original are invalidated.

**A projection does not include itself.** A projection is a mount, so a projection over
"all sources" would otherwise recurse until the stack gave out. Anything at or beneath the
projection's own path is excluded, which also covers projecting a projection.

**Depth is bounded.** Nesting is capped, and search through a projection is bounded by node
count and depth. A projection can span every mount you have, and an unbounded walk of that
is a hang; a bounded page is the same bargain `list` already makes.

## Worth knowing

Listing is lazy. Listing the root of a projection over eight sources does not touch any of
them — it draws eight directories. Only opening one resolves anything.

The graph space is rebuilt per operation, so a mount added mid-session with `mount` shows
up in an existing projection without a restart.

Deep paths survive a cold cache. Frame ids are hierarchical, so `cat /by-person/alice/3`
in a fresh process re-evaluates the projection level by level until it matches. Slower than
a warm walk, never wrong.

## See also

- [CONFIGURATION.md](CONFIGURATION.md#projection--a-graphql-view-of-your-other-mounts) — the mount type.
- [PLUGINS.md](PLUGINS.md#the-mapping-surface) — making your own integration projectable.
- [ARCHITECTURE.md](ARCHITECTURE.md#the-graph-model) — why the model is a graph.
