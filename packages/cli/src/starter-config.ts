/**
 * The file `mscomms init` writes.
 *
 * It is heavily commented because a config file is documentation that happens to be
 * executable. Every source is present but commented out, so getting started is a matter
 * of deleting `//` rather than remembering syntax.
 */

export const STARTER_CONFIG = `// MS-COMMS-TUI configuration.
//
// This file is JSON with comments and trailing commas allowed.
// After editing, run \`mscomms doctor\` to check it.

{
  // ---------------------------------------------------------------------------
  // Sources. Each mount becomes a top-level folder.
  // ---------------------------------------------------------------------------
  "mounts": [
    // Sample data, so you can try every command without connecting anything.
    // Delete this once you have a real source configured.
    {
      "path": "/demo",
      "type": "memory",
      "options": { "fixture": "mail" },
    },

    // --- Outlook mail via Microsoft Graph -------------------------------------
    // The first time you use it, you will be given a short code and a URL to
    // sign in with. Tokens are cached; you will not be asked again for weeks.
    //
    // {
    //   "path": "/mail",
    //   "type": "graph-mail",
    //   "options": {
    //     // Optional. Defaults to the Microsoft Graph Command Line Tools client,
    //     // which is a first-party public client available in most tenants.
    //     // If your tenant blocks it, register your own app and put its id here.
    //     // "clientId": "00000000-0000-0000-0000-000000000000",
    //     // "tenantId": "common",
    //     "pageSize": 50,
    //   },
    // },

    // --- Teams chats and channels via Microsoft Graph -------------------------
    // Channel messages need admin-consented permissions in most tenants. If they
    // are missing, the folders appear but stay empty with a warning rather than
    // failing the whole session.
    //
    // {
    //   "path": "/teams",
    //   "type": "graph-chat",
    //   "options": { "pageSize": 50 },
    // },

    // --- GitHub issues and pull requests --------------------------------------
    // Reads GH_TOKEN or GITHUB_TOKEN from the environment, or run \`gh auth login\`.
    //
    // {
    //   "path": "/github",
    //   "type": "github",
    //   "options": {
    //     "repos": ["octocat/hello-world"],
    //     // Or, instead of repos, everything assigned to you:
    //     // "involvesMe": true,
    //   },
    // },

    // --- RSS and Atom feeds ---------------------------------------------------
    //
    // {
    //   "path": "/news",
    //   "type": "rss",
    //   "options": {
    //     "feeds": [
    //       { "name": "GitHub Blog", "url": "https://github.blog/feed/" },
    //     ],
    //   },
    // },

    // --- Anything else, in any language ---------------------------------------
    // The exec provider speaks line-delimited JSON over stdin and stdout, so a
    // source can be a shell script, a Python file, or a compiled binary.
    // See docs/PLUGINS.md for the protocol.
    //
    // {
    //   "path": "/custom",
    //   "type": "exec",
    //   "options": { "command": ["python3", "~/bin/my-feed.py"] },
    // },

    // --- A tree of your own shape ---------------------------------------------
    // A projection is not a source. It reorganizes the mounts above into a
    // different tree, described as a GraphQL query over all of them at once, and
    // mounts the result as ordinary folders you can ls, cat, find and complete.
    //
    // Try the query at the prompt first: \`schema\` shows what you can select and
    // \`graphql '{ all { name source } }'\` runs one. See docs/PROJECTIONS.md.
    //
    // {
    //   "path": "/by-person",
    //   "type": "projection",
    //   "options": {
    //     "query": "{ all @flatten @group(by: \\"author\\") { name mtime } }",
    //     // Or, once it outgrows a single line, keep it next to this file:
    //     // "queryFile": "./by-person.graphql",
    //   },
    // },
  ],

  // ---------------------------------------------------------------------------
  // Saved queries. Use with \`find -Q name\` or as a watch filter.
  // ---------------------------------------------------------------------------
  "queries": [
    { "name": "unread", "query": "is:unread", "description": "Anything I have not read" },
    { "name": "today", "query": "since:today", "description": "Arrived today" },
    { "name": "flagged", "query": "is:flagged OR is:important" },
    { "name": "to-me", "query": "is:unread NOT from:noreply", "description": "Unread, minus robots" },
  ],

  // ---------------------------------------------------------------------------
  // Background watches. These poll while the shell is running and raise a
  // desktop notification plus an entry in \`notifications\`.
  // ---------------------------------------------------------------------------
  "watches": [
    // {
    //   "path": "/mail/Inbox",
    //   "query": "is:unread",
    //   "intervalSeconds": 120,
    //   "notify": true,
    //   "label": "Inbox",
    // },
  ],

  // ---------------------------------------------------------------------------
  // Notifications.
  // ---------------------------------------------------------------------------
  "notifications": {
    // "desktop" uses the operating system's notification centre.
    // "terminal" writes a line to the terminal, which every screen reader will
    // read and which survives Do Not Disturb.
    // "both" is the default and is recommended: desktop toasts are silently
    // suppressed by Focus Assist / Do Not Disturb, so the terminal line is what
    // guarantees you actually find out.
    "mode": "both",

    // Never send more than this many desktop notifications per minute. Beyond
    // it, they are batched into one summary.
    "maxPerMinute": 6,

    // Ring the terminal bell. Off by default; many screen readers already make
    // their own sound and two at once is unpleasant.
    "bell": false,
  },

  // ---------------------------------------------------------------------------
  // Presentation.
  // ---------------------------------------------------------------------------
  "ui": {
    // "table"    aligned columns, the default when attached to a terminal
    // "plain"    no alignment, no colour
    // "announce" one full sentence per item, ideal for screen readers
    // "json"     machine-readable
    // "tsv"      tab-separated, for cut/awk
    // "auto"     table when interactive, tsv when piped
    "mode": "auto",

    // "auto" respects NO_COLOR and whether output is a terminal.
    "color": "auto",

    // How many items \`ls\` shows before you have to ask for \`more\`.
    "pageSize": 25,

    // Include the message body preview column in listings.
    "preview": true,

    // Left-hand prompt. Leave unset for the current folder name.
    // "prompt": "mail> ",

    // Date display: "relative" (three hours ago), "absolute" (2026-08-11 14:03),
    // or "both".
    "dates": "relative",
  },

  // ---------------------------------------------------------------------------
  // Extra plugins, loaded by module specifier. These are imported at startup,
  // so only add ones you trust.
  // ---------------------------------------------------------------------------
  "plugins": [
    // "@me/mscomms-provider-jira",
    // "/home/me/code/my-provider/index.js",
  ],
}
`;
