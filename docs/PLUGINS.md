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
  unavailable?: string;  // why this cannot be opened; shown as a warning before it is tried
  parentPath?: string;   // required on search results, which have no listing context
}
```

Only `name` is genuinely required. A provider that returns `{name, kind, id, mtime, author}`
is already useful.

### Warn before the wall

`unavailable` is for a node you can see but cannot open: a folder behind a permission your
token does not have, a feature the account has switched off, a mailbox that is there but
closed to you. Set it to a short reason in lower case, phrased as what is wrong rather than
what happened -- `needs the read:project scope`, not `403 Forbidden`. The shell renders it
as a `!` marker, a dimmed name and the reason in yellow beside it, and announce mode says
"Unavailable" before it says anything else. `ls -q is:unavailable` finds them.

Two rules make it useful rather than annoying:

**Keep throwing.** The label is a warning, not a replacement for the error. `list` on an
unavailable node must still reject, or scripts and pipes have to infer failure from an empty
listing.

**Only set it when you know.** A folder marked on a guess is worse than one that is not
marked, because the user learns to ignore the marker. If a check cannot answer -- an
endpoint that does not report scopes, a probe that timed out -- leave the field alone. It is
also fine to learn the hard way: catch the permission failure the first time and set the
field from then on, which is what the GitHub provider does for boards behind SAML. Clear it
again when a later attempt succeeds, so a user who fixes their token is not left staring at
a stale warning.

**Scope the reason to what it actually covers.** Most refusals are narrower than the mount:
per organization, per repository, per mailbox. Remembering one against the whole provider
means a refusal from one owner greys out another's folder, and a success from the second
deletes the first's true warning. Key what you remember by whatever the permission belongs
to, and reserve provider-wide state for genuinely provider-wide facts such as a missing
token scope.

The engine helps with the timing: when a listing fails with `EACCES` or `EAUTH`, it drops
the parent directory's cached listing, so the label you set in response is visible on the
very next `ls` rather than after the cache expires.

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

## Describing how an item should look

`read()` returns a `Document`. Two optional fields on it decide how the detail pane renders
your item, and both are additive — a provider that sets neither renders exactly as it always
has, because the frontend synthesises an equivalent card from `headers` and `body`.

Full detail in [docs/RENDERING.md](RENDERING.md); the rules are in [docs/DESIGN.md](DESIGN.md).

### `card` — structure the renderer can use

The problem it solves: `labels.join(', ')` is what is left after the structure has been
thrown away, and the renderer cannot get it back. A pull request's labels are a *list*, its
review verdicts are a *table*, and flattening both into `Label: value` lines throws away the
only thing that would let the pane lay them out well.

```ts
import { badges, card, facts, heading, prose } from '@mscomms/core';

return {
  title: pull.title,
  headers: [...],   // still required: plain, tsv, json and search read these
  body: markdown,   // still required, and unchanged
  card: card([
    badges([{ text: 'open', tone: 'good' }, { text: 'bug', tone: 'attention' }]),
    facts([
      { title: 'Author', value: pull.user.login },
      { title: 'Mergeable', value: 'no, conflicts', tone: 'attention' },
    ]),
    heading('Description'),
    prose(pull.body),
  ], { title: `#${pull.number} ${pull.title}` }),
};
```

The vocabulary is a subset of Adaptive Cards 1.5: `TextBlock`, `FactSet`, `BadgeSet`,
`Table`, `ColumnSet`, `Container`, `ActionSet`, `Prose`. Three rules matter more than the
rest:

- **Never write a colour.** You choose a `tone` — `good`, `warning`, `attention`, `accent`,
  `subtle` — and the theme decides what that looks like, including deciding it is a text
  mark rather than a colour. A card carrying an ANSI escape is rejected by the linter.
- **A tone must mean what it says.** If you cannot finish the sentence "this is `attention`
  because it has failed", it is not `attention`. A wrong tone is worse than no tone, because
  a reader believes it.
- **`card` decides presentation, not truth.** Keep `headers` and `body` populated. Other
  output formats, the search index and the local snapshot all read them.

Your card is validated. `lintCard` in `@mscomms/core` returns the same findings the test
suite enforces, so you can assert on it in your own tests:

```ts
import { designErrors, formatFindings } from '@mscomms/core';

const findings = designErrors(myCard);
assert.equal(findings.length, 0, formatFindings(findings));
```

### `presentation` — what you know that structure cannot hold

Plain-text guidance on how your content is best visualized, for a renderer that composes the
pane itself rather than following a card verbatim:

```ts
presentation: `A pull request is read in a fixed order of questions: can it merge, who must
act, what changed, and only then what the author said about it. A draft is not waiting on
anyone, so do not lead with its reviewers.`
```

You know things about your own content that are true but not structural — that a build
status outranks a description, that a long diff should be summarised rather than shown, that
the newest comment is the one being looked for. None of that fits in a card, because a card
is already a decision.

It stays prose deliberately. The consumer is a language model, and the moment this became an
enum it would stop being able to say the useful thing. A renderer that does not generate
layouts ignores it entirely, which is why it is safe to always set it.

You may also ship a `DESIGN.md` beside your provider recording what your content *means* —
that a stale branch matters more than a description, that a draft is `subtle` rather than
`warning` because nobody is being asked for anything yet. It does not override the global
tokens; it records the judgement calls only you can make.

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
