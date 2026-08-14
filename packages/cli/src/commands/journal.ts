/**
 * Undo, redo, and the interaction log.
 *
 * These three are one feature seen from three angles: the journal is the log, `undo` walks
 * it backwards, and `redo` walks the pile that `undo` made. The reasoning about *what* is
 * reversible lives in core/journal.ts; this file is only the user-facing shape of it.
 *
 * A note on why `history` exists at all, since the shell already has readline history.
 * Readline records what you *typed*. This records what *happened* — including the
 * interactions that arrived by arrow key in the pane or by voice, which were never typed
 * anywhere. For a user who cannot glance back up the screen to see what a command did,
 * "what did I just do, and can I take it back" is one question, and it deserves one answer
 * rather than two half-answers in two different places.
 */

import type { JournalEntry } from '@mscomms/core';
import { formatRows, relativeTime, sanitizeForDisplay } from '../format.js';
import { Dispatcher } from '../dispatch.js';
import { OUTPUT_FLAGS, flagBool, flagNumber, modeFrom, type Command, type CommandTable } from './types.js';

export const undoCommand: Command = {
  name: 'undo',
  aliases: ['oops'],
  group: 'system',
  summary: 'Take back the last thing you did, whether you typed it, clicked it or said it.',
  usage: 'undo [--skip] [--dry-run]',
  maxPositional: 0,
  detail: [
    'Reverses the most recent interaction that changed something: a move, a mark-as-read,',
    'a flag, a tag. Reading and listing changed nothing, so `undo` steps over them rather',
    'than appearing to do nothing.',
    '',
    'The inverse is supplied by the source itself at the moment it acted, not guessed',
    'afterwards. That is why undoing "mark as read" on a message that was already read does',
    'nothing rather than marking it unread: the source reported that it changed nothing, so',
    'there is nothing to take back.',
    '',
    'When the last change cannot be reversed, `undo` stops and says so instead of quietly',
    'reversing something older. If you meant to step past it, `--skip` says so out loud.',
  ].join('\n'),
  flags: [
    { name: 'skip', description: 'Step past an interaction that cannot be undone, to the one before it.' },
    { name: 'dry-run', description: 'Say what would be undone without doing it.', aliases: ['n'] },
  ],
  examples: ['undo', 'undo --dry-run', 'undo --skip'],
  async run(session, args) {
    const skip = flagBool(args, 'skip');

    if (flagBool(args, 'dry-run', 'n')) {
      const plan = session.journal.planUndo(skip ? { skipIrreversible: true } : {});
      session.print(plan.ok ? `Would undo: ${plan.entry.summary}` : plan.reason);
      return;
    }

    session.print(await session.undo(skip ? { skipIrreversible: true } : {}));
  },
};

export function createRedoCommand(table: CommandTable): Command {
  return {
    name: 'redo',
    group: 'system',
    summary: 'Do again the thing you just undid.',
    usage: 'redo [--dry-run]',
    maxPositional: 0,
    detail: [
      'Re-runs the original command line rather than inverting the inverse. Inverting an',
      'inverse is right for a toggle and wrong for everything else — "remove the followup',
      'tag" reversed is only "add the followup tag" if the tag was absent to begin with,',
      'and by the time you press redo nobody remembers whether it was.',
      '',
      'Anything you do after an undo clears the redo pile, exactly as in a text editor:',
      'redoing on top of a world that has since moved is how you get a state nobody chose.',
    ].join('\n'),
    flags: [{ name: 'dry-run', description: 'Say what would be redone without doing it.', aliases: ['n'] }],
    async run(session, args) {
      if (flagBool(args, 'dry-run', 'n')) {
        const plan = session.journal.planRedo();
        session.print(plan.ok ? `Would redo: ${plan.entry.summary} (\`${plan.command}\`)` : plan.reason);
        return;
      }

      const { entry, command } = session.planRedo();
      // Dispatched, not re-derived. The redone interaction goes through the same path a
      // typed one does, so it is re-journaled, re-announced to the view, and undoable
      // again — which is the property that makes undo/redo a loop rather than a trapdoor.
      await new Dispatcher(table).execute(session, command);
      session.commitRedo(entry);
      session.status(`Redone: ${entry.summary}`);
    },
  };
}

export const historyCommand: Command = {
  name: 'history',
  aliases: ['log', 'journal'],
  group: 'system',
  summary: 'Show what you have done this session, most recent first.',
  usage: 'history [-n count] [--all] [--undoable]',
  maxPositional: 0,
  detail: [
    'This is a log of interactions, not of keystrokes. A folder opened with an arrow key in',
    'the full-screen view and one opened by typing `cd` produce the same entry, and so does',
    'one opened by voice — the source column says which.',
    '',
    'Every entry carries the command line that would repeat it, so the log doubles as a way',
    'to learn the commands: do a thing however is easiest, then read back what it was called.',
  ].join('\n'),
  flags: [
    { name: 'n', description: 'How many entries to show. Default 20.', value: true, aliases: ['limit'] },
    { name: 'all', description: 'Show every entry, including reads and listings.' },
    { name: 'undoable', description: 'Show only the entries that can still be undone.' },
    ...OUTPUT_FLAGS,
  ],
  examples: ['history', 'history -n 50', 'history --undoable'],
  async run(session, args) {
    const limit = flagNumber(args, 'n', 'limit') ?? 20;
    const mode = modeFrom(args);

    let entries = [...session.journal.entries].reverse();
    if (!flagBool(args, 'all')) entries = entries.filter((entry) => entry.kind !== 'read');
    if (flagBool(args, 'undoable')) entries = entries.filter((entry) => entry.reversal !== undefined);
    entries = entries.slice(0, limit);

    if (entries.length === 0) {
      session.print(
        flagBool(args, 'undoable')
          ? 'Nothing you have done so far can be undone.'
          : 'Nothing has happened yet this session.',
      );
      return;
    }

    if (mode === 'json') {
      session.print(JSON.stringify(entries, null, 2));
      return;
    }

    session.print(
      formatRows(
        ['when', 'what happened', 'command', 'from', 'undo'],
        entries.map((entry) => [
          relativeTime(entry.at),
          sanitizeForDisplay(entry.summary),
          sanitizeForDisplay(entry.command),
          entry.source,
          describeReversal(entry),
        ]),
        session.withMode(mode),
      ),
    );

    const undoable = session.journal.planUndo();
    if (mode !== 'tsv') {
      session.status(undoable.ok ? `\`undo\` would reverse: ${undoable.entry.summary}` : undoable.reason);
    }
  },
};

function describeReversal(entry: JournalEntry): string {
  if (entry.reversal === undefined) return entry.kind === 'read' ? '' : 'no';
  return entry.reversal.kind === 'navigate' ? `back to ${entry.reversal.path}` : entry.reversal.action;
}

export function journalCommands(table: CommandTable): readonly Command[] {
  return [undoCommand, createRedoCommand(table), historyCommand];
}
