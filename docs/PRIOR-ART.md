# Prior art and design learnings

MS-COMMS-TUI exposes Outlook mail, Microsoft Teams chats, GitHub issues, RSS feeds, and user-supplied feeds as a browsable virtual filesystem.

This document is a comparison of mechanisms:
what earlier projects did, where those mechanisms failed, and which rules MS-COMMS-TUI now enforces.

The repeated pattern is clear:
filesystems are excellent for navigation, weak for unbounded streams, and dangerous when a display name is treated as identity. Terminal clients are excellent for keyboard work, but many inherited full-screen assumptions that do not serve the user this project is built for.

## Quick comparison

| Prior art | Paged listing | Pluggable backends | Accessible by design | Keyboard-only | Cross-backend search | Change notifications | Scriptable output |
|---|---:|---:|---:|---:|---:|---:|---:|
| Plan 9 / 9P / `upas/fs` | No | Yes, via file servers | Partial | Yes | No | Polling conventions | Yes |
| `/proc` and `sysfs` | Partial | Kernel subsystems | Partial | Yes | No | Kernel-specific | Yes |
| Maildir / MH | Directory-sized | Via mail clients | Partial | Yes | No | External sync only | Yes |
| IMAP FUSE mail filesystems | Usually no | No | Partial | Yes | No | Hard: IMAP IDLE per folder | Yes |
| `gmailfs` | No | No | No | Yes | No | No | Yes |
| `sshfs` | Filesystem-native | No | Partial | Yes | No | No | Yes |
| `s3fs` | Weak under large buckets | No | Partial | Yes | No | No | Yes |
| `gitfs` / HUBFS | Partial | No | Partial | Yes | No | No | Yes |
| mutt / neomutt | Folder-sized | Accounts plus hooks | No | Yes | Partial, via notmuch | Mail-check polling | Partial |
| alpine | Folder-sized | Mail protocols | No | Yes | Limited | Mail-check polling | Partial |
| aerc | Folder/search views | Mail backends | No | Yes | Mail-only | Backend-dependent | Yes |
| Himalaya | Command results | Mail backends | Better: CLI-first | Yes | Mail-only | Backend-dependent | Yes |
| notmuch | Limit/offset search | Frontends around library | Partial | Yes | Mail-only | Requires external sync | Yes |
| Newsboat / Newsbeuter | Per-feed limits | Feeds | No | Yes | Feed queries only | Polling | Yes |
| snownews | Per-feed | Feeds | No | Yes | No | Polling | Partial |
| sfeed / rsstail | Stream/filter oriented | Feeds | Better: plain text | Yes | Shell-driven | Polling / tailing | Yes |
| tuir / rtv | API pages | Reddit only | No | Yes | Reddit only | Polling | Partial |
| toot / tuisky | API pages | Mastodon only | No | Yes | Mastodon only | Streaming/polling | Partial |
| slack-term | API pages | Slack only | No | Yes | Slack only | RTM, later broken | Partial |
| gomuks / iamb | API pages | Matrix only | No | Yes | Matrix only | Matrix sync | Partial |
| WeeChat + plugins | Buffer lists | Strong plugin API | No | Yes | Per plugin | Per plugin | Strong |
| `gh` CLI | API pages | GitHub only | Better: CLI-first | Yes | GitHub only | No persistent stream | Yes |
| `glab` | API pages | GitLab only | Better: CLI-first | Yes | GitLab only | No persistent stream | Yes |
| `jira-cli` | API pages | Jira only | Better: CLI-first | Yes | Jira only | No persistent stream | Yes |
| MS-COMMS-TUI | Yes | Yes | Yes, line shell first | Yes | Yes, VFS search | Poll cursors | Yes |

## Family 1: mail as a filesystem

### Maildir

Maildir stores each message as a file under `tmp`, `new`, or `cur`. State is encoded in the filename after `:2,`, for example `S` for seen and `R` for replied. State changes are atomic renames.

What it got right:

- It uses real files, so ordinary tools can copy, grep, back up, and index mail; Delivery is lock-free: write in `tmp`, then rename into `new`; Read/unread flags survive crashes because they are part of the filename; It does not pretend the subject is a stable filename.

What it got wrong:

- The filename is intentionally opaque; it is not meant to be read aloud; Threading, HTML rendering, attachments, and account-specific semantics are outside the format; A large folder is still a large directory; a naive `ls` must enumerate it; Search requires an external indexer such as notmuch.

Learning taken:
MS-COMMS-TUI keeps provider identity separate from display names. `packages/core/src/provider.ts` gives every `VNode` an opaque `id`, and `packages/core/src/vfs.ts` lets callers pass a `VNode` directly as a `VfsTarget` so actions do not reverse-engineer identity from the name.

### MH

