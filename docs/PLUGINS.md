# Writing a provider

There are two ways to add a source. Pick the second one unless you have a reason not to.

| | `exec` plugin | TypeScript provider |
|---|---|---|
| Language | Any | TypeScript or JavaScript |
| Distribution | A file. Point the config at it. | An npm package or a module path |
| Isolation | Separate process | In-process |
| Speed | One IPC round trip per request | Direct call |
| Effort | About forty lines | Implement an interface |

The `exec` tier exists because the alternative is telling a Python person to learn the
TypeScript build. `examples/notes-plugin.mjs` is a complete working plugin in one
dependency-free file; copying it is a legitimate way to start.

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
engine checks `'search' in provider`, so a property that exists but is `undefined` still
answers *true* and the engine will call it. Use `delete provider.search`, not
`provider.search = undefined`.

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
