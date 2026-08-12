# MS-COMMS-TUI

Browse Outlook mail, Microsoft Teams chats, your org chart, GitHub issues, Azure DevOps
boards, RSS feeds and anything else you can write forty lines of script for — as folders and
files, from the keyboard.

```
/> cd /demo-mail/Inbox
Inbox> ls
 1.  Newsletters/                                          just now
 2.  Projects/                                             just now
 3.  2026-08-11 FY26 budget review.eml       22 minutes ago  Tom Okafor      unread
 4.  2026-08-11 Q3-Q4 planning.eml           3 hours ago     Dana Whitfield
 5.  2026-08-11 Ship it — v2.4 is live.eml   5 hours ago     Sam Ito         flagged
Inbox> cat 3
From: Tom Okafor <tom.okafor@contoso.example>
Date: 2026-08-11T18:32:47Z
Subject: FY26 budget review — please read before Thursday
...
Inbox> find /mail -q "is:unread from:dana after:7d"
Inbox> find -a -q "budget~ after:7d"        # every source at once, ranked
```

`ls`, `cd`, `cat`, `find`, `grep`, `stat`. The commands you already know, pointed at the
systems you actually spend your day in.

## Why

Three things, in order of how much they shaped the code.

**Accessibility.** Every full-screen mail TUI — mutt, aerc, alpine, neomutt — is hostile to
screen readers, and for mechanical reasons rather than sloppy ones. They take over the
alternate screen buffer, which destroys scrollback; they repaint whole frames, which
fragments speech; they move the cursor constantly, which triggers announcement storms; and
ANSI offers nothing resembling ARIA, so there is no way to say "this region is a list" or
"this item is selected". A line-oriented shell has none of those problems: output is
ordinary scrolling text, it lands in scrollback, and the review cursor can go back over it.

So the line shell is the **default and primary interface**, not a fallback. See
[docs/ACCESSIBILITY.md](docs/ACCESSIBILITY.md).

**There is nothing else.** A survey of the field turned up no published open-source
terminal client for Microsoft Teams or Outlook — wrappers, raw API CLIs and web clients,
but no real TUI. See [docs/PRIOR-ART.md](docs/PRIOR-ART.md) for that survey and the
learnings taken from twenty-odd adjacent projects.

**Everything is the same shape.** Mail, chats, issues, work items and feeds are all "a
stream of authored, timestamped, sometimes-unread things, grouped somehow". Modelling them
once and writing the interface once means a new backend is a plugin, not a fork.

## Searching everything at once

`find -a` asks every mounted source in parallel and merges the answers by relevance.
Each source is queried through its own search index where it has one, so this is not a
brute-force walk; sources without an index are walked with a budget.

```
/> find -a -q "budget~ after:14d"
/> find -a --source mail,gh -q "subject:budg* OR subject:forecast^2"
```

The query language accepts Lucene syntax on top of the plain `field:value` form:

| Syntax | Meaning |
|---|---|
| `subject:budg*`, `bud?et` | wildcards; `*` is any run of characters, `?` is exactly one |
| `budgt~`, `budgt~1` | fuzzy, for a word you are not sure how to spell |
| `"budget review"~5` | the two words within five words of each other, in either order |
| `date:[2026-01 TO *]` | a range; `{}` for exclusive ends |
| `subject:budget^3` | weigh this clause more heavily when ranking |
| `+must -mustnot` | require and exclude; `&&`, `||` and `!` also work |
| `sub\*ject` | backslash escapes any of the above |

Two deliberate departures from Lucene, both because a mail client is not a document
index. Adjacent terms mean AND, not OR, because that is what every mail search does — so
`+` is accepted and then ignored, since it is already the default. And `from:dana` is a
substring match, so it finds `dana.whitfield@contoso.example`; use `from:dana*` for
whole-word and `from:=dana` for exact. Proximity also ignores word order, because someone
asking whether two words are near each other should not have to guess which one the
author wrote first.

When a source fails, times out, gets searched only in part, or gets cut off by the result
limit, it is named:

```
/> find -a -q "budget"
12 matches for budget.
Searched 3 of 4 sources. news failed (401 Unauthorized).
Searched only part of: teams (2 folders could not be read: 403 Forbidden).
More to find in: mail. Raise `-n` to see further into each source.
```