MH treats mail as numbered files in directories and exposes message operations as small shell commands.
It is close to the Unix philosophy:
compose, scan, show, and refile are commands, not modes inside a monolith.

What it got right:

- The model is scriptable; One message per file composes well with shell tools; Numbered messages are easy to address after a listing.

What it got wrong:

- Numbers are local to a folder and not stable across refile or rescan operations; The folder is the primary organizing unit, so cross-folder threads are awkward; Search and rich metadata are bolt-ons; Large folders still impose large directory operations.

Learning taken:
MS-COMMS-TUI borrows numbered addressing for interaction, not for identity. The shell advertises `ls` then `cat 3` in `packages/cli/src/shell.ts`, while the provider still receives the resolved node object.

### Plan 9 `upas/fs`

Plan 9's `upas/fs` mounts mail as a 9P filesystem. A mailbox appears under paths such as `/mail/fs/mbox/1/`, with synthetic files like `header`, `body`, `mimetext`, and `info`. Attachments are represented as nested MIME-part directories.

What it got right:

- It is the cleanest ancestor of messages-as-files; `cat` and `cp` work on message bodies and attachments; The per-message directory admits multiple representations of the same message; The interface is language-neutral because it is just file I/O.

What it got wrong:

- Rich predicates do not fit the path model; there is no natural `from:alice since:yesterday` path; Recursive traversal causes one operation per synthetic node; Synthetic files can lie about size and modification time because values may be unknown until read; Notifications are not first-class; users poll or use control files; Numbered directories are speakable but not stable across remounts.

Learning taken:
MS-COMMS-TUI keeps filesystem navigation and query evaluation separate. `packages/core/src/provider.ts` defines `list`, `read`, `search`, and `poll` as separate capabilities instead of forcing every operation through paths.

### FUSE mail filesystems: `mailfs`, IMAPFS, and similar mounts

FUSE mail filesystems map IMAP folders to directories and messages to `.eml` or text files. The attraction is obvious: the mailbox becomes visible to every Unix tool.

What they got right:

- They make remote mail tangible; They enable `grep`, `less`, and editor workflows without writing a mail client; They prove that users want a bridge between communication data and file tools.

What they got wrong:

- A plain `ls` can force full enumeration; listing a 200,000-message folder can hang the terminal; IMAP sequence numbers shift when messages are expunged, so paths based on sequence numbers can point at different mail later; IMAP `IDLE` is per folder; watching many folders consumes many server connections; `read(offset, length)` is hard because MIME and IMAP partial fetch do not align with POSIX byte ranges; Tools such as `find`, shell completion, `du`, and file managers `stat()` aggressively and can turn browsing into thousands of remote calls.

Learning taken:
`packages/core/src/provider.ts` makes listing paged:
`list()` returns one `ListPage` plus an optional cursor. `packages/core/src/vfs.ts` defaults to a page size of 50 and preserves listing order across pages so numbers do not change after `more`.

### `gmailfs`

`gmailfs` used Gmail storage as a mounted filesystem. The research found the original project and mirrors effectively gone,
but the reported behavior is relevant:
it depended on a vendor service not designed to be a filesystem.

What it got right:

- The concept was instantly legible: mount Gmail, then copy files into it; It demonstrated the appeal of hiding a remote API behind file operations.

What it got wrong:

- Authentication changes and service policy changes could kill the mount; Filesystem errors did not naturally explain OAuth or API failures; It optimized the stunt of mounting storage, not a durable user workflow.

Learning taken:
Provider failures must degrade explicitly. `packages/core/src/vfs.ts` can serve stale cached listings or documents on refresh failure, and `packages/core/src/provider.ts` models poll cursors and retry delays so vendor outages do not become silent hangs.

## Family 2: everything as a filesystem

### Plan 9 and 9P

Plan 9 generalizes the filesystem interface through per-process namespaces and 9P file servers. Network, windows, mail, and devices can all be mounted.

What it got right:

- It turned composition into the default architecture; Programs can interoperate through `read` and `write` without linking libraries; Per-process namespaces avoid one global view of the world; The plumber is a powerful pattern router for typed actions.

What it got wrong:

- The filesystem is not self-describing enough for rich, typed operations; Search requires separate conventions and tools; Every file server invents its own layout, creating an N-by-M learning problem; Network round-trips behind ordinary path traversal can be invisible until they hurt.

Learning taken:
MS-COMMS-TUI uses a small provider contract rather than a literal kernel mount. `packages/core/src/provider.ts` exposes typed capabilities, while the shell and TUI remain backend-agnostic.

### `/proc`

`/proc` exposes process and kernel state as files. It is one of the most successful examples of synthetic files.

What it got right:

- It lets shell tools inspect live system state; Text files such as `/proc/cpuinfo` are easy to parse; It makes hidden kernel data discoverable.

