# MS-COMMS-TUI

Browse Outlook mail, Microsoft Teams chats, your org chart, GitHub issues, RSS feeds and
anything else you can write forty lines of script for — as folders and files, from the
keyboard.

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

**Everything is the same shape.** Mail, chats, issues and feeds are all "a stream of
authored, timestamped, sometimes-unread things, grouped somehow". Modelling them once and
writing the interface once means a new backend is a plugin, not a fork.

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
npm install     # devDependencies only: TypeScript
npm run build
npm link        # optional: puts `mscomms` and `msh` on your PATH
```

## Try it without connecting anything

```sh
mscomms          # starts the shell
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
    { "id": "news",   "path": "/news",   "type": "rss",
      "options": { "feeds": [{ "url": "https://example.com/feed.xml", "name": "Example" }] } }
  ]
}
```

Full reference: [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

## Add your own source

Any program that reads JSON lines on stdin and writes JSON lines on stdout is a valid
backend, in any language:

```jsonc
{ "id": "notes", "path": "/notes", "type": "exec",
  "options": { "command": ["python3", "my-plugin.py"], "capabilities": ["list", "read"] } }
```

`examples/notes-plugin.mjs` is a complete, dependency-free reference implementation with
the whole protocol documented in its header. See [docs/PLUGINS.md](docs/PLUGINS.md).

## Keyboard and accessibility

- **Everything is a typed command.** There is no mouse, and no keystroke you must discover.
- **Tab completes** commands, flags, paths, query fields and query values. Pressing it again
  prints a numbered list as ordinary text — never a floating overlay, which a screen reader
  cannot observe.
- **Numbers address items.** `ls`, then `cat 3`. Use `#3` when a file is genuinely named `3`.
- **Colour is never information.** Anything shown in colour is also stated in words.
- **`--announce`** renders listings as spoken sentences instead of aligned columns.
- **stdout is data, stderr is chrome.** Prompts, banners, status lines and paging footers
  go to stderr, so `mscomms find -q is:unread --json | jq` works.

There is also an opt-in full-screen pane:

```bash
mscomms --tui
```

It is **opt-in on purpose**. The line shell above is the primary interface, because a
full-screen application that repaints itself is exactly the thing screen readers handle
worst. The pane adds no capability of its own — `:` inside it runs the same commands, and
anything you can do there you can do by typing. It refuses to start with `--announce` or
`--plain`, and says why rather than ignoring you. Arrow keys move, Enter opens, `?` lists
the keys, `q` quits, and **Ctrl+C always works, from any mode**, including mid-filter.
On exit it prints where you were and what was selected, so a full-screen session isn't a
hole in your scrollback.

## Scripting

```sh
mscomms ls /mail/Inbox --json
mscomms find /mail -q "is:unread from:dana" --tsv
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
| [docs/ACCESSIBILITY.md](docs/ACCESSIBILITY.md) | The reasoning behind the interface decisions |
| [docs/PRIOR-ART.md](docs/PRIOR-ART.md) | What twenty-odd earlier projects got right and wrong |

## Status

Working and tested: the VFS engine, query language, cache, notifications, the line shell,
tab completion, the opt-in full-screen pane (`--tui`), and the memory, RSS, GitHub, Graph
and exec providers. 800 tests.

Exercised end-to-end against live data: RSS (over HTTP), GitHub (against the public API),
and the exec plugin protocol (against a Python plugin). The Graph providers have been
exercised against the API shape but not against every tenant configuration; if your tenant
blocks the default public client, set `clientId` in the mount options.

Not done: offline-first sync. The full-screen pane has been tested against synthetic
terminals rather than every real one.

## Licence

MIT.