That reporting is the point of the feature. "No results" and "I could not look" must never
render as the same line — including the quiet middle case, where a source answers normally
having silently skipped half of itself.

**People are a filesystem too.** `/people` mounts the corporate hierarchy as directories:
`cd` walks up to your manager and back down through their reports, and each person's folder
merges everything they have said to you — mail and Teams together — ordered by what you owe
them rather than by date. Unread first, then unanswered, then everything else.

```
/> cd /people/Me/manager
/> ls
Dana Whitfield          unread(2) unanswered   Engineering Manager — Platform
/> cd "Dana Whitfield"
/> ls
profile.md
manager/  reports/  peers/
2026-08-11 16:04 chat — Ping about the rollout.md     unread unanswered
2026-08-09 08:00 mail — Budget question.eml           unread unanswered
2026-08-10 09:00 mail — Design review.eml             unanswered
/> do 2 reply body="Looking at it now"
```

The graph is genuinely cyclic — your manager's `reports/` contains you — and a person is one
person however you got there, so `find /people -q "is:unanswered"` lists each thing you owe a
reply to exactly once.

## Install

Node 20.11 or newer. No third-party runtime dependencies — deliberately: this program reads
your corporate mail, and every transitive package is somebody else's ability to change what
it does. The only `dependencies` entries are this repo's own workspace packages.

```sh
git clone https://github.com/MSFT-TKENDRICK/MS-COMMS-TUI
cd MS-COMMS-TUI
npm run setup   # npm install (devDependencies only: TypeScript) + npm run build
npm link        # optional: puts `mscomms` and `msh` on your PATH
```

`npm run setup` is the same two commands you would type yourself — `npm install` and
`npm run build` — wrapped so that every entry point into this repo agrees on what "set up"
means. Run them by hand if you prefer.

### From the GitHub Copilot desktop app

[`.github/github-app.yml`](.github/github-app.yml) wires the app's **Setup** and **Run**
buttons to `scripts/app-setup.mjs` and `scripts/app-run.mjs`, so a workspace the app creates
installs and builds itself and then has something to run. It takes effect once the file is
on the default branch and the project's repository config has been trusted in the app's
settings.

The Run script adapts to where it is started. In a real terminal — the app's Run panel is a
genuine pty, as is any IDE terminal — it opens the **full-screen two-pane view** on your own
accounts. In the app's log pane, where nothing can be typed, it drives the line shell from a
short canned transcript instead, so the log shows the tool working rather than a prompt
nobody can answer.

It never mounts the sample data on its own. Fixtures that appear without being asked for are
indistinguishable from real data that is wrong, so a machine with nothing configured is told
how to connect an account rather than handed props; `MSCOMMS_RUN_DEMO=1` asks for them
deliberately. And because the Microsoft device-code prompt is written to stderr — invisible
underneath an alternate screen buffer — a machine that has never signed in does that first,
on an ordinary screen, where the code can actually be read.

That is the opposite of what `mscomms` does on its own, and deliberately so: the line shell
is the binary's default [for accessibility reasons](#keyboard-and-accessibility), and a
command someone types must not ambush them with an alternate screen buffer. Clicking a play
button in a windowed GUI is already a sighted, pointer-driven act that asks to be shown the
thing, so that is the one place the full-screen view is assumed rather than requested.

| Variable | Effect |
| --- | --- |
| `MSCOMMS_RUN_TUI=0` | Use the line shell instead of the full-screen view. |
| `MSCOMMS_RUN_DEMO=1` | Mount the sample data. Off unless asked for: the Run button shows your accounts, not fixtures. |
| `MSCOMMS_RUN_SIGNIN=0` | Skip the Microsoft sign-in that otherwise happens before the pane opens. |
| `MSCOMMS_RUN_INTERACTIVE=0/1` | Override the terminal check that picks between a live interface and the transcript. |
| `MSCOMMS_RUN_SCRIPT=<file>` | Use a file of commands as the transcript. |
| `MSCOMMS_RUN_BUILD=0` | Skip the rebuild and run the last successful build as-is. |

