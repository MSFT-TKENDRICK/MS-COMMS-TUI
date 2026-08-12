# Configuration

Everything is one JSON file. It supports `//` and `/* */` comments and tolerates trailing
commas, so you can annotate it and leave a mount commented out without reformatting.

```sh
mscomms init      # writes a starter config, commented throughout
mscomms doctor    # tells you where the file is and what is wrong with it
mscomms -c ./other.json ls /mail   # use a different file for one run
```

## Where the file lives

| Platform | Config file |
|---|---|
| Linux, BSD and macOS | `$XDG_CONFIG_HOME/mscomms/config.jsonc`, else `~/.config/mscomms/config.jsonc` |
| Windows | `%APPDATA%\mscomms\config.jsonc` |

The extension is `.jsonc` because the file is meant to be commented.

Cache, logs, notification history and OAuth tokens live in the data directory —
`$XDG_DATA_HOME/mscomms` or `%LOCALAPPDATA%\mscomms`. `doctor` prints all of them.

| Variable | Overrides |
|---|---|
| `MSCOMMS_CONFIG` | The config file path itself. |
| `MSCOMMS_CONFIG_DIR` | The directory the config file is looked for in. |
| `MSCOMMS_DATA_DIR` | Cache, log, notification history and token storage. |

## Unknown keys are an error

A typo in a config file usually fails silently, and you find out weeks later when the thing
you configured turns out never to have been configured. This program refuses to start and
names the nearest real key:

```
Unknown config key "notification". Did you mean "notifications"?
```

That is deliberate and there is no lenient mode. The suggestion is distance-capped, so a
genuinely unrelated key gets a plain "unknown key" rather than a misleading guess.

## Top-level keys

| Key | Type | Meaning |
|---|---|---|
| `mounts` | array | The sources to mount, and where. The only key most people need. |
| `plugins` | string[] | Extra provider modules to load, by path or package name. |
| `queries` | array | Saved queries, available by name to `find` and `watch`. |
| `watches` | array | Watches to start automatically at launch. |
| `ui` | object | Display settings. |
| `notifications` | object | Desktop notification settings. |
| `keymap` | object | Key rebindings for the opt-in TUI. |
| `cache` | object | Local Turso/libSQL snapshot, background sync and prefetching. |
| `ttlMs` | number | Default cache lifetime for listings, in milliseconds. |

## `mounts`

```jsonc
{
  "mounts": [
    {
      "path": "/mail",        // required: where it appears in the tree
      "type": "graph-mail",   // required: which provider (see `plugins`)
      "id": "work-mail",      // optional: name used in logs and `mounts`
      "description": "Work mailbox",
      "options": { },         // provider-specific, see below
      "ttlMs": 60000,         // optional: cache lifetime for this mount
      "pageSize": 50          // optional: items fetched per page
    }
  ]
}
```

Mount paths must be absolute and must not nest inside one another. `mounts` in the shell
lists what is mounted and what each source can actually do.

### `memory` — sample data

Needs no credentials and makes no network calls. Used by `demo`, and useful for testing a
config or a script.

| Option | Type | Meaning |
|---|---|---|
| `fixture` | `"mail"` \| `"chat"` \| `"issues"` \| `"people"` \| `"empty"` | Which sample tree to generate. |
| `items` | array | Your own fixture, instead of a built-in one. |

`empty` is genuinely empty, which is useful for checking that your scripts handle a folder
with nothing in it. `people` is a small org chart, and is the one fixture that is a *graph*
rather than a tree.

A hand-written `items` entry is an object with `id`, `title`, and any of `body`, `summary`,
`flags`, `author`, `agoMinutes`, `format`, `meta`, `webUrl`, `threadId`, `attachments`, plus
either `children` (items defined inline, which makes it a folder) or `refs`:

```jsonc
{ "id": "colleagues", "title": "Colleagues", "refs": ["person-priya", "person-tom"] }
```

`refs` names items defined elsewhere in the same fixture and lists them here as well. It is
what lets a fixture model a backend that is not tree-shaped — an org chart, where the same
person appears under several folders and your manager's `reports` contains you. A referenced
item is not a copy: it keeps one id, so `find` reports it once however many paths reach it,
`stat` agrees from every direction, and marking it read from one path marks it read from all
of them. References may point backwards or form cycles; the only rules are that the id must
exist and that an item may not reference itself.

### `rss` — any RSS, RDF or Atom feed

