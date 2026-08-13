/**
 * Turning a {@link Document} into a {@link Card}.
 *
 * WHY THIS EXISTS
 *
 * `Document.card` is optional and has to stay optional. Every provider that shipped before
 * cards existed returns headers and a body, and none of them should have to be rewritten to
 * keep rendering. So the pane never asks "does this provider support cards?" — it asks this
 * module for a card and always gets one.
 *
 * That inverts the usual migration. Instead of a feature that works for providers which
 * opted in, cards are the only path, and opting in means *improving* a rendering that
 * already works rather than switching one on.
 *
 * WHAT A SYNTHESISED CARD KNOWS
 *
 * Less than a hand-written one, necessarily — the structure was flattened into strings
 * before this module was called, and it cannot be recovered in general. What it can do is
 * recognise the conventions the existing providers already follow, and it is careful to
 * only do that where being wrong is harmless. A header whose value looks like a list is
 * shown as a list; if the guess is wrong the reader sees the same words in the same order.
 */

import type { Card, CardElement, Document, Tone } from '@mscomms/core';
import { badges, card, facts, prose } from '@mscomms/core';

/**
 * Header labels whose values are conventionally comma-separated lists.
 *
 * Matched case-insensitively against the label, and only used to *display* the value as
 * chips. Restricted to labels the built-in providers actually emit, because a generic
 * "contains a comma" rule would shred a subject line or an address.
 */
const LIST_HEADERS = new Set([
  'labels',
  'tags',
  'assignees',
  'reviewers',
  'reviewers requested',
  'categories',
  'to',
  'cc',
]);

/**
 * Values that carry a status meaning, and the tone each deserves.
 *
 * Deliberately small and exact-match. A fuzzy rule would tone things it does not
 * understand, and a wrongly-toned status is worse than an untoned one: it is confidently
 * incorrect, and in a monochrome terminal it also prints a misleading mark.
 */
const STATUS_TONES: Readonly<Record<string, Tone>> = {
  open: 'good',
  merged: 'accent',
  closed: 'subtle',
  draft: 'subtle',
  resolved: 'good',
  answered: 'good',
  success: 'good',
  passing: 'good',
  failed: 'attention',
  failing: 'attention',
  error: 'attention',
  blocked: 'attention',
  pending: 'warning',
  'changes requested': 'warning',
  approved: 'good',
  unread: 'accent',
  active: 'good',
  abandoned: 'subtle',
  completed: 'good',
};

/** Labels whose value should be run through {@link STATUS_TONES}. */
const STATUS_HEADERS = new Set(['state', 'status', 'result', 'conclusion', 'mergeable', 'review']);

export function toneForStatus(value: string): Tone | undefined {
  return STATUS_TONES[value.trim().toLowerCase()];
}

/**
 * Build a card for a document that did not supply one.
 *
 * The shape mirrors what `formatDocument` has always produced — title, then facts, then
 * attachments, then body, then the web link — because this is a rendering change and not a
 * redesign of what a document says. A reader should not be able to tell that the pipeline
 * underneath changed.
 */
export function cardFromDocument(doc: Document): Card {
  const elements: CardElement[] = [];

  const headerFacts: { title: string; value: string; tone?: Tone }[] = [];
  for (const [label, value] of doc.headers) {
    if (value.trim() === '') continue;

    const key = label.trim().toLowerCase();

    if (LIST_HEADERS.has(key)) {
      const items = value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '');
      // One item is not a list. Rendering it as a single chip is more visual noise than
      // the fact it replaces.
      if (items.length > 1) {
        elements.push(badges(items.map((item) => ({ text: item })), { label: label.trim(), spacing: 'none' }));
        continue;
      }
    }

    const tone = STATUS_HEADERS.has(key) ? toneForStatus(value) : undefined;
    headerFacts.push({ title: label.trim(), value: value.trim(), ...(tone === undefined ? {} : { tone }) });
  }

  // Facts come first even though badge sets were pushed during the same loop: the facts are
  // the document's identity and a screen reader should reach them before its labels.
  if (headerFacts.length > 0) elements.unshift(facts(headerFacts, { spacing: 'none' }));

  const attachments = doc.attachments ?? [];
  if (attachments.length > 0) {
    elements.push(
      badges(
        attachments.map((attachment) => ({ text: attachment.name })),
        { label: `Attachments (${String(attachments.length)})`, spacing: 'default' },
      ),
    );
  }

  if (doc.body.trim() !== '') {
    elements.push(
      prose(doc.body, {
        format: doc.format === 'markdown' ? 'markdown' : 'text',
        spacing: 'default',
        // A rule between the metadata and the body, which is the one structural boundary
        // in a document that every reader looks for.
        separator: elements.length > 0,
      }),
    );
  }

  if (doc.webUrl !== undefined && doc.webUrl.trim() !== '') {
    elements.push({
      type: 'ActionSet',
      actions: [{ type: 'Action.OpenUrl', title: 'Web link', url: doc.webUrl.trim() }],
      spacing: 'default',
    });
  }

  return card(elements, {
    ...(doc.title.trim() === '' ? {} : { title: doc.title.trim() }),
    fallbackText: doc.title.trim() === '' ? 'Nothing to show.' : doc.title.trim(),
  });
}

/**
 * The card for a document, hand-written if there is one and synthesised otherwise.
 *
 * The single entry point the renderer uses, so no caller has to remember the fallback.
 */
export function documentCard(doc: Document): Card {
  return doc.card ?? cardFromDocument(doc);
}
