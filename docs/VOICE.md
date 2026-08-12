# Voice

Speaking to this program is not a separate interface. It is a way of producing the same
command line you would have typed, which is then run by the same dispatcher, recorded in the
same journal, and undone by the same `undo`. Nothing you can say is something you could not
have typed, and nothing you say bypasses a confirmation that typing would have triggered.

That constraint is the whole design. Everything below follows from it.

```
Inbox> voice on
Voice is on, push-to-talk.
Say one thing at a time with `voice once`, or hold Ctrl+Space in the pane.
Say "what can I say" for the phrase list, or "stop listening" to finish.

  (you) "go to the inbox"
Heard: "go to the inbox"
Ran `cd inbox`

  (you) "mark three as read"
Heard: "mark three as read"
Mark "FY26 budget review — please read before Thursday" as read? [y/N] y
Marked "FY26 budget review — please read before Thursday" as read.
`undo` will mark it unread again.

  (you) "undo that"
Undone: Marked "FY26 budget review — please read before Thursday" as read.
  — Marked "FY26 budget review — please read before Thursday" as unread.
```

## Trying it without a microphone or an API key

`voice say` takes the text a recognizer would have produced and runs the rest of the
pipeline — grammar, confirmation, dispatch, journal — with no audio and no credentials:

```
mscomms
/> demo
/> cd /demo-mail/Inbox
Inbox> ls
Inbox> voice say "mark three as read"
Inbox> history
Inbox> undo
```

`voice test "some phrase"` goes one step further and shows what the grammar made of a phrase
without running anything, which is the fastest way to find out why something was refused:

```
Inbox> voice test "mark three as read"
"mark three as read"
  runs:    do read 3
  meaning: read 2026-08-12 FY26 budget review — please read before Thursday.eml
  rule:    action-on
  confirm: yes — this changes something
```

Neither needs a microphone. `voice test` with no phrase checks the hardware and credentials
instead, which is the other thing you might mean by testing voice.

## Setting up speech

```jsonc
{
  "voice": {
    "engine": "mai",
    "endpoint": "https://my-resource.cognitiveservices.azure.com",
    "apiKey": "${env:FOUNDRY_API_KEY}",
    "language": "en-US"
  }
}
```

Then `export FOUNDRY_API_KEY=...` and run `voice on`. The model defaults to
`mai-transcribe-1.5`, so there is nothing else to set.

The key is a `${env:NAME}` reference, not a key. The config file is plain text that ends up
in dotfile repos and screen shares; a program that reads your mail should not be the reason
your transcription key leaks. `voice status` tells you whether the reference resolved
without printing what it resolved to.

### Engines

| `engine` | What it talks to | Needs |
|---|---|---|
| `mai` *(default)* | Foundry LLM Speech API, MAI-Transcribe-1.5 | `endpoint`, `apiKey` |
| `foundry` | The same tenant's OpenAI-compatible surface | `endpoint`, `model`, `apiKey` |
| `azure-speech` | Azure AI Speech REST | `region` or `endpoint`, `apiKey` |
| `openai` | OpenAI `/audio/transcriptions` | `apiKey` |
| `xai` | xAI | `apiKey` |
| `command` | A local binary: WAV on stdin, text on stdout | `command` |

`mai` and `foundry` are two different APIs on the same resource, not two names for one.
MAI-Transcribe is served by the LLM Speech API — `speechtotext/transcriptions:transcribe`,
with the model named inside an `enhancedMode` object and the transcript returned as
`combinedPhrases`. `foundry` is for a Whisper or `gpt-4o-transcribe` *deployment*, which is
why it needs a `model`: that is the name you gave the deployment, and there is nothing
sensible to guess.

The default is **MAI-Transcribe-1.5**, Microsoft's current speech recognition model,
covering 43 languages. It is the default here less for its benchmark scores than because it
takes a phrase list — see below. `model` and `endpoint` are both plain strings with no
validation, because hosted API surfaces move faster than releases of this program and
someone holding the current path should not have to wait for us.

### Telling it what is on screen

Almost nothing said to this program is a dictionary word. "Open the Contoso deal review",
"reply to Rehaan", "go to FY26 Planning" — these are proper nouns, and a general recognizer
has no prior for any of them. It has a very strong prior for "can't so".

So before each utterance the names currently listed, the mount names and the available
action verbs are sent along as a phrase list, and `mai` passes them to the model as an
entity bias. This is the single biggest difference between voice navigation working and
being a party trick, and it is why `mai` rather than `foundry` is the default: the
OpenAI-compatible surface has nowhere to put them.