No credentials, no vendor API, and nobody can turn it off.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `feeds` | array of `{url, name}` | — | Multiple feeds, each a folder. |
| `url` | string | — | Shorthand for a single feed. |
| `name` | string | derived | Display name for the single-feed form. |
| `maxItems` | number | 500 | Items kept per feed. |
| `refreshMs` | number | 300000 | How often a feed may be refetched. |
| `timeoutMs` | number | 15000 | Per-request timeout. |
| `userAgent` | string | `mscomms/0.1 (+repo URL)` | Sent on every request. |

### `github` — issues, pull requests and notifications

| Option | Type | Default | Meaning |
|---|---|---|---|
| `repos` | string[] | — | `owner/name` entries, each a folder. |
| `token` | string | — | A PAT. Use `${env:GITHUB_TOKEN}`; omit it to fall back to the environment or `gh`. |
| `baseUrl` | string | api.github.com | Set for GitHub Enterprise Server. |
| `includePulls` | boolean | `true` | Show pull requests alongside issues. |
| `includeComments` | boolean | `true` | Append the comment thread when reading. |
| `includeNotifications` | boolean | `false` | Add a `notifications/` folder. |
| `state` | `"open"` \| `"closed"` \| `"all"` | `"open"` | Which issues to list. |
| `timeoutMs` | number | 20000 | Per-request timeout. |

Without a token you get public data at a much lower rate limit. `cache` in the shell shows
how close you are to it.

The token is looked for in three places, in order: the `token` option, then `GITHUB_TOKEN`
or `GH_TOKEN` in the environment, then the credential belonging to `gh auth login`. The
last of these means a machine with the GitHub CLI signed in needs no configuration at all —
`gh` keeps its token in the OS keychain, so there is nothing to inherit and asking it is the
only way to find out. That lookup runs only when the first two found nothing, never gets
anything from the config file, and treats every failure as "no token".

### `graph-mail` — Outlook mail

Read-only unless you grant write scopes. Mail folders become directories; messages become
`.eml` files.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `clientId` | string | Microsoft Graph Command Line Tools | Your own app registration, if the default is blocked. |
| `tenantId` | string | `common` | Single-tenant directory ID. |
| `scopes` | string[] | see below | Add `Mail.ReadWrite` to mark messages read. |
| `authority` | string | login.microsoftonline.com | Sovereign or national clouds. |
| `pageSize` | number | 50 | Messages fetched per request. |
| `includeHiddenFolders` | boolean | `false` | Include folders Outlook hides. |
| `timeoutMs` | number | 30000 | Per-request timeout. |

Sign-in is the OAuth device code flow: the program prints a URL and a code, you approve in
a browser, and the refresh token is stored in the data directory. No password is ever
typed into the terminal.

The default scope set covers both mail and Teams, because one consent prompt is kinder than
two:

```
offline_access  User.Read  Mail.Read  MailboxSettings.Read
Chat.Read  ChannelMessage.Read.All  Team.ReadBasic.All  Channel.ReadBasic.All
```

Set `scopes` yourself to narrow that — a mail-only mount needs only `offline_access`,
`User.Read` and `Mail.Read`, and asking for less is easier to get approved. Writing
requires `Mail.ReadWrite`, which is deliberately not in the default set: a program that
reads your mail and a program that can alter it are different risks, and the second should
be something you opted into.

### `graph-chat` — Teams and chats

Chats, teams, channels and threads become directories; messages become files.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `chatsOnly` | boolean | `false` | Skip teams and channels; 1:1 and group chats only. |
| `maxReplies` | number | 50 | Replies fetched per thread. |
| `pageSize` | number | 50 | Messages fetched per request. |

Plus every `graph-mail` authentication option. Teams scopes such as
`ChannelMessage.Read.All` require admin consent in most tenants; without them the provider
degrades to what it can reach rather than failing outright, and `mounts` reports the
reduced capability set.

### `graph-people` — the corporate hierarchy

The people graph as directories. `cd` walks the reporting chain in either direction, and
every person's folder merges what they have said to you across mail and Teams into one
list, **most owed first**.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `pageSize` | number | 50 | Directory entries fetched per request. |
| `commsPerPerson` | number | 25 | Communications merged into one person's listing (max 100). |
| `allowSend` | boolean | `false` | Enable the actions that write: `mail`, `chat`, `reply`, `read`, `unread`. |
| `chats` | boolean | `true` | Include Teams chat in the merge. Turn off when the tenant blocks `Chat.Read`. |
| `signalTtlMs` | number | 60000 | How long the cross-person priority index stays warm. |
| `maxChainDepth` | number | 12 | Safety valve on the climb up the management chain (max 30). |