Arguments passed to the script win over all of it: `node scripts/app-run.mjs ls /demo-mail`
runs that one command, and `node scripts/app-run.mjs --shell` gives the line shell.

Every run recompiles first, so the button always runs the code that is on disk rather than
whatever was built last. That is an incremental no-op once warm.

## Try it without connecting anything

```sh
mscomms          # starts the shell — `npm start` if you skipped `npm link`
/> demo          # mounts sample mail, chats, issues and people
/> ls /demo-mail/Inbox
/> cat 3
/> find /demo-mail -q "budget is:unread"
/> ls /demo-people/Recent
```

The demo data is generated in-process. No credentials, no network.

## Connect something real

```sh
mscomms init     # writes a starter config and tells you where it went
mscomms doctor   # checks the setup and names a fix for anything wrong
```

A minimal config:

```jsonc
{
  "mounts": [
    { "id": "mail",   "path": "/mail",   "type": "graph-mail" },
    { "id": "teams",  "path": "/teams",  "type": "graph-chat" },
    { "id": "people", "path": "/people", "type": "graph-people" },
    { "id": "gh",     "path": "/gh",     "type": "github",
      "options": { "repos": ["octocat/hello-world"], "token": "${env:GITHUB_TOKEN}" } },
    { "id": "ado",    "path": "/ado",    "type": "ado-boards",
      "options": { "organization": "contoso", "token": "${env:AZURE_DEVOPS_EXT_PAT}" } },
    { "id": "news",   "path": "/news",   "type": "rss",
      "options": { "feeds": [{ "url": "https://example.com/feed.xml", "name": "Example" }] } }
  ]
}
```

