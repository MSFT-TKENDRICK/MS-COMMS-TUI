/**
 * The design system, enforced.
 *
 * `docs/DESIGN.md` states the rules; `packages/core/src/design.ts` checks the ones a
 * machine can check; this file is what makes either of them matter. There is deliberately
 * no `npm run lint` — a design rule that only runs when someone remembers to run it is a
 * suggestion, so these run in the ordinary suite alongside everything else.
 *
 * Four kinds of check live here, and they fail for different reasons:
 *
 *  1. Real provider cards are linted. Not fixtures: the actual output of `pullCard` and
 *     friends, built from realistic inputs including the awkward ones, because a rule that
 *     only ever sees hand-written examples is a rule about hand-written examples.
 *  2. Every registered theme is linted, so adding a theme puts it under the accessibility
 *     contract automatically rather than when somebody notices.
 *  3. The renderer's own source is scanned for hand-written colour. This is the rule that
 *     was already broken once — two `color: 'dim'` literals bypassed the theme and leaked
 *     escape sequences into the monochrome theme, which is the one place they must never
 *     appear.
 *  4. `docs/DESIGN.md` is checked against the linter. Every rule the linter can emit must
 *     be documented and every rule documented must exist. Documentation drifts silently;
 *     this is the cheapest way to make it fail loudly instead.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import {
  card,
  cardToSpeech,
  designErrors,
  formatFindings,
  heading,
  lintCard,
  lintTheme,
  prose,
  text,
  type Card,
  type DesignFinding,
} from '@mscomms/core';
import { discussionCard, issueCard, pullCard } from '@mscomms/provider-github';
import { messageCard } from '@mscomms/provider-graph';

import { THEMES } from '../card/theme.js';
import { renderCard } from '../card/render.js';

const here = dirname(fileURLToPath(import.meta.url));
/** dist/test -> dist -> package -> packages -> repo root. */
const repoRoot = join(here, '..', '..', '..', '..');

function read(...parts: readonly string[]): string {
  return readFileSync(join(repoRoot, ...parts), 'utf8');
}

function clean(value: Card, label: string): void {
  const findings = designErrors(value);
  assert.equal(findings.length, 0, `${label}\n${formatFindings(findings)}`);
}

// ---------------------------------------------------------------------------
// Real cards from the built-in providers
// ---------------------------------------------------------------------------

/**
 * A pull request with every awkward property at once.
 *
 * Long labels that will not fit, a reviewer who changed their mind, a body containing a
 * fenced code block, conflicts, and a title long enough to wrap. Cards are easy to get
 * right on tidy input; the rules exist for this one.
 */
const AWKWARD_PULL = pullCard({
  number: 4821,
  title: 'Replace the hand-rolled retry loop with an exponential backoff that respects Retry-After',
  author: 'octocat',
  state: 'open',
  merged: false,
  draft: false,
  repository: 'contoso/platform',
  headRef: 'fix/retry-after',
  baseRef: 'main',
  createdAt: '2024-03-02T09:14:00Z',
  updatedAt: '2024-03-04T17:02:00Z',
  mergeable: false,
  changedFiles: 12,
  additions: 876,
  deletions: 24,
  labels: ['bug', 'needs-triage', 'area/networking-and-transport-layer', 'breaking-change'],
  requestedReviewers: ['alice', 'bob', 'carol'],
  reviews: [
    { author: 'alice', state: 'CHANGES_REQUESTED', submittedAt: '2024-03-03T11:00:00Z' },
    { author: 'alice', state: 'APPROVED', submittedAt: '2024-03-04T08:30:00Z' },
    { author: 'dave', state: 'COMMENTED', submittedAt: '2024-03-03T12:00:00Z' },
  ],
  body: 'Fixes the thundering herd.\n\n```ts\nawait sleep(backoff(attempt));\n```\n\nSee the linked issue.',
  conversation: '## alice\n\nLooks good now.\n\n## dave\n\nWhy not use the platform helper?',
  webUrl: 'https://github.com/contoso/platform/pull/4821',
});

/** The empty end of the range: nothing optional supplied, nothing to say. */
const BARE_PULL = pullCard({
  number: 1,
  title: 'x',
  author: 'octocat',
  state: 'open',
  merged: false,
  repository: 'contoso/platform',
  createdAt: '2024-03-02T09:14:00Z',
  updatedAt: '2024-03-02T09:14:00Z',
  labels: [],
  requestedReviewers: [],
  reviews: [],
  body: '',
  conversation: '',
});

