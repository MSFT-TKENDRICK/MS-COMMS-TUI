# Accessibility

## Design thesis

MS-COMMS-TUI treats terminal output as a narrow serial channel.
A sighted user can glance over a dense table and skip to the one row that matters.
A screen reader or braille user receives the same output in order, one phrase or
one cell window at a time.

Karl Dahlke, the blind author of edbrowse, states the rule precisely:

> Output is measured and conserved like a precious commodity as it passes through the narrow channel of speech or braille.

That quote is also embedded in `packages/cli/src/format.ts`, because the output
renderer is where the accessibility promise is kept.
The design consequence is simple:
MS-COMMS-TUI rations output, avoids repainting, preserves scrollback, and keeps
every action reachable from the keyboard.

## Default interface: line shell, not full-screen TUI

The line-oriented shell is the default interface.
The full-screen TUI is strictly opt-in.
This is not a preference for plainness; it is a mechanical accessibility decision
documented in `packages/cli/src/shell.ts`.

Full-screen terminal UIs are screen-reader-hostile for four mechanical reasons.

### 1. The alternate screen destroys scrollback

Classic TUI frameworks enter the alternate screen buffer with the terminal
sequence `\033[?1049h`.
That swaps out the scrolling transcript for a separate screen-sized canvas.

For a screen-reader user, scrollback is not decoration.
It is how previous output is reviewed after the fact.
When the alternate screen replaces it, the user's review log disappears.

### 2. Full-frame repaints fragment speech

A TUI does not usually append a new sentence.
It moves the cursor and redraws cells.
A screen reader can see that the terminal changed, but it cannot reliably infer
which semantic item changed.
The result can be silence, repeated content, or speech broken mid-word.

### 3. Cursor tracking causes announcement storms

Screen readers often announce text around the cursor as it moves.
A repainting TUI moves the cursor repeatedly: row, column, cell, next cell,
selection bar, status line.
Those cursor moves can trigger per-cell announcements.
A user hears fragments instead of state.

### 4. ANSI has no ARIA equivalent

ANSI can move the cursor, set colour, clear regions, and draw characters.
It cannot say:

- this is a list;
- this row is selected;
- this region is a live update;
- this control is a button;
- this panel has a label.

There is no terminal equivalent of ARIA roles, labels, or live regions.
A green dot is just a coloured glyph.
A box is just characters.

## What the line shell guarantees

The shell appends text.
It does not require a mouse.
It does not clear the screen.
It does not depend on cursor-positioning updates for meaning.
It works over SSH, in a serial console, in `tmux`, and when piped from a file.

`packages/cli/src/shell.ts` also catches command errors and prints sentences
rather than dumping stack traces at the prompt.
For audio users, this matters:
a stack trace is not visually skimmable.
It is a long sequence of file paths and frames before the one actionable line.

## Why fzf-style overlay completion was rejected

Modern terminal tools often use an fzf-style overlay:
a floating list appears under or over the prompt, filters on every keystroke,
and is navigated with arrow keys.

MS-COMMS-TUI deliberately rejects that pattern.
The reason is documented in `packages/cli/src/completion.ts`.
An overlay repaints a region of the terminal.
A screen reader has no event saying that a list appeared, no role for the list,
no current item, and no guarantee that repaint output enters scrollback.
For many users, the candidates simply do not exist.

Instead, completion follows the accessible readline pattern:

- one match is inserted;
- a shared prefix may be inserted silently;
- multiple candidates are printed as ordinary scrolling text;
- the prompt returns after the printed list.

Printed text lands in scrollback.
A user can review it with the screen reader or braille display.

## Numbered addressing

Numbered addressing is the load-bearing accessibility feature.
The core workflow is:

```text
ls
cat 3
```

Every listing row is prefixed with a stable number for that listing.
The number is short, speakable, and easy to type.
It beats mouse selection because no pointing device or visual cursor target is
required.
It beats name-typing because names can be long, duplicated, punctuated, or hard
to transcribe from speech.

