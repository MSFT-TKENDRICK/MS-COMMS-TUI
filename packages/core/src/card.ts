/**
 * The card model — a structured description of what a detail pane should show.
 *
 * WHY THIS EXISTS
 *
 * {@link Document} can say "here are some label/value pairs and here is a blob of text".
 * That is enough to display a mail message and not much else. A pull request has labels,
 * requested reviewers, a diffstat and a set of review verdicts; every one of those arrives
 * at the renderer as a pre-joined string like `"bug, needs-triage"` or
 * `"3 file(s), +120 -40"`, because a string is the only thing the shape can hold. Once a
 * provider has flattened a list into prose the renderer cannot un-flatten it, so it cannot
 * lay labels out as chips, colour a state, or align a table. The structure is gone at the
 * point it would have been useful.
 *
 * A card keeps it. Providers describe *what* the thing is; the renderer decides how it
 * looks in the space it has.
 *
 * WHY IT LOOKS LIKE ADAPTIVE CARDS
 *
 * This is deliberately a subset of the Adaptive Cards 1.5 schema (MIT, and specified at
 * <https://adaptivecards.io/explorer/>) rather than a format of our own, for three reasons
 * that all point the same way:
 *
 *  1. Teams and Outlook already send Adaptive Cards. A Teams bot message carries a payload
 *     of `application/vnd.microsoft.card.adaptive`, and Outlook actionable messages are
 *     Adaptive Cards too. Both are sources this program already reads. Choosing any other
 *     vocabulary would mean translating theirs into ours on the way in, for no gain.
 *  2. It is a published, versioned spec with a schema, so it does not drift and we do not
 *     maintain it. A format we invented would be a format we own forever.
 *  3. Language models emit it correctly without being taught, which is what makes a
 *     generated detail pane practical rather than a research project.
 *
 * It is a *subset*: no images, no inputs, no `Action.Submit`. Those either cannot work in a
 * terminal or would make a read-only pane interactive, which is a different feature. The
 * subset stays structurally compatible, so a card that renders here is valid Adaptive Cards
 * JSON, and an Adaptive Card from Teams can be narrowed to this and rendered.
 *
 * WHY THE MODEL LIVES IN CORE AND THE RENDERER DOES NOT
 *
 * Providers construct cards, so the types have to be in the package providers depend on.
 * How a card becomes pixels is a frontend concern, and deliberately not fixed here: the
 * terminal renderer lives in the CLI, and a future GUI could render the same cards without
 * core learning anything about either. Core knows the vocabulary, not the presentation.
 *
 * ACCESSIBILITY IS PART OF THE MODEL, NOT AN AFTERTHOUGHT
 *
 * `docs/ACCESSIBILITY.md` requires that colour is never the only carrier of meaning, and
 * the shell has an `announce` output mode for screen readers. So every element that can be
 * styled also carries the words that justify the styling — a {@link Badge} has `text`, not
 * merely a tone — and {@link cardToSpeech} can turn any card into flat prose. An element
 * that could only be understood by looking at it would be unrenderable in announce mode,
 * so the model does not allow one to be expressed.
 */

/** Emphasis for a text run. Maps to weight/size, never to colour alone. */
export type TextStyle = 'default' | 'heading' | 'strong' | 'subtle' | 'monospace';

/**
 * Semantic colour slots, borrowed from Adaptive Cards' Host Config.
 *
 * Named by meaning rather than by colour so a theme picks the actual ANSI code. `good` is
 * not "green": a theme for a monochrome terminal renders it with a glyph and no colour at
 * all, and both are correct.
 */
export type Tone = 'default' | 'accent' | 'good' | 'warning' | 'attention' | 'subtle';

/** Space above an element. `none` lets a caller build tight groups. */
export type Spacing = 'none' | 'small' | 'default' | 'medium' | 'large';

export interface TextBlock {
  readonly type: 'TextBlock';
  readonly text: string;
  readonly style?: TextStyle;
  readonly tone?: Tone;
  /** Let long text wrap. Off by default, matching Adaptive Cards. */
  readonly wrap?: boolean;
  /** Truncate to this many lines once wrapped. */
  readonly maxLines?: number;
  readonly spacing?: Spacing;
  /** Draw a rule above this element. */
  readonly separator?: boolean;
  /**
   * What a screen reader should say instead of `text`.
   *
   * For when the visual form is a shorthand the ear cannot unpack: `"+120 -40"` reads as
   * gibberish, `"120 added, 40 removed"` does not.
   */
  readonly speak?: string;
}

