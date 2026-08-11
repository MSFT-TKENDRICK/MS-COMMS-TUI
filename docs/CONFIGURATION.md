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
| `token` | string | — | A PAT. Use `${env:GITHUB_TOKEN}`. |
| `baseUrl` | string | api.github.com | Set for GitHub Enterprise Server. |
| `includePulls` | boolean | `true` | Show pull requests alongside issues. |
| `includeComments` | boolean | `true` | Append the comment thread when reading. |
| `includeNotifications` | boolean | `false` | Add a `notifications/` folder. |
| `state` | `"open"` \| `"closed"` \| `"all"` | `"open"` | Which issues to list. |
| `timeoutMs` | number | 20000 | Per-request timeout. |

Without a token you get public data at a much lower rate limit. `cache` in the shell shows
how close you are to it.

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

## Secrets

Never write a token into the file. Two indirections are resolved at use time:

```jsonc
"token": "${env:GITHUB_TOKEN}"          // read from the environment
"token": "${file:~/.config/gh-token}"   // read from a file, trimmed
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