What it got wrong:

- Many files are not regular files in any meaningful sense; Size and seek behavior are often special; Formats are ad hoc and vary by platform or kernel version; It is easy for scripts to depend on undocumented layout details.

Learning taken:
MS-COMMS-TUI does not pretend every synthetic node has complete POSIX metadata. `packages/core/src/provider.ts` marks `size`, `mtime`, counts, and metadata as optional.

### `sysfs`

`sysfs` exposes kernel devices and attributes as a hierarchy of files. It pushes strongly toward one value per file.

What it got right:

- It is structured and predictable compared with older `/proc` interfaces; Small attribute files are easy to inspect and script; Paths communicate hierarchy and ownership.

What it got wrong:

- It is still a specialized control plane, not a general query language; Operations with side effects can look like simple writes; Users must already understand the device model to navigate it safely.

Learning taken:
Actions in MS-COMMS-TUI are explicit descriptors, not magic writes. `packages/core/src/provider.ts` defines `ActionDescriptor`, parameters, and a `destructive` flag so shell, TUI, and help can present actions consistently.

### `sshfs`

`sshfs` mounts SFTP over FUSE. It is the benchmark for successful user-space filesystems.

What it got right:

- SFTP is already filesystem-shaped; File size, modification time, directory listing, and read ranges have honest protocol support; Error modes are familiar: connection loss is a connection error; Existing programs work because the remote semantics are close to local files.

What it got wrong for this project:

- Its success does not transfer to APIs that are not filesystem-shaped; It does not solve rich queries or cross-service search; It gives no pattern for message-specific concepts such as unread, thread, mention, or attachment.

Learning taken:
MS-COMMS-TUI avoids FUSE as the primary UX. It presents a VFS inside an accessible shell so it can page, filter, cache, and explain errors instead of satisfying arbitrary POSIX callers.

### `s3fs`

`s3fs` maps object storage buckets into a filesystem. It is useful but reveals the mismatch between object stores and POSIX.

What it got right:

- It makes object storage reachable from ordinary tools; It is good enough for simple copy and read workflows.

What it got wrong:

- Directories are simulated through prefixes; Rename is not a cheap atomic metadata operation; it can become copy plus delete; Listing large buckets is paged by the object API, but many POSIX callers expect complete directories; Consistency and metadata semantics are not those of a local filesystem.

Learning taken:
The provider API is honest about cursors and approximate totals. `packages/core/src/provider.ts` exposes `cursor` and optional `total` rather than pretending a complete directory is always known.

### `gitfs` and HUBFS

Git-backed filesystems expose repository contents as directories and files. HUBFS is especially relevant because it exposes GitHub repository content via WinFsp/FUSE-like machinery. The research notes HUBFS deliberately refuses to list the root because there are too many owners.

What they got right:

- The hierarchy `/owner/repo/ref/path` is intuitive; They exploit an underlying tree model that is already filesystem-like; HUBFS's refusal to list an unbounded root is the right kind of honesty; Local caching is essential and explicit.

What they got wrong:

- Repository content is not issue, PR, chat, or mail metadata; GitHub rate limits make recursive traversal expensive; Search such as `label:bug assignee:me` is not naturally expressible as a path; Branch names and paths carry their own escaping and ambiguity problems.

Learning taken:
MS-COMMS-TUI treats GitHub issues as provider data, not as literal repository files. Search is a capability, and listing is bounded.

### WikipediaFS and title-named filesystems

WikipediaFS mounted wiki pages as files named after article titles.

What it got right:

- Editing a page in `$EDITOR` is a good power-user workflow; Page-as-file is immediately understandable.

What it got wrong:

- Article titles contain spaces, punctuation, Unicode, slashes, and case distinctions; Renaming a page changes the apparent file path; Authentication and API changes made long-term maintenance brittle; Filesystem legality, URL legality, and human title legality are different rules.

Learning taken:
`packages/core/src/naming.ts` centralizes sanitization. It normalizes Unicode, removes invisible controls, replaces path separators, protects Windows device names, preserves readable spaces, truncates by UTF-8 bytes, and keeps extensions usable.

### Tag filesystems and semantic desktops

Tag filesystems such as Tagsistant and semantic desktop projects attempted to replace folders with metadata queries expressed as paths.

What they got right:

- Messages and articles often belong to multiple categories; Tags are closer to how people search than a single folder tree; Query-like paths can be composable in narrow cases.

What they got wrong:

- Users do not tag consistently enough to make tags the only navigation model; Automatic tagging creates trust and correction problems; Query syntax embedded in paths is hard to discover and hard to quote; The resulting path language is neither shell syntax nor SQL nor a familiar search UI.

Learning taken:
MS-COMMS-TUI uses hierarchy for browsing and query for narrowing. `packages/core/src/provider.ts` supports query push-down, and `packages/core/src/vfs.ts` applies the remainder locally.

