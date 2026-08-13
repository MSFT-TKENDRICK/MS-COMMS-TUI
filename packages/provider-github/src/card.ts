/**
 * Cards for GitHub items — what a pull request looks like when its structure survives.
 *
 * The provider already knows that a pull request has labels (a set), reviewers (a set),
 * a diffstat (three numbers) and review verdicts (a table of who said what). Until now all
 * of that was flattened into `Document.headers` — `join(', ')` for the sets, a pre-baked
 * `"3 file(s), +120 -40"` string for the diffstat, and reviews concatenated into the body
 * as markdown. The renderer received prose and could only lay it out as prose.
 *
 * A card keeps the structure intact all the way to the pane, which is what lets a pull
 * request look like a pull request rather than like a mail message with different words in
 * it. Nothing here decides how any of it *looks*: no colours, no widths, no glyphs. It
 * says "this is a set of labels" and "this label is a warning", and the theme decides the
 * rest.
 *
 * Every builder here is a pure function of a payload. That is deliberate — it means the
 * interesting rendering decisions are testable without a network, a token, or a terminal.
 */

import {
  type Badge,
  type Card,
  type CardElement,
  type Fact,
  type TableCell,
  type Tone,
  badges,
  card,
  facts,
  fill,
  len,
  prose,
  text,
} from '@mscomms/core';

/**
 * How a reviewer's verdict should read and feel.
 *
 * `CHANGES_REQUESTED` is `warning` rather than `attention` on purpose: requested changes
 * are the process working, not something broken. `attention` is reserved for states that
 * mean a thing has failed.
 */
const REVIEW_TONES: Readonly<Record<string, { readonly verdict: string; readonly tone: Tone }>> = {
  APPROVED: { verdict: 'approved', tone: 'good' },
  CHANGES_REQUESTED: { verdict: 'changes requested', tone: 'warning' },
  COMMENTED: { verdict: 'commented', tone: 'default' },
  DISMISSED: { verdict: 'dismissed', tone: 'subtle' },
};

/**
 * Labels whose names carry a meaning worth showing, matched exactly and case-insensitively.
 *
 * Deliberately a small exact-match table rather than a substring rule. A repository is free
 * to name a label `not-a-bug`, and a fuzzy matcher would tone it as a problem — confidently
 * saying the opposite of what the label means. Anything unrecognised stays neutral, which
 * is the only safe default when the vocabulary belongs to someone else.
 */
const LABEL_TONES: Readonly<Record<string, Tone>> = {
  bug: 'attention',
  regression: 'attention',
  security: 'attention',
  blocked: 'attention',
  breaking: 'warning',
  'breaking-change': 'warning',
  'needs-triage': 'warning',
  'needs triage': 'warning',
  'help wanted': 'accent',
  'good first issue': 'accent',
  enhancement: 'accent',
  feature: 'accent',
  documentation: 'subtle',
  docs: 'subtle',
  chore: 'subtle',
  duplicate: 'subtle',
  wontfix: 'subtle',
  stale: 'subtle',
};

function labelTone(name: string): Tone | undefined {
  return LABEL_TONES[name.trim().toLowerCase()];
}

/** A label as a badge, toned only when its name is one we actually recognise. */
function labelBadge(name: string): Badge {
  const tone = labelTone(name);
  return tone === undefined ? { text: name } : { text: name, tone };
}

/**
 * The plain-text guidance a generative renderer needs to lay a pull request out well.
 *
 * This is `Document.presentation`: not markup and not a template, but the things a provider
 * knows about its own content that no general-purpose renderer could infer. It is prose
 * because the audience is either a human reading the source or a model composing a layout,
 * and both do better with reasons than with directives.
 */
export const PULL_PRESENTATION = `A pull request is read in a fixed order of questions: can it merge, who must act,
what does it change, and only then what does it say. Lead with state and mergeability,
then the review verdicts, then the diffstat, then the description. Labels and requested
reviewers are sets and should stay legible as sets rather than being run together into a
sentence. The diffstat is three separate numbers, not one string: additions and deletions
carry opposite meanings and should not be given the same weight. Review verdicts are the
single most useful thing on the page and must never be scrolled past to reach — put them
above the description however long the conversation is.`;

export const ISSUE_PRESENTATION = `An issue is a conversation with a state. Lead with whether it is open or closed and who
it is assigned to, because those answer "does this need me". Labels are a set and are the
main axis people scan by, so keep them grouped and individually legible. The description
is the substance; comments follow it in time order and should not be reordered or
summarised, because a thread reads as an argument and its sequence is its meaning.`;