A user hearing:

```text
3. unread message, FY26 budget review. From Ada. 2 hours ago.
```

can type:

```text
cat 3
```

That is faster and less error-prone than typing:

```text
cat "2026-08-11 FY26 budget review~2.eml"
```

The code keeps this distinction clear.
`packages/cli/src/format.ts` prints numbers in every listing mode.
`packages/core/src/vfs.ts` lets commands act on a `VNode` directly, so the
backend identity does not depend on the display name or number.

## Completion rules

Completion is designed to be useful without becoming audio noise.
The rules are implemented in `packages/cli/src/completion.ts`.

### Completion never fetches from the network

Tab completion runs on a keystroke.
If it blocks on a mailbox page load, a screen-reader user experiences the program
as hung.
Completion uses the last listing and stale VFS cache only.
If nothing is cached, it says nothing rather than doing a slow fetch.

### Multiple candidates are printed one per line

Readline's default column layout is visually efficient but speech-hostile.
MS-COMMS-TUI prints candidates vertically and numbers them.
Long lists are capped and ask the user to type more characters.

### Index candidates are not offered on empty Tab

This rule is subtle and important.
After `ls`, the item numbers are already on screen.
If empty Tab offered both names and numbers, every candidate list would roughly
double in length.
Through speech, that doubling can be the difference between a list the user can
hold in memory and one they cannot.

So index candidates appear only after the user has typed a digit or `#`.
Examples:

```text
cat <Tab>
```

offers names.

```text
cat 3<Tab>
cat #3<Tab>
```

offers matching item indices.

### Index candidates include descriptions

The candidate `3` spoken by itself is meaningless.
The candidate `3, FY26 budget review` is actionable.
For that reason, index completion carries the item title as the description.

## Output discipline

Output rules live mostly in `packages/cli/src/format.ts`.
They are not cosmetic.
They decide whether terminal output remains understandable through speech,
braille, pipes, and narrow terminals.

### Colour is decoration

Colour is never the only carrier of information.
An unread item is identified by words or flags, not merely by bold or a colour.
This also helps users with colour-vision differences and users with custom
terminal themes.

### Relative times are spelled out

MS-COMMS-TUI writes `2 hours ago`, not `2h`.
A speech synthesizer can read the former as intended.
The latter may be spoken as `two aitch`, which is short visually but expensive
audibly.

### Tables degrade to plain formats

Aligned tables are for sighted terminal users on an interactive TTY.
When stdout is not a TTY, output can be plain, TSV, JSON, or announce-style.
TSV avoids padding and preserves columns for scripts.
This is implemented by the format modes in `packages/cli/src/format.ts`.

### `--mode announce` is for speech

Announce mode produces one self-describing sentence per item.
It front-loads the number, state, kind, title, sender, time, counts, and relevant
flags.
It follows the Emacspeak lesson:
do not describe a picture of a table; state the facts the user needs.

### Body text is wrapped carefully

Message bodies are normalized to line endings and wrapped only when appropriate.
Indented lines and quoted/code-like lines are not reflowed, because whitespace is
the only structure they have in a terminal.

## Error presentation

Every VFS error can carry a structured `hint` field.
`packages/cli/src/shell.ts` prints the main error message, then prints the hint
on its own line.
Retry delays are printed as separate sentences.

Stack traces are not shown at the prompt.
A user navigating by audio cannot skim a trace for the one actionable frame.
They must listen to every path, line number, and function name in sequence.
The prompt should answer:

- what failed;
- what the user can do next;
- whether retrying later is useful.

Debug traces belong in logs, not in the interactive speech path.

## Refusing rather than half-doing

A command that quietly uses part of what was typed is the worst failure mode this
program has, because through speech it is indistinguishable from success.
`cd /mail/Inbox /archive` used to print `/mail/Inbox` and exit zero, having thrown
away half the line. Nothing announced that anything had been discarded.

