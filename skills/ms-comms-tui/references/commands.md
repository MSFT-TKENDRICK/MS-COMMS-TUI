# Command reference

Invoke an existing `mscomms <command> [args] [global flags]` on `PATH`, or use `node` and the
absolute `packages/cli/dist/bin.js` path of the user's existing built checkout. Do not assume
the current directory is that checkout. Paths are mount-relative (`/mail/Inbox`, `/chats/...`,
`/people/...`).

Exit codes: `0` success, `1` command failed, `2` bad usage or bad config, `4` no such path,
`77` permission denied, `127` unknown command.

## Global flags

| Flag | Effect |
|---|---|
| `--json` / `--tsv` / `--plain` | Machine-readable output (prefer `--json`). |
| `--announce` | Screen-reader friendly progress text. |
| `-c, --config <file>` | Use a specific config file (default `%APPDATA%\mscomms\config.jsonc` on Windows; `MSCOMMS_CONFIG` overrides). |
| `--demo` | Built-in sample mounts. Output is sample data — label it. |
| `-i, --shell` / `--tui` | Interactive modes. **Not for automation.** |

## navigate (read-only)

| Command | Notes |
|---|---|
| `ls [path] [-l] [-n N] [-q query] [--sort field:dir] [--all] [--refresh]` | List entries. Filtered listings go to the source, not the cache. |
| `more [-n N]` | Next page of the previous listing. |
| `cd [path\|number]`, `pwd`, `back`, `up` | Shell navigation; mostly useful inside `--shell`. |
| `tree [path] [--depth N] [--files]` | Folder tree. |
| `mounts` | Configured mounts. |

## read

| Command | Notes |
|---|---|
| `cat <path> [--raw] [--headers]` | Read an item body. |
| `stat <path>` | Item metadata. |
| `actions <path>` | List actions an item supports. |
| `attachments <path>` | List attachments. |
| `url [path\|number]` | Web link for an item. |
| `do <action> [path\|number] [--param value ...] [--yes]` | **Mutates** (reply, archive, mark read, …). Destructive actions need `--yes`. |
| `save <path\|number> [attachment-number] [--to file]` | **Writes** an attachment/item to disk. |

## search (read-only)

| Command | Notes |
|---|---|
| `find [path] -q <query> [-a] [--source ids] [-n N] [--depth N] [--local\|--offline] [--no-semantic]` | Snapshot first, then live sources. `--local` stops at the snapshot and never contacts a source. `-a` searches all mounts. |
| `grep <text> [path] [-i] [-n N] [--scan N] [--context N] [--regex]` | Text match over listings; `--scan N` reads up to N bodies (more network). |
| `queries [name]` | Saved queries from config. |

## graph (read-only)

| Command | Notes |
|---|---|
| `schema [--source id]` | GraphQL schema of the mounts. |
| `graphql <query> \| --file f \| - [--operation name] [--var k=v] [--limit N] [--compact]` | Query mounts as GraphQL. |

## watch (stateful)

| Command | Notes |
|---|---|
| `watch [path] [-q] [--every] [--id] [--updates] [--label]` | **Creates** a watch. |
| `watches` | List watches (read-only). |
| `unwatch <id>` | **Removes** a watch. |
| `poll [id]` | Run watches once. |
| `notifications [--all] [--clear] [--read]` | `--clear`/`--read` **mutate** history. |

## system

| Command | Notes |
|---|---|
| `help [command]` | Usage. |
| `doctor` | Checks config, cache and each mount's auth path. Run only after the config preflight; startup can prompt. |
| `plugins`, `config` | Inspect plugins / effective config. |
| `set [name] [value]` | **Writes** settings. |
| `refresh [path]` | Re-fetch from the source. |
| `cache [clear\|sync\|export <path>]` | `clear`/`sync` **change** the snapshot; `export` writes a file. |
| `demo [--reset]`, `syntax`, `quit` | Demo data, syntax help, exit shell. |

## journal

`history [-n N] [--all] [--undoable]` (read-only); `undo [--skip] [--dry-run]`, `redo [--dry-run]` (**mutate** unless `--dry-run`).

## other

`voice <on|off|once|say|status|help|devices|test> [words...]` — voice control; not for automation.