Full reference: [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

Credentials never live in the config. GitHub takes an explicit `token`, then `GH_TOKEN` or
`GITHUB_TOKEN`, and failing both it borrows the credential from `gh auth login` — so on a
machine with the GitHub CLI signed in, the `token` line above is unnecessary. The Microsoft
sources sign in interactively the first time you open them and cache the result.

## Add your own source

Any program that reads JSON lines on stdin and writes JSON lines on stdout is a valid
backend, in any language:

```jsonc
{ "id": "notes", "path": "/notes", "type": "exec",
  "options": { "command": ["python3", "my-plugin.py"], "capabilities": ["list", "read"] } }
```

`examples/notes-plugin.mjs` is a complete, dependency-free reference implementation with
the whole protocol documented in its header. See [docs/PLUGINS.md](docs/PLUGINS.md).

In TypeScript there is a shorter route. Describe the kinds of thing your API has and how
they connect, and `defineMapping` builds the paging, naming, search and graph for you:

```ts
export const trackerPlugin = defineMapping({
  type: 'tracker',
  displayName: 'Tracker',
  setup: (options) => ({
    types: [{ name: 'Issue', key: (i) => i.id, title: (i) => i.title }],
    roots: [{ name: 'issues', type: 'Issue', universal: true, resolve: () => fetchIssues() }],
  }),
});
```

See [the mapping surface](docs/PLUGINS.md#the-mapping-surface).

## Rearrange the tree to match how you think

The folders a source ships with are one opinion about navigation. Outlook gives you folders
because Outlook has folders; it does not know you think in people, or in weeks, or in
"things I have not replied to".

Because every mounted source is exposed as a graph rather than only a tree, you can say so —
in GraphQL, across all of them at once, mounted back as an ordinary directory tree:

```jsonc
{ "path": "/by-person", "type": "projection",
  "options": { "query": "{ all(filter: \"is:unread\") @flatten @group(by: \"author\") { name mtime } }" } }
```

```sh
mscomms schema                                      # what can I select?
mscomms graphql '{ all(filter: "is:unread") { name source } }'
```

That mount lists, pages, caches, searches and completes like any other, and `cat` on a
message inside it opens the real message. Sources that never heard of graphs get the one
their tree implies, so nothing has to opt in. See [docs/PROJECTIONS.md](docs/PROJECTIONS.md).

## Keyboard and accessibility

- **Everything is a typed command.** There is no mouse, and no keystroke you must discover.
- **Tab completes** commands, flags, paths, query fields and query values. Pressing it again
  prints a numbered list as ordinary text — never a floating overlay, which a screen reader
  cannot observe.
- **Numbers address items.** `ls`, then `cat 3`. Use `#3` when a file is genuinely named `3`.
- **Colour is never information.** Anything shown in colour is also stated in words.
- **`--announce`** renders listings as spoken sentences instead of aligned columns.
- **Speak to it, if you want.** `voice on` turns on speech control. It produces the same
  command lines you would have typed — so everything it does lands in `history`, obeys the
  same confirmations, and comes back with `undo`. See [docs/VOICE.md](docs/VOICE.md).
- **Everything is undoable.** `undo` reverses your last change, whether it came from a typed
  command, an arrow key or your voice. `history` shows what happened and which of those it
  was. Undo stops at anything it cannot reverse and says so, rather than skipping past it.
- **stdout is data, stderr is chrome.** Prompts, banners, status lines and paging footers
  go to stderr, so `mscomms find -q is:unread --json | jq` works.

There is also an opt-in full-screen pane:

```bash
mscomms --tui
mscomms --tui --demo   # with the sample data already mounted
```

It is **opt-in on purpose**. The line shell above is the primary interface, because a
full-screen application that repaints itself is exactly the thing screen readers handle
worst. The pane adds no capability of its own — `:` inside it runs the same commands, and
anything you can do there you can do by typing. It refuses to start with `--announce` or
`--plain`, and says why rather than ignoring you. Arrow keys move, Enter opens, `?` lists
the keys, `q` quits, and **Ctrl+C always works, from any mode**, including mid-filter.
On exit it prints where you were and what was selected, so a full-screen session isn't a
hole in your scrollback.

`--demo` is the `demo` command hoisted to startup. The line shell can be told `demo` at its
prompt, but the pane has no prompt until it has drawn itself, so on an unconfigured machine
it would otherwise open onto an empty tree.

## Scripting

```sh
mscomms ls /mail/Inbox --json
mscomms find /mail -q "is:unread from:dana" --tsv
mscomms find -a -q "subject:budg* OR subject:forecast^2" --json
mscomms cat "/mail/Inbox/2026-08-11 FY26 budget review.eml"
mscomms watch /mail/Inbox -q is:unread      # desktop notification on new mail
```

Exit codes: `0` success, `1` command failed, `2` bad usage or bad config, `4` no such path,
`77` permission denied, `127` unknown command.

## Documentation

| Document | What is in it |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the VFS, providers and cache fit together, and why |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Every config key, every built-in provider's options |
| [docs/PLUGINS.md](docs/PLUGINS.md) | Writing a backend, in TypeScript or any other language |
| [docs/PROJECTIONS.md](docs/PROJECTIONS.md) | Reorganizing your tree with a GraphQL query over every source |
| [docs/VOICE.md](docs/VOICE.md) | Speaking to it, and why every interaction is undoable |
| [docs/ACCESSIBILITY.md](docs/ACCESSIBILITY.md) | The reasoning behind the interface decisions |
| [docs/PRIOR-ART.md](docs/PRIOR-ART.md) | What twenty-odd earlier projects got right and wrong |

## Status

Working and tested: the VFS engine, the query language (including Lucene syntax and
relevance ranking), cross-source search, cache, notifications, the line shell, tab
completion, the opt-in full-screen pane (`--tui`), the interaction journal and undo, voice
control, the graph model, the mapping surface, GraphQL projections, and the memory, RSS,
GitHub, Graph, Azure DevOps and exec providers. 1314 tests.

Exercised end-to-end against live data: RSS (over HTTP), GitHub (against the public API),
and the exec plugin protocol (against a Python plugin). The Graph providers have been
exercised against the API shape but not against every tenant configuration; if your tenant
blocks the default public client, set `clientId` in the mount options.

Not done: offline-first sync. The full-screen pane has been tested against synthetic
terminals rather than every real one. Voice has been exercised end to end through
`voice say`, which covers everything except the microphone and the transcription service;
the grammar, journal, confirmation and undo paths are all tested, but the hosted
transcription endpoints have not been run against a live tenant.

## Licence

MIT.
