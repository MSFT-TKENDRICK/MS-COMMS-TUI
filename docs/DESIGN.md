# Design system

How a detail pane is allowed to look.

This document is the source of truth for the tokens, and `packages/core/src/design.ts` is
the half of it that runs. Every rule below carries its machine name in `code font`; a test
in `packages/cli/src/test/design.test.ts` asserts that the two lists match exactly, so a
rule cannot be added to the linter without being written down here, and a rule cannot be
written down here without being enforced or explicitly marked as unenforceable.

Scope: this applies to the **detail pane** and nothing else. The tree pane, the status
line, the line shell and every non-interactive output format are governed by
`docs/ACCESSIBILITY.md` and by the existing formatters, which predate this system and are
not being retrofitted into it.

## Why there is a design system at all

The pane renders content nobody here wrote. A pull request is shaped nothing like a mail
message, which is shaped nothing like an RSS item, and a provider plugin is third-party
code that can describe its own layout. Without a shared vocabulary each surface invents its
own, and the accessibility guarantees in `docs/ACCESSIBILITY.md` become something each
author has to remember rather than something the system keeps.

So providers do not draw. They describe, in the vocabulary below, and one renderer draws.
That is the whole architecture: see `docs/RENDERING.md` for how it fits together.

## Tokens

### Tones

A tone is a **meaning**, never a colour. The theme decides what it looks like, and a theme
for a monochrome terminal is as correct as one for a 24-bit one.

| Tone | Means | Marked |
| --- | --- | --- |
| `default` | no claim | no |
| `accent` | look here first | no |
| `good` | succeeded, healthy, approved | yes |
| `warning` | needs attention, not yet wrong | yes |
| `attention` | failed, blocked, rejected | yes |
| `subtle` | present but secondary | no |

The table splits into two groups that behave differently, and the split is the most
important thing on this page.

**Status tones** — `good`, `warning`, `attention` — assert a fact about the world. Each one
must survive losing colour, so every theme owes each of them a short text mark, and the
marks must differ from one another. Enforced by `status-tone-has-mark` and
`status-marks-distinct`.

**Emphasis tones** — `accent`, `subtle` — only draw the eye. They carry no mark on purpose:
there is no distinction for a mark to preserve, and a decorative glyph on every heading is
noise when read aloud. Enforced by `emphasis-tone-unmarked`.

The rule that follows, and the one easiest to break by accident:

> **A status must never be encoded in `accent` or `subtle` alone.**

Colour those if you like, but the fact must also be in the text, because those two tones
disappear completely in a monochrome terminal and in speech. A linter cannot tell whether
`accent` was meant as status, so this rule is on you.

### Text styles

`default`, `heading`, `strong`, `subtle`, `monospace`.

A style maps to weight, case or spacing — never to colour alone, for the same reason.
`monospace` exists so a commit SHA or a code span is not re-wrapped as prose.

### Spacing

`none`, `small`, `default`, `medium`, `large`, resolved by the theme to a number of blank
rows. `none` is what builds a tight group: a heading and the fact set under it are one
thing and should not be separated by a gap.

Vertical space is the pane's scarcest resource. The `compact` theme collapses most of it,
which is what a fifteen-row pane needs.

### Constraints

Column widths follow Ratatui's model, not flexbox: `len(n)` for fixed, `percent(n)` for
proportional, `fill(weight)` to share what remains. Fixed widths are honoured first, then
percentages, then fill weights divide the remainder.

Full flexbox would be a large amount of machinery for a pane that only ever needs "this
column is twelve wide, that one takes the rest".

## Rules the linter enforces

Errors. A card that trips one of these is wrong in a way that damages the pane or the
reader, and the test suite fails on it.

| Rule | What it catches |
| --- | --- |
| `no-ansi` | An escape sequence in card text. Colour is applied after layout by the renderer; text arriving pre-coloured is measured wrong and, worse, gets stripped to visible garbage by the sanitizer. |
| `no-tabs` | A tab in anything laid out in columns. Tab stops are not knowable at layout time, so alignment built from tabs is alignment that breaks at a width you did not test. |
| `no-control-characters` | Anything else in the C0 range reaching the terminal. |
| `known-tone`, `known-style`, `known-spacing`, `known-format`, `known-element` | A value outside the vocabulary. Cards can arrive as JSON from a plugin or a model, where a typo is not a compile error. |
| `tone-needs-text` | A tone on empty text. The colour-only failure in its purest form: the tone was the entire message, so a reader without colour receives nothing. |
| `table-rows-match` | A ragged table. Cells silently shift into the wrong column. |
| `sane-constraint` | A percent outside 0-100, a negative length, a zero fill weight, `maxLines: 0`. |
| `safe-action-url` | An `Action.OpenUrl` whose scheme is not `http`, `https` or `mailto`. This is a security rule, not a style one: cards can come from a mail server. |
| `action-needs-title` | A link with nothing describing where it goes. |
| `speakable` | A card that `cardToSpeech` renders as nothing. Announce mode would read it as silence. |

