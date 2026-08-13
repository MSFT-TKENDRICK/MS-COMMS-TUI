# Rendering the detail pane

How a provider says what an item *is* without saying what it should look like.

Read `docs/DESIGN.md` for the rules this system enforces. This document is about the
mechanism.

## The problem

A detail pane has to show a mail message, a pull request, a Teams thread, an RSS entry and
whatever a third-party plugin invents next. Those have almost nothing in common. A pull
request has review verdicts, a diffstat and a mergeability state; a message has recipients,
attachments and a read flag. One fixed layout serves one of them well and the rest badly.

The pane used to be a fixed layout. Every provider flattened its item into `Label: value`
lines plus a body string, so a pull request's labels arrived as `bug, needs-triage`, its
reviews arrived as prose inside the markdown body, and the renderer had no way to know that
the first was a list and the second was a table. The structure existed at the source and was
destroyed one function call before the thing that needed it.

## The shape of the answer

Providers describe. The renderer draws.

```
provider.read()  ->  Document { headers, body, card?, presentation? }
                                                 |
                          cardFromDocument() <---+ (absent: synthesise from headers/body)
                                                 |
                                        renderCardRows(card, theme, width)
                                                 |
                                          rows of plain text + a colour
                                                 |
                                             fit to width
                                                 |
                                            paint, then print
```

`Document.card` is optional and must stay that way. `headers` plus `body` is a complete
document for a mail message, and a provider with nothing richer to say renders exactly as it
did before, because the frontend synthesises an equivalent card from those fields.

The two are not alternatives. A provider that sets `card` still populates `headers` and
`body`, because `plain`, `tsv` and `json` output, search indexing and the local snapshot all
read those. **The card decides presentation, not truth.**

## The vocabulary is Adaptive Cards