Plus every `graph-mail` authentication option.

Seven sections sit at the mount root:

| Section | What is in it |
|---|---|
| `Me` | Your own card. Not a folder containing you — `cd Me` lands *on* you. |
| `Org` | Your management chain, top-most first, in hierarchy order. |
| `Reports` | People who report to you. |
| `Colleagues` | Everyone else who reports to your manager. |
| `Recent` | People you correspond with, most owed first. |
| `External` | Correspondents outside your organisation. |
| `Directory` | The tenant directory. `ls -q <name>` looks somebody up. |

Inside a person: `profile.md`, then `manager/`, `reports/` and `peers/`, then their
communications. The hierarchy folders are cyclic on purpose — your manager's `reports/`
contains you, so you can wander the org chart without going back to the root.

Ordering is the point of the mount, and it is not by date. A person's list is ranked
**unread → unanswered → mentioned → everything else → things you sent**, and only then by
recency inside each band. "Unanswered" is a property of a *thread*, not of a message: a
colleague who sent four messages in a row is owed one reply, not four. The same rule ranks
the people themselves, so `ls Recent` puts whoever is most waiting on you at the top.
Mail and chat are **merged**, never grouped by channel, because a reply you missed is
missed precisely because it arrived in the app you were not looking at.

Two scopes beyond the `graph-mail` set are needed and are in the default:
`User.ReadBasic.All` and `People.Read`. `User.Read.All` is better if your tenant will grant
it — job titles, departments and offices need it, and the provider retries with the basic
property set when it is refused rather than failing. `/me/people`, the chat roster and the
directory are each optional: a tenant that withholds any of them loses that source and
keeps the rest.

Writing is off by default, exactly as `graph-mail` is. Setting `allowSend` also means
re-running `login`, because the send scopes (`Mail.Send`, `Chat.ReadWrite`,
`ChatMessage.Send`) are deliberately absent from the default consent — a tool that reads
your corporate mail is easy to justify installing; one that can send mail as you is a
different conversation.

```jsonc
{
  "path": "/people",
  "type": "graph-people",
  "options": { "commsPerPerson": 30 }
}
```

To try the shape without a tenant, run `demo` in the shell and explore `/demo-people`.

### `ado-boards` — Azure DevOps Boards

Projects, teams, boards and columns become directories; work items become files.

```
/ado/Contoso/Platform Team/Stories/Active/2026-08-11 #1234 Ship the thing.md
/ado/Contoso/Assigned to me/2026-08-11 #1234 Ship the thing.md
```

The column level is the point: "what is in Active" becomes `ls` rather than a query. Every
project also gets an `Assigned to me` folder, which is the view most people actually open
Azure DevOps for.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `organization` | string | — | Organization name, e.g. `contoso`. Required unless `orgUrl` is set. |
| `orgUrl` | string | — | Full collection URL. Required for Azure DevOps Server; overrides `organization`. |
| `projects` | string[] | every visible project | Restricting this also skips discovery, so a project-scoped PAT works. |
| `teams` | string[] | every visible team | Restrict to these team names. |
| `boards` | string[] | every board | Restrict to these board names, e.g. `["Stories"]`. |
| `auth` | `"auto"` \| `"pat"` \| `"aad"` | `"auto"` | See below. |
| `token` | string | — | A PAT. Use `${env:AZURE_DEVOPS_EXT_PAT}`. |
| `clientId` | string | Azure CLI public client | Your own app registration, if the default is blocked. |
| `tenantId` | string | `common` | Single-tenant directory ID. |
| `authority` | string | login.microsoftonline.com | Sovereign or national clouds. |
| `includeAssignedToMe` | boolean | `true` | Add an `Assigned to me` folder to every project. |
| `includeComments` | boolean | `true` | Append the discussion when reading a work item. |
| `pageSize` | number | 50 | Work items fetched per request. |
| `maxItems` | number | 1000 | Hard cap per listing. Guards against a 20,000-item board. |
| `apiVersion` | string | `7.1` | Only worth changing for an older Azure DevOps Server. |
| `timeoutMs` | number | 30000 | Per-request timeout. |

`auth` defaults to `auto`: use a personal access token if one is available, otherwise sign
in interactively with the device code flow. That order matters for CI, where a device code
prompt would hang a pipeline forever with no terminal to read the code from. A PAT is looked
for in `token` first, then `AZURE_DEVOPS_EXT_PAT`, `AZURE_DEVOPS_PAT` and
`SYSTEM_ACCESSTOKEN` — so a machine already set up for `az devops`, or a pipeline step with
the job token enabled, needs no extra configuration. The token needs only the
**Work items (read)** scope.