/** One row of a {@link FactSet}. */
export interface Fact {
  readonly title: string;
  readonly value: string;
  readonly tone?: Tone;
}

/**
 * An aligned list of label/value pairs — the shape `Document.headers` always wanted.
 *
 * Ordered, because a screen reader announces the facts in array order and the provider is
 * the only party that knows From should precede Subject.
 */
export interface FactSet {
  readonly type: 'FactSet';
  readonly facts: readonly Fact[];
  readonly spacing?: Spacing;
  readonly separator?: boolean;
}

/**
 * A short chip: a label, a state, a reviewer's verdict.
 *
 * `text` is mandatory and `tone` is optional, which is the whole accessibility argument in
 * one signature. A badge that rendered as a bare coloured block would be invisible to a
 * screen reader and meaningless in a monochrome terminal.
 */
export interface Badge {
  readonly text: string;
  readonly tone?: Tone;
}

/** A row of badges, wrapped across as many lines as the width needs. */
export interface BadgeSet {
  readonly type: 'BadgeSet';
  readonly badges: readonly Badge[];
  /** Optional lead-in, e.g. `Labels`. */
  readonly label?: string;
  readonly spacing?: Spacing;
  readonly separator?: boolean;
}

export interface TableCell {
  readonly text: string;
  readonly tone?: Tone;
  readonly style?: TextStyle;
}

/**
 * Column sizing, following Ratatui's constraint model rather than flexbox.
 *
 * Full flexbox is a large amount of machinery for a pane that needs "this column is 12
 * columns wide, that one takes what is left". `Fill` weights share the remainder.
 */
export type Constraint =
  | { readonly kind: 'length'; readonly value: number }
  | { readonly kind: 'percent'; readonly value: number }
  | { readonly kind: 'fill'; readonly weight: number };

export interface Table {
  readonly type: 'Table';
  readonly columns?: readonly Constraint[];
  /** Optional header row, rendered emphasised and never colour-only. */
  readonly header?: readonly TableCell[];
  readonly rows: readonly (readonly TableCell[])[];
  readonly spacing?: Spacing;
  readonly separator?: boolean;
  /**
   * What a screen reader should say instead of the cells.
   *
   * Tables are the element that suffers most in speech: a grid is a two-dimensional thing
   * being read down a one-dimensional channel, and even with headers re-attached it comes
   * out as a stream of qualified fragments. When a table is really shorthand for one
   * sentence — a diffstat, a score, a tally — this says the sentence instead.
   */
  readonly speak?: string;
}

/** One column of a {@link ColumnSet}. */
export interface Column {
  readonly width?: Constraint;
  readonly items: readonly CardElement[];
}

/**
 * Side-by-side layout.
 *
 * Degrades to stacking when the pane is too narrow to split — two unreadable slivers are
 * worse than two readable blocks, the same bargain the TUI already makes at 60 columns.
 */
export interface ColumnSet {
  readonly type: 'ColumnSet';
  readonly columns: readonly Column[];
  readonly spacing?: Spacing;
  readonly separator?: boolean;
}

/** A titled group. Nests, so a comment thread is a container of containers. */
export interface Container {
  readonly type: 'Container';
  readonly items: readonly CardElement[];
  readonly title?: string;
  readonly tone?: Tone;
  readonly spacing?: Spacing;
  readonly separator?: boolean;
}

/**
 * A link out to the native web client.
 *
 * Adaptive Cards calls this `Action.OpenUrl`. It is the only action carried over, because
 * it is the only one that means anything in a pane that cannot be typed into: everything
 * else a user might do to an item already goes through `do`, which is discoverable,
 * completable and works identically in the line shell.
 */
export interface OpenUrlAction {
  readonly type: 'Action.OpenUrl';
  readonly title: string;
  readonly url: string;
}

export interface ActionSet {
  readonly type: 'ActionSet';
  readonly actions: readonly OpenUrlAction[];
  readonly spacing?: Spacing;
  readonly separator?: boolean;
}

/**
 * Pre-rendered prose — a mail body, a markdown comment.
 *
 * Distinct from {@link TextBlock} because it is a paragraph flow rather than a labelled
 * value: it always wraps, and it preserves indented lines instead of reflowing them, since
 * indentation in a message body is quoted text or code and re-wrapping destroys the only
 * structure it has.
 */