The element set is a subset of [Adaptive Cards](https://adaptivecards.io) 1.5:
`TextBlock`, `FactSet`, `Table`, `ColumnSet`, `Container`, `ActionSet`, plus `BadgeSet` and
`Prose` for things a terminal needs and the browser schema does not name.

Adopting an existing schema rather than inventing one was the single most consequential
decision here, for three reasons:

1. **It is already in the data.** Teams bot messages carry
   `application/vnd.microsoft.card.adaptive`, and Outlook actionable messages *are* Adaptive
   Cards. Those are sources this program already reads. A message that arrives carrying a
   card can eventually be rendered as one rather than flattened to text.
2. **It is published, versioned and MIT.** It does not drift because we do not maintain it.
3. **A language model emits it correctly without being taught.** That matters for
   `presentation` (below) and for anything that generates a layout later.

What was not adopted is the layout model. Adaptive Cards assumes CSS flexbox, which is a
large amount of machinery for a pane that needs "this column is twelve wide, that one takes
the rest". Column sizing follows [Ratatui](https://ratatui.rs)'s constraint model instead:
`len`, `percent`, `fill`. Adaptive Cards' Host Config, which separates the payload from the
host's visual vocabulary, carries over directly as the theme contract — the slots survive,
the pixel and hex values do not.

No terminal renderer for Adaptive Cards exists anywhere, in any language. That part is
genuinely new; everything above it is borrowed.

## Why not Ink, or React, or a real DOM

The obvious answer is [Ink](https://github.com/vadimdemedes/ink): React for terminals,
flexbox via Yoga, mature, widely used. It was measured rather than assumed.

`npm install ink --dry-run` adds **38 packages**, not the several thousand that gets quoted
in arguments like this one. Thirty-eight is not a lot. The objection is what they are, not
how many: the tree includes `ws` (a WebSocket client) and `yoga-layout` (a WASM binary).
This program holds a broad-scope OAuth token for corporate mail. A WebSocket client and a
WASM blob in that process are a different kind of cost from thirty-eight lines in a
lockfile, and `docs/PRIOR-ART.md` records zero runtime dependencies as a deliberate security
property rather than an aesthetic one.

There is a second argument that would hold even without the security one. React's value is
reconciling **stateful, interactive** trees: it earns its complexity when a keystroke has to
mutate a component three levels down and only the changed subtree should repaint. The detail
pane is a read-only projection. It has no state, no handlers and no partial updates — it is
recomputed from the document whenever the document changes. That is the full price of React
for none of the benefit.

**This is reversible.** The card model is the boundary. Swapping the renderer for an
Ink-backed one means reimplementing `renderCardRows`, and nothing in `packages/core` or in
any provider changes, because none of them know how a card is drawn.

## Two-phase width discipline

The rule, documented at the top of `packages/cli/src/tui/render.ts` and worth restating:

> Compose plain text. Fit it to an exact column count. **Then** colour the fitted string,
> last.

This is not stylistic. The TUI re-fits every pane row through `sanitizeForDisplay`, which
strips `\u001B` — but only the escape character. Text coloured before fitting arrives at the
terminal as a visible literal `[36m`, and every row below it is displaced. That bug was live
in the pane and is now covered by a regression test.

So rows travel as `{ text, color? }` pairs and the colour is applied after the width is
settled. Tone *marks* are the exception: they are applied in phase one, because a mark is
content that has to be measured.

## Themes

A theme is plain data — tone styles, glyphs, spacing, indents — so swapping the entire visual
language is a different object rather than a different renderer. Four ship: `default`,
`ascii`, `mono`, `compact`. Select one with `ui.cardTheme`; `ui.plain` implies `ascii`.

Every tone resolves to a colour *and* a mandatory text mark. That is the accessibility
contract from `docs/ACCESSIBILITY.md` expressed as a type: a theme that encodes meaning in
colour alone cannot be written, because there is nowhere to put it. `mono` exists to be
tested against.

## `presentation`: the seam for generated layouts

`Document.presentation` is plain-text guidance on how an item is best visualized, carried
alongside the card:

> A pull request is read in a fixed order of questions: can it merge, who must act, what
> changed, and only then what the author said about it.

A provider knows things about its own content that are true but not structural — that a
build status matters more than a description, that the newest comment is the one being
looked for. None of that fits in a card, because **a card is already a decision**.

It is prose on purpose, and it is not going to become an enum. The consumer is a language
model composing a layout; the moment this had a schema it would stop being able to say the
useful thing. A renderer that does not generate layouts ignores it, which is why it is safe
for a provider to always set it.

Nothing generates layouts today. The seam exists, the providers populate it, and the card
model gives a generated layout a validated vocabulary to emit into — `lintCard` is the gate,
and it is the reason a model-authored card can be trusted enough to render at all.

## Where things live

| Path | What |
|---|---|
| `packages/core/src/card.ts` | The vocabulary, plus `cardToSpeech` and `cardToPlainText` |
| `packages/core/src/design.ts` | The linter: `lintCard`, `lintTheme` |
| `packages/cli/src/card/theme.ts` | Themes and tone resolution |
| `packages/cli/src/card/layout.ts` | Constraint solving, wrapping, badge flow |
| `packages/cli/src/card/render.ts` | Card to rows |
| `packages/cli/src/card/document.ts` | Synthesising a card for providers that supply none |
| `packages/provider-github/src/card.ts` | Pull, issue and discussion cards |
| `packages/provider-graph/src/card.ts` | Message cards |

## Known gap: announce mode

This is scoped to the detail pane, and the full-screen pane refuses to run under
`--announce` — a repainting UI and a screen reader contradict each other, which is
`shouldRefuseTui`'s whole point. The consequence is that **screen-reader users get no benefit
from any of this**, which sits awkwardly beside a project whose accessibility charter is
binding.

`cardToSpeech` is written and tested and walks the same tree as the visual renderer, so
announce mode would be a first-class serialization rather than a degraded one. Wiring it to
`cat`'s announce path is a few lines. It has not been done because it would change output
outside the detail pane, which is outside what was asked for. Its current production role is
as the `speakable` rule's oracle in the linter.

If you want the pane's structural knowledge in speech — review verdicts as verdicts,
`and 14 others` instead of a truncated recipient list — that is the change to make.