Commands therefore declare `maxPositional`, and `surplusMessage` in
`packages/cli/src/commands/types.ts` refuses the line instead of running it.
The guard is called from both the shell dispatcher and the one-shot `argv` path,
because a rule that holds in only one of them teaches the user something false.

The refusal names the fix, not only the rule. Message subjects are mostly spaces, so
the commonest mistake anyone will make with this program is `cat FY26 budget review`,
and the useful answer is `cat "FY26 budget review"` — the exact line that would have
worked. That turns a dead end into the moment the quoting rule is learned, without
having to go and read anything.

It declines to guess when the evidence contradicts the guess. Two absolute paths are
two things, not one name with a space in it, so `cd /a /b` gets the usage line rather
than a suggested `cd "/a /b"` that would fail a second time. A wrong suggestion is
worse than none: it costs another round trip and it teaches the wrong lesson.

## Never answering "nothing found" when the question was misread

`find /blog deploy` used to join both words into the query, search for titles
containing `/blog`, and report `(empty)`. A false negative is the most damaging
answer available here, because the user concludes the message does not exist and
stops looking.

`find` and `grep` now split path from query on evidence rather than on shape: a word
is only treated as a folder when it actually resolves to one. `find` tests the
leading word, `grep` the trailing one, matching where each declares its path.

The inference is always spoken:

```
> find /blog deploy
Searching /blog for "deploy". Use `-q` to search from here instead.
```

An inference the user cannot hear is one they cannot correct.

## Flags mean the same thing everywhere

`is:reply` must not mean "is a reply to something" in one mount and "has comments"
in another. The GitHub provider originally reused the well-known `reply` flag for
issues with comments, which both broke cross-mount queries and implied a reply
action it does not offer. It emits `discussed` instead. Providers may invent flags
freely; they may not redefine the shared ones.

Empty metadata fields are omitted rather than rendered blank, because a row that
reads aloud as "assignees, nothing" is pure noise to listen to.

## Security as accessibility

Remote-controlled text is hostile input.
Mail subjects, chat messages, feed titles, and issue names can contain terminal
control sequences or bidirectional override characters.

`packages/cli/src/format.ts` strips dangerous display characters with
`sanitizeForDisplay`.
It removes terminal control characters that could ring bells, move cursors,
clear lines, or repaint the terminal.
It also removes bidi and RTL override controls that can reverse visual order.

The attack is concrete:
a hostile subject can include escape sequences that visually rewrite the prompt,
or a bidi override that makes a dangerous attachment name appear reversed.
For example, a name that visually appears to end in `.txt` may actually end in
`.exe` when control characters are interpreted.

This matters more, not less, for users who cannot see the corruption.
A sighted user may notice that the terminal display looks wrong.
A screen-reader user may hear only the sanitized or reordered final text and miss
the fact that the display was attacked.
Therefore remote text is sanitized before display, and path names are separately
sanitized in `packages/core/src/naming.ts`.

## Keyboard reference

The default shell uses ordinary text commands.
The optional TUI must follow the reserved-key policy below.

### Safe keys

These are generally safe for application shortcuts:

| Key | Use |
|---|---|
| Plain letters | Primary commands and navigation |
| `Tab` | Completion or next focus |
| `Shift+Tab` | Previous focus |
| `Enter` | Open, accept, run |
| `Space` | Toggle or page where appropriate |
| `Escape` | Cancel or leave a mode |
| `/` | Search |
| `?` | Help |
| `F5` through `F12` | Secondary commands |

Plain-letter shortcuts should remain remappable.
The help screen must be reachable by keyboard and printable as ordinary text.

### Reserved keys to avoid

Assistive technology and terminals claim important key space.
Do not use these as primary shortcuts:

