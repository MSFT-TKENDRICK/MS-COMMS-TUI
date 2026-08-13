/**
 * Cards for mail — what a message looks like when it is not a pull request.
 *
 * This file exists mostly to be compared with `provider-github/src/card.ts`. Both build a
 * card from a payload; neither picks a colour, a width or a glyph. What differs is the
 * *shape of the answer*, because the questions differ: a pull request is read for whether
 * it can merge and who must act, a message is read for who sent it, who else saw it, and
 * whether it needs a reply. Same renderer, same theme, same eight elements — different
 * card, so a different pane.
 *
 * That is the whole argument for describing panes as data rather than writing a formatter
 * per content type. The provider knows what matters about its own content, and it is the
 * only party that does.
 */

import {
  type Badge,
  type Card,
  type CardElement,
  type Fact,
  type TableCell,
  badges,
  card,
  facts,
  fill,
  len,
  prose,
  text,
} from '@mscomms/core';

/**
 * How a message should be laid out, in the provider's own words.
 *
 * See `Document.presentation`. Written as prose because the reader is a person or a model,
 * and both do better with the reasoning than with a list of rules.
 */
export const MESSAGE_PRESENTATION = `A message is read to answer "is this for me, and does it need something from me". Lead
with the sender and with anything that changes urgency: unread, flagged, high importance,
or the fact that you are on Cc rather than To. Recipients are a list and stay useful as a
list, especially when it is long enough that the reader wants to know how many. Attachments
are a set of named things with sizes, not a sentence. The body is the substance and should
be given the room: it is the only part that cannot be summarised without losing the point.
Quoted reply chains keep their indentation, because re-wrapping a quote destroys the only
signal of who said what.`;

export interface MessageCardInput {
  readonly subject: string;
  readonly from: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly receivedAt: string;
  readonly isRead: boolean;
  readonly isDraft: boolean;
  readonly importance: string;
  readonly flagStatus?: string | undefined;
  readonly attachments: readonly MessageAttachmentSummary[];
  readonly body: string;
  readonly webUrl?: string | undefined;
}

export interface MessageAttachmentSummary {
  readonly name: string;
  readonly size: number;
  readonly contentType: string;
  readonly inline: boolean;
}

/**
 * The badges that change how urgently a message reads.
 *
 * Only states that are *true* get a badge. A read message does not need a "read" badge —
 * it is the absence of a signal, and rendering the absence of signals is how a pane fills
 * with noise that nobody looks at.
 */
function messageBadges(input: MessageCardInput): Badge[] {
  const out: Badge[] = [];
  if (input.isDraft) out.push({ text: 'draft', tone: 'subtle' });
  if (!input.isRead) out.push({ text: 'unread', tone: 'accent' });
  if (input.flagStatus === 'flagged') out.push({ text: 'flagged', tone: 'warning' });
  if (input.flagStatus === 'complete') out.push({ text: 'flag complete', tone: 'good' });
  // `warning`, not `attention`. `attention` renders with a failure mark, and a message
  // marked urgent by its sender has not failed at anything — it is asking to be read first.
  // Rendering it as `x high importance` was the exact tone misuse docs/DESIGN.md warns
  // about: a wrong tone is worse than no tone, because a reader believes it.
  if (input.importance === 'high') out.push({ text: 'high importance', tone: 'warning' });
  if (input.importance === 'low') out.push({ text: 'low importance', tone: 'subtle' });
  if (input.attachments.length > 0) {
    const count = input.attachments.length;
    out.push({ text: `${String(count)} attachment${count === 1 ? '' : 's'}` });
  }
  return out;
}

/**
 * A recipient list, truncated with an honest count rather than an ellipsis.
 *
 * "and 14 others" tells a reader that this went wide, which is often the single most
 * important thing about a message. A bare "…" tells them nothing and looks like a bug.
 */
function recipientValue(list: readonly string[], limit = 3): string {
  if (list.length === 0) return '';
  if (list.length <= limit) return list.join(', ');
  const shown = list.slice(0, limit).join(', ');
  const rest = list.length - limit;
  return `${shown}, and ${String(rest)} other${rest === 1 ? '' : 's'}`;
}

/** `12 KB`. Bytes are not a unit anyone reads a mail attachment in. */
function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : String(Math.round(value))} ${units[unit] ?? 'KB'}`;
}

/**
 * `2024-03-11 08:15Z` — the ISO instant with the seconds and the `T` taken out.
 *
 * Not localised, and deliberately so. The card is built in the provider, which has no
 * access to the session's `dateStyle`, and inventing a second date policy here would mean
 * the pane and the listing could disagree about when something arrived. Seconds are dropped
 * because no one has ever needed them to triage mail; the `Z` stays because a timestamp
 * without a zone is a timestamp that will eventually be read wrong.
 */
function readableTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)}Z`;
}

/**
 * Attachments as a table of names and sizes.
 *
 * Inline attachments are dropped: they are the images embedded in the body, and listing
 * them as though they were documents someone attached on purpose is misleading. They are
 * still reachable through `attachments`, which is the interface for actually saving one.
 */
function attachmentElements(input: MessageCardInput): CardElement[] {
  const real = input.attachments.filter((a) => !a.inline);
  if (real.length === 0) return [];

  const rows = real.map((attachment): TableCell[] => [
    { text: attachment.name },
    { text: humanSize(attachment.size), style: 'subtle' },
  ]);

  return [
    {
      type: 'Container',
      title: 'Attachments',
      separator: true,
      spacing: 'medium',
      items: [
        {
          type: 'Table',
          columns: [fill(1), len(10)],
          rows,
        },
      ],
    },
  ];
}

export function messageCard(input: MessageCardInput): Card {
  const body: CardElement[] = [];

  const flags = messageBadges(input);
  if (flags.length > 0) body.push(badges(flags, { spacing: 'none' }));

  const headerFacts: Fact[] = [{ title: 'From', value: input.from }];
  const to = recipientValue(input.to);
  if (to !== '') headerFacts.push({ title: 'To', value: to });
  const cc = recipientValue(input.cc);
  if (cc !== '') headerFacts.push({ title: 'Cc', value: cc });
  headerFacts.push({ title: 'Received', value: readableTime(input.receivedAt) });
  body.push(facts(headerFacts, { spacing: 'small' }));

  const message = input.body.trim();
  body.push({
    type: 'Container',
    separator: true,
    spacing: 'medium',
    items: [
      message === ''
        ? text('This message has no body.', { style: 'subtle', wrap: true })
        : prose(message, { format: 'text' }),
    ],
  });

  body.push(...attachmentElements(input));

  if (input.webUrl !== undefined && input.webUrl !== '') {
    body.push({
      type: 'ActionSet',
      spacing: 'medium',
      actions: [{ type: 'Action.OpenUrl', title: 'Open in Outlook', url: input.webUrl }],
    });
  }

  return card(body, {
    title: input.subject,
    fallbackText: `Message from ${input.from}: ${input.subject}`,
  });
}