const MERGED_PULL = pullCard({
  ...{
    number: 12,
    title: 'Add the thing',
    author: 'octocat',
    state: 'closed',
    merged: true,
    repository: 'contoso/platform',
    createdAt: '2024-03-02T09:14:00Z',
    updatedAt: '2024-03-05T09:14:00Z',
    labels: ['enhancement'],
    requestedReviewers: [],
    reviews: [{ author: 'alice', state: 'APPROVED', submittedAt: '2024-03-04T08:30:00Z' }],
    body: 'Body.',
    conversation: '',
    additions: 10,
    deletions: 10,
    changedFiles: 2,
  },
});

const CLOSED_ISSUE = issueCard({
  number: 77,
  title: 'Crash when the mailbox is empty',
  author: 'reporter',
  state: 'closed',
  stateReason: 'not_planned',
  repository: 'contoso/platform',
  createdAt: '2024-01-02T09:14:00Z',
  updatedAt: '2024-02-02T09:14:00Z',
  labels: ['bug', 'wontfix'],
  assignees: ['alice', 'bob'],
  milestone: 'v2',
  comments: 14,
  body: 'Steps to reproduce:\n\n1. Empty the mailbox\n2. Open it',
  conversation: '## alice\n\nCannot reproduce.',
  webUrl: 'https://github.com/contoso/platform/issues/77',
});

const OPEN_ISSUE = issueCard({
  number: 78,
  title: 'Support pagination',
  author: 'reporter',
  state: 'open',
  repository: 'contoso/platform',
  createdAt: '2024-01-02T09:14:00Z',
  updatedAt: '2024-02-02T09:14:00Z',
  labels: [],
  assignees: [],
  comments: 0,
  body: '',
  conversation: '',
});

const ANSWERED_DISCUSSION = discussionCard({
  number: 9,
  title: 'How do I mount two accounts at once?',
  author: 'asker',
  category: 'Q&A',
  repository: 'contoso/platform',
  createdAt: '2024-01-02T09:14:00Z',
  upvotes: 12,
  answered: true,
  answeredBy: 'maintainer',
  commentCount: 30,
  shownCount: 10,
  body: 'I have two tenants.',
  conversation: '## maintainer\n\nUse two mounts.',
  webUrl: 'https://github.com/contoso/platform/discussions/9',
});

const UNANSWERED_DISCUSSION = discussionCard({
  number: 10,
  title: 'Roadmap?',
  author: 'asker',
  repository: 'contoso/platform',
  createdAt: '2024-01-02T09:14:00Z',
  answered: false,
  commentCount: 0,
  shownCount: 0,
  body: '',
  conversation: '',
});

const WIDE_MESSAGE = messageCard({
  subject: 'Re: Q3 planning - please read before Thursday',
  from: 'Priya Raman <priya@contoso.com>',
  to: Array.from({ length: 18 }, (_, i) => `person${String(i)}@contoso.com`),
  cc: ['leads@contoso.com'],
  receivedAt: '2024-03-04T17:02:00Z',
  isRead: false,
  isDraft: false,
  importance: 'high',
  flagStatus: 'flagged',
  attachments: [
    { name: 'plan.xlsx', size: 284_113, contentType: 'application/vnd.ms-excel', inline: false },
    { name: 'logo.png', size: 4_113, contentType: 'image/png', inline: true },
  ],
  body: 'Please read the attached before Thursday.\n\n> Original message\n> was indented',
  webUrl: 'https://outlook.office.com/mail/id/abc',
});

const PLAIN_MESSAGE = messageCard({
  subject: '',
  from: 'noreply@example.com',
  to: [],
  cc: [],
  receivedAt: '2024-03-04T17:02:00Z',
  isRead: true,
  isDraft: false,
  importance: 'normal',
  attachments: [],
  body: '',
});

const PROVIDER_CARDS: readonly (readonly [string, Card])[] = [
  ['github pull, awkward', AWKWARD_PULL],
  ['github pull, bare', BARE_PULL],
  ['github pull, merged', MERGED_PULL],
  ['github issue, closed as not planned', CLOSED_ISSUE],
  ['github issue, open and empty', OPEN_ISSUE],
  ['github discussion, answered', ANSWERED_DISCUSSION],
  ['github discussion, unanswered', UNANSWERED_DISCUSSION],
  ['graph message, wide recipients', WIDE_MESSAGE],
  ['graph message, minimal', PLAIN_MESSAGE],
];