| Key | Why avoided |
|---|---|
| `Insert` | NVDA and JAWS screen-reader modifier |
| `CapsLock` | Narrator, VoiceOver laptop layout, and Orca modifier |
| `Ctrl+Option+*` | VoiceOver command space on macOS |
| `Ctrl+C` | Terminal interrupt |
| `Ctrl+Z` | Terminal suspend |
| `Ctrl+S` | XON flow control in many terminals |
| `Ctrl+Q` | XOFF resume / flow control pairing |
| `Ctrl+W` | Common terminal or shell close/delete behavior |
| `Ctrl+D` | EOF / closes stdin |

A note on `Ctrl+C`, since the pane does bind it and that looks like a violation: the rule is
*don't repurpose* a reserved key, not *don't respond* to one. Binding `Ctrl+C` to "save this
draft" would be a violation. Binding it to "stop and get me out of here" is the meaning the
user already expects, so honouring it is compliance. The distinction that matters is whether
a user's existing muscle memory produces the outcome they predicted.

Arrow keys may be used for optional TUI navigation, but there must be an
alternative that does not require screen-reader browse-mode gymnastics.

### Keys in the full-screen pane

Every one of these has a typed equivalent in the line shell; none is the only route to a
capability.

| Key | Does | Typed equivalent |
|---|---|---|
| `Up` / `Down`, or `k` / `j` | Move the selection | `ls`, then a number |
| `Left`, `h`, or `Backspace` | Go to the parent folder | `cd ..` |
| `Right`, `l`, or `Enter` | Open the selection | `cd <name>` or `cat <n>` |
| `Home` / `End` | First / last item | — |
| `PageUp` / `PageDown` | Move by a screen | — |
| `Tab` | Switch between list and preview | — |
| `/` | Start filtering | `find -q ...` |
| `Enter` while filtering | Keep the filter, return to browsing | — |
| `Escape` while filtering | Clear the filter | — |
| `Escape` while browsing | Quit | `quit` |
| `r` | Refresh, bypassing the cache | `refresh` |
| `:` | Run any command | the shell itself |
| `?` | Help | `help` |
| `q` | Quit | `quit` |
| `Ctrl+C` | Quit — **from any mode, including mid-filter** | — |

Letters are never text unless you have explicitly entered a text mode with `/` or `:`.
An earlier draft let any unbound letter start a filter, on the theory that typing a name
should just work. It was removed: because `q`, `r` and `hjkl` are bindings, the real rule
was "any letter except six", and a user filtering for *quarterly* would press `q` and watch
the program exit. One sentence with no exceptions beats a convenience with six. `/` is
named in the footer of every frame, so it is advertised rather than assumed.

Arrow keys and vim-style `hjkl` are both accepted, so neither a hand on the arrow cluster nor
a hand on the home row is the wrong hand. Quitting is always safe: nothing in this program
holds an unsaved draft, and exiting prints where you were.

## Full-screen pane policy — and how the shipped pane complies

The pane (`--tui`) is allowed only as an opt-in visual enhancement.
It must not be the only way to perform a command.
Every command must remain available through the line shell.

It must avoid reserved keys.
It must provide `?` help.
It must avoid claiming that colour, selection bars, or panels are accessible just
because they are visible.
If it uses an alternate screen, documentation must say that scrollback review is
not available in that mode.

What was built against that policy, and why each choice was made:

**It is opt-in, and it refuses rather than degrades.** `--tui` with `--announce` or
`--plain` exits 2 and explains the contradiction, instead of silently picking a winner.
A user who has put `announce = true` in their config has stated a need; quietly overriding
it would be worse than declining. It also refuses when stdout is not a terminal, because a
repainting UI in a pipe produces garbage.

**It adds no capability.** `:` opens a command line that runs the *same* dispatcher as the
line shell — this is not a claim in a doc, it is a shared `Dispatcher` class that both call.
That means the help screen's promise ("adds no capability of its own") cannot rot: if a
command exists in the shell, it exists here.

**Ctrl+C works from every mode.** This was a real bug found in testing. The check originally
lived in the browse-mode branch, so while typing a filter — where `q` is correctly a literal
letter — there was no mode-independent way out. "Press Escape" is not an answer for someone
who doesn't know that. Ctrl+C is the one key every terminal user already knows, so it is now
checked before mode dispatch, and it is the only Ctrl binding in the program.