## Family 3: terminal mail clients

### mutt and neomutt

Mutt and NeoMutt are keyboard-driven terminal mail clients built around folders, message indexes, and configurable keybindings. NeoMutt adds virtual mailboxes and notmuch integration.

What they got right:

- Keyboard operation is complete and fast; Pattern filters such as `~f alice` are powerful; Hooks make per-folder behavior possible; Virtual mailboxes bridge folder navigation and search; External viewers let users choose tools for HTML and attachments.

What they got wrong:

- Configuration is dense; a working `muttrc` can become hundreds of lines; Native IMAP is often avoided by heavy users in favor of external sync to Maildir; Threads spanning Inbox and Sent can be awkward because folders remain primary; HTML mail depends on external filters and fragile setup; The full-screen interface inherits screen-reader problems discussed in `docs/ACCESSIBILITY.md`.

Learning taken:
MS-COMMS-TUI keeps the default interface line-oriented and keeps backends replaceable. The shell is implemented in `packages/cli/src/shell.ts`; providers live behind `packages/core/src/provider.ts`.

### alpine

Alpine is a menu-driven terminal mail client descended from Pine. It remains keyboard-oriented and approachable compared with mutt.

What it got right:

- It exposes commands through visible menus and key hints; Keyboard navigation is first-class; It is easier to begin using than highly customized mutt setups.

What it got wrong:

- It is still a full-screen terminal application; Its model is mail-specific, not a general communications VFS; Cross-backend search across mail, Teams, issues, and feeds is out of scope; Screen-reader users still face repaint, cursor, and alternate-screen limitations.

Learning taken:
MS-COMMS-TUI's help and commands must be discoverable without committing to a full-screen menu. Plain `help`, printed completion, and numbered listings carry that load.

### aerc

Aerc is a modern terminal mail client with accounts, tabs, a command prompt, external filters, and optional notmuch integration.

What it got right:

- The buffer/tab model maps well to multiple accounts and searches; `:search` creates mail views without leaving the keyboard; Pipe filters make HTML rendering and transformations composable; `$EDITOR` is used for serious composition.

What it got wrong:

- The best search experience depends on external notmuch indexing; HTML rendering still depends on external filter configuration; It is mail-focused; feeds, Teams, and issues require a different abstraction; As a full-screen TUI, it cannot make ANSI output semantic to a screen reader.

Learning taken:
Actions and providers in MS-COMMS-TUI are data-driven. A new backend can expose commands through `ActionDescriptor` without changing the shell or TUI.

### Himalaya

Himalaya is a CLI-first email client with multiple backends and scriptable commands.

What it got right:

- It separates backend concerns from frontend use; It is naturally pipeable and scriptable; A command such as list/read is friendlier to screen readers than a repainting TUI.

What it got wrong:

- It is mail-specific; It does not provide a shared VFS spanning issues, feeds, chats, and mail; It does not solve cross-backend naming collisions.

Learning taken:
MS-COMMS-TUI follows the backend/frontend separation but generalizes it through `ProviderPlugin` in `packages/core/src/provider.ts`.

### notmuch

Notmuch is a local mail indexer and query system, not a mail transport or full mail client. It relies on other tools to sync, send, and render.

What it got right:

- Search and tags are primary rather than afterthoughts; It separates indexing from UI; It exposes a library and command-line interface for other programs; Saved searches behave like virtual folders.

What it got wrong:

- Initial indexing can be expensive for large mailboxes; It requires mail to exist locally, usually as Maildir; New mail is not visible until sync and `notmuch new` run; Graph mail, Teams chats, GitHub issues, and RSS items are not Maildir files.

Learning taken:
MS-COMMS-TUI uses provider-native search where possible, but the engine verifies query honesty. `packages/core/src/vfs.ts` re-applies query predicates unless a provider explicitly reports the applied query.

### sup and alot

Sup pioneered thread-centric, tag-and-search mail in the terminal. Alot builds a terminal mail UI on notmuch with buffers and Python hooks.

What they got right:

- Conversation and search can be better primary units than folders; Hooks and buffers are useful extension points; Tags fit mail better than single-location filing.

What they got wrong:

- Sup's own state could diverge from the mail source; syncing changes back was limited; Alot inherits notmuch's local-index dependency; Python hooks are powerful but single-language; Both are mail clients, not general cross-service browsers.

Learning taken:
Provider state in MS-COMMS-TUI is scoped and explicit through `StateStore`, while plugins can also be external programs through `packages/provider-exec/src/provider.ts`.

## Family 4: news and RSS readers

### Newsboat and Newsbeuter

Newsboat, the maintained fork of Newsbeuter, is a terminal RSS/Atom reader. Its query feeds are virtual feeds defined by filter expressions.