describe('provider cards obey the design system', () => {
  for (const [label, value] of PROVIDER_CARDS) {
    it(`${label} lints clean`, () => {
      clean(value, label);
    });
  }

  it('every provider card says something out loud', () => {
    for (const [label, value] of PROVIDER_CARDS) {
      const speech = cardToSpeech(value);
      assert.ok(speech.trim().length > 0, `${label} announces as silence`);
    }
  });

  /**
   * The card is the whole answer, not a caption on one.
   *
   * A card that lints clean but renders to two rows has technically obeyed every rule while
   * losing the content. This is a floor, not a target: the numbers are low enough that only
   * a genuine regression trips them.
   */
  it('every provider card renders to something substantial', () => {
    for (const [label, value] of PROVIDER_CARDS) {
      const rows = renderCard(value, { theme: THEMES.default!, width: 80, color: false });
      assert.ok(rows.length >= 3, `${label} rendered only ${rows.length} rows`);
    }
  });
});

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

describe('themes obey the accessibility contract', () => {
  for (const [name, theme] of Object.entries(THEMES)) {
    it(`${name} lints clean`, () => {
      const findings = lintTheme(theme).filter((f) => f.severity === 'error');
      assert.equal(findings.length, 0, `${name}\n${formatFindings(findings)}`);
    });
  }

  /**
   * The rule the type cannot express.
   *
   * `ToneStyle.mark` being mandatory stops a theme encoding meaning in colour alone. It
   * does not stop a theme giving `good` and `attention` the same mark, which satisfies the
   * type and fails the reader in exactly the case the mark existed to cover.
   */
  it('no theme reuses a status mark', () => {
    for (const [name, theme] of Object.entries(THEMES)) {
      const marks = ['good', 'warning', 'attention'].map((t) => theme.tones[t as 'good'].mark);
      assert.equal(new Set(marks).size, marks.length, `${name} reuses a mark among ${marks.join(' ')}`);
    }
  });
});

// ---------------------------------------------------------------------------
// The linter catches what it claims to
// ---------------------------------------------------------------------------

function ruleNames(findings: readonly DesignFinding[]): readonly string[] {
  return findings.map((f) => f.rule);
}

