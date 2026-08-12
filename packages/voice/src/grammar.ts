/**
 * Turning what somebody said into a command line.
 *
 * This file is deliberately pure: a string and a snapshot of context go in, a command line
 * comes out. Nothing here records audio, calls a model, or touches the session. That is not
 * tidiness for its own sake — it is the only way the interesting part of voice control is
 * testable. Microphones and cloud endpoints are hard to write assertions about; "given the
 * user said 'open the third one', we produce `cat 3`" is easy, and that is where every real
 * bug in a speech interface lives.
 *
 * The output is a *command line*, not a function call. That is the load-bearing decision.
 * Voice does not get its own code path into the VFS: it produces text that goes through the
 * exact same `dispatch` a typed line goes through, which means it inherits confirmation
 * prompts, the journal, undo, and the audit log for free, and can never drift from what the
 * keyboard can do. It also means every spoken action is reviewable after the fact as a line
 * you could have typed yourself, which matters a great deal in a program that reads and
 * mutates corporate mail.
 *
 * Three rules shape the grammar:
 *
 * 1. Refuse rather than guess. Speech recognition is probabilistic; acting on a coin flip in
 *    a mailbox is how somebody archives the wrong thread. When a phrase is ambiguous we
 *    return a refusal that names the candidates, and the caller asks. A refusal the user can
 *    resolve in one word is far better than a confident mistake they have to notice first.
 *
 * 2. Never silently escalate. Destructive verbs are translated to the same command a typed
 *    user would get — without `--yes`. Voice never auto-confirms. If the shell would stop and
 *    ask, it still stops and asks.
 *
 * 3. Speech is not typing. Transcripts arrive lowercase, unpunctuated, with numbers as words,
 *    and with predictable mishearings ("in box", "un do", "cat" for "cad"). Normalising those
 *    is not a hack; it is the actual problem. The alternative — making users enunciate command
 *    syntax — produces an interface nobody uses twice.
 */

/** What the grammar knows about the world when it interprets a phrase. */
export interface VoiceContext {
  /** Current folder, so refusals and confirmations can say where they would act. */
  readonly cwd: string;
  /** The visible listing, so "open the budget one" can become a number. */
  readonly entries: readonly VoiceEntry[];
  /** Mount names, so "go to github" resolves without the user spelling a path. */
  readonly mounts: readonly string[];
  /** Action names available at the cursor, so "flag it" is only offered when flagging works. */
  readonly actions: readonly string[];
  /** Whether anything is currently undoable, so "undo that" can be refused kindly. */
  readonly canUndo?: boolean;
}

export interface VoiceEntry {
  /** 1-based position in the listing, which is what the user reads aloud. */
  readonly index: number;
  /** The name as shown; matched against loosely. */
  readonly name: string;
  /**
   * Whether this entry can be entered or only read.
   *
   * "Open the budget review" and "open the archive folder" are the same sentence to a
   * listener and different commands to the shell. Without this, the grammar has to guess,
   * and guessing wrong means `cd` on a message — an error the user did not cause and
   * cannot interpret. Optional because a caller that does not know should not have to lie.
   */
  readonly kind?: 'directory' | 'file';
}

export type Interpretation = InterpretationOk | InterpretationRefused;

export interface InterpretationOk {
  readonly ok: true;
  /** The command line to dispatch, exactly as if typed. */
  readonly command: string;
  /** What the grammar believes the user asked for, in plain words, for confirmation prompts. */
  readonly intent: string;
  /** The rule that matched, for `voice test` and for debugging a phrase that went wrong. */
  readonly rule: string;
  /** True when the command changes the world and should be confirmed before running. */
  readonly mutating: boolean;
}

export interface InterpretationRefused {
  readonly ok: false;
  /** Why we would not act, phrased for a person, not a parser. */
  readonly reason: string;
  /** Phrases that would have worked, when we can name them. */
  readonly suggestions: readonly string[];
}