**It narrates position first.** The status line leads with "3 of 17" before the item's name,
because ordinal position is precisely the information a sighted user gets for free from a
scrollbar and a screen-reader user does not get at all.

**Selection is a glyph, not a colour.** The selected row is marked `> ` and unread is `*`.
Colour only tracks which pane has focus, and never carries information by itself. The marker
stays put when focus moves to the preview, so "where was I" survives a pane switch.

**It leaves a trace.** On exit it restores the terminal, then prints the working directory to
stdout and the selection to stderr. An alternate-screen session normally vanishes without a
record; this way the session ends with something you can read, and the directory you ended in
is a value you can pipe.

**It refuses to split below 60 columns.** Two 28-column panes are two unusable panes. Below
the threshold it shows one list, full width.

**Held keys are dropped, not queued.** While an effect is in flight, further keys are
discarded. Queuing makes a held-down arrow key fire a burst of navigation that resolves after
the user has stopped moving, which is disorienting for anyone and actively misleading when a
screen reader is announcing each landing.

One thing the pane cannot fix: a lone Escape byte followed quickly by a letter is
indistinguishable from Alt+letter at the terminal protocol level. That ambiguity is in the
protocol, not in this program, and it is the reason Escape is never the *only* way out of
anything.

## Testing checklist

Use this checklist before merging user-visible CLI or TUI changes.

### Screen readers

- Verify the line shell with NVDA on Windows.
- Verify the line shell with VoiceOver on macOS.
- Verify the line shell with Orca on Linux.
- Confirm new output is announced in order.
- Confirm the user can review prior output from scrollback.
- Confirm completion candidates are spoken after pressing Tab.

### Narrow and plain output

- Verify listings at 40 columns.
- Verify message bodies at 40 columns.
- Verify with `NO_COLOR=1`.
- Verify with `TERM=dumb` when possible.
- Verify output piped to a file.
- Verify TSV or plain output contains no ANSI colour escapes.

### Keyboard-only operation

- Verify every command is reachable without a mouse.
- Verify `help` is reachable from the shell.
- Verify `?` is reachable in the optional TUI.
- Verify `ls` then `cat 3` works for files.
- Verify `ls` then `cd 3` works for directories.
- Verify completion does not require arrow-key selection.
- Verify no primary shortcut uses `Insert`, `CapsLock`, or `Ctrl+Option`.
- Verify no required command depends on `Ctrl+C`, `Ctrl+Z`, `Ctrl+S`, `Ctrl+Q`, `Ctrl+W`, or `Ctrl+D`.

### Information design

- Verify no command depends on colour to be understood.
- Verify unread, mention, important, open, and closed states have textual names somewhere visible.
- Verify relative times are spoken words, not abbreviations such as `2h`.
- Verify errors print an actionable hint when one exists.
- Verify stack traces are not printed in the interactive prompt.
- Verify hostile-looking subjects with escape characters are sanitized before display.
- Verify bidi override characters do not reorder displayed subjects or filenames.

### Completion

- Verify empty Tab after a path command offers names, not duplicate name-and-index lists.
- Verify typing a digit or `#` offers index candidates from the last listing.
- Verify index candidates include the item title as a description.
- Verify completion does not trigger network access.
- Verify long candidate lists are capped with an instruction to narrow the prefix.

### Scriptability

- Verify `--mode announce` prints one self-describing sentence per item.
- Verify JSON output is valid JSON.
- Verify TSV output can be parsed by tabs.
- Verify piped output does not assume a terminal width.
- Verify output remains meaningful when colour is disabled.

## Contributor rule of thumb

If a feature is only usable when the user can see a region of the screen update,
it is not accessible enough for the default interface.
Make it a line-shell command first.
Then, if useful, add a TUI view as an optional presentation of the same state.
