# Safety: auth, network and mutation

## When does the CLI sign in?

One-shot commands still await session startup, which connects every configured mount.

| Mount | Auth path | Prompts? |
|---|---|---|
| `graph-mail`, `graph-chat`, `graph-people` | M365 MCP server (`MSCOMMS_GRAPH_MCP_COMMAND`, `MSCOMMS_GRAPH_MCP_CONFIG`, `~/.copilot/mcp-config.json`) | No |
| same | `MSCOMMS_GRAPH_TOKEN` supplied by the caller | No |
| same | neither of the above → cached token / refresh → **OAuth device code** | **Yes** |
| `ado-boards` | separate token (`MSCOMMS_ADO_TOKEN`) or device code | Possibly |
| `github` | `GITHUB_TOKEN` or a credential borrowed from `gh` | No |
| `memory`, `rss`, `exec`, `projection` | none / as configured | No |

Agent procedure:

1. Read the config (`MSCOMMS_CONFIG`; otherwise `%APPDATA%\mscomms\config.jsonc` on Windows,
   or `$XDG_CONFIG_HOME/mscomms/config.jsonc`, falling back to `~/.config/mscomms/config.jsonc`,
   on Linux and macOS) and look for `graph-*`/`ado-boards` mounts without a non-interactive
   auth path. Do not expose configuration secrets.
   `doctor` prints the same summary ("N of M Microsoft 365 source(s) will ask you to sign in
   with a device code"), but like every command it starts the session first.
2. If any mount would use device code, or its auth path cannot be established, **do not
   continue**; ask the user to configure a non-interactive auth path or remove the mount.
   Never complete a device-code flow on the user's behalf.
3. Never echo, log or pass tokens into model context. Strip secret-looking env vars
   (`*TOKEN*`, `*SECRET*`, `*KEY*`, …) when spawning the CLI from another tool unless that
   mount explicitly needs them.

## What touches the network?

| Command | Network |
|---|---|
| `find --local` | None — local Turso snapshot only (mount startup still runs). |
| `find` (no `--local`) | Snapshot first, then live sources. |
| `ls` (unfiltered) | Snapshot if fresh, else source. Filtered `ls` always hits the source. |
| `cat`, `stat`, `actions`, `attachments`, `grep --scan`, `graphql` | Usually the source. |

The snapshot is deliberately incomplete (`cache.recent` items per folder), so absence of a
`find --local` hit is not proof that a message does not exist.

## Mutating commands (require explicit user intent)

`do` (destructive actions also need `--yes`), `save`, `set`, `watch`, `unwatch`, `poll` (may fire notifications),
`notifications --clear` / `--read`, `undo`, `redo`.

## Automation pattern

Spawn without a shell, with a timeout, kill on cancel, bound stdout size, and parse JSON:

```js
spawn(process.execPath,
  [absoluteCliEntry, "find", "--local", "-a", "-q", query, "--json"],
  { cwd: checkoutRoot, shell: false, env: sanitizedEnv, stdio: ["ignore", "pipe", "pipe"] });
```

`absoluteCliEntry` and `checkoutRoot` refer to the user's existing built checkout, not the
plugin installation. Resolve them before spawning and perform the auth preflight above first.
Treat non-zero exit, non-JSON stdout or a missing `dist/bin.js` as "disconnected" rather than
as an empty result.