describe('linter', () => {
  it('rejects an ANSI escape hidden in card text', () => {
    const bad = card([text('\u001b[31mred\u001b[0m')], { title: 'x' });
    assert.ok(ruleNames(designErrors(bad)).includes('no-ansi'));
  });

  it('rejects a tab, which is alignment that breaks at an untested width', () => {
    const bad = card([text('name\tvalue')], { title: 'x' });
    assert.ok(ruleNames(designErrors(bad)).includes('no-tabs'));
  });

  /**
   * The security rule. Cards can arrive from a mail server, so the action URL is untrusted
   * input that happens to be shaped like UI.
   */
  it('rejects an action URL that is not http, https or mailto', () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,<b>', 'JaVaScRiPt:x']) {
      const bad = card([{ type: 'ActionSet', actions: [{ type: 'Action.OpenUrl', title: 'Open', url }] }], {
        title: 'x',
      });
      assert.ok(
        ruleNames(designErrors(bad)).includes('safe-action-url'),
        `${url} was allowed through`,
      );
    }
  });

  it('accepts the schemes a provider actually needs', () => {
    for (const url of ['https://github.com/a/b/pull/1', 'http://localhost:8080/x', 'mailto:a@b.com']) {
      const ok = card([{ type: 'ActionSet', actions: [{ type: 'Action.OpenUrl', title: 'Open', url }] }], {
        title: 'x',
      });
      assert.equal(designErrors(ok).length, 0, url);
    }
  });

  it('rejects a tone carrying meaning on its own', () => {
    const bad = card([{ type: 'BadgeSet', badges: [{ text: '', tone: 'attention' }] }], { title: 'x' });
    assert.ok(ruleNames(designErrors(bad)).includes('tone-needs-text'));
  });

  it('rejects a ragged table, where cells shift into the wrong column', () => {
    const bad = card(
      [
        {
          type: 'Table',
          header: [{ text: 'a' }, { text: 'b' }],
          rows: [[{ text: '1' }, { text: '2' }], [{ text: '3' }]],
        },
      ],
      { title: 'x' },
    );
    assert.ok(ruleNames(designErrors(bad)).includes('table-rows-match'));
  });

  it('rejects a tone that is not in the vocabulary', () => {
    const bad = card([{ ...text('hi'), tone: 'danger' as 'attention' }], { title: 'x' });
    assert.ok(ruleNames(designErrors(bad)).includes('known-tone'));
  });

  it('rejects an unusable constraint', () => {
    const bad = card(
      [{ type: 'Table', columns: [{ kind: 'percent', value: 140 }], rows: [[{ text: 'a' }]] }],
      { title: 'x' },
    );
    assert.ok(ruleNames(designErrors(bad)).includes('sane-constraint'));
  });

  /**
   * `cardToSpeech` never returns silence — it substitutes a stock phrase — so the naive
   * check for an empty string could never fire. The rule has to distinguish "said
   * something" from "said the fallback", which is the case that actually reaches a user.
   */
  it('rejects a card whose elements contribute no speech', () => {
    const bad = card([{ type: 'Prose', text: '' }]);
    assert.ok(ruleNames(designErrors(bad)).includes('speakable'), formatFindings(lintCard(bad)));
  });

  it('accepts a card that only says something through its fallback text', () => {
    const ok = card([text('Sync failed, nothing to show')], { title: 'Inbox' });
    assert.ok(!ruleNames(designErrors(ok)).includes('speakable'));
  });

  /**
   * Prose is the one element where a tab is content rather than a layout mistake: it is a
   * mail body or a code block, and the author's whitespace is the only structure it has.
   */
  it('allows a tab inside prose, where whitespace is content', () => {
    const ok = card([heading('Body'), prose('function f() {\n\treturn 1;\n}')], { title: 'x' });
    assert.equal(designErrors(ok).length, 0, formatFindings(designErrors(ok)));
  });

  it('warns rather than fails on an off-pattern card', () => {
    const odd = card([{ type: 'FactSet', facts: [] }, heading('Something')], { title: 'x' });
    const findings = lintCard(odd);
    assert.equal(findings.filter((f) => f.severity === 'error').length, 0);
    assert.ok(findings.some((f) => f.rule === 'no-empty-element' && f.severity === 'warning'));
  });

  it('reports where the problem is, not just that there is one', () => {
    const bad = card([heading('ok'), text('bad\ttab')], { title: 'x' });
    const finding = designErrors(bad)[0];
    assert.equal(finding?.path, 'body[1].text');
  });
});

// ---------------------------------------------------------------------------
// The renderer's own source
// ---------------------------------------------------------------------------