Warnings. Legible but off-pattern; reviewed rather than blocked.

| Rule | What it catches |
| --- | --- |
| `no-empty-element` | An element with no content, which renders as an unexplained gap. |
| `fact-needs-label` | A value announced without saying what it is. |
| `container-depth` | Nesting past four, where the indent costs more than the structure conveys. |
| `max-lines-needs-wrap` | `maxLines` on unwrapped text, which is already one line. |
| `theme-covers-tones` | A theme missing a tone. |
| `emphasis-tone-unmarked` | A mark on `accent` or `subtle`. |

## Rules no linter can check

Written here because they are the ones that actually go wrong.

**A tone must mean what it says.** The worst tone is not a missing one, it is a wrong one,
because a reader believes it. Two mistakes made while building this, both caught by looking
at the rendered output rather than by any test:

- A diffstat toned as `good` for additions and `attention` for deletions rendered as
  `+ +876   x -24`, which puts a failure mark on the healthiest thing a pull request can
  do. A diffstat has no tone. It is a measurement.
- Requested reviewers toned `warning` rendered as `[! alice]`. Being asked to review is
  entirely normal and nothing is wrong.

If you cannot finish the sentence "this is `attention` because it has failed", it is not
`attention`.

**Structure is the point.** A list is a `BadgeSet`, a set of verdicts is a `Table`, a
label/value pair is a `Fact`. `labels.join(', ')` is what is left after the structure has
been thrown away, and the renderer cannot get it back. This is the single largest
improvement the card model makes over the string it replaced.

**Truncate loudly.** When content does not fit, say how much was hidden — `(3 more lines)`,
`and 14 others`. Trailing off with an ellipsis tells a reader that something was cut but
not whether it mattered. The marker wins over the body text when both cannot fit, because
silent truncation is the failure being prevented.

**Degrade, do not fail.** A pane too narrow to split columns stacks them. A theme without
Unicode uses ASCII. Two unreadable slivers are worse than two readable blocks, which is the
same bargain the TUI already makes when it drops the tree pane below 60 columns.

## Themes

A theme is plain data: tone styles, glyphs, spacing, indents. Swapping the entire visual
language is a different object, not a different renderer. Set `ui.cardTheme` to choose one.

| Theme | For |
| --- | --- |
| `default` | Unicode box drawing, colour. |
| `ascii` | Terminals that mangle box drawing. Selected automatically by `ui.plain`. |
| `mono` | No colour at all. |
| `compact` | No blank rows, minimal indent, for a short pane. |

`mono` exists to be tested against, not merely to be used. If a card is unambiguous under
`mono` then colour was decoration everywhere, which is the rule `docs/ACCESSIBILITY.md`
sets and the one that is otherwise easy to violate without noticing. There is a test
asserting no theme emits an escape sequence under it.

Writing a theme: implement `Theme` in `packages/cli/src/card/theme.ts` and add it to
`THEMES`. `lintTheme` runs over every registered theme in the suite, so a new one is
checked the moment it is added.

## Per-provider design notes

A provider may ship its own `DESIGN.md` beside its source. It does not override anything
here — the tokens and rules are global — but it records what its content means, which is
knowledge only the provider has: that a stale branch matters more than a description, that
an unread flag outranks a timestamp, that a draft pull request is `subtle` rather than
`warning` because nobody is being asked for anything yet.

The per-document equivalent is `Document.presentation`, a plain-text hint carried on each
item for a renderer that composes the pane itself rather than following a card verbatim.
Kept as prose deliberately: the consumer is a language model, and the moment it became an
enum it would stop being able to say the useful thing. See `docs/PLUGINS.md`.

## Checking your work

```
npm test
```

`packages/cli/src/test/design.test.ts` lints every card the built-in providers produce,
every registered theme, and this document against the linter. There is no separate lint
script, on purpose: a design rule that only runs when someone remembers to run it is a
suggestion.
