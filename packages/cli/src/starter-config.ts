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
    // If you already have an MCP server that provides Microsoft 365 access — the
    // one Copilot installs is found automatically — it is used, and you are never
    // asked to sign in. Otherwise you get a short code and a URL to sign in with,
    // and the tokens are cached for weeks.
    //
    // Run \`doctor\` to see which of the two is in use.
    //
    // {
    //   "path": "/mail",
    //   "type": "graph-mail",
    //   "options": {
    //     // "auto" (the default) prefers the MCP server and signs in only if
    //     // there is none. Force one or the other with "mcp" or "device-code".
    //     // "transport": "auto",
    //     //
    //     // Point at a different MCP server if you do not want the discovered one.
    //     // "mcp": { "command": "npx", "args": ["-y", "@microsoft/workiq@latest", "mcp"] },
    //     //
    //     // Only used when signing in. Defaults to the Microsoft Graph Command
    //     // Line Tools client, a first-party public client available in most
    //     // tenants. If yours blocks it, register an app and put its id here.
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
    // on one of their messages. When signing in, turning it on requires signing
    // in again so that consent covers Mail.Send, Chat.ReadWrite and
    // ChatMessage.Send; through an MCP server, that server's own permissions
    // decide whether sending is allowed.
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

    // --- GitHub issues, pull requests, discussions and projects ---------------
    // Uses GH_TOKEN or GITHUB_TOKEN if either is set, and otherwise borrows the
    // credential from \`gh auth login\`. Without any of the three it still works on
    // public repositories, just at 60 requests an hour — though discussions and
    // project boards need a token either way, because GitHub's GraphQL API has no
    // anonymous access at all. Boards additionally need the \`read:project\` scope.
    //
    // {
    //   "path": "/github",
    //   "type": "github",
    //   "options": {
    //     "repos": ["octocat/hello-world"],
    //     // Boards that span repositories belong to the org, not to any one repo,
    //     // so an owner can be listed on its own to reach them.
    //     // "owners": ["octocat"],
    //     // Or, instead of repos, your notification inbox — everything across
    //     // every repository that is actually waiting on you. Needs a token.
    //     // "includeNotifications": true,
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
  // Local snapshot. Off by default; this is the setting that makes the tool feel
  // instant. Mail is synced into a local Turso (libSQL) database in the
  // background, listings are served from disk instead of the network, and
  // \`find\` searches locally before it searches remotely.
  //
  // It keeps the most recent items per folder rather than replicating your
  // mailbox, so it is honest about what it can answer: a plain \`ls\` comes from
  // the snapshot, a filtered one goes to the source, and search never concludes
  // "no results" from local data alone.
  //
  // The database never leaves this machine. It holds message bodies, so there is
  // deliberately no setting that points it at a hosted database.
  // ---------------------------------------------------------------------------
  // "cache": {
  //   "enabled": true,
  //
  //   // Items kept per folder. The rest are evicted; this is what stops a large
  //   // mailbox from turning the first sync into an overnight job.
  //   "recent": 500,
  //
  //   // Message bodies to pre-download per folder per sync, so \`cat\` on
  //   // something recent is instant and \`body:\` works offline. 0 disables.
  //   "bodies": 25,
  //
  //   // Record every fetch in an AgentFS tool_calls log inside the snapshot:
  //   // what was called, which path, how long, and whether it failed. Paths and
  //   // sizes only, never message content. Shown in \`cache\`.
  //   // "audit": true,
  // },

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
  // Voice control. Off unless you configure it.
  //
  // Speaking produces the same command line you would have typed, so anything
  // said obeys the same confirmations, lands in \`history\`, and comes back with
  // \`undo\`. Try it without a microphone or an API key first:
  //
  //   demo
  //   voice say "mark three as read"
  //   undo
  //
  // "apiKey" holds a \`\${env:NAME}\` reference, never the key itself — this file
  // ends up in dotfile repos and screen shares. See docs/VOICE.md.
  // ---------------------------------------------------------------------------
  "voice": {
    // "mai"          Foundry's LLM Speech API, running MAI-Transcribe-1.5. The
    //                default, and the only engine that accepts a phrase list.
    // "foundry"      The same resource's OpenAI-compatible surface, for a
    //                Whisper or gpt-4o-transcribe deployment. Needs "model".
    // "azure-speech" The classic Azure AI Speech REST endpoint.
    // "openai"       Whisper, or any OpenAI-compatible host.
    // "xai"          Grok.
    // "command"      A local binary, so no audio leaves this machine.
    // "engine": "mai",
    // "endpoint": "https://my-resource.cognitiveservices.azure.com",
    // "apiKey": "\${env:FOUNDRY_API_KEY}",
    // "language": "en-US",

    // Keeping speech recognition local instead:
    // "engine": "command",
    // "command": "whisper-cli",
    // "commandArgs": ["--model", "base.en", "--output-txt", "-"],

    // The names on screen are sent to the recognizer as hints, because almost
    // everything you say to this program is a proper noun no model has a prior
    // for. They are already on your screen and go to the same endpoint that is
    // about to hear you read them aloud, so this discloses nothing new — but
    // turn it off to send audio and nothing else.
    // "phraseBias": false,

    // "push" captures one utterance when you ask for it, which is the default
    // because a microphone left listening in an open-plan office, in a program
    // that has your mail open, is a privacy incident waiting for a quiet
    // afternoon. "continuous" needs a wake word before it will obey anything.
    // "mode": "continuous",
    // "wakeWord": "computer",

    // Push-to-talk in the --tui pane, the way it works in Discord: hold the key
    // and speak, let go and it stops. Holding needs a terminal that reports key
    // releases (kitty, foot, WezTerm, Ghostty, rio, Alacritty, Windows Terminal
    // 1.25+); anywhere else the same key presses to start and presses again to
    // stop, which "auto" falls back to on its own. Force it with "hold" or
    // "toggle" if you would rather it never changed under you.
    // "pushToTalk": "auto",
    // One modifier and one key — the modifier is not optional, because a terminal
    // sends an unmodified key as ordinary typed text and cannot report it being
    // held. A few Ctrl combinations are refused too, because the terminal sends
    // them as another key entirely — ctrl+m is Enter, ctrl+i is Tab, ctrl+h is
    // Backspace — and ctrl+c and ctrl+[ are the ways out of the pane. Setting one
    // of those tells you which key is in the way.
    // "talkKey": "ctrl+space",

    // Keep recording for this long after the key comes up. Discord uses about
    // 20ms; this defaults to 250 because letting go on the last word of "archive
    // this" gives a recognizer "archive thi", and the command is then correctly
    // refused for a reason that looks like a broken microphone.
    // "releaseDelayMs": 250,

    // Read results back through the operating system's own synthesizer. Never a
    // cloud voice: subject lines have no business on a network, and a screen
    // reader user already has a voice they have configured.
    // "speak": true,

    // Run recognized commands that change something without confirming first.
    // Only turn this on if you also trust the recognizer with "archive it".
    // "autoRun": false,
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