export interface Prose {
  readonly type: 'Prose';
  readonly text: string;
  readonly format?: 'text' | 'markdown';
  readonly spacing?: Spacing;
  readonly separator?: boolean;
}

export type CardElement =
  | TextBlock
  | FactSet
  | BadgeSet
  | Table
  | ColumnSet
  | Container
  | ActionSet
  | Prose;

/**
 * A described detail pane.
 *
 * `fallbackText` exists for the same reason Adaptive Cards has it: a consumer that cannot
 * render this card, or a card that arrives using elements this build does not know, still
 * has something true to show.
 */
export interface Card {
  readonly type: 'AdaptiveCard';
  /** Schema version of the subset. Present so a stored card can be migrated later. */
  readonly version?: string;
  readonly title?: string;
  readonly body: readonly CardElement[];
  readonly fallbackText?: string;
  /** Whole-card speech override, used by announce mode ahead of per-element `speak`. */
  readonly speak?: string;
}

// ---------------------------------------------------------------------------
// Construction helpers
// ---------------------------------------------------------------------------

export const CARD_VERSION = '1.5';

/** Build a card, defaulting the boilerplate so providers write one object literal. */
export function card(body: readonly CardElement[], extra: Omit<Partial<Card>, 'type' | 'body'> = {}): Card {
  return { type: 'AdaptiveCard', version: CARD_VERSION, body, ...extra };
}

export function text(value: string, extra: Omit<Partial<TextBlock>, 'type' | 'text'> = {}): TextBlock {
  return { type: 'TextBlock', text: value, ...extra };
}

export function heading(value: string, extra: Omit<Partial<TextBlock>, 'type' | 'text' | 'style'> = {}): TextBlock {
  return { type: 'TextBlock', text: value, style: 'heading', ...extra };
}

/**
 * Build a fact set, dropping facts with an empty value.
 *
 * Providers assemble these from optional backend fields, so a missing value is normal and
 * an empty row is noise — worse in announce mode, where it is a label followed by silence.
 */
export function facts(entries: readonly Fact[], extra: Omit<Partial<FactSet>, 'type' | 'facts'> = {}): FactSet {
  return { type: 'FactSet', facts: entries.filter((f) => f.value.trim() !== ''), ...extra };
}

export function badges(items: readonly Badge[], extra: Omit<Partial<BadgeSet>, 'type' | 'badges'> = {}): BadgeSet {
  return { type: 'BadgeSet', badges: items.filter((b) => b.text.trim() !== ''), ...extra };
}

export function prose(value: string, extra: Omit<Partial<Prose>, 'type' | 'text'> = {}): Prose {
  return { type: 'Prose', text: value, ...extra };
}

/** Fixed-width column. */
export function len(value: number): Constraint {
  return { kind: 'length', value };
}

/** Share of whatever is left after fixed columns. */
export function fill(weight = 1): Constraint {
  return { kind: 'fill', weight };
}

export function percent(value: number): Constraint {
  return { kind: 'percent', value };
}

// ---------------------------------------------------------------------------
// Speech
// ---------------------------------------------------------------------------

/**
 * Flatten a card to the prose a screen reader should hear.
 *
 * This is the reason the model can be trusted: `announce` mode is not a degraded rendering
 * that happens to drop the colours, it is a first-class serialization that walks the same
 * tree. If a card cannot be spoken it is malformed, and that is detectable here rather than
 * by a user discovering silence.
 *
 * Sentence-per-element, because a screen reader pauses at a full stop and that pause is the
 * only structural cue available once the layout is gone.
 */
export function cardToSpeech(value: Card): string {
  if (value.speak !== undefined && value.speak.trim() !== '') return value.speak.trim();

  const parts: string[] = [];
  if (value.title !== undefined && value.title.trim() !== '') push(parts, value.title);
  for (const element of value.body) speakElement(element, parts);

  // A card whose elements were all empty still has to say something, or the pane is a
  // wall of silence with no explanation.
  if (parts.length === 0) {
    const fallback = value.fallbackText ?? '';
    return fallback.trim() === '' ? 'Nothing to show.' : sentence(fallback);
  }
  return parts.join(' ');
}

