# Writing a provider

There are three ways to add a source.

| | `exec` plugin | Mapping | TypeScript provider |
|---|---|---|---|
| Language | Any | TypeScript or JavaScript | TypeScript or JavaScript |
| Distribution | A file. Point the config at it. | An npm package or a module path | An npm package or a module path |
| Isolation | Separate process | In-process | In-process |
| Speed | One IPC round trip per request | Direct call | Direct call |
| Effort | About forty lines | Describe your types and edges | Implement an interface |
| Projectable | Via its tree | Via your own graph | Only if you write one |

The `exec` tier exists because the alternative is telling a Python person to learn the
TypeScript build. `examples/notes-plugin.mjs` is a complete working plugin in one
dependency-free file; copying it is a legitimate way to start.

If you are writing TypeScript, start at [the mapping surface](#the-mapping-surface). It is
less code than implementing `Provider`, and it is the only route that gives users a real
graph of your integration to write [projections](PROJECTIONS.md) against.

## The model you are implementing

Everything is a tree of nodes. A node is a directory or a file:

```ts
interface VNode {
  name: string;          // required; the filename, must be unique among its siblings
  id: string;            // the backend's real identifier; defaults to name
  kind: 'dir' | 'file';  // defaults to 'file'
  title?: string;        // human title, if different from the name
  mtime?: Date;
  size?: number;
  flags?: string[];      // 'unread', 'flagged', 'attachment', 'mention', 'draft'
  summary?: string;      // one-line preview
  author?: string;
  meta?: Record<string, unknown>;  // anything else; queryable as meta.key:value
  childCount?: number;
  unreadCount?: number;
  parentPath?: string;   // required on search results, which have no listing context
}
```

Only `name` is genuinely required. A provider that returns `{name, kind, id, mtime, author}`
is already useful.

### Names are yours to choose, and it matters

The engine will not rename your nodes. If you emit `AAMkAGI2...`, that is what the user
types. Emit something a person can read and complete: a date prefix sorts usefully and
disambiguates, and a truncated subject is a better filename than a GUID.

Names must be unique among siblings and must survive being typed into a shell. The engine
provides helpers for this — `sanitizeSegment` and `NameAllocator` in `@mscomms/core`, with
`timestampPrefix` for date prefixes and `inferExtension` for extension handling — which deal
with the cases you will otherwise discover in the field: `/` and `\0`, the Windows reserved
device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`), trailing dots and
spaces, names that normalise to the same string under NFC, empty names, and names long
enough to break a filesystem. `NameAllocator` adds a `~2` suffix to collisions, like
Explorer, and puts it before the extension rather than after.

If you are writing an `exec` plugin in another language, do the same work. The demo fixture
deliberately contains a message named `CON`, a 200-character subject, an emoji, and two
messages with identical subjects, because those are the four things that break naive
implementations.

### `unreadCount` is a promise about cost

A directory that reports `unreadCount` gets a counter drawn on its own row, in `ls` and in
the pane, and that row is how a user decides where to go. So it is worth filling in — and
worth filling in under one constraint: **`list()` on the parent must not go to the network to
compute it.** A listing of eight mailboxes that fans out into eight requests is a listing that
is slow when it works and broken when it doesn't. Report the number if you already know it,
from the same response that gave you the children, from a counts endpoint you were calling
anyway, or from something you wrote down last time. Otherwise leave it `undefined`.

`undefined` and `0` are different claims, and the shell prints neither, but it will not turn
one into the other: a source that cannot count must not be made to look like one that counted
and found nothing.

**Your number is final.** The engine never adds to a count you reported, so report the number
you want a person to read on that row and nothing else has to be arranged around it. What
that number means is your decision: a mail folder that says `9` means nine messages in *that*
folder, which is what every mail client does and what users already expect, while a folder
whose children are all folders should count its whole subtree or it will read `0` while
holding unread mail. Only you can tell those two cases apart, which is why the choice lives
here.

Where you report nothing, the engine may fill a number in from directories it has *already*
listed and cached, purely so a parent isn't blank while its children are visibly counted. It
never fetches to do this, it stops a few levels down, and it stays silent rather than guess:
a partially-paged directory yields no number at all, because a floor presented as a total is
worse than no total. It also counts each `id` once however many folders lead to it, so a
source whose tree is really a graph is not inflated by its own cross-references.

### `unreadTotal()` — for the row standing for your whole mount

Optional, and only worth implementing if the engine would otherwise get it wrong.

The row for `/mail` in `/` has no node of yours behind it, so its counter is obtained by
adding up the counts of the folders you returned at the top level. For a mailbox that is
correct. For anything shaped like a graph it is not: in a people directory the same person is
under `Org`, under `Recent`, under `Colleagues` and in the `Directory` they are defined in,
and the totals of those sections overlap in a way nothing outside your provider can see. The
demo org chart's six unread messages were being reported as thirty-three.

```ts
unreadTotal(): number | undefined {
  return this.#index === undefined ? undefined : this.#index.distinctUnread;
}
```

Two obligations, both the same ones `unreadCount` carries. **No I/O** — this is called while
a listing is being rendered, and a root that went to the network would make `ls /` fail
offline for the sake of a badge. And **`undefined`, never `0`, when you have no basis**: a
source that has fetched nothing yet, or has no concept of read state, has to stay silent.
Returning `undefined` simply leaves the engine's own arithmetic in place, which is what every
provider that does not implement this gets. If you throw, or answer with something that is
not a whole number, the engine logs it, drops the badge and renders the listing anyway.

This one is in-process only. It is synchronous by design — that is how "no I/O" is enforced
rather than merely requested — and there is no way to make a synchronous call across the
`exec` protocol's pipe. An `exec` plugin keeps the derived number, which for a tree-shaped
source is the same answer.

If the backend has no server-side notion of read — feeds mostly don't — you can keep the
state yourself in `context.state`, which is exactly what `provider-rss` does; read it for the
shape. Two rules there are easy to get backwards. **Listing a folder does not read it**, or
the counter resets at the moment you look at the thing it is attached to and therefore counts
nothing. And **the first sight of a source is silent**: a feed subscribed to this morning is
not forty articles you have failed to read, and a counter whose first value is `40` is one the
user learns to ignore on day one.

Some sources have no read state to report. GitHub issues and pull requests are the clear
case: nothing in the API says whether you have seen one, so those directories stay
`undefined` and wear no counter. That is the honest answer, and it is better than a `0` that
would quietly claim everything had been read.

## The `exec` protocol

One JSON object per line on stdin, one per line on stdout.

```
-->  {"id": 1, "method": "list", "params": {"parent": null, "limit": 50}}
<--  {"id": 1, "result": {"entries": [{"name": "hello.txt", "kind": "file", "id": "1"}]}}
```

Errors use the same envelope:

```
<--  {"id": 1, "error": {"code": "ENOENT", "message": "No such folder"}}
```

**`stderr` is yours.** The host logs it and never parses it, so `console.error` is a safe
debugging tool. `console.log` is not — it writes into the protocol stream and will corrupt
the next response. This is the single most common way to break a plugin, and the reason the
example plugin says so twice.

### Methods

Every method is optional except `list`.

| Method | Returns | Notes |
|---|---|---|
| `initialize` | `{protocol, displayName, capabilities}` | Called once at startup. |
| `list` | `{entries: VNode[], cursor?}` | `params: {parent, limit?, cursor?, query?, sort?}` |
| `resolveChild` | `VNode \| null` | Resolve one name without listing the whole folder. |
| `read` | `{title, headers, body, format}` | `format` is `text`, `markdown` or `html`. |
| `search` | `{entries: VNode[]}` | Entries **must** carry `parentPath`. |
| `poll` | `{changes: [{type, path, at}], cursor}` | For watches and notifications. |
| `actions` | `[{name, label, params?, destructive?}]` | What `do` can offer. |
| `invoke` | `{ok, message, invalidates?}` | `invalidates` lists paths to drop from cache. |
| `readAttachment` | `{name, contentType, data}` | `data` is base64. |

If you implement none of the optional ones, you get a browsable, readable tree, and every
other feature degrades to something sensible rather than erroring.

### Capabilities

Declare what you support in `initialize`:

```json
{"id": 1, "result": {"protocol": 1, "displayName": "Jira", "capabilities": ["list", "read", "search"]}}
```

The valid values are `list`, `read`, `search`, `poll`, `actions` and `attachments`.

Declaring a capability you have not implemented is worse than not declaring it: the shell
will offer the feature and the user will get an error where they were promised a result.

If you skip `initialize` entirely, the mount assumes `list` and `read`, which is why a
fifteen-line script works without a handshake.

**The mount config can restrict you.** If the user writes `"capabilities": ["list", "read"]`
in their config, that acts as a ceiling and is intersected with what you declare — so a
plugin offering `actions` will not be given them. This is not a sandbox; you are an
arbitrary program with the user's privileges and could do anything regardless. It exists so
that a user who wants a read-only mount gets one, and so their config file does not say one
thing while the program does another.

### Paging

Return a `cursor` alongside `entries` and expect it back on the next call. Any opaque
string works. Omit it to mean "that was everything".

Honour `limit`. A plugin that ignores it and returns forty thousand rows makes the shell
appear to hang, and through a screen reader an unexplained delay reads as a crash.

### Search

The `query` parameter arrives as a **string** in the plugin's own text form, e.g.
`is:unread from:dana after:7d`. Parse what you can and ignore what you cannot.

You do not have to be exhaustive. The engine re-filters your results locally unless you
echo back an `appliedQuery` that exactly matches what you were given. Returning a superset
is correct and safe; the honest failure mode is to return too much, never too little.

The `query` passed to `list` is informational only, always. Use it to push filtering down to
your backend if you can, and ignore it otherwise.

### Transport

By default the process is started once and kept alive. Set `"oneshot": true` in the mount
options to get a fresh process per request instead, which suits a shell script that has no
way to hold state. The protocol is identical; only the lifetime changes.

## Trying it

```jsonc
{
  "mounts": [
    { "path": "/notes", "type": "exec",
      "options": { "command": ["node", "examples/notes-plugin.mjs", "--root", "."] } }
  ]
}
```

```sh
mscomms -c ./my-config.jsonc mounts     # confirms it started and shows its capabilities
mscomms -c ./my-config.jsonc ls /notes
mscomms -c ./my-config.jsonc --verbose ls /notes   # protocol traffic on stderr
```

`mounts` is the fastest way to see whether your handshake worked: it prints the capability
set the host actually ended up with.

## Testing it

The contract is available as an executable test suite, so you do not have to guess what
"correct" means:

```ts
import { conformanceTests } from '@mscomms/core/testing';

for (const testCase of conformanceTests({ create: () => myProvider, offlineOnly: true })) {
  it(testCase.name, () => testCase.run());
}
```

It checks the things that are easy to get subtly wrong: that paging terminates and does not
repeat or drop entries, that names are unique and safe, that search results carry
`parentPath`, that `resolveChild` agrees with `list`, that cursors are honoured, and —
importantly — that the object's shape matches its declared capabilities.

That last one has caught real bugs in this repo more than once. If you declare `search`, the
engine will call `provider.search`, so the method has to actually be there — and, in the
other direction, a method that *is* there while the capability is not means the shell never
offers a feature you already wrote.

The trap is that an optional method has to genuinely not be installed, which is harder than
it sounds in a class. A method lives on the prototype, so it exists on every instance no
matter what the constructor decided, and `delete this.search` cannot remove it. Declare
optional capabilities as optional *fields* and assign them only when you can honour them:

```ts
class MyProvider implements Provider {
  readonly search?: (query: Query, options: SearchOptions) => Promise<SearchPage>;

  constructor(canSearch: boolean) {
    if (canSearch) this.search = (query, options) => this.#searchImpl(query, options);
  }
}
```

`MemoryProvider` and `MappedProvider` both do this, and the conformance suite is what
keeps them honest.

`packages/provider-exec/src/test/conformance.test.ts` runs this suite against the example
plugin over the real protocol, in both transports. It is a working example of testing a
plugin from the outside, in whatever language.

## Writing a TypeScript provider instead

Implement `Provider` from `@mscomms/core` and export a factory. The interface is the same
model as the wire protocol, with types.

The one rule that surprises people: **providers never parse paths.** Every operation
receives a resolved `VNode | null`, never a string path. Path syntax, mount boundaries,
`..`, and the root are the engine's business. This exists because five providers each
parsing paths is five chances to disagree about what `/a//b/../c` means, and users notice
disagreements between mounts long before they notice a bug in any one of them.

Register it with:

```jsonc
{ "plugins": ["./my-provider.js"] }
```

Then use its type name in a mount. `plugins` runs your code in-process; prefer `exec` for
anything you did not write yourself.

## Actions

An action is a verb a user can run against one node: approve a pull request, reply to a
mail, close an issue. `Provider.actions(node)` advertises them and `Provider.invoke(node,
name, params)` performs them, and the two must agree — an action offered but not handled
tells the user "not supported" about a verb they were just shown, and an action handled but
no longer offered is dead code nobody can reach.

`ActionRegistry` removes that possibility by deriving both halves from one table. Each verb
is a single object: what it advertises, when it applies, and what it does.

```ts
import { ActionRegistry, requiredText, type ActionCommand } from '@mscomms/core';

interface Ctx { readonly client: MyClient }

const approve: ActionCommand<Ctx> = {
  descriptor: {
    name: 'approve',
    label: 'Approve this pull request',
    description: 'Submit an approving review.',
    group: 'review',
    key: 'a',
    params: [{ name: 'body', type: 'text', label: 'Review comment', required: true }],
  },
  applies: (node) => node.subtype === 'pull' && !(node.flags ?? []).includes('merged'),
  async run({ node, params, context }) {
    const url = await context.client.approve(node.id, requiredText(params, 'body'));
    return { ok: true, message: `Approved ${node.title}.`, details: [url] };
  },
};

const registry = new ActionRegistry<Ctx>([approve /* , ... */]);
```

Wire it to the provider once and never think about it again:

```ts
actions(node) { return registry.descriptors(node, this.#ctx); }
invoke(node, name, params) { return registry.invoke(name, node, params, this.#ctx, this.id); }
```

### `applies` is the whole point

It is what makes actions contextual rather than merely typed. "Approve" is not a property of
pull requests in general; it is a property of *this* one, which is open, is not a draft, and
is not already merged. Encoding that as a predicate beside the descriptor means the list a
user is offered is the list that will actually work. The alternative — offering a verb and
then explaining why it was refused — is a worse interface, and for someone driving by
keyboard or by voice it is a longer one.

Omit `applies` to mean "always".

### Parameters are declared, not parsed

`params` states which arguments exist, which are `required`, what `type` each is (`text`,
`number`, `boolean`, `choice`) and, for a choice, the legal `choices`. The registry enforces
that declaration **before** `run` is called, so a command receives values that are already
present and already the right type. Do not re-check them.

Unknown parameters are rejected rather than ignored, with a "did you mean" for near misses.
`--commnet "looks good"` that silently approves with no comment is a wrong answer wearing
the costume of a right one, and it cannot be taken back.

Use `requiredText`, `optionalText`, `optionalFlag`, `metaText` and `metaNumber` to read
them; they express intent and keep the types honest.

### Descriptor fields the shell uses

| Field | Effect |
|---|---|
| `label` | The sentence shown in the palette and in `actions`. |
| `group` | Sorts related verbs together — `review`, `reply`, `state`, `triage`. |
| `key` | A *requested* accelerator. Collisions are resolved by the frontend, so treat it as a hint. |
| `destructive` | The shell confirms first: `--yes` on the command line, `y` in the palette. |
| `params` | Drives both flag parsing and the palette's prompts. |

`ActionResult.details` carries anything longer than one line, such as the URL of a review
just submitted. `message` is the sentence a screen reader announces, so keep it short and
put the rest in `details`. List every path whose cached state you invalidated in
`invalidates`, or the listing will keep showing the state you just changed.

### How it reaches the user

Actions are surfaced three ways from the same descriptors, so anything you declare works in
all of them with no extra wiring:

- `actions <item>` lists what applies, and `do <verb> <item> --body "…"` runs it.
- In the full-screen shell, `a` opens a contextual palette on the selection, prompts for
  each declared parameter in turn, confirms anything destructive, then refreshes the view.
- Anything driving the shell by text or voice uses the same two commands.

Mark a verb `destructive` if it cannot be undone. Merging and deleting are not the same
class of thing as flagging, and the shell is the only place that distinction can be
enforced consistently.

### From a mapping, or over the wire

A mapping type declares `invoke` and the mount gains the `actions` capability
automatically; see below. An `exec` plugin implements the `actions` and `invoke` methods of
the wire protocol and gets the same treatment — the registry is a convenience for
in-process providers, not part of the contract.

## The mapping surface

Implementing `Provider` means writing paging, cursors, name allocation, `resolveChild`,
search and a graph — the same six things every integration writes, differently, and gets
subtly wrong in its own way. A **mapping** is the declarative alternative: describe the
kinds of thing your API has and how they connect, and `defineMapping` produces an ordinary
`ProviderPlugin` with all of that already built.

```ts
import { defineMapping } from '@mscomms/core';

interface Issue { id: string; title: string; state: string; user: string; at: string }

export const trackerPlugin = defineMapping<{ project: string }>({
  type: 'tracker',
  displayName: 'Tracker',
  setup(options) {
    return {
      types: [
        {
          name: 'Issue',
          key: (i: Issue) => i.id,
          title: (i: Issue) => `#${i.id} ${i.title}`,
          datePrefix: true,
          extension: '.md',
          mtime: (i: Issue) => new Date(i.at),
          author: (i: Issue) => i.user,
          flags: (i: Issue) => (i.state === 'open' ? ['unread'] : []),
          fields: [
            { name: 'state', type: 'String', value: (i: Issue) => i.state },
          ],
          read: (i: Issue) => ({ body: i.title, headers: [['State', i.state]] }),
        },
      ],
      roots: [
        {
          name: 'issues',
          type: 'Issue',
          universal: true,
          resolve: (request) => fetchIssues(options.project, request.limit),
        },
      ],
    };
  },
});
```

That is a complete, first-class mount. It lists, pages, caches, completes, searches,
watches, and appears in `schema` as a graph users can project.

### The three pieces

**A type** is one kind of thing. `key` and `title` are required — `key` is the stable
identity that caching and paths hang off, so it must survive a rename. Everything else is
optional and defaulted: `kind` is `dir` when the type has a `childEdge` and `file`
otherwise, `filename` is the sanitized title with `extension` and an optional `datePrefix`,
`subtype` is the lowercased type name. `mtime`, `author`, `summary`, `size`, `flags`,
`meta`, `childCount` and `unreadCount` map straight onto `VNode`.

**A field** is scalar data that shows up in the graph and is selectable in a projection.
**An edge** is a named relationship to another type in the same mapping, and this is the
part a tree cannot express:

```ts
edges: [
  { name: 'comments', target: 'Comment', list: true,
    resolve: (i: Issue, request) => fetchComments(i.id, request.limit) },
  { name: 'author', target: 'User',
    resolve: (i: Issue) => [fetchUser(i.user)] },
],
childEdge: 'comments',
```

`childEdge` names the one edge `ls` follows. The others are still there, still queryable,
still projectable — they simply are not the containment the default tree chose. Declaring
them costs nothing and is what makes `{ all { author { name } } }` possible later.

**A root** is an entry point: where a walk starts. `universal: true` marks a root as
"everything here", which is what a cross-source `all` fans out to; without it your source
is reachable by name but sits out the wildcard queries. `mount: false` keeps a root out of
the default tree while leaving it projectable, which is how you expose a by-author index
without cluttering `ls`.

`rootMode` decides how roots appear at the mount point. The default, `auto`, puts a single
root's records directly at the mount — making a user `cd issues` inside `/issues` is pure
ceremony — and gives each root its own folder when there is more than one.

### Capabilities follow from what you declared

You do not declare a capability set. A type with `read` gives the mount `read`; a type with
`invoke` gives it `actions`; `search` and `graph` are always available because the engine
provides them. The set is computed, so it cannot disagree with the object — which is the
bug the conformance suite exists to catch, removed rather than tested for.

### What you get for free

Paging and opaque cursors. Name allocation, including the Windows reserved names and the
collision suffixes. `resolveChild`. Search across every mounted root, with local
re-filtering. A `GraphSource` derived from your types and edges, so the mount is
projectable the moment it exists. `MappingRequest.query` is pushed to you if you can use it
and ignored safely if you cannot, exactly as in the wire protocol.

`lookup(key)` is the one thing worth adding deliberately. It re-fetches a record from its
key, which is what lets a projection resolve `/by-person/alice/3` in a cold process without
walking there first. Without it that path still works — the engine re-evaluates level by
level — it is just slower.

### If a mapping is the wrong shape

Implement `Provider` directly. Mappings are a convenience over the same contract, not a
restriction on it, and a provider that declares its own `graph` is used verbatim. A
provider that declares no graph at all still gets the one its tree implies — `children`,
`descendants`, `parent` — so it is projectable regardless. Nothing has to opt in, because a
projection over "all sources" that silently omitted one would be indistinguishable from a
source with nothing in it.

See [PROJECTIONS.md](PROJECTIONS.md) for what users do with the graph once you have
declared it.
