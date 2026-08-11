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
| `fixture` | `"mail"` \| `"chat"` \| `"issues"` \| `"empty"` | Which sample tree to generate. |

`empty` is genuinely empty, which is useful for checking that your scripts handle a folder
with nothing in it.

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