function speakElement(element: CardElement, out: string[]): void {
  switch (element.type) {
    case 'TextBlock':
      push(out, element.speak ?? element.text);
      return;

    case 'FactSet':
      // "Label, value." reads naturally and keeps the pairing audible; a bare list of
      // values would be unattributable.
      for (const fact of element.facts) push(out, `${fact.title}, ${fact.value}`);
      return;

    case 'BadgeSet': {
      if (element.badges.length === 0) return;
      const list = element.badges.map((b) => b.text).join(', ');
      push(out, element.label === undefined ? list : `${element.label}, ${list}`);
      return;
    }

    case 'Table': {
      if (element.speak !== undefined && element.speak.trim() !== '') {
        push(out, element.speak);
        return;
      }
      // Re-attach the header to every cell. A table read as bare rows is a stream of
      // unlabelled values, which is exactly the thing that makes tables hostile in speech.
      const header = element.header;
      for (const row of element.rows) {
        const cells = row.map((cell, i) => {
          const label = header?.[i]?.text;
          return label === undefined || label.trim() === '' ? cell.text : `${label}, ${cell.text}`;
        });
        push(out, cells.join(', '));
      }
      return;
    }

    case 'ColumnSet':
      // Column order is reading order; visual side-by-side has no audible equivalent.
      for (const column of element.columns) for (const item of column.items) speakElement(item, out);
      return;

    case 'Container':
      if (element.title !== undefined && element.title.trim() !== '') push(out, element.title);
      for (const item of element.items) speakElement(item, out);
      return;

    case 'ActionSet':
      for (const action of element.actions) push(out, `${action.title}, ${action.url}`);
      return;

    case 'Prose':
      // Paragraph by paragraph, not as one string.
      //
      // {@link sentence} collapses whitespace, which is right for a label and catastrophic
      // for a mail body: forty paragraphs become one unbroken run-on with no pause anywhere
      // in it, and the pause at a full stop is the only structural cue speech has left. The
      // blank line between paragraphs is the author's own structure, so it is the one piece
      // of layout worth carrying into the audio.
      for (const paragraph of element.text.split(/\n\s*\n/)) push(out, paragraph);
      return;
  }
}

/**
 * Append a spoken sentence, dropping it if there is nothing to say.
 *
 * An empty string still joins with a space on either side, so pushing one produces a
 * doubled gap that a synthesizer reads as a hesitation the text does not contain.
 */
function push(out: string[], value: string): void {
  const spoken = sentence(value);
  if (spoken !== '') out.push(spoken);
}

/**
 * Normalize to one spoken sentence.
 *
 * Collapsing whitespace matters more here than it looks: a screen reader reading a run of
 * newlines from a mail body pauses once per line, which sounds like the program has
 * stopped responding.
 */
function sentence(value: string): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (clean === '') return '';
  return /[.!?,;:]$/.test(clean) ? clean : `${clean}.`;
}

/**
 * Flatten a card to plain text, one element per line.
 *
 * For `plain` and `tsv` output, which are parsed by other programs: no alignment padding,
 * no colour, no box drawing. The layout engine is for humans looking at a pane; this is
 * for `grep`.
 */
export function cardToPlainText(value: Card): string {
  const lines: string[] = [];
  if (value.title !== undefined && value.title.trim() !== '') lines.push(value.title.trim());
  for (const element of value.body) plainElement(element, lines);
  return lines.join('\n');
}

function plainElement(element: CardElement, out: string[]): void {
  switch (element.type) {
    case 'TextBlock':
      out.push(element.text);
      return;
    case 'FactSet':
      for (const fact of element.facts) out.push(`${fact.title}: ${fact.value}`);
      return;
    case 'BadgeSet': {
      if (element.badges.length === 0) return;
      const list = element.badges.map((b) => b.text).join(', ');
      out.push(element.label === undefined ? list : `${element.label}: ${list}`);
      return;
    }
    case 'Table':
      for (const row of element.rows) out.push(row.map((c) => c.text).join('\t'));
      return;
    case 'ColumnSet':
      for (const column of element.columns) for (const item of column.items) plainElement(item, out);
      return;
    case 'Container':
      if (element.title !== undefined && element.title.trim() !== '') out.push(element.title);
      for (const item of element.items) plainElement(item, out);
      return;
    case 'ActionSet':
      for (const action of element.actions) out.push(`${action.title}: ${action.url}`);
      return;
    case 'Prose':
      out.push(element.text);
      return;
  }
}