The list is rebuilt per utterance from the same snapshot the grammar interprets against, so
the recognizer is never biased toward a folder the interpreter has already left. Confirmations
are excluded — while it is waiting for "yes" or "no", biasing toward message subjects would
make a subject line the likelier hearing of "no".

Nothing new leaves the machine: these names are already on your screen, and they go to the
same endpoint that is about to receive a recording of you reading them aloud. Set
`"phraseBias": false` if you would rather send audio and nothing else.

### Keeping audio on the machine

`engine: "command"` sends nothing anywhere:

```jsonc
{
  "voice": {
    "engine": "command",
    "command": "whisper-cli",
    "commandArgs": ["--model", "base.en", "--output-txt", "-"]
  }
}
```

The binary receives a 16 kHz mono WAV on stdin and prints the transcript. Anything that fits
that shape works. This is the only configuration in which no audio leaves the machine, which
matters more here than in most programs: the audio is you dictating about your mail.

Speech *output* is always local — the OS synthesizer, never a cloud service. Sending subject
lines to a TTS API to be read back would leak exactly the content the rest of this program
is careful about, and a screen reader user already has a voice they have configured and can
understand at speed.

## What you can say

`voice help` prints this list; `what can I say` speaks it.

| Intent | Say | Runs |
|---|---|---|
| Navigate | "go to inbox", "open the budget thread", "go up", "go back", "go home" | `cd`, `up`, `back`, `cat` |
| Look | "list", "show me the unread ones", "next page", "where am I" | `ls`, `ls --unread`, `more`, `pwd` |
| Read | "read three", "read it to me", "show me the details", "what can I do" | `cat`, `stat`, `do` |
| Search | "search for budget", "find messages from alice", "find unread" | `find -q …` |
| Act | "mark as read", "flag it", "mark three as unread", "archive it" | `do …` |
| Undo | "undo that", "redo", "what did I just do" | `undo`, `redo`, `history` |
| Anything else | "command find -q subject:budget --source mail" | verbatim |
| Stop | "stop listening", "cancel", "quit" | |

Numbers work as digits, words and ordinals: "three", "the third one", "number 3". "Open"
covers both folders and messages — see below for how it tells them apart.

### The escape hatch

`command <anything>` runs what follows verbatim, exactly as typed. It is checked against the
raw transcript before any normalization, so punctuation and capitalization survive —
`command find -q From:Alice` keeps its colon and its capital, which the normalizer would
otherwise strip. Anyone who knows the shell should not have to discover which English the
grammar happens to like.

## How it decides what you meant

The grammar is an ordered table of rules, each anchored at both ends of the phrase, so a
rule matches a whole utterance or not at all. "Delete everything and go to inbox" cannot
match the `go to` rule while quietly discarding the first half — it is read as a delete,
finds nothing called "everything and go to inbox", and is refused.

**It refuses rather than guesses.** A name that matches more than one visible item names the
candidates and asks which:

```
Inbox> voice test "open the weekly status"
"open the weekly status" → refused: "weekly status" matches 6 items. Which one?
  11. 2026-08-09 Weekly status.eml; 12. 2026-08-09 Re- Weekly status.eml; ...
Try: "open 11", "open 12", "open 17"
```

Picking the first would be right most of the time. The times it was wrong would be the times
somebody archived a message they had never read, so it is not a trade worth making.

**Position references are never clamped:**

```
Me> voice test "open nine"
"open nine" → refused: There is no item 9 here — this folder has 4.
Try: "list"
```

**"Open" resolves by what the thing is**, not by the verb: a directory is entered, a message
is read. Only the navigational verbs ("go to", "switch to") fall through to the shell when
nothing on screen matches, because listings are paged and a folder you cannot see may still
exist. "Open" refers to something you believe is in front of you, so a miss is worth
refusing.

## Confirmation

Anything that changes the world is confirmed before it runs, and voice does not get an
exemption. A spoken command produces the same command line as typing, so it triggers the
same confirmation. `command …` is always treated as changing something, because an arbitrary
command line cannot be inspected for whether it does.

The question is asked out loud first and answered out loud, so hands-free stays hands-free.
Only unambiguous words count — "yes", "yeah", "go ahead", "no", "nope", "cancel". Anything
else, including silence, a half-sentence, or a cough the recognizer rendered as a word, falls
through to the keyboard. A confirmation prompt that guesses is not a confirmation prompt.