export const DISCUSSION_PRESENTATION = `A discussion is a question and its answers. If one comment is marked as the answer, that
fact outranks everything except the question itself and should be visible without
scrolling. Category and upvotes tell a reader how settled the topic is. Replies are nested
under their comment and the nesting must survive being read aloud, so express it in text
rather than in indentation alone.`;

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

export interface PullCardInput {
  readonly number: number;
  readonly title: string;
  readonly author: string;
  readonly state: string;
  readonly merged: boolean;
  readonly draft?: boolean;
  readonly repository: string;
  readonly headRef?: string;
  readonly baseRef?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly mergeable?: boolean | null;
  readonly changedFiles?: number;
  readonly additions?: number;
  readonly deletions?: number;
  readonly labels: readonly string[];
  readonly requestedReviewers: readonly string[];
  readonly reviews: readonly PullReviewSummary[];
  readonly body: string;
  readonly conversation: string;
  readonly webUrl?: string;
}

export interface PullReviewSummary {
  readonly author: string;
  readonly state: string;
  readonly submittedAt?: string | undefined;
}

/**
 * The state of a pull request as one badge.
 *
 * Draft is checked before open because a draft *is* open, and "draft" is the more useful of
 * the two facts: it is the one that tells a reader not to review yet.
 */
function pullStateBadge(input: PullCardInput): Badge {
  if (input.merged) return { text: 'merged', tone: 'accent' };
  if (input.state === 'closed') return { text: 'closed', tone: 'subtle' };
  if (input.draft === true) return { text: 'draft', tone: 'subtle' };
  return { text: 'open', tone: 'good' };
}

/**
 * Mergeability, or an honest statement that GitHub has not worked it out yet.
 *
 * GitHub computes this lazily and returns `null` while it is thinking. Reporting `null` as
 * "not mergeable" would be a lie that costs someone a rebase, so the third state is kept.
 */
function mergeabilityFact(input: PullCardInput): Fact | undefined {
  if (input.merged || input.state !== 'open') return undefined;
  if (input.mergeable === null || input.mergeable === undefined) {
    return { title: 'Mergeable', value: 'being computed' };
  }
  return input.mergeable
    ? { title: 'Mergeable', value: 'yes', tone: 'good' }
    : { title: 'Mergeable', value: 'no, conflicts', tone: 'attention' };
}

/**
 * The diffstat as one line, with a speech override.
 *
 * An earlier version made this a three-cell table with `good` on additions and `attention`
 * on deletions, which was wrong in a way worth recording: deletions are not a failure and
 * additions are not a success. Under the default theme it rendered as `+ +876   x -24`,
 * putting a failure mark on the healthiest thing a pull request can do. A tone has to mean
 * what it says, so the honest answer is that a diffstat has no tone at all — the `+` and
 * `-` signs already carry the only distinction there is.
 *
 * The `speak` override survives from that version, because it is real: "+876 -40" read
 * aloud is an arithmetic expression rather than a diffstat.
 */
function diffstatElements(input: PullCardInput): CardElement[] {
  if (input.changedFiles === undefined) return [];
  const additions = input.additions ?? 0;
  const deletions = input.deletions ?? 0;
  const files = input.changedFiles;

  return [
    text(`${String(files)} file${files === 1 ? '' : 's'} changed, +${String(additions)} -${String(deletions)}`, {
      spacing: 'small',
      speak: `${String(files)} file${files === 1 ? '' : 's'} changed, ${String(additions)} line${additions === 1 ? '' : 's'} added, ${String(deletions)} removed`,
    }),
  ];
}

/**
 * Review verdicts as a table: who, what they said, when.
 *
 * This is the change that matters most. Previously a reviewer's verdict was a sentence
 * inside a markdown blob that also held their entire comment, so finding out whether the
 * PR was approved meant reading the whole conversation. As a table it is one glance, and
 * it sits above the description no matter how long the thread is.
 */
function reviewElements(reviews: readonly PullReviewSummary[]): CardElement[] {
  if (reviews.length === 0) return [];

  // One row per reviewer, latest verdict wins. GitHub keeps every submission, so a reviewer
  // who requested changes and later approved appears twice; showing both would leave the
  // reader to work out which one is current, and the answer is always "the last one".
  const latest = new Map<string, PullReviewSummary>();
  for (const review of reviews) {
    if (review.state.toUpperCase() === 'PENDING') continue;
    latest.set(review.author, review);
  }
  if (latest.size === 0) return [];

  const rows = [...latest.values()].map((review): TableCell[] => {
    const verdict = REVIEW_TONES[review.state.toUpperCase()] ?? { verdict: 'reviewed', tone: 'default' as Tone };
    const when = review.submittedAt === undefined ? '' : shortDate(review.submittedAt);
    return [
      { text: review.author },
      { text: verdict.verdict, ...(verdict.tone === 'default' ? {} : { tone: verdict.tone }) },
      { text: when, style: 'subtle' },
    ];
  });

  return [
    {
      type: 'Container',
      title: 'Reviews',
      separator: true,
      spacing: 'medium',
      items: [
        {
          type: 'Table',
          columns: [fill(2), fill(2), len(10)],
          header: [
            { text: 'Reviewer', style: 'strong' },
            { text: 'Verdict', style: 'strong' },
            { text: 'When', style: 'strong' },
          ],
          rows,
        },
      ],
    },
  ];
}