What it got right:

- Query feeds make saved searches feel like normal feeds; Filters over fields such as title, author, date, unread, feed title, and tags are powerful; Feed items are naturally paged by source and time; External bookmark commands preserve Unix composability.

What it got wrong:

- The filter language is custom; users must learn another syntax; Real-time narrowing inside an open feed is limited compared with an interactive search; It is feed-specific; It remains a full-screen TUI in normal use.

Learning taken:
Saved or typed queries should be first-class, but query syntax must be honest about what a backend actually applied. That rule is enforced by `appliedQuery` in `packages/core/src/provider.ts` and by the guard in `packages/core/src/vfs.ts`.

### snownews

Snownews is a small terminal RSS reader.

What it got right:

- It is focused and keyboard-oriented; It avoids the complexity of mail clients; It demonstrates the value of a simple feed list and item reader.

What it got wrong:

- Its model is one backend family: feeds; Search and cross-source workflow are limited; It does not solve naming, identity, or action semantics across arbitrary providers.

Learning taken:
MS-COMMS-TUI treats RSS as one mount among many, not a special top-level mode.

### canto

Canto is an RSS reader with a configurable terminal interface.

What it got right:

- Configuration enables feed-specific presentation; Keyboard navigation and terminal use are assumed.

What it got wrong:

- Configuration and scripting are reader-specific rather than a provider contract; It does not generalize to Teams, Outlook, GitHub, or arbitrary subprocess feeds; Full-screen presentation remains an accessibility risk.

Learning taken:
Extension points belong at the provider boundary, not in one feed reader.

### sfeed

`sfeed` is a suite of small tools that converts feeds into simple text formats.

What it got right:

- Plain text output is highly scriptable; It composes with shell tools instead of trapping the user in an interface; It aligns well with screen-reader and braille output because it is linear.

What it got wrong:

- It is intentionally minimal; interactive browsing, actions, and cross-backend identity are out of scope; Users assemble their own workflow from pieces; It does not provide provider notifications or a shared cache.

Learning taken:
MS-COMMS-TUI keeps scriptable modes. `packages/cli/src/format.ts` supports `plain`, `tsv`, `json`, and `announce` renderers instead of only an aligned table.

### rsstail

`rsstail` watches feed updates and prints items as they arrive.

What it got right:

- It treats feeds as streams; It is naturally pipeable; It avoids a screen UI for a notification-like workflow.

What it got wrong:

- It is not a browser of existing state; It is feed-only; It cannot express actions such as mark read, reply, open thread, or close issue.

Learning taken:
Polling is a provider capability, not a UI loop detail. `packages/core/src/provider.ts` models `poll(cursor)` with resumable cursors.

## Family 5: forum, social, and chat TUIs

### rtv and tuir

`rtv` and its fork `tuir` brought Reddit to the terminal. They are important because their ecosystem was effectively killed by Reddit API pricing and policy changes in 2023.

What they got right:

- They made large threaded discussions keyboard-browsable; They used familiar terminal navigation conventions; They showed that social feeds can work in a terminal.

What they got wrong:

- They depended on one vendor API and one policy regime; API pricing changes could destroy the client regardless of code quality; The full-screen model was not accessible by design; Reddit-specific assumptions did not generalize to other backends.

Learning taken:
Backends must be replaceable and degraded independently. `packages/core/src/provider.ts` keeps providers separate, and broken mounts are reported without preventing other mounts from working in `packages/cli/src/shell.ts`.

### toot and tuisky

Toot and tuisky are terminal clients for Mastodon-like social timelines.

What they got right:

- API pagination maps naturally to timelines; Keyboard interaction suits reading and posting short messages; Open protocols reduce the vendor-kill risk compared with closed services.

What they got wrong:

- They are protocol-specific; Timeline APIs do not solve mailbox threading or issue workflows; Full-screen timeline UIs still repaint state without terminal semantics.

Learning taken:
A provider can map any backend to `VNode`s, but the shell should not know whether an item is a toot, mail message, Teams chat, issue, or RSS article.

### slack-term

`slack-term` was a Go terminal client for Slack. The research identifies Slack API changes and legacy token deprecation as the failure pattern.

What it got right:

- It made team chat usable from a terminal; Channels, DMs, and message panes are a natural terminal layout for sighted users.

What it got wrong:

- It depended on Slack's legacy RTM/token model; OAuth scope changes and API deprecations could remove essential functionality; Chat protocols that require webhooks or app registrations do not fit a simple local TUI; It did not provide a general plugin boundary for other communications sources.

Learning taken:
MS-COMMS-TUI treats auth and API-specific sync as provider concerns. Provider configuration validates early through `ProviderPlugin.validateOptions`.

### matrix-commander

`matrix-commander` is a command-line Matrix client.

