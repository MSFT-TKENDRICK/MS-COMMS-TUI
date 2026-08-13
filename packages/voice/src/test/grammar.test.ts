/**
 * Grammar tests.
 *
 * This is where voice control is actually verified. Everything downstream — the microphone,
 * the transcription service, the confirmation prompt — is plumbing that either works or
 * fails loudly. The grammar is the part that can be subtly, silently wrong: it can hear
 * "archive it" and produce a command for the wrong message, and nothing about that failure
 * announces itself.
 *
 * So the assertions here are mostly about the cases where the right answer is *no answer*.
 * Anyone can make "go to inbox" work. The value is in proving that an ambiguous phrase
 * refuses, that a destructive verb never arrives pre-confirmed, and that a number nobody
 * said is never invented.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { interpret, knownPhrases, normalize, parseSpokenNumber, type VoiceContext } from '../grammar.js';

function context(overrides: Partial<VoiceContext> = {}): VoiceContext {
  return {
    cwd: '/mail/Inbox',
    entries: [
      { index: 1, name: 'Q3 budget review', kind: 'file' },
      { index: 2, name: 'Lunch on Friday', kind: 'file' },
      { index: 3, name: 'Deploy plan', kind: 'file' },
      { index: 4, name: 'Archive', kind: 'directory' },
    ],
    mounts: ['mail', 'github', 'teams'],
    actions: ['read', 'unread', 'flag', 'unflag', 'archive'],
    canUndo: true,
    ...overrides,
  };
}

function commandFor(phrase: string, ctx: VoiceContext = context()): string {
  const result = interpret(phrase, ctx);
  assert.equal(result.ok, true, `expected "${phrase}" to be understood, got: ${result.ok ? '' : result.reason}`);
  return result.ok ? result.command : '';
}

function refusalFor(phrase: string, ctx: VoiceContext = context()): string {
  const result = interpret(phrase, ctx);
  assert.equal(result.ok, false, `expected "${phrase}" to be refused, got: ${result.ok ? result.command : ''}`);
  return result.ok ? '' : result.reason;
}

describe('normalization', () => {
  it('strips punctuation the recognizer added', () => {
    assert.equal(normalize('Go to inbox.'), 'go to inbox');
    assert.equal(normalize('Open three!'), 'open three');
  });

  it('removes politeness without removing meaning', () => {
    assert.equal(normalize('please go to inbox'), 'go to inbox');
    assert.equal(normalize('ok so could you open three please'), 'open three');
  });

  it('repairs mishearings that are not plausible instructions', () => {
    // Nobody navigates to a folder called "in box"; it is always this word.
    assert.equal(normalize('go to the in box'), 'go to the inbox');
    assert.equal(normalize('un do that'), 'undo that');
  });

  it('leaves a phrase it does not recognize alone', () => {
    assert.equal(normalize('bananas'), 'bananas');
  });
});

describe('spoken numbers', () => {
  it('reads digits and words alike', () => {
    assert.equal(parseSpokenNumber('3'), 3);
    assert.equal(parseSpokenNumber('three'), 3);
  });

  it('reads ordinals, because people say "the third one"', () => {
    assert.equal(parseSpokenNumber('third'), 3);
    assert.equal(parseSpokenNumber('3rd'), 3);
  });

  it('returns undefined rather than a guess for a non-number', () => {
    assert.equal(parseSpokenNumber('budget'), undefined);
    assert.equal(parseSpokenNumber(undefined), undefined);
  });
});

describe('navigation', () => {
  it('goes to a mount by name', () => {
    assert.equal(commandFor('go to mail'), 'cd /mail');
  });

  it('enters a directory that is visible in the listing', () => {
    assert.equal(commandFor('go to archive'), 'cd 4');
  });

  it('reads a message rather than trying to enter it', () => {
    // "go to the deploy plan" and "go to the archive" sound identical; only the entry
    // kind tells them apart, and getting it wrong means `cd` on a message.
    assert.equal(commandFor('go to deploy plan'), 'cat 3');
  });

  it('falls through to the shell for a folder that is not on this page', () => {
    // Listings are paged. Refusing to navigate to a real folder that scrolled off would
    // be worse than letting the shell answer, since the shell knows the whole tree.
    assert.equal(commandFor('go to sent'), 'cd sent');
  });

  it('treats "go home" as the root', () => {
    assert.equal(commandFor('go home'), 'cd /');
    assert.equal(commandFor('take me to the top'), 'cd /');
  });

  it('distinguishes back from up, because they are different journeys', () => {
    assert.equal(commandFor('go back'), 'back');
    assert.equal(commandFor('go up'), 'up');
  });

  it('does not let a looser rule swallow a more specific one', () => {
    // "go back" must not be read as "go to <somewhere called back>".
    assert.equal(commandFor('back'), 'back');
  });
});

describe('the broad verbs do not swallow specific phrases', () => {
  // "show me X" and "open X" are broad enough to match almost anything, so every phrase
  // that starts with one of them and means something particular has to win first.
  const specific: ReadonlyArray<readonly [string, string]> = [
    ['show me the unread ones', 'ls --unread'],
    ['show me the details', 'stat'],
    ['show me the actions', 'actions'],
    ['show me the list', 'ls'],
    ['show me the folder', 'ls'],
  ];

  for (const [phrase, expected] of specific) {
    it(`reads "${phrase}" as ${expected}`, () => {
      assert.equal(commandFor(phrase), expected);
    });
  }
});

describe('opening and reading', () => {
  it('opens by position', () => {
    assert.equal(commandFor('open three'), 'cat 3');
    assert.equal(commandFor('read message two'), 'cat 2');
  });

  it('opens by name when exactly one thing matches', () => {
    assert.equal(commandFor('open the budget review'), 'cat 1');
  });

  it('reads the current item when nothing is named', () => {
    assert.equal(commandFor('read it to me'), 'cat');
  });

  it('refuses a position that is not on screen rather than clamping', () => {
    // Clamping to the last item would open a message the user never referred to.
    const reason = refusalFor('open nine');
    assert.match(reason, /no item 9/i);
  });

  it('refuses an ambiguous name and says what it could have meant', () => {
    const ctx = context({
      entries: [
        { index: 1, name: 'Budget review Q3', kind: 'file' },
        { index: 2, name: 'Budget review Q4', kind: 'file' },
      ],
    });
    const reason = refusalFor('open the budget review', ctx);
    assert.match(reason, /matches 2 items/i);
    assert.match(reason, /Q3/);
    assert.match(reason, /Q4/);
  });

  it('refuses a name that matches nothing, and suggests searching for it', () => {
    const result = interpret('open the tax return', context());
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /nothing here matches/i);
      assert.ok(result.suggestions.some((s) => s.includes('search')));
    }
  });
});

describe('actions', () => {
  it('marks read and unread', () => {
    assert.equal(commandFor('mark as read'), 'do read');
    assert.equal(commandFor('mark three as unread'), 'do unread 3');
  });

  it('flags the current item', () => {
    assert.equal(commandFor('flag it'), 'do flag');
  });

  it('never adds --yes to a destructive verb', () => {
    // Voice must not auto-confirm. If the typed command would stop and ask, so must this.
    const command = commandFor('archive it');
    assert.equal(command, 'do archive');
    assert.ok(!command.includes('--yes'));
  });

  it('marks world-changing commands as needing confirmation', () => {
    const result = interpret('archive it', context());
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.mutating, true);
  });

  it('does not ask for confirmation to look at something', () => {
    for (const phrase of ['go to mail', 'list', 'open three', 'read it']) {
      const result = interpret(phrase, context());
      assert.equal(result.ok, true, phrase);
      if (result.ok) assert.equal(result.mutating, false, `${phrase} should not need confirming`);
    }
  });

  it('asks what "mark" means rather than assuming read', () => {
    const reason = refusalFor('mark it');
    assert.match(reason, /mark it as what/i);
  });

  it('refuses a verb this source does not support, and lists what it does', () => {
    const ctx = context({ actions: ['read', 'unread'] });
    const reason = refusalFor('archive it', ctx);
    assert.match(reason, /not something you can do here/i);
    assert.match(reason, /read, unread/);
  });

  it('does not filter by action when the available list is unknown', () => {
    // An empty list means "we have not looked", not "nothing is possible".
    const ctx = context({ actions: [] });
    assert.equal(commandFor('archive it', ctx), 'do archive');
  });
});

describe('search', () => {
  it('turns "from X" into the query syntax rather than a bare word', () => {
    assert.equal(commandFor('find messages from alice'), 'find -q from:alice');
  });

  it('quotes a multi-word search term so it survives tokenizing', () => {
    assert.equal(commandFor('search for budget review'), 'find -q "budget review"');
  });

  it('refuses a search with nothing to search for', () => {
    assert.match(refusalFor('search for'), /did not understand|not what for/i);
  });
});

describe('undo', () => {
  it('understands the ways people ask to take something back', () => {
    for (const phrase of ['undo', 'undo that', 'take that back', 'reverse that']) {
      assert.equal(commandFor(phrase), 'undo', phrase);
    }
  });

  it('says there is nothing to undo instead of running a command that will fail', () => {
    const reason = refusalFor('undo that', context({ canUndo: false }));
    assert.match(reason, /nothing to undo/i);
  });

  it('treats redo as its own verb', () => {
    assert.equal(commandFor('redo'), 'redo');
  });
});

describe('the literal escape hatch', () => {
  it('passes a spoken command line through untouched', () => {
    assert.equal(commandFor('command find -q subject:budget --source mail'), 'find -q subject:budget --source mail');
  });

  it('preserves the punctuation and case that make a command line work', () => {
    // Normalisation strips colons and lowercases everything. Running the escape hatch
    // through it would turn `From:Alice` into `from alice` and silently change the query —
    // which defeats the one feature whose entire promise is "say exactly this".
    assert.equal(commandFor('command find -q From:Alice --json'), 'find -q From:Alice --json');
  });

  it('refuses "command" with nothing after it', () => {
    assert.match(refusalFor('command'), /nothing after it|did not understand/i);
  });
});

describe('refusing well', () => {
  it('returns a refusal, never throws, for nonsense', () => {
    const result = interpret('purple monkey dishwasher', context());
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.suggestions.length > 0, 'a refusal should show a way forward');
  });

  it('handles an empty transcript', () => {
    const result = interpret('   ', context());
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /did not hear/i);
  });

  it('treats "cancel" as a deliberate stop, not a misunderstanding', () => {
    assert.match(refusalFor('never mind'), /cancelled/i);
  });

  it('never produces a command containing a raw newline', () => {
    // A newline in a dispatched line would run a second, unreviewed command.
    for (const phrase of ['search for a\nb', 'command ls\nrm -rf /']) {
      const result = interpret(phrase, context());
      if (result.ok) assert.ok(!result.command.includes('\n'), `${phrase} produced a multi-line command`);
    }
  });
});

describe('the advertised phrase list', () => {
  it('only advertises phrases whose shape the grammar knows', () => {
    // A help screen that lists a phrase the grammar cannot parse is worse than no help
    // screen. Whether a *name* in an example resolves depends on what is on screen, so the
    // assertion is narrower than "it works": no advertised phrase may come back unparsed.
    for (const group of knownPhrases()) {
      for (const example of group.examples) {
        const result = interpret(example, context());
        if (result.ok) continue;
        assert.doesNotMatch(
          result.reason,
          /did not understand/i,
          `advertised phrase "${example}" is not recognised by any rule`,
        );
      }
    }
  });
});