Interactive sign-in reuses the same device code flow as the Graph mounts, but Azure DevOps
is a different *resource*: a separate token is cached under `MSCOMMS_ADO_TOKEN`, and signing
out of one does not sign you out of the other.

Filters push down into WIQL where they can be translated exactly — `find . -q "after:7d"`
becomes a server-side date bound — and are applied locally otherwise. Nothing is ever
claimed as filtered unless it was, so a narrower result is never a silently shorter one.

### `exec` — any program, any language

| Option | Type | Default | Meaning |
|---|---|---|---|
| `command` | string[] | required | Program and arguments. **Always an array**, never shelled. |
| `capabilities` | string[] | from `initialize` | `list`, `read`, `search`, `poll`, `actions`, `attachments`. |
| `cwd` | string | current directory | Working directory. |
| `env` | object | inherited | Extra environment variables. |
| `oneshot` | boolean | `false` | Restart per request instead of keeping a long-lived process. |
| `timeout` | number | 30 | Per-request timeout **in seconds**. |

`command` is an array because a string would have to be split by a shell, and shell
splitting of a path a user did not write is how injection bugs happen. Note that `timeout`
is in **seconds** here, unlike the `timeoutMs` options elsewhere — it is the number a
plugin author reaches for, and the name says which it is. See [PLUGINS.md](PLUGINS.md).

### `projection` — a GraphQL view of your other mounts

Not a source. A projection reorganizes the mounts you already have into a different tree,
described by a GraphQL query over every mounted source. It is here because from your side
it is just another mount type.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `query` | string | — | The projection, as GraphQL. Required unless `queryFile` is set. |
| `queryFile` | string | — | Read it from a file instead. Relative paths resolve next to this config file. |
| `operation` | string | the only one | Which named operation to run, when the document has more than one. |
| `variables` | object | `{}` | Values for the query's variables. |
| `defaultLimit` | number | 200 | Entries fetched per field when the query does not say. |

```jsonc
{
  "path": "/by-person",
  "type": "projection",
  "options": {
    "query": "{ all(filter: \"is:unread\") @flatten @group(by: \"author\") { name mtime } }"
  }
}
```

That mount lists, pages, caches, searches and completes like any other, and `cat` on a
message inside it opens the actual message.

Use `queryFile` once a projection outgrows a JSON string — escaping quotes inside JSONC
gets unpleasant fast:

```jsonc
{ "path": "/by-person", "type": "projection", "options": { "queryFile": "./by-person.graphql" } }
```

Two rules follow from a projection being a mount. It never includes itself, or anything
beneath its own path, because a projection over "all sources" would otherwise recurse until
the stack gave out — which also means you cannot project a projection. And it cannot
contain a mutation: it is a view, and acting on an item is `do`, which works normally
inside one.

Errors surface when the mount is built rather than on first `ls`, so a syntax error, an
unknown operation name or a missing variable all fail at startup with the position in the
query.

Write the query at the prompt before committing it to a file. `schema` prints what you can
select from the mounts you actually have, and `graphql` runs a query and prints JSON:

```sh
mscomms schema
mscomms graphql '{ all(filter: "is:unread") { name source } }'
```

The full reference is [PROJECTIONS.md](PROJECTIONS.md).

## Secrets

Never write a token into the file. Two indirections are resolved at use time:

```jsonc
"token": "${env:GITHUB_TOKEN}"          // read from the environment
"token": "${file:~/.config/gh-token}"   // read from a file, trimmed
"token": "${env:AZURE_DEVOPS_EXT_PAT}"  // the same indirection, any provider
```

`${file:...}` accepts `~`, absolute and relative paths, and suits both
`gh auth token > ~/.gh-token` and Docker secrets. A config using only indirections is safe
to commit and safe to paste into a bug report. A literal string still works if you insist,
but nothing in the docs or the generated config will ever show you how.

## `ui`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `plain` | boolean | auto | No colour, no box drawing, no spinners, no alternate screen. |
| `color` | `"auto"` \| `"always"` \| `"never"` | `"auto"` | `NO_COLOR` and a non-TTY stdout both force off. |
| `announce` | boolean | `false` | Render listings as spoken sentences rather than aligned columns. |
| `pageSize` | number | 25 | Rows per page. |
| `dateStyle` | `"relative"` \| `"absolute"` \| `"iso"` | `"relative"` | Relative dates are spelled in words: "2 hours ago". |
| `prompt` | string | last path component + `"> "` | Keep it short — a screen reader re-reads it on every keystroke. |
| `bell` | boolean | `false` | Terminal bell on new items. |
| `showHiddenMeta` | boolean | `false` | Show provider-internal fields in `stat`. |