`set voice.autoRun on` skips confirmation for mutating commands, for the rest of the session.
It is off by default, and navigation and reading are never confirmed either way. The same
switch is what makes voice scriptable: piped input cannot answer a prompt, so a mutating
command refuses and says so rather than reading your next line as the answer.

## Undo

Every interaction is recorded with the command that would repeat it and, where one exists,
the inverse that would reverse it. `undo` reverses the most recent one that changed
something; `history` shows what happened and where each entry came from.

That last part matters more than it sounds. The first question anyone asks after a surprise
is "did I do that, or did it mishear me?" — so the journal records the source:

```
Inbox> history
when      what happened                                                       command              from   undo
--------  ------------------------------------------------------------------  -------------------  -----  ---------
just now  Marked "FY26 budget review — please read before Thursday" as read.  do read 3            voice  unread
just now  Moved to /demo-mail/Inbox                                           cd /demo-mail/Inbox  shell  back to /
```

`undo` says what it is about to reverse before reversing it, and what it did afterwards:

```
Inbox> undo
`undo` would reverse: Marked "FY26 budget review — please read before Thursday" as read.
Undone: Marked "FY26 budget review — please read before Thursday" as read.
  — Marked "FY26 budget review — please read before Thursday" as unread.
```

**Undo refuses rather than skipping.** If the most recent change cannot be reversed, it stops
there and says what is in the way, instead of reaching past it to undo something older.
Suppose you archive a message and then reply to it: a skipping undo would silently
un-archive the message you have just replied to, two steps back, reported as if it were the
obvious one. `undo --skip` steps past deliberately, which is a decision you made rather than
one the program made for you.

Reads and view changes are recorded but not undoable — there is nothing to reverse, and
putting them on the stack would mean `undo` often did nothing visible, which teaches people
that undo is unreliable.

## In the full-screen pane

`Ctrl+Space` is push-to-talk for one command. `u` undoes. The status line says `[MIC ON]` or
`[MIC …]` in words, not as a coloured dot — the people most likely to be using voice control
are the least likely to be able to see one.

The pane stays in step because it does not maintain its own idea of where you are. Anything
that changes the world announces it, and the pane folds that announcement into its state.
That is also why arrow-key navigation is undoable: pressing Enter on a folder goes through
the same journaled navigation a typed `cd` does, rather than assigning to a field.

## Settings

| Key | Default | What it does |
|---|---|---|
| `engine` | `mai` | Which service transcribes |
| `endpoint` | — | Resource URL; required except for `command` |
| `apiKey` | — | Use `${env:NAME}` |
| `model` | `mai-transcribe-1.5` | Model name; a deployment name for `foundry` |
| `phraseBias` | `true` | Send on-screen names to the recognizer as a bias |
| `language` | `en-US` | BCP-47 tag |
| `region` | — | For `azure-speech` |
| `command` / `commandArgs` | — | Local binary for `engine: "command"` |
| `mode` | `push` | `continuous` listens until told to stop, and needs `wakeWord` |
| `wakeWord` | — | Required prefix in continuous mode |
| `maxSeconds` | `15` | Longest single utterance |
| `recorder` / `device` | auto | Force a capture program or input device |
| `autoRun` | `false` | Skip confirmation for mutating commands |
| `speak` | `false` | Read results back through the OS synthesizer |

Every key is documented in full in [CONFIGURATION.md](CONFIGURATION.md#voice).

## When it does not work

`voice status` answers the setup question without needing a microphone, a key, or `voice
on` — which matters, because "off" is usually the state you are trying to get out of:

```
/> voice status
Voice is off. Turn it on with `voice on`.
  Engine:   foundry
  Endpoint: not set
  Key:      not set — add "apiKey": "${env:NAME}" to the config file
  Confirm:  on for anything that changes something
  Recorder: none found — install ffmpeg or sox, or `set voice.recorder <program>`
```

The key line says whether the `${env:NAME}` reference resolved, never what it resolved to.
"Did I export that variable" is the only question anyone has here, and answering it by
printing the key would put a credential in your scrollback — which is the thing the
indirection exists to prevent.

`voice devices` goes further and shows the exact recorder command line, so you can run it
yourself and hear the result.

Recording uses whatever the OS already provides — `ffmpeg`, `sox`/`rec`, `arecord` or
PowerShell — rather than a native audio module, because this program has no third-party
runtime dependencies and a microphone binding is not worth being the first.

"I did not hear anything" and "I did not understand" are deliberately different messages.
The first means the audio was silent — a muted or unselected microphone. The second means it
was heard and did not match a rule. Different problems, different fixes, so they must not
look the same.
