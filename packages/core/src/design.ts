/**
 * The design-system linter — `DESIGN.md` expressed as code that runs.
 *
 * `DESIGN.md` is the prose statement of how a detail pane is allowed to look. This module
 * is the half of it a machine can check, and the two are meant to be read together: every
 * rule here cites the section it enforces, and a rule that cannot be checked stays in the
 * document rather than being approximated by a heuristic here.
 *
 * WHY A LINTER AND NOT JUST A TYPE
 *
 * The card model already refuses whole categories of mistake — a badge cannot be a bare
 * coloured block because `text` is mandatory, and a theme cannot encode meaning in colour
 * alone because `mark` is mandatory. What types cannot catch is a *value*: a tone that is
 * not one of the six, an `Action.OpenUrl` pointing at `javascript:`, a table whose rows are
 * ragged, a tab character that silently destroys the column arithmetic.
 *
 * Those matter more here than in a typical UI because a card is not always written by us.
 * A provider plugin is third-party code, a Teams message can arrive carrying an Adaptive
 * Card of its own, and the whole point of {@link Document.presentation} is that a language
 * model may compose the layout. Anything crossing that boundary is untrusted input that
 * happens to be shaped like UI, and {@link lintCard} is where it is checked.
 *
 * SEVERITY IS A REAL DISTINCTION
 *
 * `error` means the card is wrong in a way that damages the pane or the reader: an unsafe
 * link, an unrenderable tone, text that would corrupt the layout. `warning` means it is
 * legible but off-pattern. Tests treat errors as failures and warnings as review notes,
 * which keeps the linter useful rather than something to be silenced.
 */

import type {
  Card,
  CardElement,
  Constraint,
  Spacing,
  TextStyle,
  Tone,
} from './card.js';
import { cardToSpeech } from './card.js';

/** Every tone a card may name. Anything else is a typo or a card from a newer schema. */
export const TONES: readonly Tone[] = ['default', 'accent', 'good', 'warning', 'attention', 'subtle'];

/**
 * Tones that assert a state of the world.
 *
 * These are the ones that must survive losing colour, so a theme owes each of them a
 * distinct mark. See {@link lintTheme}.
 */
export const STATUS_TONES: readonly Tone[] = ['good', 'warning', 'attention'];

/**
 * Tones that only draw the eye.
 *
 * The rule that follows from the split — and the one worth remembering — is that a status
 * may never be encoded in `accent` or `subtle` alone, because these deliberately carry no
 * mark and therefore vanish entirely in a monochrome terminal or in speech.
 */
export const EMPHASIS_TONES: readonly Tone[] = ['accent', 'subtle'];

export const TEXT_STYLES: readonly TextStyle[] = ['default', 'heading', 'strong', 'subtle', 'monospace'];

export const SPACINGS: readonly Spacing[] = ['none', 'small', 'default', 'medium', 'large'];

/**
 * URL schemes an action may use.
 *
 * Deliberately a short allow-list rather than a deny-list of the dangerous ones. A pane
 * that renders provider-supplied cards is rendering data that came off the network, and
 * "everything except the attacks I thought of" is the wrong shape for that check. `file:`
 * is absent on purpose: a link that opens a local path is a plausible request and an
 * implausible thing to have arrived from a mail server.
 */
export const ALLOWED_URL_SCHEMES: readonly string[] = ['http', 'https', 'mailto'];

/**
 * How deep containers may nest before the indent eats the pane.
 *
 * Four levels at the default two-column indent is eight columns of margin, which is already
 * a tenth of a narrow terminal. Deeper than that and the structure has stopped being
 * legible as structure.
 */
export const MAX_CONTAINER_DEPTH = 4;

export type DesignSeverity = 'error' | 'warning';

export interface DesignFinding {
  readonly rule: string;
  readonly severity: DesignSeverity;
  readonly message: string;
  /** Where in the card, as a readable path: `body[2].rows[0][1]`. */
  readonly path: string;
}

/** Control characters that break column arithmetic or terminal state. */
const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F]/;