`set` changes any of these for the current session without editing the file.

Colour is decoration only. Everything shown in colour is also stated in words, so
`--plain` loses appearance and never loses information.

## `notifications`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `desktop` | boolean | `true` | Send desktop notifications. |
| `appName` | string | `MS-COMMS-TUI` | Name shown in the notification. |
| `appId` | string | platform default | Windows AUMID. |
| `maxEntries` | number | 500 | Notifications kept in the log. |

Every notification is written to a log regardless, readable with `notifications`. Desktop
notification systems drop things — Focus Assist, Do Not Disturb, a full stack, a missing
daemon — and a notification you cannot retrieve after the fact is worse than none, because
you believed you would be told.

On Windows, toasts are attributed to PowerShell unless you set `appId` to a registered
AUMID. `doctor` says so rather than leaving you to wonder.

## `cache`

Off by default. Turn it on and the tool keeps a local libSQL (Turso) database of what it
has seen, syncs new mail into it in the background, and answers from it first.

```jsonc
"cache": {
  "enabled": true,
  "recent": 500,
  "bodies": 25
}
```

That is the whole of a useful configuration: keep the last 500 items per folder and
pre-download 25 bodies a cycle so the messages you are most likely to open are already
there. Everything below has a working default.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `false` | Keep a local snapshot at all. |
| `path` | string | `snapshot.db` in the cache dir | Where the database file lives. |
| `driver` | string | `auto` | Backend: `auto`, `libsql`, `libsql-remote`, `node-sqlite`. |
| `syncUrl` | string | — | Remote Turso database, e.g. `libsql://mail-org.turso.io`. |
| `authToken` | string | — | Token for it. Use `${env:TURSO_AUTH_TOKEN}`, not a literal. |
| `recent` | number | 200 | Items kept per folder, and refreshed per sync cycle. The rest are evicted. |
| `ttlMs` | number | 300000 | How long a snapshot listing is considered fresh. |
| `intervalMs` | number | 300000 | Background sync period. Floors at 30s. |
| `depth` | number | 2 | How far below each mount root to sync. |
| `bodies` | number | 0 | Message bodies to pre-download per folder per cycle. 0 disables. |
| `vectors` | boolean | `true` | Build embeddings so `find` can match on meaning. |
| `prefetch` | boolean | `true` | Fetch what you are about to open, before you open it. |
| `prefetchConcurrency` | number | 2 | Speculative fetches in flight at once. |
| `audit` | boolean | `false` | Record every provider fetch in an AgentFS `tool_calls` log. |

### What it buys you

Cold start stops being cold. Opening the shell and typing `ls /mail/Inbox` reads from disk
instead of waiting on Graph, so the first listing arrives in milliseconds rather than
seconds. Navigation gets faster still: moving into a folder triggers speculative fetches of
the places you usually go next, so the folder is often already loaded when you ask for it.

`find` searches the snapshot before touching the network, and merges the live results in as
they arrive. You see local matches immediately and remote ones when they land. With
`vectors` on, the local half also matches on meaning, so "quarterly numbers" can find a
message titled "Q3 financials". `find --local` stops at the snapshot and never contacts a
source — useful on a plane, and the fastest possible answer.

### `recent`, and why the cache is deliberately incomplete

`recent` caps how many items are kept per folder. A mailbox with 80,000 messages is not
worth replicating to answer questions about the last fortnight, and trying would make the
first sync so long that nobody would leave it on.

This shapes what the cache is allowed to answer. A snapshot listing serves an ordinary `ls`
because the newest items are exactly the ones it holds. A *filtered* `ls` goes to the
source instead: answering `is:unread` locally could report nothing while an unread message
from six months ago sits just outside the window, and a wrong answer that looks like a
right one is worse than a slow one. Search behaves the same way — it never concludes
absence from the snapshot alone, and `find` says how many results came from it.

### `driver`

`auto` is right unless you have a reason.

- **`libsql`** — the native Turso client. Local file, optional embedded replica of a remote
  database, and vector similarity computed inside the database. The best option where a
  prebuilt binary exists.