What it got right:

- It is scriptable and line-oriented; It exposes Matrix operations without forcing a full-screen UI; It is useful in automation.

What it got wrong:

- It is a command surface, not a browsable VFS; It is Matrix-specific; The user must know the Matrix command shape rather than navigating a shared tree.

Learning taken:
MS-COMMS-TUI needs both command access and discoverable browsing. The shell's implicit path-or-number handling in `packages/cli/src/shell.ts` serves that discovery path.

### gomuks

Gomuks is a Matrix client with a backend/frontend split; the terminal frontend is one of multiple frontends.

What it got right:

- Separating sync/backend from UI is the right architecture for communications; A backend can maintain session state while multiple frontends connect; Matrix sync is treated as a first-class state problem.

What it got wrong:

- Matrix-specific semantics do not cover Outlook, Teams, GitHub, and RSS; The terminal frontend remains a TUI rather than an accessibility-first shell; It does not solve arbitrary user-supplied providers.

Learning taken:
MS-COMMS-TUI's core package owns VFS behavior, while providers own protocol behavior.

### iamb

Iamb is a Matrix TUI with Vim-style keybindings.

What it got right:

- Vim-like commands are efficient for keyboard users; Multi-profile configuration is relevant to multi-account communications; It builds on a protocol SDK instead of hand-rolling the backend.

What it got wrong:

- It is Matrix-only; Modal full-screen interfaces require a screen-reader user to learn both the app and the workaround; Rich terminal rendering does not create semantic accessibility information.

Learning taken:
Keyboard efficiency is important, but not at the cost of making the accessible interface secondary.

### WeeChat plus BitlBee, Matrix, and other plugins

WeeChat is a modular chat client with a C core, buffers, plugins, scripting languages, and a relay protocol. BitlBee and Matrix plugins show the wider ecosystem around chat protocol bridges.

What it got right:

- Buffers are a strong abstraction for many conversations; Plugins can be loaded and unloaded independently; The relay protocol decouples backend state from frontend presentation; Scripts can add commands, hooks, and completions.

What it got wrong:

- Configuration spreads across many options and can overwhelm new users; Multi-protocol support quality depends on community plugins; IRC assumptions remain visible even in non-IRC use; The full-screen terminal UI is not accessible by design.

Learning taken:
MS-COMMS-TUI uses two plugin tiers. Native JavaScript providers implement `ProviderPlugin` in `packages/core/src/provider.ts`; language-agnostic subprocess providers are implemented in `packages/provider-exec/src/provider.ts`.

### matterhorn

Matterhorn is a mature Mattermost terminal client.

What it got right:

- It supports production chat features such as threads, reactions, attachments, and key help; Completion for users, channels, commands, emoji, and code languages is a strong interaction pattern; Versioning against a server API acknowledges compatibility as an ongoing maintenance burden.

What it got wrong:

- It is Mattermost-specific; Its completion and UI are full-screen terminal interactions; It does not provide a cross-backend virtual filesystem.

Learning taken:
Completion is necessary, but MS-COMMS-TUI prints candidates as scrolling text in `packages/cli/src/completion.ts` rather than as a repainting overlay.

## Family 6: issue trackers and developer CLIs

### `gh` CLI

The GitHub CLI exposes issues, pull requests, checks, releases, and repository operations as commands.

What it got right:

- Output can be human-readable or JSON; It is scriptable and pipeable; It respects the shell as the interaction model; It covers a broad API without inventing a full-screen UI.

What it got wrong:

- It is GitHub-only; It does not mount issues beside mail, Teams, and feeds; Cross-backend search and navigation are out of scope; The user must remember command shapes rather than browse a unified tree.

Learning taken:
MS-COMMS-TUI keeps scriptable output modes but adds a VFS and numbered browsing.

### `glab`

`glab` is the GitLab counterpart to `gh`.

What it got right:

- It provides issue and merge-request workflows in the terminal; It supports automation-friendly output; It maps a web API into commands without a screen UI.

What it got wrong:

- It is GitLab-specific; It does not solve cross-provider identity or naming; Its search is bounded by GitLab's API model.

Learning taken:
Issue trackers should be providers, not special cases.

### `jira-cli`

Jira CLI tools expose Jira issues through terminal commands.

What they got right:

- They make issue search and updates scriptable; They support keyboard-only workflows; They prove that web issue trackers do not require a browser for every task.

What they got wrong:

- Jira query language and project configuration leak into every workflow; Tool behavior is tied to one product's schema; They do not integrate with mail, chat, and feeds as one navigable space.

Learning taken:
Provider metadata in `packages/core/src/provider.ts` is free-form and queryable, so issue fields can exist without hard-coding Jira or GitHub concepts into the engine.

### `hub`

`hub` extended Git with GitHub-aware commands before `gh` became the official CLI.

