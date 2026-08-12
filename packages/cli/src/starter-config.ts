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

    // --- Your colleagues, as folders ------------------------------------------
    // Traverse the org chart with \`cd\`: /people/Me/manager/1/reports lists your
    // manager's other reports. Inside a person's folder you get their profile
    // plus every mail and chat you have exchanged, merged into one list with
    // unread first, then messages of theirs you have not answered.
    //
    // Sending is off unless you ask for it. With "allowSend": true you can run
    // \`do 1 message --subject "..." --body "..."\` on a person, or \`do 3 reply\`
    // on one of their messages. Turning it on requires signing in again so that
    // consent covers Mail.Send, Chat.ReadWrite and ChatMessage.Send.
    //
    // {
    //   "path": "/people",
    //   "type": "graph-people",
    //   "options": {
    //     "pageSize": 50,
    //     // How many recent messages to show inside each person's folder.
    //     "commsPerPerson": 20,
    //     // "allowSend": true,
    //     // Set false to leave Teams out and use mail alone.
    //     // "chats": true,
    //   },
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

    // --- Azure DevOps boards --------------------------------------------------
    // Projects, teams, boards and columns become folders; work items become
    // files, so "what is in Active" is \`ls\` rather than a query. Every project
    // also gets an "Assigned to me" folder.
    //
    // Uses AZURE_DEVOPS_EXT_PAT (or AZURE_DEVOPS_PAT) if one is set, and signs
    // in interactively if not. A token needs only the "Work items (read)" scope.
    //
    // {
    //   "path": "/ado",
    //   "type": "ado-boards",
    //   "options": {
    //     "organization": "contoso",
    //     // For Azure DevOps Server, give the full collection URL instead:
    //     // "orgUrl": "https://tfs.contoso.example/tfs/DefaultCollection",
    //
    //     // Listing projects also skips discovery, so a token scoped to one
    //     // project is enough. Omit to show everything you can see.
    //     // "projects": ["Contoso"],
    //     // "boards": ["Stories"],
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
    // "command" is always an array: a string would have to be split by a shell,
    // and shell-splitting a path you did not write is how injection bugs happen.
    // See docs/PLUGINS.md for the protocol.
    //
    // {
    //   "path": "/custom",
    //   "type": "exec",
    //   "options": { "command": ["python3", "~/bin/my-feed.py"] },
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
    //   "id": "inbox",
    //   "path": "/mail/Inbox",
    //   "query": "is:unread",
    //   "intervalMs": 120000,
    //   "label": "Inbox",
    //   // Also notify when something already seen changes, not just on arrival.
    //   "includeUpdates": false,
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