- **`libsql-remote`** — the pure-JavaScript client, talking to `syncUrl` over HTTP. Used
  where the native binary has no build for the platform. Requires `syncUrl`; there is no
  local file, so this is a network cache rather than an offline one.
- **`node-sqlite`** — Node's built-in SQLite (22.5+). Local only, no replication, and
  similarity is computed in-process. Slower on large vector sets, otherwise identical.

Node did not bundle the FTS5 extension in `node:sqlite` until v23, so on Node 22 this
driver has no full-text index. That is a missing feature, not a failure: the snapshot
opens, caches and pre-fetches as usual, semantic search is unaffected, and text search
falls back to a scan. `cache` says so when it happens.

Pinning a driver that cannot load is an error at startup with a hint saying why, rather
than a silent fallback: if you asked for a replica of a shared database, quietly giving you
a local-only file would be the wrong kind of help.

### When it cannot start

A cache that will not open is a slower program, not a broken one. Startup records the
reason and carries on with in-memory caching; `cache` prints it on stderr. `cache clear`
empties it, `cache sync` forces a cycle immediately instead of waiting for the timer.

### AgentFS: exporting and auditing

The snapshot is a SQLite database, which means [Turso
AgentFS](https://github.com/tursodatabase/agentfs) can be pointed straight at it. Two
features come from that.

**`cache export <path>`** writes the snapshot out as an AgentFS filesystem: a single file
containing your mail as a real directory tree, one `.eml` per message, with a manifest at
the root. Anything that speaks AgentFS can then mount and read it.

```
> cache export ~/mail-snapshot.db
Exported 78 items into 6 folders, 30 without bodies (19.8 KB).
```

Messages whose bodies were never downloaded are exported as headers only — the folder
structure is still complete. Items that cannot be written for any reason are skipped and
counted rather than aborting the export; refusing to write four thousand good messages
because one has an unrepresentable name is not a trade worth making.

**`"audit": true`** records every provider fetch in a `tool_calls` table inside the
snapshot: what was called, which path, how long it took, and whether it failed. `cache`
then summarises it:

```
Audit: 34 recorded fetches.
```

The log deliberately holds paths and result *shapes* — a body's length, an entry count —
and never message content. An audit trail that quietly became a second copy of your mail
would be worse than the problem it solves. For the same reason it is off by default, it is
never copied into an exported file, and a failure to write it can never interrupt syncing.

## `queries`

```jsonc
"queries": [
  { "name": "urgent", "query": "is:unread (from:dana OR from:tom) after:2d" },
  { "name": "mine",   "query": "is:mention OR is:flagged" }
]
```

Then `find /mail -q urgent`. `queries` lists them alongside the searchable fields, and Tab
completes saved names. `syntax` prints the full query grammar.

## `watches`

```jsonc
"watches": [
  { "id": "inbox", "path": "/mail/Inbox", "query": "is:unread",
    "intervalMs": 60000, "label": "Work inbox", "includeUpdates": false }
]
```

`intervalMs` has a hard minimum of 1000. A smaller value is an error rather than a silent
correction, because the plausible reason to write `100` is a misunderstanding of the units,
and silently running 10× slower than asked is its own bug. `includeUpdates` also notifies on
changes to existing items, not only on new ones.

## `plugins`

```jsonc
"plugins": ["@me/mscomms-provider-jira", "./local-provider.mjs"]
```

Each entry is a module exporting a provider factory, loaded at startup and available as a
mount `type`. For anything not written in TypeScript, use an `exec` mount instead — it needs
no registration.

## Environment variables

| Variable | Effect |
|---|---|
| `MSCOMMS_CONFIG` | Config file path. |
| `MSCOMMS_CONFIG_DIR` | Directory searched for the config file. |
| `MSCOMMS_DATA_DIR` | Cache, logs, notification history and tokens. |
| `MSCOMMS_PLAIN` | Set to anything to force plain output. |
| `MSCOMMS_ANNOUNCE` | Set to anything to force sentence-style output. |
| `NO_COLOR` | Disables colour, whatever `ui.color` says. |

`MSCOMMS_PLAIN` and `MSCOMMS_ANNOUNCE` exist so a screen reader user can set them once in a
shell profile and never think about them again, rather than remembering a flag on every
invocation.

## When it will not start

Run `doctor`. It checks the config file, every mount, reachability, the output mode,
notification delivery and active watches, and names a fix for each failure rather than
reporting a status. If `doctor` is clean and something is still wrong, `--verbose` prints
request-level detail to stderr, where it stays out of piped output.