/** `2024-03-11`, which is short, sorts correctly and is unambiguous in every locale. */
function shortDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : (date.toISOString().slice(0, 10) ?? '');
}

/** Build the card for a pull request. */
export function pullCard(input: PullCardInput): Card {
  const body: CardElement[] = [];

  body.push(
    badges([pullStateBadge(input), ...input.labels.map(labelBadge)], { spacing: 'none' }),
  );

  const headerFacts: Fact[] = [
    { title: 'Author', value: input.author },
    { title: 'Repository', value: input.repository },
  ];
  if (input.headRef !== undefined && input.baseRef !== undefined) {
    headerFacts.push({ title: 'Branch', value: `${input.headRef} into ${input.baseRef}` });
  }
  const mergeable = mergeabilityFact(input);
  if (mergeable !== undefined) headerFacts.push(mergeable);
  headerFacts.push({ title: 'Updated', value: shortDate(input.updatedAt) });
  body.push(facts(headerFacts, { spacing: 'small' }));

  body.push(...diffstatElements(input));

  if (input.requestedReviewers.length > 0) {
    // No tone on the names. Being asked to review is the normal course of events, not a
    // warning, and marking each reviewer `!` said the opposite. The label carries the
    // meaning, which is where it belongs.
    body.push(
      badges(
        input.requestedReviewers.map((login) => ({ text: login })),
        { label: 'Awaiting review from', spacing: 'small' },
      ),
    );
  }

  body.push(...reviewElements(input.reviews));

  const description = input.body.trim();
  body.push({
    type: 'Container',
    title: 'Description',
    separator: true,
    spacing: 'medium',
    items: [
      description === ''
        ? text('No description.', { style: 'subtle', wrap: true })
        : prose(description, { format: 'markdown' }),
    ],
  });

  const conversation = input.conversation.trim();
  if (conversation !== '') {
    body.push({
      type: 'Container',
      title: 'Conversation',
      separator: true,
      spacing: 'medium',
      items: [prose(conversation, { format: 'markdown' })],
    });
  }

  if (input.webUrl !== undefined && input.webUrl !== '') {
    body.push({
      type: 'ActionSet',
      spacing: 'medium',
      actions: [{ type: 'Action.OpenUrl', title: 'Open on GitHub', url: input.webUrl }],
    });
  }

  return card(body, {
    title: `#${String(input.number)} ${input.title}`,
    fallbackText: `Pull request #${String(input.number)}: ${input.title}`,
  });
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

export interface IssueCardInput {
  readonly number: number;
  readonly title: string;
  readonly author: string;
  readonly state: string;
  readonly stateReason?: string | undefined;
  readonly repository: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly labels: readonly string[];
  readonly assignees: readonly string[];
  readonly milestone?: string | undefined;
  readonly comments: number;
  readonly body: string;
  readonly conversation: string;
  readonly webUrl?: string;
}

/**
 * Closed-as-not-planned is a different outcome from closed-as-completed, and GitHub
 * distinguishes them. Collapsing both to "closed" loses the answer to "was this ever
 * fixed?", which is usually the reason someone opened the issue in the first place.
 */
function issueStateBadge(input: IssueCardInput): Badge {
  if (input.state !== 'closed') return { text: 'open', tone: 'good' };
  return input.stateReason === 'not_planned'
    ? { text: 'closed as not planned', tone: 'subtle' }
    : { text: 'closed', tone: 'accent' };
}

export function issueCard(input: IssueCardInput): Card {
  const body: CardElement[] = [];

  body.push(badges([issueStateBadge(input), ...input.labels.map(labelBadge)], { spacing: 'none' }));

  const headerFacts: Fact[] = [
    { title: 'Author', value: input.author },
    { title: 'Repository', value: input.repository },
  ];
  headerFacts.push({
    title: 'Assigned to',
    value: input.assignees.length === 0 ? 'nobody' : input.assignees.join(', '),
    ...(input.assignees.length === 0 ? { tone: 'warning' as Tone } : {}),
  });
  if (input.milestone !== undefined && input.milestone !== '') {
    headerFacts.push({ title: 'Milestone', value: input.milestone });
  }
  headerFacts.push({ title: 'Updated', value: shortDate(input.updatedAt) });
  headerFacts.push({
    title: 'Comments',
    value: input.comments === 0 ? 'none' : String(input.comments),
  });
  body.push(facts(headerFacts, { spacing: 'small' }));

  const description = input.body.trim();
  body.push({
    type: 'Container',
    title: 'Description',
    separator: true,
    spacing: 'medium',
    items: [
      description === ''
        ? text('No description.', { style: 'subtle', wrap: true })
        : prose(description, { format: 'markdown' }),
    ],
  });

  const conversation = input.conversation.trim();
  if (conversation !== '') {
    body.push({
      type: 'Container',
      title: 'Conversation',
      separator: true,
      spacing: 'medium',
      items: [prose(conversation, { format: 'markdown' })],
    });
  }

  if (input.webUrl !== undefined && input.webUrl !== '') {
    body.push({
      type: 'ActionSet',
      spacing: 'medium',
      actions: [{ type: 'Action.OpenUrl', title: 'Open on GitHub', url: input.webUrl }],
    });
  }

  return card(body, {
    title: `#${String(input.number)} ${input.title}`,
    fallbackText: `Issue #${String(input.number)}: ${input.title}`,
  });
}

// ---------------------------------------------------------------------------
// Discussions
// ---------------------------------------------------------------------------

export interface DiscussionCardInput {
  readonly number: number;
  readonly title: string;
  readonly author: string;
  readonly category?: string | undefined;
  readonly repository: string;
  readonly createdAt: string;
  readonly upvotes?: number | undefined;
  readonly answered: boolean;
  readonly answeredBy?: string | undefined;
  readonly commentCount: number;
  readonly shownCount: number;
  readonly body: string;
  readonly conversation: string;
  readonly webUrl?: string;
}

export function discussionCard(input: DiscussionCardInput): Card {
  const body: CardElement[] = [];

  const stateBadges: Badge[] = [
    input.answered ? { text: 'answered', tone: 'good' } : { text: 'unanswered', tone: 'warning' },
  ];
  if (input.category !== undefined && input.category !== '') {
    stateBadges.push({ text: input.category, tone: 'accent' });
  }
  body.push(badges(stateBadges, { spacing: 'none' }));

  const headerFacts: Fact[] = [
    { title: 'Asked by', value: input.author },
    { title: 'Repository', value: input.repository },
  ];
  if (input.answeredBy !== undefined && input.answeredBy !== '') {
    headerFacts.push({ title: 'Answered by', value: input.answeredBy, tone: 'good' });
  }
  if (input.upvotes !== undefined && input.upvotes > 0) {
    headerFacts.push({ title: 'Upvotes', value: String(input.upvotes) });
  }
  headerFacts.push({ title: 'Asked', value: shortDate(input.createdAt) });
  // Say when the thread is truncated. A reader who thinks they have seen the whole
  // conversation and has not is worse off than one who knows there is more.
  headerFacts.push({
    title: 'Comments',
    value:
      input.shownCount < input.commentCount
        ? `${String(input.shownCount)} of ${String(input.commentCount)} shown`
        : input.commentCount === 0
          ? 'none'
          : String(input.commentCount),
    ...(input.shownCount < input.commentCount ? { tone: 'warning' as Tone } : {}),
  });
  body.push(facts(headerFacts, { spacing: 'small' }));

  const question = input.body.trim();
  body.push({
    type: 'Container',
    title: 'Question',
    separator: true,
    spacing: 'medium',
    items: [
      question === ''
        ? text('No description.', { style: 'subtle', wrap: true })
        : prose(question, { format: 'markdown' }),
    ],
  });

  const conversation = input.conversation.trim();
  if (conversation !== '') {
    body.push({
      type: 'Container',
      title: 'Replies',
      separator: true,
      spacing: 'medium',
      items: [prose(conversation, { format: 'markdown' })],
    });
  }

  if (input.webUrl !== undefined && input.webUrl !== '') {
    body.push({
      type: 'ActionSet',
      spacing: 'medium',
      actions: [{ type: 'Action.OpenUrl', title: 'Open on GitHub', url: input.webUrl }],
    });
  }

  return card(body, {
    title: `#${String(input.number)} ${input.title}`,
    fallbackText: `Discussion #${String(input.number)}: ${input.title}`,
  });
}