What it got right:

- It integrated with an existing mental model: Git commands; It was useful because it reduced browser round trips.

What it got wrong:

- It was tightly coupled to GitHub and Git workflows; It did not generalize into a communications browser; As a wrapper, it inherited limits from both Git and GitHub APIs.

Learning taken:
MS-COMMS-TUI should not hide every backend behind an existing command vocabulary; it should expose a common browsing vocabulary and provider-specific actions.

## Family 7: arbitrary plugins and subprocesses

### Language-specific plugin APIs

WeeChat, irssi, mutt hooks, alot hooks, and aerc filters show several extension styles.

What they got right:

- Extension is why long-lived terminal clients survive; Hooks and commands let users adapt a tool to their own workflow; External filters are often safer and more durable than in-process APIs.

What they got wrong:

- Single-language APIs age with their language ecosystem; In-process plugins can crash or compromise the host; Config-only hooks become brittle for complex logic; Too much plugin power without a narrow contract makes compatibility hard.

Learning taken:
`packages/provider-exec/src/provider.ts` defines an external JSON-lines plugin tier. Commands are arrays and are never passed through a shell; remote data reaches the plugin as JSON, not shell text. The engine re-filters queries from exec providers instead of trusting them to hide or show mail correctly.

## Distilled learnings enforced in this codebase

### 1. Listing is always paged

Prior work failure:
FUSE mail mounts and object-store mounts can turn ordinary `ls`, completion, `find`, or `du` into unbounded remote enumeration.

Enforcement:
`packages/core/src/provider.ts` defines `ListOptions.limit`, `ListOptions.cursor`, and `ListPage.cursor`. `packages/core/src/vfs.ts` applies a default page size and keeps directory order stable across pages.

### 2. Queries push down, but the engine verifies honesty

Prior work failure:
Downloading every message to grep locally does not scale, but blindly trusting a backend search can return false positives or hide matches.

Enforcement:
`packages/core/src/provider.ts` lets a provider return `appliedQuery`. `packages/core/src/vfs.ts` re-applies the query unless the provider's applied query string matches the requested query. `packages/provider-exec/src/provider.ts` treats subprocess query handling as a hint and relies on engine-side re-filtering.

### 3. Identity is not the display name

Prior work failure:
Title-named filesystems lose identity when titles are sanitized, renamed, or collide. A display name such as `Budget review.eml` cannot be parsed back into a Graph ID.

Enforcement:
`packages/core/src/provider.ts` requires `VNode.id`. `packages/core/src/vfs.ts` defines `VfsTarget = string | VNode` and prefers the node object when one is available. Providers receive nodes, not path strings, for read and action operations.

### 4. Human names are sanitized centrally

Prior work failure:
Wiki and mail title files break on slashes, device names, Unicode normalization, case-insensitive filesystems, long components, and invisible spoofing characters.

Enforcement:
`packages/core/src/naming.ts` implements `sanitizeSegment`, `collisionKey`, and `NameAllocator`. It preserves spaces for screen-reader users, protects extensions, strips bidi and zero-width controls, and appends `~2` before extensions on collisions.

### 5. Numbered addressing is interaction, not storage

Prior work failure:
Sequential message numbers are convenient but unstable if used as persistent identity.

Enforcement:
The shell in `packages/cli/src/shell.ts` teaches `ls` then `cat 3`. `packages/core/src/vfs.ts` keeps page order stable after more results are loaded. The resolved node, not the number, is passed onward.

### 6. Search hits keep real paths

Prior work failure:
Search results from multiple folders cannot be acted on if their leaf names are joined to the search root.

Enforcement:
`packages/core/src/vfs.ts` has `#searchHitPath` and `#nameSearchHits`. Search hit display names can be relative paths such as `Inbox/budget.eml`, while `path` remains the actionable true VFS path.

### 7. Completion must not block or repaint

Prior work failure:
Fuzzy overlays and shell menu completions repaint regions that screen readers do not perceive, and network-backed completion can look like a hang.

Enforcement:
`packages/cli/src/completion.ts` completes only from the last listing or stale VFS cache, prints multiple candidates as ordinary scrolling text, and never performs a network fetch on Tab.

### 8. Output has modes, and colour is not data

Prior work failure:
Terminal clients often encode state as colour, glyphs, or table layout that is lost through speech, braille, or pipes.

Enforcement:
`packages/cli/src/format.ts` has `table`, `plain`, `announce`, `json`, and `tsv` renderers. It spells out relative times, prefixes every listing row with a number, and uses words as well as decoration.

### 9. Remote text is hostile until sanitized

Prior work failure:
A subject line, chat message, or issue title can contain control sequences or bidirectional override characters. Printed raw, it can repaint the terminal or visually reorder text.