const NUMBER_WORDS: ReadonlyMap<string, number> = new Map([
  ['zero', 0], ['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5],
  ['six', 6], ['seven', 7], ['eight', 8], ['nine', 9], ['ten', 10],
  ['eleven', 11], ['twelve', 12], ['thirteen', 13], ['fourteen', 14], ['fifteen', 15],
  ['sixteen', 16], ['seventeen', 17], ['eighteen', 18], ['nineteen', 19], ['twenty', 20],
  // Ordinals, because people say "the third one" far more often than "item three".
  ['first', 1], ['second', 2], ['third', 3], ['fourth', 4], ['fifth', 5],
  ['sixth', 6], ['seventh', 7], ['eighth', 8], ['ninth', 9], ['tenth', 10],
  // Homophones and near-misses that speech models produce constantly.
  ['won', 1], ['too', 2], ['to', 2], ['for', 4], ['ate', 8],
]);

/**
 * Mishearings common enough to be worth correcting outright.
 *
 * Every entry here was chosen because the wrong reading is not a plausible thing to say in
 * this program: nobody navigates to a folder called "in box". Where a mishearing *could* be
 * legitimate — "to" for "two" — it is handled in number parsing instead, under a rule that
 * only fires where a number is expected, rather than rewritten globally.
 */
const PHRASE_FIXUPS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bin box\b/g, 'inbox'],
  [/\bin-box\b/g, 'inbox'],
  [/\bsent items?\b/g, 'sent'],
  [/\be[- ]?mails?\b/g, 'mail'],
  [/\bun[- ]do\b/g, 'undo'],
  [/\bre[- ]do\b/g, 'redo'],
  [/\bun[- ]read\b/g, 'unread'],
  [/\bgit hub\b/g, 'github'],
  [/\bazure devops\b/g, 'ado'],
  [/\bteams? chat\b/g, 'teams'],
  [/\bar chive\b/g, 'archive'],
];

/** Politeness and filler that carries no instruction. Stripped so rules stay readable. */
const FILLER =
  /^(?:(?:um|uh|er|ok|okay|so|now|please|hey|computer|assistant|could you|can you|would you|i want to|i'd like to|let's|lets)\s+)+/;

const TRAILING_FILLER = /\s+(?:please|thanks|thank you|now|for me)$/;