/** An ANSI escape introducer, however it was written into the string. */
const ANSI_RE = /\u001B\[|\u009B/;

function isTone(value: unknown): value is Tone {
  return typeof value === 'string' && (TONES as readonly string[]).includes(value);
}

function describeControl(value: string): string {
  const match = CONTROL_RE.exec(value);
  if (match === null) return '';
  const code = match[0].codePointAt(0) ?? 0;
  return `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * Check one string of card-supplied text.
 *
 * Tabs get their own message because they are the mistake people make on purpose: a tab
 * looks like alignment right up until the pane is narrower than the tab stop, at which
 * point every column downstream is wrong and nothing about the output says why.
 */
function lintText(value: string, path: string, out: DesignFinding[]): void {
  if (ANSI_RE.test(value)) {
    out.push({
      rule: 'no-ansi',
      severity: 'error',
      path,
      message: 'contains an ANSI escape; colour belongs to the theme, not to card text',
    });
    return;
  }
  if (value.includes('\t')) {
    out.push({
      rule: 'no-tabs',
      severity: 'error',
      path,
      message: 'contains a tab; tab stops are not knowable at layout time, so use columns',
    });
  }
  if (CONTROL_RE.test(value)) {
    out.push({
      rule: 'no-control-characters',
      severity: 'error',
      path,
      message: `contains the control character ${describeControl(value)}`,
    });
  }
}

function lintTone(tone: unknown, path: string, out: DesignFinding[]): void {
  if (tone === undefined) return;
  if (!isTone(tone)) {
    out.push({
      rule: 'known-tone',
      severity: 'error',
      path,
      message: `unknown tone ${JSON.stringify(tone)}; expected one of ${TONES.join(', ')}`,
    });
  }
}

function lintConstraint(value: Constraint, path: string, out: DesignFinding[]): void {
  if (value.kind === 'percent') {
    if (!(value.value > 0 && value.value <= 100)) {
      out.push({
        rule: 'sane-constraint',
        severity: 'error',
        path,
        message: `percent constraint ${value.value} is outside 0-100`,
      });
    }
    return;
  }
  if (value.kind === 'length') {
    if (!Number.isFinite(value.value) || value.value < 0) {
      out.push({
        rule: 'sane-constraint',
        severity: 'error',
        path,
        message: `length constraint ${value.value} is not a usable width`,
      });
    }
    return;
  }
  if (!Number.isFinite(value.weight) || value.weight <= 0) {
    out.push({
      rule: 'sane-constraint',
      severity: 'error',
      path,
      message: `fill weight ${value.weight} would claim no space`,
    });
  }
}

/**
 * A toned element with nothing to say.
 *
 * This is the colour-only failure in its purest form: the tone was the entire message, so
 * a reader without colour receives nothing at all. It is an error rather than a warning
 * because there is no reading of it that is merely untidy.
 */
function lintTonedText(value: string, tone: Tone | undefined, path: string, out: DesignFinding[]): void {
  if (tone === undefined || tone === 'default') return;
  if (value.trim() !== '') return;
  out.push({
    rule: 'tone-needs-text',
    severity: 'error',
    path,
    message: `tone ${tone} on empty text; the tone would be the only information present`,
  });
}

function lintElement(element: CardElement, path: string, depth: number, out: DesignFinding[]): void {
  switch (element.type) {
    case 'TextBlock': {
      lintText(element.text, `${path}.text`, out);
      lintTone(element.tone, `${path}.tone`, out);
      lintTonedText(element.text, element.tone, path, out);
      if (element.speak !== undefined) lintText(element.speak, `${path}.speak`, out);
      if (element.style !== undefined && !(TEXT_STYLES as readonly string[]).includes(element.style)) {
        out.push({
          rule: 'known-style',
          severity: 'error',
          path: `${path}.style`,
          message: `unknown style ${JSON.stringify(element.style)}`,
        });
      }
      if (element.maxLines !== undefined && element.maxLines < 1) {
        out.push({
          rule: 'sane-constraint',
          severity: 'error',
          path: `${path}.maxLines`,
          message: `maxLines ${element.maxLines} would hide the element entirely`,
        });
      }
      if (element.maxLines !== undefined && element.wrap !== true) {
        out.push({
          rule: 'max-lines-needs-wrap',
          severity: 'warning',
          path,
          message: 'maxLines without wrap has no effect; unwrapped text is already one line',
        });
      }
      break;
    }
    case 'FactSet': {
      if (element.facts.length === 0) {
        out.push({ rule: 'no-empty-element', severity: 'warning', path, message: 'fact set has no facts' });
      }
      element.facts.forEach((fact, i) => {
        lintText(fact.title, `${path}.facts[${i}].title`, out);
        lintText(fact.value, `${path}.facts[${i}].value`, out);
        lintTone(fact.tone, `${path}.facts[${i}].tone`, out);
        lintTonedText(fact.value, fact.tone, `${path}.facts[${i}]`, out);
        if (fact.title.trim() === '') {
          out.push({
            rule: 'fact-needs-label',
            severity: 'warning',
            path: `${path}.facts[${i}]`,
            message: 'fact has no label, so its value is announced without saying what it is',
          });
        }
      });
      break;
    }
    case 'BadgeSet': {
      if (element.badges.length === 0) {
        out.push({ rule: 'no-empty-element', severity: 'warning', path, message: 'badge set has no badges' });
      }
      if (element.label !== undefined) lintText(element.label, `${path}.label`, out);
      element.badges.forEach((badge, i) => {
        lintText(badge.text, `${path}.badges[${i}].text`, out);
        lintTone(badge.tone, `${path}.badges[${i}].tone`, out);
        lintTonedText(badge.text, badge.tone, `${path}.badges[${i}]`, out);
      });
      break;
    }
    case 'Table': {
      element.columns?.forEach((c, i) => lintConstraint(c, `${path}.columns[${i}]`, out));
      element.header?.forEach((cell, i) => {
        lintText(cell.text, `${path}.header[${i}].text`, out);
        lintTone(cell.tone, `${path}.header[${i}].tone`, out);
      });
      if (element.speak !== undefined) lintText(element.speak, `${path}.speak`, out);
      const width = element.header?.length ?? element.rows[0]?.length ?? 0;
      element.rows.forEach((row, r) => {
        if (row.length !== width) {
          out.push({
            rule: 'table-rows-match',
            severity: 'error',
            path: `${path}.rows[${r}]`,
            message: `row has ${row.length} cells but the table is ${width} wide`,
          });
        }
        row.forEach((cell, c) => {
          lintText(cell.text, `${path}.rows[${r}][${c}].text`, out);
          lintTone(cell.tone, `${path}.rows[${r}][${c}].tone`, out);
          lintTonedText(cell.text, cell.tone, `${path}.rows[${r}][${c}]`, out);
        });
      });
      if (element.rows.length === 0 && element.header !== undefined) {
        out.push({
          rule: 'no-empty-element',
          severity: 'warning',
          path,
          message: 'table has a header and no rows; a bare header states a shape, not a fact',
        });
      }
      break;
    }
    case 'ColumnSet': {
      if (element.columns.length === 0) {
        out.push({ rule: 'no-empty-element', severity: 'warning', path, message: 'column set has no columns' });
      }
      element.columns.forEach((column, i) => {
        if (column.width !== undefined) lintConstraint(column.width, `${path}.columns[${i}].width`, out);
        column.items.forEach((item, j) =>
          lintElement(item, `${path}.columns[${i}].items[${j}]`, depth + 1, out),
        );
      });
      break;
    }
    case 'Container': {
      if (element.title !== undefined) lintText(element.title, `${path}.title`, out);
      lintTone(element.tone, `${path}.tone`, out);
      if (depth + 1 > MAX_CONTAINER_DEPTH) {
        out.push({
          rule: 'container-depth',
          severity: 'warning',
          path,
          message: `nested ${depth + 1} deep; past ${MAX_CONTAINER_DEPTH} the indent costs more than the structure conveys`,
        });
      }
      if (element.items.length === 0) {
        out.push({ rule: 'no-empty-element', severity: 'warning', path, message: 'container has no items' });
      }
      element.items.forEach((item, i) => lintElement(item, `${path}.items[${i}]`, depth + 1, out));
      break;
    }
    case 'ActionSet': {
      if (element.actions.length === 0) {
        out.push({ rule: 'no-empty-element', severity: 'warning', path, message: 'action set has no actions' });
      }
      element.actions.forEach((action, i) => {
        lintText(action.title, `${path}.actions[${i}].title`, out);
        if (action.title.trim() === '') {
          out.push({
            rule: 'action-needs-title',
            severity: 'error',
            path: `${path}.actions[${i}]`,
            message: 'action has no title, so nothing describes where it goes',
          });
        }
        lintUrl(action.url, `${path}.actions[${i}].url`, out);
      });
      break;
    }
    case 'Prose': {
      // Prose is the one place a tab survives: it is a mail body or a code block, where the
      // author's whitespace is content and re-flowing it is the destructive act.
      if (ANSI_RE.test(element.text)) {
        out.push({
          rule: 'no-ansi',
          severity: 'error',
          path: `${path}.text`,
          message: 'contains an ANSI escape; colour belongs to the theme, not to card text',
        });
      }
      if (element.format !== undefined && element.format !== 'text' && element.format !== 'markdown') {
        out.push({
          rule: 'known-format',
          severity: 'error',
          path: `${path}.format`,
          message: `unknown prose format ${JSON.stringify(element.format)}`,
        });
      }
      break;
    }
    default: {
      const unknown = element as { readonly type?: unknown };
      out.push({
        rule: 'known-element',
        severity: 'error',
        path,
        message: `unknown element type ${JSON.stringify(unknown.type)}`,
      });
    }
  }

  const spacing = (element as { readonly spacing?: unknown }).spacing;
  if (spacing !== undefined && !(SPACINGS as readonly unknown[]).includes(spacing)) {
    out.push({
      rule: 'known-spacing',
      severity: 'error',
      path: `${path}.spacing`,
      message: `unknown spacing ${JSON.stringify(spacing)}`,
    });
  }
}

/**
 * Check an action's destination.
 *
 * The card model has exactly one action for a reason, and this is the other half of that
 * reason: a single URL field is a small enough surface to actually validate. Parsing rather
 * than pattern-matching, so `jAvAsCrIpT:` and percent-encoded variants resolve to the same
 * scheme the runtime would eventually see.
 */
function lintUrl(url: string, path: string, out: DesignFinding[]): void {
  lintText(url, path, out);
  let scheme: string;
  try {
    scheme = new URL(url).protocol.replace(/:$/, '').toLowerCase();
  } catch {
    out.push({
      rule: 'safe-action-url',
      severity: 'error',
      path,
      message: `${JSON.stringify(url)} is not a URL`,
    });
    return;
  }
  if (!ALLOWED_URL_SCHEMES.includes(scheme)) {
    out.push({
      rule: 'safe-action-url',
      severity: 'error',
      path,
      message: `scheme ${scheme}: is not one of ${ALLOWED_URL_SCHEMES.map((s) => `${s}:`).join(', ')}`,
    });
  }
}

/**
 * Check a card against `DESIGN.md`.
 *
 * Returns findings rather than throwing, so a caller can decide: a test fails on any error,
 * while the renderer could one day drop the offending element and show the rest. Ordered by
 * traversal, which is the order a reader would meet the problems.
 */
export function lintCard(value: Card): readonly DesignFinding[] {
  const out: DesignFinding[] = [];

  if (value.type !== 'AdaptiveCard') {
    out.push({
      rule: 'known-element',
      severity: 'error',
      path: 'type',
      message: `card type ${JSON.stringify(value.type)} is not AdaptiveCard`,
    });
  }
  if (value.title !== undefined) lintText(value.title, 'title', out);
  if (value.speak !== undefined) lintText(value.speak, 'speak', out);
  if (value.fallbackText !== undefined) lintText(value.fallbackText, 'fallbackText', out);
  if (value.body.length === 0) {
    out.push({ rule: 'no-empty-element', severity: 'warning', path: 'body', message: 'card has no body' });
  }
  value.body.forEach((element, i) => lintElement(element, `body[${i}]`, 0, out));

  // The speech check runs last and on the finished card, because it is the only rule about
  // the card as a whole: every other rule can be satisfied element by element while still
  // producing something that announces as nothing.
  //
  // `cardToSpeech` deliberately never returns silence — a card with nothing to say falls
  // back to a stock phrase, which is right in production and useless here, because a linter
  // needs to tell "said something" from "said the stock phrase". Substituting a sentinel
  // fallback makes that observable without this side having to know the other's wording.
  const sentinel = 'a1e0f2c4nothingtosaya1e0f2c4';
  const probe = cardToSpeech({ ...value, fallbackText: sentinel });
  if (probe.includes(sentinel) || probe.trim() === '') {
    out.push({
      rule: 'speakable',
      severity: 'error',
      path: '',
      message: 'no element contributes any speech; announce mode would read the card as empty',
    });
  } else if (ANSI_RE.test(probe) || CONTROL_RE.test(probe)) {
    out.push({
      rule: 'speakable',
      severity: 'error',
      path: '',
      message: 'speech contains control characters',
    });
  }

  return out;
}

/** Just the errors, for the common case of asserting a card is clean. */
export function designErrors(value: Card): readonly DesignFinding[] {
  return lintCard(value).filter((f) => f.severity === 'error');
}

/** Render findings for a test failure message, one per line. */
export function formatFindings(findings: readonly DesignFinding[]): string {
  return findings
    .map((f) => `${f.severity} ${f.rule} at ${f.path === '' ? '<card>' : f.path}: ${f.message}`)
    .join('\n');
}

/**
 * The shape {@link lintTheme} needs, restated locally.
 *
 * `Theme` lives in the CLI package because it names ANSI colours, and core does not depend
 * on the CLI. Structural typing means the real theme satisfies this without either side
 * importing the other, which keeps the rule with the rest of the design system rather than
 * stranded in the frontend that happens to hold the data.
 */
export interface ThemeLike {
  readonly name: string;
  readonly tones: Readonly<Record<string, { readonly mark: string; readonly color?: unknown }>>;
  readonly spacing?: Readonly<Record<string, number>>;
}

/**
 * Check a theme against the accessibility contract.
 *
 * The type already forces every tone to declare a mark; what it cannot force is that the
 * marks are *useful*. A theme giving `good` and `attention` the same mark satisfies the
 * type and fails the reader, and it fails them silently, in exactly the case the mark
 * existed to cover.
 */
export function lintTheme(theme: ThemeLike): readonly DesignFinding[] {
  const out: DesignFinding[] = [];
  const seen = new Map<string, Tone>();

  for (const tone of TONES) {
    const style = theme.tones[tone];
    if (style === undefined) {
      out.push({
        rule: 'theme-covers-tones',
        severity: 'error',
        path: `${theme.name}.tones.${tone}`,
        message: `theme does not define ${tone}`,
      });
      continue;
    }
    if (ANSI_RE.test(style.mark) || CONTROL_RE.test(style.mark)) {
      out.push({
        rule: 'no-ansi',
        severity: 'error',
        path: `${theme.name}.tones.${tone}.mark`,
        message: 'mark contains a control character; marks are plain text',
      });
    }
    if ((STATUS_TONES as readonly string[]).includes(tone)) {
      if (style.mark.trim() === '') {
        out.push({
          rule: 'status-tone-has-mark',
          severity: 'error',
          path: `${theme.name}.tones.${tone}.mark`,
          message: `${tone} states a fact, so it needs a mark that survives losing colour`,
        });
        continue;
      }
      const clash = seen.get(style.mark);
      if (clash !== undefined) {
        out.push({
          rule: 'status-marks-distinct',
          severity: 'error',
          path: `${theme.name}.tones.${tone}.mark`,
          message: `mark ${JSON.stringify(style.mark)} is also used by ${clash}`,
        });
      }
      seen.set(style.mark, tone);
    } else if ((EMPHASIS_TONES as readonly string[]).includes(tone) && style.mark !== '') {
      out.push({
        rule: 'emphasis-tone-unmarked',
        severity: 'warning',
        path: `${theme.name}.tones.${tone}.mark`,
        message: `${tone} is emphasis rather than status, so a mark on it is noise in speech`,
      });
    }
  }

  if (theme.spacing !== undefined) {
    for (const [name, value] of Object.entries(theme.spacing)) {
      if (!Number.isInteger(value) || value < 0) {
        out.push({
          rule: 'sane-constraint',
          severity: 'error',
          path: `${theme.name}.spacing.${name}`,
          message: `spacing ${value} is not a row count`,
        });
      }
    }
  }

  return out;
}