Enforcement:
`packages/cli/src/format.ts` provides `sanitizeForDisplay` for rendered output. `packages/core/src/naming.ts` separately strips invisible controls from path segments.

### 10. Change notification is poll-with-cursor

Prior work failure:
Most remote services do not push directly to a local CLI without webhooks, persistent sockets, or vendor-specific mechanisms.

Enforcement:
`packages/core/src/provider.ts` defines `poll(parent, cursor)` and `PollResult` with `changes`, `cursor`, and `retryAfter`. That covers Graph delta links, RSS validators, GitHub `since` queries, and provider-specific cursors.

### 11. Plugins must be language-agnostic

Prior work failure:
Single-language plugin systems age, and vendor-specific clients die when one API changes.

Enforcement:
`packages/core/src/provider.ts` defines the TypeScript provider contract. `packages/provider-exec/src/provider.ts` adds the subprocess JSON-lines tier for programs in any language.

## Deliberate divergence: human-readable names instead of raw IDs

The filesystem research recommended using raw backend IDs as filenames, with a human-readable sidecar or index.
The argument is strong:
IDs are stable, subjects are mutable, and display names collide. A filename such as `AAMkAGI2...eml` survives a subject edit better than `2026-08-11 Budget review.eml`.

MS-COMMS-TUI deliberately does not follow that recommendation. It uses human-readable names such as `2026-08-11 Budget review.eml`, sanitized by `packages/core/src/naming.ts`, and disambiguates collisions with `~2`.
The primary way to act on an item is numbered addressing:
run `ls`, hear or read the list, then type `cat 3`. The `stat` command can reveal the true provider ID because `VNode.id` is retained.

The reason is the target user. This tool is designed for keyboard-only terminal use where output may be heard through speech or read through braille. An opaque Graph ID is unspeakable and unmemorable. ID-as-filename optimizes for a script that never has to hear the path, at the expense of the human the tool exists for.

Stability is recovered differently. `packages/core/src/vfs.ts` defines `VfsTarget = string | VNode`. When a user acts on a numbered listing, the CLI can pass the resolved node object itself to the VFS and provider. Identity therefore does not round-trip through the display name. The provider receives the original `VNode.id`.

The tradeoff is real: names are not stable across sessions when a subject or title is edited; two sessions can allocate different `~N` suffixes depending on listing order and cache state; a copied display path may fail later if the backend title changes; scripts that need durable identity should use `stat` and machine-readable output, not human names.

This is an explicit accessibility trade. Human navigation gets readable names and numbers. Programmatic identity remains available but is not forced into every spoken path.

## What we have not solved

### Offline-first sync

Prior art repeatedly shows that offline-first mail is hard. Maildir plus notmuch works because everything is local first, but it requires a separate synchronizer and conflict model. MS-COMMS-TUI can serve stale cached data from `packages/core/src/vfs.ts`, but that is not the same as a full offline-first replica with queued actions, conflict resolution, and complete search.

### Backend-specific threading

Email threads use `Message-ID`, `In-Reply-To`, and `References`. Teams threads and replies use Graph chat and channel message structures. GitHub issues and comments have another model. RSS feeds often have no reliable thread model. A shared VFS can expose threads, but it cannot make these semantics identical.

### True cross-backend full-text indexing

The VFS can call provider-native search and can walk bounded trees when needed. That is not the same as a local, always-fresh, cross-backend full-text index like notmuch for every source. Building that would require storage, incremental indexing, deletion handling, privacy choices, and ranking rules.

### Literal POSIX compatibility

MS-COMMS-TUI is a virtual filesystem inside a CLI/TUI, not a kernel mount. That avoids the worst FUSE failure modes, but it also means arbitrary POSIX tools cannot directly `open()` every message path unless a future bridge is added.

### Microsoft Teams and Outlook terminal clients

The research found no published open-source TUI for Microsoft Teams or Outlook. It did find wrappers, raw API CLIs, and web clients, but not a real terminal communications client for those Microsoft surfaces. That negative result is the gap MS-COMMS-TUI is filling.

### Notification delivery

The provider contract supports polling with cursors. It does not guarantee real-time push. Graph webhooks, RSS validators, GitHub polling, and arbitrary subprocess feeds have different delivery, throttling, and retry behavior.

## Claims intentionally not carried forward as facts

The research included several useful but less certain notes.
This document avoids depending on them as primary claims:

- Exact Reddit API pricing figures from 2023 are not needed to prove the vendor-kill pattern; Deleted or 404 projects such as some `imapfs`, `gmailfs`, `tuir`, and `circumflex` entries are treated as cautionary examples, not as source-verified implementation references; Auth-blocked GitHub accessibility issues are not used as direct evidence here; Claims about Teams API scope restrictions are kept general because current Microsoft Graph permissions should be verified against live documentation before implementation decisions.