/** Normalise a raw transcript into something the rules can match against. */
export function normalize(transcript: string): string {
  let text = transcript.toLowerCase().trim();
  // Speech models punctuate; command grammars do not care. Keep apostrophes and hyphens.
  text = text.replace(/[.,!?;:"“”]+/g, ' ');
  text = text.replace(/\s+/g, ' ').trim();
  for (const [pattern, replacement] of PHRASE_FIXUPS) text = text.replace(pattern, replacement);
  let previous = '';
  // Filler stacks ("ok so please open three"), so strip until it stops shrinking.
  while (text !== previous) {
    previous = text;
    text = text.replace(FILLER, '').replace(TRAILING_FILLER, '').trim();
  }
  return text;
}

/** Read a spoken number, whether it arrived as a word or as digits. */
export function parseSpokenNumber(token: string | undefined): number | undefined {
  if (token === undefined) return undefined;
  const trimmed = token.trim();
  // Strip the suffix only when it trails digits. Applying it to words turns "third" into
  // "thi", which is exactly the ordinal the rule was written to support.
  const cleaned = trimmed.replace(/^(\d+)(?:st|nd|rd|th)$/, '$1');
  if (/^\d+$/.test(cleaned)) {
    const value = Number.parseInt(cleaned, 10);
    return Number.isSafeInteger(value) ? value : undefined;
  }
  return NUMBER_WORDS.get(cleaned);
}

/** Quote a value so it survives the round trip back through `tokenize`. */
function quote(value: string): string {
  if (value === '') return '""';
  if (!/[\s"'\\]/.test(value)) return value;
  return `"${value.replace(/(["\\])/g, '\\$1')}"`;
}

const STOPWORDS = new Set(['the', 'a', 'an', 'that', 'this', 'it', 'one', 'item', 'message', 'thing']);

function significantWords(phrase: string): string[] {
  return phrase
    .split(/\s+/)
    .map((word) => word.replace(/[^a-z0-9]/g, ''))
    .filter((word) => word !== '' && !STOPWORDS.has(word));
}

type Resolution =
  | { readonly ok: true; readonly value: string; readonly label: string; readonly entry?: VoiceEntry }
  | { readonly ok: false; readonly reason: string; readonly suggestions: readonly string[] };

/**
 * Turn a spoken reference into something the shell can address.
 *
 * People refer to a listing three ways: by position ("the third one"), by name ("the budget
 * thread"), and by a name they only half-remember. The first is exact, the second is usually
 * exact, and the third is where a voice interface either earns trust or loses it. Partial
 * matches are accepted only when exactly one entry matches; when several do, we name them and
 * refuse. Picking the first would be right most of the time, and the times it was wrong would
 * be the times somebody archived a message they had never read.
 */
function resolveReference(phrase: string, context: VoiceContext): Resolution {
  const trimmed = phrase.trim();
  if (trimmed === '') {
    return { ok: false, reason: 'I did not catch which item you meant.', suggestions: ['open three', 'open the budget one'] };
  }

  const numeric = parseSpokenNumber(trimmed.replace(/^(?:number|item|message|the)\s+/, '').replace(/\s+one$/, ''));
  if (numeric !== undefined) {
    const entry = context.entries.find((candidate) => candidate.index === numeric);
    if (entry === undefined && context.entries.length > 0) {
      return {
        ok: false,
        reason: `There is no item ${numeric} here — this folder has ${context.entries.length}.`,
        suggestions: ['list'],
      };
    }
    return { ok: true, value: String(numeric), label: entry?.name ?? `item ${numeric}`, ...(entry === undefined ? {} : { entry }) };
  }

  const words = significantWords(trimmed);
  if (words.length === 0) {
    return { ok: false, reason: 'I did not catch which item you meant.', suggestions: ['open three'] };
  }
  const needle = words.join(' ');

  const scored = context.entries
    .map((entry) => {
      const haystack = entry.name.toLowerCase();
      const compact = significantWords(haystack).join(' ');
      if (compact === needle || haystack === needle) return { entry, rank: 0 };
      if (compact.startsWith(needle) || haystack.startsWith(needle)) return { entry, rank: 1 };
      if (words.every((word) => haystack.includes(word))) return { entry, rank: 2 };
      return undefined;
    })
    .filter((hit): hit is { entry: VoiceEntry; rank: number } => hit !== undefined)
    .sort((left, right) => left.rank - right.rank);

  if (scored.length === 0) {
    return {
      ok: false,
      reason: `Nothing here matches "${trimmed}".`,
      suggestions: context.entries.length > 0 ? ['list', `search for ${trimmed}`] : ['list'],
    };
  }

  const best = scored[0]!;
  const tied = scored.filter((hit) => hit.rank === best.rank);
  if (tied.length > 1) {
    const names = tied.slice(0, 4).map((hit) => `${hit.entry.index}. ${hit.entry.name}`);
    return {
      ok: false,
      reason: `"${trimmed}" matches ${tied.length} items. Which one? ${names.join('; ')}`,
      suggestions: tied.slice(0, 3).map((hit) => `open ${hit.entry.index}`),
    };
  }
  return { ok: true, value: String(best.entry.index), label: best.entry.name, entry: best.entry };
}

/**
 * Resolve a folder reference for the navigational verbs.
 *
 * Kept separate from `resolveReference` because "go to sent" and "archive sent" are asking
 * different questions. Navigation may legitimately name something that is not on the current
 * page — listings are paged, and refusing to `cd` into a folder that exists but scrolled off
 * would be maddening — so it ends in a pass-through to the shell, whose error message knows
 * the tree and ours does not. Acting on something has no such excuse and must resolve exactly.
 */
function resolveFolder(phrase: string, context: VoiceContext): Resolution {
  const trimmed = phrase.trim().replace(/^(?:the|my)\s+/, '');
  if (/^(?:home|root|top|the top|the beginning)$/.test(trimmed)) {
    return { ok: true, value: '/', label: 'the root' };
  }
  if (trimmed === '') {
    return { ok: false, reason: 'I did not catch where you wanted to go.', suggestions: ['go to inbox'] };
  }

  const words = significantWords(trimmed);
  const needle = words.join(' ');
  const mount = context.mounts.find((name) => name.toLowerCase() === needle);
  if (mount !== undefined) return { ok: true, value: `/${mount}`, label: `/${mount}` };

  const resolved = resolveReference(trimmed, context);
  if (resolved.ok) return resolved;

  // Not in this folder and not a mount — but a slash-free name is still a legal relative
  // path, and the shell's own error is more useful than ours because it knows the tree.
  if (/^[a-z0-9 _-]+$/.test(trimmed)) {
    return { ok: true, value: trimmed.replace(/\s+/g, ' '), label: trimmed };
  }
  return resolved;
}

/**
 * Build the command for a verb that means "put this in front of me".
 *
 * `open`, `go to` and `show me` all land here, because a listener cannot tell them apart and
 * neither should the grammar. What decides the command is the *thing*, not the verb: a
 * directory is entered, everything else is read. `allowPath` is the one real difference —
 * the navigational verbs may name an off-page folder and hand the miss to the shell, while
 * `open` refers to something the speaker believes is on screen, so a miss is worth refusing.
 */
function openish(phrase: string, context: VoiceContext, allowPath: boolean): Interpretation {
  const cleaned = phrase.trim().replace(/^(?:the|my)\s+/, '').trim();
  if (cleaned === '') {
    return refuse('I did not catch what you wanted to open.', ['open three', 'go to inbox']);
  }
  if (/^(?:home|root|top|the top|the beginning)$/.test(cleaned)) {
    return ok('cd /', 'go to the root', 'goto');
  }

  const asEntry = (value: string, label: string, entry: VoiceEntry | undefined): InterpretationOk =>
    // Unknown kind reads rather than enters: `cat` on a directory is a listing, while `cd`
    // on a message is an error, so the safe default is the one that degrades gracefully.
    entry?.kind === 'directory'
      ? ok(`cd ${value}`, `go to ${label}`, 'goto')
      : ok(`cat ${value}`, `open ${label}`, 'goto');

  const numeric = parseSpokenNumber(cleaned.replace(/^(?:number|item|message)\s+/, ''));
  if (numeric !== undefined) {
    return fromResolution(resolveReference(cleaned, context), asEntry);
  }

  const resolution = allowPath ? resolveFolder(cleaned, context) : resolveReference(cleaned, context);
  if (!resolution.ok) return refuse(resolution.reason, resolution.suggestions);
  // A path or mount came back with no entry behind it; those are always directories.
  if (resolution.entry === undefined && allowPath) {
    return ok(`cd ${quote(resolution.value)}`, `go to ${resolution.label}`, 'goto');
  }
  return asEntry(resolution.value, resolution.label, resolution.entry);
}

/** Verbs the user can say, mapped to the action names providers actually publish. */
const ACTION_SYNONYMS: ReadonlyMap<string, string> = new Map([
  ['read', 'read'], ['mark as read', 'read'], ['mark read', 'read'], ['mark it read', 'read'],
  ['unread', 'unread'], ['mark as unread', 'unread'], ['mark unread', 'unread'],
  ['flag', 'flag'], ['flag it', 'flag'], ['star', 'flag'], ['pin', 'flag'],
  ['unflag', 'unflag'], ['clear the flag', 'unflag'], ['unstar', 'unflag'],
  ['archive', 'archive'], ['file it', 'archive'],
  ['delete', 'delete'], ['trash', 'delete'], ['bin it', 'delete'],
  ['reply', 'reply'], ['forward', 'forward'],
  ['close', 'close'], ['reopen', 'reopen'], ['merge', 'merge'], ['approve', 'approve'],
  ['open in browser', 'open'], ['open externally', 'open'],
]);

/** Verbs that change something. Used to decide whether to confirm before running. */
const MUTATING_ACTIONS = new Set([
  'read', 'unread', 'flag', 'unflag', 'untag', 'tag', 'archive', 'delete',
  'reply', 'forward', 'close', 'reopen', 'merge', 'approve', 'send',
]);

interface Rule {
  readonly name: string;
  readonly pattern: RegExp;
  readonly build: (match: RegExpMatchArray, context: VoiceContext) => Interpretation;
}

function ok(command: string, intent: string, rule: string, mutating = false): InterpretationOk {
  return { ok: true, command, intent, rule, mutating };
}

function refuse(reason: string, suggestions: readonly string[] = []): InterpretationRefused {
  return { ok: false, reason, suggestions };
}

function fromResolution(
  resolution: Resolution,
  build: (value: string, label: string, entry: VoiceEntry | undefined) => InterpretationOk,
): Interpretation {
  return resolution.ok
    ? build(resolution.value, resolution.label, resolution.entry)
    : refuse(resolution.reason, resolution.suggestions);
}

/**
 * The rule table, in priority order.
 *
 * Order matters and is not alphabetical: the most specific phrasings come first, so that
 * "go back" is not eaten by the looser "go to <somewhere>" rule. Each rule anchors both ends
 * of the phrase. A partial match would let "delete everything and go to inbox" navigate,
 * which is exactly the sort of half-understood instruction that must be refused instead.
 */
const RULES: readonly Rule[] = [
  // --- Escape hatch: say the command verbatim. ---------------------------------------
  // Handled ahead of normalisation in `interpret`, so this entry only catches phrasings
  // that reached the table some other way. Kept here so the table stays a full inventory.
  {
    name: 'literal',
    pattern: /^(?:command|run|execute|literally)\s+(.+)$/,
    build: (match) => {
      const line = (match[1] ?? '').trim();
      if (line === '') return refuse('I heard "command" but nothing after it.');
      return ok(line, `run \`${line}\``, 'literal', true);
    },
  },

  // --- Voice control itself. ---------------------------------------------------------
  {
    name: 'voice-off',
    pattern: /^(?:stop listening|stop the mic(?:rophone)?|mic(?:rophone)? off|voice off|go to sleep|that's all)$/,
    build: () => ok('voice off', 'stop listening', 'voice-off'),
  },
  {
    name: 'voice-help',
    pattern: /^(?:what can i say|voice help|help with voice|what are the voice commands)$/,
    build: () => ok('voice help', 'list the phrases voice understands', 'voice-help'),
  },
  {
    name: 'cancel',
    pattern: /^(?:cancel|never mind|nevermind|forget it|stop|scratch that)$/,
    build: () => refuse('Cancelled — nothing was run.'),
  },

  // --- Undo and redo. ----------------------------------------------------------------
  {
    name: 'undo',
    pattern: /^(?:undo(?: that| it| the last(?: one| thing| change)?)?|take that back|reverse that|put it back)$/,
    build: (_match, context) =>
      context.canUndo === false
        ? refuse('There is nothing to undo yet.')
        : ok('undo', 'undo the last change', 'undo', true),
  },
  {
    name: 'redo',
    pattern: /^(?:redo(?: that| it)?|do it again|put it back again)$/,
    build: () => ok('redo', 'redo the change you just undid', 'redo', true),
  },
  {
    name: 'history',
    pattern: /^(?:(?:show|what's|what is|read)(?: me)? (?:the )?history|what have i done|what did i just do)$/,
    build: () => ok('history', 'show what has happened this session', 'history'),
  },

  // --- Navigation. -------------------------------------------------------------------
  {
    name: 'back',
    pattern: /^(?:go back|back|previous folder|take me back)$/,
    build: () => ok('back', 'go back to the previous folder', 'back'),
  },
  {
    name: 'up',
    pattern: /^(?:(?:go |move )?up(?: a level| one level| a folder)?|parent(?: folder)?|out of here)$/,
    build: () => ok('up', 'go up one level', 'up'),
  },
  {
    name: 'home',
    pattern: /^(?:(?:go|take me) (?:home|to the (?:root|top|beginning))|home|start over)$/,
    build: () => ok('cd /', 'go to the root', 'home'),
  },

  // --- Listing and paging. -----------------------------------------------------------
  {
    name: 'list',
    pattern:
      /^(?:list|list (?:it|them|this|everything)|show (?:me )?(?:the )?(?:list|folder|contents)|what(?:'s| is) (?:here|in here|in this folder)|where am i)$/,
    build: (match) => {
      const said = match[0];
      if (said === 'where am i') return ok('pwd', 'say where you are', 'list');
      return ok('ls', 'list this folder', 'list');
    },
  },
  {
    name: 'list-unread',
    pattern: /^(?:(?:show|list)(?: me)? (?:the )?unread(?: ones| messages| items)?|what(?:'s| is) unread)$/,
    build: () => ok('ls --unread', 'list only the unread items', 'list-unread'),
  },
  {
    name: 'more',
    pattern: /^(?:more|next page|show more|keep going|continue|next)$/,
    build: () => ok('more', 'show the next page', 'more'),
  },

  // --- Reading. ----------------------------------------------------------------------
  // `read-current` precedes `read-item` deliberately: "read it to me" is a complete
  // instruction, and the item rule would otherwise capture "it" as a name and refuse.
  {
    name: 'read-current',
    pattern: /^(?:read(?: it| this| that)?(?: to me| out loud| aloud)?|what does it say|read the message)$/,
    build: () => ok('cat', 'read the current item', 'read-current'),
  },
  {
    name: 'read-item',
    pattern: /^read(?: me)?\s+(?:the\s+)?(?:message|item|email|number)?\s*(.+?)(?:\s+(?:to me|out loud|aloud))?$/,
    build: (match, context) =>
      fromResolution(resolveReference(match[1] ?? '', context), (value, label) =>
        ok(`cat ${value}`, `read ${label}`, 'read-item'),
      ),
  },
  {
    name: 'details',
    pattern: /^(?:(?:show|tell me)(?: me)? (?:the )?details|details|stat|more info(?:rmation)?|who(?:'s| is) it from)$/,
    build: () => ok('stat', 'show the details of the current item', 'details'),
  },
  {
    name: 'what-can-i-do',
    pattern: /^(?:what can i do(?: with (?:this|it))?|(?:show|list)(?: me)? (?:the )?actions|options)$/,
    build: () => ok('actions', 'list the actions available here', 'what-can-i-do'),
  },

  // --- Opening and navigating. -------------------------------------------------------
  // These sit below the rules above on purpose. Both verbs are broad enough to capture
  // "show me the unread ones" or "show me the details", so every phrase that starts with
  // one of these words and means something specific has to be recognised first.
  {
    name: 'open',
    pattern: /^(?:open|show(?: me)?)\s+(?:the\s+)?(.+?)(?:\s+folder)?$/,
    build: (match, context) => openish(match[1] ?? '', context, false),
  },
  {
    name: 'goto',
    pattern: /^(?:go to|switch to|navigate to|take me to|jump to)\s+(?:the\s+)?(.+?)(?:\s+folder)?$/,
    build: (match, context) => openish(match[1] ?? '', context, true),
  },

  // --- Search. -----------------------------------------------------------------------
  {
    name: 'search-from',
    pattern: /^(?:search|find|look) (?:for )?(?:messages |mail |emails? |anything )?from\s+(.+)$/,
    build: (match) => {
      const who = (match[1] ?? '').trim();
      if (who === '') return refuse('I heard "from" but not who from.');
      return ok(`find -q ${quote(`from:${who}`)}`, `search for mail from ${who}`, 'search-from');
    },
  },
  {
    name: 'search-unread',
    pattern: /^(?:search|find) (?:all )?unread(?: messages| mail| items)?$/,
    build: () => ok('find -q is:unread', 'search for unread mail', 'search-unread'),
  },
  {
    name: 'search',
    pattern: /^(?:search|find|look)(?: for| up)?\s+(.+)$/,
    build: (match) => {
      const term = (match[1] ?? '')
        .trim()
        .replace(/^(?:for|up)\s+/, '')
        .replace(/^(?:everything|anything|all)\s+/, '');
      // "search for" with nothing after it comes through here as the word "for" itself,
      // because the optional group in the pattern gave it back rather than fail to match.
      if (term === '' || term === 'for' || term === 'up') {
        return refuse('I heard "search" but not what for.', ['search for budget', 'find messages from alice']);
      }
      return ok(`find -q ${quote(term)}`, `search for "${term}"`, 'search');
    },
  },

  // --- Actions with an explicit target. ----------------------------------------------
  {
    name: 'action-on',
    pattern:
      /^(?:mark|flag|star|archive|delete|trash|unflag|unstar|close|reopen|approve|merge|reply to|forward)\b\s*(.*)$/,
    build: (match, context) => {
      const whole = match[0];
      const rest = (match[1] ?? '').trim();
      const verbWord = whole.split(/\s+/)[0] ?? '';

      // "mark" needs a state; the others carry their own.
      let action: string | undefined;
      let targetPhrase = rest;
      if (verbWord === 'mark') {
        const stateMatch = /(?:^|\s)(?:as\s+)?(read|unread|done|complete|completed)\s*$/.exec(rest);
        if (stateMatch === null) {
          return refuse('Mark it as what? Say "mark as read" or "mark as unread".', [
            'mark as read',
            'mark three as unread',
          ]);
        }
        const state = stateMatch[1] ?? 'read';
        action = state === 'unread' ? 'unread' : 'read';
        targetPhrase = rest.slice(0, stateMatch.index).trim();
      } else {
        action =
          ACTION_SYNONYMS.get(whole.trim()) ??
          ACTION_SYNONYMS.get(verbWord) ??
          (verbWord === 'reply' ? 'reply' : verbWord);
        targetPhrase = rest.replace(/^(?:it|this|that|them)$/, '').trim();
      }

      if (action === undefined) return refuse(`I do not know how to "${verbWord}" something.`);

      // Only offer verbs the provider actually publishes here. Producing `do archive` for a
      // source with no archive is a worse experience than being told plainly it cannot.
      if (context.actions.length > 0 && !context.actions.includes(action)) {
        return refuse(
          `"${action}" is not something you can do here. Available: ${context.actions.join(', ')}.`,
          context.actions.slice(0, 3).map((name) => `${name} it`),
        );
      }

      const mutating = MUTATING_ACTIONS.has(action);
      if (targetPhrase === '') {
        return ok(`do ${action}`, `${action} the current item`, 'action-on', mutating);
      }
      return fromResolution(resolveReference(targetPhrase, context), (value, label) =>
        ok(`do ${action} ${value}`, `${action} ${label}`, 'action-on', mutating),
      );
    },
  },

  // --- Refresh, watch, quit. ---------------------------------------------------------
  {
    name: 'refresh',
    pattern: /^(?:refresh|reload|update|check(?: for)? (?:new )?(?:mail|messages)|any(?:thing)? new)$/,
    build: () => ok('refresh', 'check for new items', 'refresh'),
  },
  {
    name: 'quit',
    pattern: /^(?:quit|exit|close the app|log out|goodbye|bye)$/,
    build: () => ok('quit', 'quit', 'quit'),
  },
];

/**
 * Interpret a transcript.
 *
 * Returns either a command line to dispatch or a refusal that explains itself. It never
 * throws: a speech interface that crashes on an odd phrase is worse than useless, because the
 * user has no way to see what they did wrong.
 */
export function interpret(transcript: string, context: VoiceContext): Interpretation {
  // The literal escape hatch is checked against the raw transcript, before normalisation.
  // Normalising would defeat its entire purpose: `subject:budget` would lose its colon and
  // `From:Alice` its capital, and a user who reached for the escape hatch did so precisely
  // because they wanted the shell to see exactly what they said.
  const raw = transcript.trim().replace(/[.!?]+$/, '');
  const literal = /^(?:command|run|execute|literally)\s+(.+)$/i.exec(raw);
  if (literal !== null) {
    // A transcript should never contain a newline, but a recogniser is free to emit one, and
    // a newline in a dispatched line would run a second command nobody reviewed.
    const line = (literal[1] ?? '').replace(/\s+/g, ' ').trim();
    if (line === '') return refuse('I heard "command" but nothing after it.');
    return ok(line, `run \`${line}\``, 'literal', true);
  }

  const text = normalize(transcript);
  if (text === '') {
    return refuse('I did not hear anything.');
  }

  for (const rule of RULES) {
    const match = rule.pattern.exec(text);
    if (match !== null) {
      try {
        return rule.build(match, context);
      } catch (error) {
        // A rule that throws is a bug in this file, not a bad thing to have said. Report it
        // as a refusal so the session keeps going and the phrase is still visible.
        const detail = error instanceof Error ? error.message : String(error);
        return refuse(`I understood "${text}" but could not turn it into a command: ${detail}`);
      }
    }
  }

  return refuse(`I did not understand "${text}".`, [
    'go to inbox',
    'open three',
    'mark as read',
    'undo that',
    `command <any shell command>`,
  ]);
}

/** Every phrase family the grammar knows, for `voice help`. */
export function knownPhrases(): readonly { readonly rule: string; readonly examples: readonly string[] }[] {
  return [
    { rule: 'Navigate', examples: ['go to inbox', 'open the budget thread', 'go up', 'go back', 'go home'] },
    { rule: 'Look', examples: ['list', 'show me the unread ones', 'next page', 'where am I'] },
    { rule: 'Read', examples: ['read three', 'read it to me', 'show me the details', 'what can I do'] },
    { rule: 'Search', examples: ['search for budget', 'find messages from alice', 'find unread'] },
    { rule: 'Act', examples: ['mark as read', 'flag it', 'mark three as unread', 'archive it'] },
    { rule: 'Undo', examples: ['undo that', 'redo', 'what did I just do'] },
    { rule: 'Anything else', examples: ['command find -q subject:budget --source mail'] },
    { rule: 'Stop', examples: ['stop listening', 'cancel', 'quit'] },
  ];
}