describe('renderer source', () => {
  /**
   * Colour comes from the theme or it does not come at all.
   *
   * This rule was broken before it was written: two `color: 'dim'` literals in the row
   * builders bypassed the theme entirely, so the monochrome theme emitted escape sequences.
   * `toneRow` is the single sanctioned place a colour is chosen, and it reads the theme.
   */
  it('never hand-writes a colour outside toneRow', () => {
    const source = read('packages', 'cli', 'src', 'card', 'render.ts');
    const offenders = source
      .split('\n')
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => /\bcolor:\s*'/.test(line))
      .filter(([, line]) => !line.includes('toneStyle('));
    assert.equal(
      offenders.length,
      0,
      `hand-written colour at ${offenders.map(([n]) => `render.ts:${String(n)}`).join(', ')}; use toneRow`,
    );
  });

  it('card builders never emit escape sequences', () => {
    const sources = [
      ['packages', 'core', 'src', 'card.ts'],
      ['packages', 'cli', 'src', 'card', 'document.ts'],
      ['packages', 'provider-github', 'src', 'card.ts'],
      ['packages', 'provider-graph', 'src', 'card.ts'],
    ];
    for (const parts of sources) {
      const source = read(...parts);
      assert.ok(
        !/\\u001[bB]|\\x1[bB]|\\033/.test(source),
        `${parts.join('/')} contains an escape sequence; cards carry text, the theme carries colour`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// DESIGN.md against the linter
// ---------------------------------------------------------------------------

/**
 * Documentation drifts silently, which is the only reason it is worth testing.
 *
 * Both directions matter and they fail for different reasons. An undocumented rule is a
 * failure someone will hit without being able to look up what it means. A documented rule
 * that does not exist is worse: it reads as a guarantee and is not one.
 */
describe('DESIGN.md', () => {
  const doc = read('docs', 'DESIGN.md');

  /** Rule names as the linter can actually emit them, gathered from the source. */
  const implemented = new Set(
    [...read('packages', 'core', 'src', 'design.ts').matchAll(/rule:\s*'([a-z-]+)'/g)].map(
      (m) => m[1] as string,
    ),
  );

  /** Rule names the document claims, taken from its `code font` spans. */
  const documented = new Set(
    [...doc.matchAll(/`([a-z]+(?:-[a-z]+)+)`/g)]
      .map((m) => m[1] as string)
      .filter((name) => implemented.has(name) || name.includes('-')),
  );

  it('documents every rule the linter can emit', () => {
    const missing = [...implemented].filter((rule) => !doc.includes(`\`${rule}\``)).sort();
    assert.deepEqual(missing, [], `undocumented rules: ${missing.join(', ')}`);
  });

  it('does not promise a rule that is not implemented', () => {
    // Only names that look like rule names are considered; prose backticks such as
    // `ui.cardTheme` or `docs/DESIGN.md` are excluded by the hyphen-only shape and by this
    // allow-list of identifiers that legitimately look the same.
    const notRules = new Set([
      'not-planned',
      'needs-triage',
      'breaking-change',
      'area-networking',
      'fix-retry-after',
      'no-reply',
    ]);
    const promised = [...documented].filter((name) => !implemented.has(name) && !notRules.has(name));
    assert.deepEqual(promised, [], `documented but unimplemented: ${promised.join(', ')}`);
  });

  it('documents every tone and every theme', () => {
    for (const tone of ['default', 'accent', 'good', 'warning', 'attention', 'subtle']) {
      assert.ok(doc.includes(`\`${tone}\``), `tone ${tone} is not documented`);
    }
    for (const name of Object.keys(THEMES)) {
      assert.ok(doc.includes(`\`${name}\``), `theme ${name} is not documented`);
    }
  });

  it('states the rule a linter cannot check', () => {
    assert.ok(
      doc.includes('never be encoded in `accent` or `subtle` alone'),
      'the status-in-emphasis rule is the one that most needs writing down',
    );
  });
});

// ---------------------------------------------------------------------------
// Regressions found by looking at the output
// ---------------------------------------------------------------------------

/**
 * Both of these were found by rendering a card and reading it, not by a failing assertion.
 * Neither violates any rule the linter can express, which is precisely why they are pinned
 * here: the tone rules and the truncation rules in `docs/DESIGN.md` are judgement calls,
 * and a judgement call that has been got wrong once should be a test.
 */
describe('rendered output', () => {
  it('never puts a failure mark on a message that has not failed', () => {
    const urgent = messageCard({
      subject: 'Please read',
      from: 'a@b.com',
      to: ['c@d.com'],
      cc: [],
      receivedAt: '2024-03-04T17:02:00Z',
      isRead: false,
      isDraft: false,
      importance: 'high',
      flagStatus: 'flagged',
      attachments: [],
      body: 'Body.',
    });
    const rows = renderCard(urgent, { theme: THEMES.mono!, width: 70, color: false });
    const rendered = rows.join('\n');
    assert.ok(rendered.includes('high importance'), rendered);
    assert.ok(!rendered.includes('x high importance'), `urgency marked as failure:\n${rendered}`);
  });

  /**
   * A URL that wraps must reassemble, and must not claim it was truncated.
   *
   * `AWKWARD_PULL` is the card this was found on: at width 40 the web URL rendered as
   * `...platform/pul…` then `/4821`, so it was both marked as truncated when nothing had
   * been dropped and short one character that appeared nowhere. Pasting the link out of the
   * pane is the only reason the pane shows it.
   */
  it('wraps a long URL intact, so it can still be copied out of the pane', () => {
    const url = 'https://github.com/contoso/platform/pull/4821';
    for (const width of [30, 40, 55, 72]) {
      const rows = renderCard(AWKWARD_PULL, { theme: THEMES.default!, width, color: false });
      const joined = rows.map((row) => row.trimEnd()).join('');
      assert.ok(joined.includes(url), `URL not reassemblable at width ${width}:\n${rows.join('\n')}`);
    }
  });
});
