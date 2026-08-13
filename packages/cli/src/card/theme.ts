/**
 * Themes — how a semantic tone becomes something you can see.
 *
 * A card says `tone: 'attention'`. It does not say red, because red is not available in
 * every terminal, is not distinguishable to every reader, and is not always the right
 * answer even when it is both. The theme is where that decision is made, and it is plain
 * data so that swapping the entire visual language is a different object rather than a
 * different renderer.
 *
 * The design is lifted from Adaptive Cards' Host Config, which separates the card payload
 * from the host's visual vocabulary for exactly this reason. Host Config speaks in pixels
 * and hex, so the slots carry over and the values do not.
 *
 * THE ACCESSIBILITY CONTRACT, ENFORCED BY THE TYPE
 *
 * `docs/ACCESSIBILITY.md` requires that colour is decoration and never information. A tone
 * therefore resolves to a {@link ToneStyle} carrying *both* an optional colour and a
 * mandatory `mark` — the short text prefix that survives when colour does not. Set
 * `color: false` on any theme, or run in a monochrome terminal, and every distinction the
 * theme draws is still legible because the marks are still there.
 *
 * That is why `mark` is not optional. A theme cannot be written that encodes meaning in
 * colour alone, because there is nowhere to put such a theme.
 */

import type { Spacing, Tone } from '@mscomms/core';
import type { ColorName } from '../format.js';

/**
 * How one tone renders.
 *
 * `mark` is the belt to colour's braces: `!` on a warning, `x` on a failure. It is
 * deliberately short, because it is spent from the same column budget as the content, and
 * deliberately mandatory, because it is the half that always works.
 */
export interface ToneStyle {
  /** ANSI colour, when the terminal has colour at all. */
  readonly color?: ColorName;
  /**
   * Text marker shown before the content, carrying the same distinction as the colour.
   * Empty for `default`, where there is no distinction to carry.
   */
  readonly mark: string;
}

/** Box-drawing and layout glyphs, so a theme can be pure ASCII. */
export interface ThemeGlyphs {
  /** Rule drawn by `separator: true`. */
  readonly rule: string;
  /** Opens and closes a badge. */
  readonly badgeOpen: string;
  readonly badgeClose: string;
  /** Separates a container's title from its body. */
  readonly titleRule: string;
  /** Column gutter in a table. */
  readonly columnGap: string;
  /** Bullet for list-like prose. */
  readonly bullet: string;
}

export interface Theme {
  readonly name: string;
  /** Blank rows inserted above an element, by spacing name. */
  readonly spacing: Readonly<Record<Spacing, number>>;
  readonly tones: Readonly<Record<Tone, ToneStyle>>;
  readonly glyphs: ThemeGlyphs;
  /** Columns of indent applied inside a titled container. */
  readonly containerIndent: number;
  /** Gap between a fact's label column and its value column. */
  readonly factGap: number;
  /** Cap on the label column of a fact set, so a long label cannot eat the values. */
  readonly maxFactLabel: number;
  /** Style applied to a heading, alongside its own tone. */
  readonly headingColor?: ColorName;
}

/**
 * The default theme.
 *
 * Unicode box drawing, because the TUI already uses it for its own rules and a terminal
 * without the font shows a box rather than nothing. Marks are ASCII punctuation, which
 * every font has.
 */
export const DEFAULT_THEME: Theme = {
  name: 'default',
  spacing: { none: 0, small: 0, default: 1, medium: 1, large: 2 },
  tones: {
    default: { mark: '' },
    // `accent` is emphasis, not status, so it earns no mark: there is no distinction for
    // a mark to preserve, and a decorative glyph on every heading is noise in speech.
    accent: { color: 'cyan', mark: '' },
    good: { color: 'green', mark: '+' },
    warning: { color: 'yellow', mark: '!' },
    attention: { color: 'red', mark: 'x' },
    subtle: { color: 'dim', mark: '' },
  },
  glyphs: {
    rule: '\u2500',
    badgeOpen: '[',
    badgeClose: ']',
    titleRule: '\u2500',
    columnGap: '  ',
    bullet: '\u2022',
  },
  containerIndent: 2,
  factGap: 1,
  maxFactLabel: 22,
  headingColor: 'cyan',
};

/**
 * Pure ASCII, for terminals that mangle box drawing.
 *
 * Not merely the default with substitutions: `ascii` is the theme that proves the model
 * works without Unicode, and it is what a conformance test asserts against.
 */
export const ASCII_THEME: Theme = {
  ...DEFAULT_THEME,
  name: 'ascii',
  glyphs: { rule: '-', badgeOpen: '[', badgeClose: ']', titleRule: '-', columnGap: '  ', bullet: '*' },
};

/**
 * No colour at all — every distinction carried by marks and words.
 *
 * This exists to be tested against, not merely to be used. If a card renders unambiguously
 * under this theme then colour was decoration everywhere, which is the rule
 * `docs/ACCESSIBILITY.md` sets and the thing that is otherwise easy to violate by accident.
 */
export const MONO_THEME: Theme = (() => {
  // `headingColor` has to be absent, not `undefined`: the project compiles with
  // `exactOptionalPropertyTypes`, which distinguishes the two.
  const { headingColor: _dropped, ...rest } = ASCII_THEME;
  return {
    ...rest,
    name: 'mono',
    tones: {
      default: { mark: '' },
      accent: { mark: '' },
      good: { mark: '+' },
      warning: { mark: '!' },
      attention: { mark: 'x' },
      subtle: { mark: '' },
    },
  };
})();

/**
 * Dense: no blank rows, minimal indent.
 *
 * For a short pane, where vertical space is the scarce resource and a reader would rather
 * see three more facts than breathe between them.
 */
export const COMPACT_THEME: Theme = {
  ...DEFAULT_THEME,
  name: 'compact',
  spacing: { none: 0, small: 0, default: 0, medium: 1, large: 1 },
  containerIndent: 1,
};

export const THEMES: Readonly<Record<string, Theme>> = {
  default: DEFAULT_THEME,
  ascii: ASCII_THEME,
  mono: MONO_THEME,
  compact: COMPACT_THEME,
};

/** Look up a theme by name, falling back to the default rather than throwing. */
export function themeByName(name: string | undefined): Theme {
  if (name === undefined) return DEFAULT_THEME;
  return THEMES[name] ?? DEFAULT_THEME;
}

/**
 * Pick the theme for a session.
 *
 * An explicit `ui.cardTheme` always wins — a user who names a theme means it. Absent that,
 * `ui.plain` selects the ASCII theme, because plain mode exists precisely to promise that
 * nothing outside the ASCII range reaches the terminal, and box-drawing glyphs would break
 * that promise.
 */
export function themeFor(ui: { readonly cardTheme?: string; readonly plain?: boolean }): Theme {
  if (ui.cardTheme !== undefined) return themeByName(ui.cardTheme);
  return ui.plain === true ? ASCII_THEME : DEFAULT_THEME;
}

export function toneStyle(theme: Theme, tone: Tone | undefined): ToneStyle {
  return theme.tones[tone ?? 'default'];
}

/**
 * Prefix a string with its tone's mark.
 *
 * Applied to the plain text before any colouring, so the mark is measured as part of the
 * content and the layout accounts for it. Doing it after would make every toned element
 * one or two columns wider than the width it was fitted to.
 */
export function withMark(theme: Theme, tone: Tone | undefined, value: string): string {
  const mark = toneStyle(theme, tone).mark;
  if (mark === '' || value === '') return value;
  return `${mark} ${value}`;
}
