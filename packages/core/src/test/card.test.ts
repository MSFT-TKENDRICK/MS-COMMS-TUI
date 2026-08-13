/**
 * Tests for the card model — the vocabulary providers write in.
 *
 * The renderer has its own file. What is checked here is the part that has to be true
 * before any rendering happens: that the helpers drop things that would render as noise,
 * and that every card can be spoken. The speech tests are not a nicety. `announce` mode is
 * the interface for a screen reader, and a card that renders beautifully and speaks as
 * silence is broken in the way that matters most.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CARD_VERSION,
  type Card,
  badges,
  card,
  cardToPlainText,
  cardToSpeech,
  facts,
  fill,
  heading,
  len,
  percent,
  prose,
  text,
} from '../card.js';

describe('card construction', () => {
  it('stamps the version so a stored card can be migrated later', () => {
    assert.equal(card([]).version, CARD_VERSION);
    assert.equal(card([]).type, 'AdaptiveCard');
  });

  it('drops facts with no value, because a label followed by nothing is noise', () => {
    const set = facts([
      { title: 'Author', value: 'octocat' },
      { title: 'Milestone', value: '' },
      { title: 'Assignee', value: '   ' },
    ]);
    assert.deepEqual(
      set.facts.map((f) => f.title),
      ['Author'],
    );
  });

  it('drops empty badges rather than rendering an empty bracket pair', () => {
    const set = badges([{ text: 'bug' }, { text: '' }, { text: '  ' }]);
    assert.deepEqual(
      set.badges.map((b) => b.text),
      ['bug'],
    );
  });

  it('marks a heading as a heading without needing the caller to say so twice', () => {
    assert.equal(heading('Reviews').style, 'heading');
  });

  it('builds the three constraint kinds', () => {
    assert.deepEqual(len(12), { kind: 'length', value: 12 });
    assert.deepEqual(percent(50), { kind: 'percent', value: 50 });
    assert.deepEqual(fill(), { kind: 'fill', weight: 1 });
    assert.deepEqual(fill(3), { kind: 'fill', weight: 3 });
  });
});

describe('cardToSpeech', () => {
  it('says the title first, because it is the answer to "what am I looking at"', () => {
    const spoken = cardToSpeech(card([text('body')], { title: 'Budget review' }));
    assert.ok(spoken.startsWith('Budget review.'), spoken);
  });

  /**
   * A mail body is not one sentence.
   *
   * Whitespace collapsing is right for a label and catastrophic for prose: without this,
   * forty paragraphs arrive as a single unbroken run-on, and the pause at a full stop is
   * the only structural cue speech has left.
   */
  it('keeps a paragraph break in prose, because it is the only pause left', () => {
    const spoken = cardToSpeech(
      card([prose('First paragraph\nwrapped oddly\n\nSecond paragraph')], { title: 'Note' }),
    );
    assert.ok(spoken.includes('First paragraph wrapped oddly.'), spoken);
    assert.ok(spoken.includes('Second paragraph.'), spoken);
  });

  it('never emits a doubled gap, which reads as a hesitation that is not in the text', () => {
    const spoken = cardToSpeech(
      card([text(''), prose(''), text('Real content'), text('   ')], { title: 'Note' }),
    );
    assert.ok(!spoken.includes('  '), JSON.stringify(spoken));
    assert.equal(spoken, 'Note. Real content.');
  });

  it('pairs each fact with its label, so a value is never unattributable', () => {
    const spoken = cardToSpeech(card([facts([{ title: 'From', value: 'dana@contoso.com' }])]));
    assert.ok(spoken.includes('From, dana@contoso.com.'), spoken);
  });

  it('prefers an element speak override to its visible text', () => {
    const spoken = cardToSpeech(card([text('+876 -24', { speak: '876 lines added, 24 removed' })]));
    assert.ok(spoken.includes('876 lines added, 24 removed.'), spoken);
    assert.ok(!spoken.includes('+876'), spoken);
  });

  it('prefers a table speak override to reading the grid cell by cell', () => {
    const spoken = cardToSpeech(
      card([
        {
          type: 'Table',
          rows: [[{ text: '15' }, { text: '+876' }, { text: '-24' }]],
          speak: '15 files changed',
        },
      ]),
    );
    assert.equal(spoken, '15 files changed.');
  });

  it('re-attaches table headers when there is no override, so cells stay labelled', () => {
    const spoken = cardToSpeech(
      card([
        {
          type: 'Table',
          header: [{ text: 'Reviewer' }, { text: 'Verdict' }],
          rows: [[{ text: 'alice' }, { text: 'approved' }]],
        },
      ]),
    );
    assert.ok(spoken.includes('Reviewer, alice, Verdict, approved.'), spoken);
  });

  it('reads columns in order, because side-by-side has no audible equivalent', () => {
    const spoken = cardToSpeech(
      card([
        {
          type: 'ColumnSet',
          columns: [{ items: [text('left')] }, { items: [text('right')] }],
        },
      ]),
    );
    assert.ok(spoken.indexOf('left') < spoken.indexOf('right'), spoken);
  });

  it('announces a container title before its contents', () => {
    const spoken = cardToSpeech(
      card([{ type: 'Container', title: 'Reviews', items: [text('alice approved')] }]),
    );
    assert.ok(spoken.indexOf('Reviews.') < spoken.indexOf('alice approved'), spoken);
  });

  it('treats a run of blank lines as one pause, not four', () => {
    const spoken = cardToSpeech(card([prose('one\n\n\n\ntwo')]));
    assert.equal(spoken, 'one. two.');
  });

  it('never returns silence, even for a card whose elements are all empty', () => {
    const empty = cardToSpeech(card([]));
    assert.notEqual(empty.trim(), '');
  });

  it('falls back to fallbackText before it falls back to "nothing"', () => {
    const spoken = cardToSpeech(card([], { fallbackText: 'Pull request 11' }));
    assert.equal(spoken, 'Pull request 11.');
  });

  it('honours a whole-card override', () => {
    const spoken = cardToSpeech(card([text('ignored')], { title: 'also ignored', speak: 'Just this.' }));
    assert.equal(spoken, 'Just this.');
  });

  it('does not double up terminal punctuation', () => {
    assert.ok(!cardToSpeech(card([text('Done.')])).includes('Done..'));
  });

  /**
   * The one that would catch a real regression: every element type has to contribute
   * something audible. A `switch` that grows a ninth element and forgets a case would
   * render fine and speak nothing, and no other test would notice.
   */
  it('speaks something for every element type', () => {
    const all: Card = card([
      text('a text block'),
      facts([{ title: 'Label', value: 'value' }]),
      badges([{ text: 'a badge' }]),
      { type: 'Table', rows: [[{ text: 'a cell' }]] },
      { type: 'ColumnSet', columns: [{ items: [text('a column')] }] },
      { type: 'Container', items: [text('a container item')] },
      { type: 'ActionSet', actions: [{ type: 'Action.OpenUrl', title: 'a link', url: 'https://x' }] },
      prose('some prose'),
    ]);
    const spoken = cardToSpeech(all);
    for (const fragment of [
      'a text block',
      'Label, value',
      'a badge',
      'a cell',
      'a column',
      'a container item',
      'a link',
      'some prose',
    ]) {
      assert.ok(spoken.includes(fragment), `${fragment} was not spoken: ${spoken}`);
    }
  });
});

describe('cardToPlainText', () => {
  it('emits no alignment padding, because other programs parse this', () => {
    const flat = cardToPlainText(
      card([facts([{ title: 'From', value: 'dana' }])], { title: 'Subject' }),
    );
    for (const line of flat.split('\n')) {
      assert.equal(line, line.trimEnd(), `trailing whitespace in ${JSON.stringify(line)}`);
    }
  });

  it('contains no ANSI escapes', () => {
    const flat = cardToPlainText(card([text('hello'), badges([{ text: 'bug', tone: 'attention' }])]));
    // eslint-disable-next-line no-control-regex
    assert.ok(!/\u001B/.test(flat));
  });
});
