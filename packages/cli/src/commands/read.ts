/**
 * Reading: cat, stat, actions, do, attachments, save, url.
 */

import { writeFile } from 'node:fs/promises';
import { resolve as resolveHostPath } from 'node:path';
import { vpath, type MetaValue } from '@mscomms/core';
import { Session } from '../session.js';
import { formatDocument, formatPairs, formatRows, formatBytes, sanitizeForDisplay } from '../format.js';
import {
  OUTPUT_FLAGS,
  flagBool,
  flagNumber,
  flagString,
  modeFrom,
  quoteCorrection,
  type Command,
} from './types.js';

export const catCommand: Command = {
  name: 'cat',
  aliases: ['read', 'show', 'view'],
  group: 'read',
  summary: 'Read an item: its headers, then its text.',
  usage: 'cat [path|number] [--raw] [--headers]',
  detail: [
    'Takes a number from the last listing, a name, or a full path.',
    '',
    'Output is plain text, wrapped to your terminal width, with headers first and a blank',
    'line before the body. HTML mail is converted to text rather than dumped with its',
    'tags, because a screen reader reads those tags aloud one by one.',
  ].join('\n'),
  args: ['node'],
  maxPositional: 1,
  correction: quoteCorrection('cat'),
  flags: [
    { name: 'raw', description: 'Do not wrap the body to the terminal width.' },
    { name: 'headers', description: 'Print only the headers, not the body.', aliases: ['h'] },
    ...OUTPUT_FLAGS,
  ],
  examples: ['cat 3', 'cat "FY26 budget review.eml"', 'cat /mail/Inbox/3'],
  async run(session, args) {
    const token = args.positional[0];
    if (token === undefined) throw new Error('Which item? Try `cat 1`, or run `ls` first to see the numbers.');
    const path = session.resolveTarget(token);

    const doc = await session.vfs.read(path);
    const mode = modeFrom(args);

    if (flagBool(args, 'headers', 'h')) {
      session.print(formatPairs(doc.headers, session.withMode(mode)));
      return;
    }

    const format = session.withMode(mode);
    session.print(formatDocument(doc, flagBool(args, 'raw') ? { ...format, width: 0 } : format));

    if ((doc.attachments ?? []).length > 0 && mode !== 'json') {
      session.status(
        `${String((doc.attachments ?? []).length)} attachment(s). Use \`attachments\` to list them and \`save\` to write one to disk.`,
      );
    }
  },
};

export const statCommand: Command = {
  name: 'stat',
  aliases: ['info'],
  group: 'read',
  summary: 'Show everything known about an item, including its real backend identifier.',
  usage: 'stat [path|number]',
  detail: [
    'Displayed names are sanitized for the filesystem-like interface: illegal characters',
    'are replaced, long subjects are shortened, and duplicates get a ~2 suffix. That makes',
    'them readable and typeable but not authoritative.',
    '',
    '`stat` shows the untouched title and the provider\'s own identifier, which is what you',
    'want when scripting, filing a bug, or checking that two similar-looking items really',
    'are different.',
  ].join('\n'),
  args: ['node'],
  maxPositional: 1,
  correction: quoteCorrection('stat'),
  flags: [...OUTPUT_FLAGS],
  async run(session, args) {
    const token = args.positional[0];
    const path = token === undefined ? session.cwd : session.resolveTarget(token);
    const node = await session.vfs.stat(path);
    const mode = modeFrom(args);

    if (mode === 'json') {
      session.print(JSON.stringify(node, null, 2));
      return;
    }

    const pairs: Array<readonly [string, string]> = [
      ['Path', node.path ?? Session.pathOf(path)],
      ['Name', node.name],
      ['Title', node.title],
      ['Kind', node.kind === 'dir' ? `folder${node.subtype === undefined ? '' : ` (${node.subtype})`}` : (node.subtype ?? 'item')],
      ['Id', node.id],
    ];
    if (node.mtime !== undefined) pairs.push(['Date', node.mtime.toISOString()]);
    if (node.author !== undefined) pairs.push(['Author', node.author]);
    if (node.authorId !== undefined) pairs.push(['Author id', node.authorId]);
    if (node.size !== undefined) pairs.push(['Size', formatBytes(node.size)]);
    if ((node.flags ?? []).length > 0) pairs.push(['Flags', (node.flags ?? []).join(', ')]);
    if (node.childCount !== undefined) pairs.push(['Items', String(node.childCount)]);
    if (node.unreadCount !== undefined) pairs.push(['Unread', String(node.unreadCount)]);
    if (node.summary !== undefined) pairs.push(['Summary', node.summary]);

    for (const [key, value] of Object.entries(node.meta ?? {})) {
      if (value === null) continue;
      pairs.push([`meta.${key}`, String(value)]);
    }

    session.print(formatPairs(pairs, session.withMode(mode)));

    if (node.name !== node.title && mode !== 'tsv') {
      session.status('The displayed name differs from the original title because it was sanitized for use as a filename.');
    }
  },
};

export const actionsCommand: Command = {
  name: 'actions',
  group: 'read',
  summary: 'List what you can do to an item.',
  usage: 'actions [path|number]',
  detail:
    'Actions come from the source itself, so mail offers different verbs from GitHub\n' +
    'issues. Run one with `do <action> <item>`.',
  args: ['node'],
  maxPositional: 1,
  correction: quoteCorrection('actions'),
  flags: [...OUTPUT_FLAGS],
  async run(session, args) {
    const token = args.positional[0];
    const path = token === undefined ? session.cwd : session.resolveTarget(token);
    const actions = await session.vfs.actions(path);
    const mode = modeFrom(args);

    if (actions.length === 0) {
      session.print('There are no actions available on that item.');
      return;
    }

    session.print(
      formatRows(
        ['action', 'what it does', 'arguments'],
        actions.map((action) => [
          action.name,
          action.label + (action.destructive === true ? ' (destructive)' : ''),
          (action.params ?? []).map((param) => `${param.name}${param.required === true ? '*' : ''}`).join(' '),
        ]),
        session.withMode(mode),
      ),
    );
  },
};

export const doCommand: Command = {
  name: 'do',
  aliases: ['run'],
  group: 'read',
  summary: 'Run an action on an item, for example marking it read.',
  usage: 'do <action> [path|number] [--param value ...]',
  maxPositional: 2,
  correction: quoteCorrection('do', { before: 1 }),
  detail:
    'Destructive actions ask for confirmation unless you pass `--yes`. In a non-interactive\n' +
    'shell they refuse outright rather than guessing, because a script that silently\n' +
    'deletes mail is a much worse failure than one that stops.',
  args: ['action', 'node'],
  flags: [
    { name: 'yes', description: 'Skip the confirmation prompt for destructive actions.', aliases: ['y'] },
    ...OUTPUT_FLAGS,
  ],
  examples: ['do read 3', 'do flag 1', 'do close 2 --comment "fixed"'],
  async run(session, args) {
    const action = args.positional[0];
    if (action === undefined) throw new Error('Which action? Run `actions` to see what is available.');
    const token = args.positional[1];
    const path = token === undefined ? session.cwd : session.resolveTarget(token);

    const available = await session.vfs.actions(path);
    const descriptor = available.find((candidate) => candidate.name === action);
    if (descriptor === undefined) {
      throw new Error(
        `There is no action called "${action}" on that item. Available: ${available.map((a) => a.name).join(', ') || '(none)'}.`,
      );
    }

    if (descriptor.destructive === true && !flagBool(args, 'yes', 'y')) {
      throw new Error(
        `"${descriptor.label}" cannot be undone. Re-run with --yes to confirm: do ${action} ${token ?? ''} --yes`.trim(),
      );
    }

    const params: Record<string, MetaValue> = {};
    for (const param of descriptor.params ?? []) {
      const raw = args.flags[param.name];
      if (raw === undefined) {
        if (param.required === true) {
          throw new Error(`"${action}" needs --${param.name} (${param.label}).`);
        }
        continue;
      }
      params[param.name] =
        param.type === 'number' ? Number(raw) : param.type === 'boolean' ? raw === true || raw === 'true' : String(raw);
    }

    const result = await session.vfs.invoke(action, path, params);
    session.print(result.message);
  },
};

export const attachmentsCommand: Command = {
  name: 'attachments',
  aliases: ['att'],
  group: 'read',
  summary: 'List the attachments on an item.',
  usage: 'attachments [path|number]',
  args: ['node'],
  maxPositional: 1,
  correction: quoteCorrection('attachments'),
  flags: [...OUTPUT_FLAGS],
  async run(session, args) {
    const token = args.positional[0];
    if (token === undefined) throw new Error('Which item? Try `attachments 1`.');
    const path = session.resolveTarget(token);
    const doc = await session.vfs.read(path);
    const list = doc.attachments ?? [];

    if (list.length === 0) {
      session.print('That item has no attachments.');
      return;
    }

    session.print(
      formatRows(
        ['#', 'name', 'size', 'type'],
        list.map((attachment, index) => [
          String(index + 1),
          sanitizeForDisplay(attachment.name),
          formatBytes(attachment.size),
          attachment.contentType ?? '',
        ]),
        session.withMode(modeFrom(args)),
      ),
    );
    session.status('Save one with `save <item> <number> [destination]`.');
  },
};

export const saveCommand: Command = {
  name: 'save',
  group: 'read',
  summary: 'Write an attachment, or an item\'s text, to a file on disk.',
  usage: 'save <path|number> [attachment-number] [--to file]',
  maxPositional: 2,
  correction: quoteCorrection('save', { trailingNumber: true }),
  detail:
    'With no attachment number, saves the item\'s text. Attachment filenames from the\n' +
    'network are never trusted: any directory component is stripped, so a message cannot\n' +
    'write outside the folder you chose.',
  args: ['node', 'none'],
  flags: [
    { name: 'to', description: 'Where to write the file. Defaults to the current directory.', value: true, aliases: ['o'] },
    { name: 'force', description: 'Overwrite an existing file.', aliases: ['f'] },
  ],
  examples: ['save 3', 'save 3 1 --to C:\\temp\\report.pdf'],
  async run(session, args) {
    const token = args.positional[0];
    if (token === undefined) throw new Error('Which item? Try `save 1`.');
    const path = session.resolveTarget(token);
    const attachmentIndex = flagNumber(args, 'attachment') ?? numberOf(args.positional[1]);

    const doc = await session.vfs.read(path);

    if (attachmentIndex === undefined) {
      const target = flagString(args, 'to', 'o') ?? `${safeFileName(doc.title)}.txt`;
      const text = [
        ...doc.headers.map(([label, value]) => `${label}: ${value}`),
        '',
        doc.body,
      ].join('\n');
      await writeText(resolveHostPath(target), text, flagBool(args, 'force', 'f'));
      session.print(`Saved the message text to ${resolveHostPath(target)}.`);
      return;
    }

    const attachment = (doc.attachments ?? [])[attachmentIndex - 1];
    if (attachment === undefined) {
      throw new Error(
        `There is no attachment ${String(attachmentIndex)}. That item has ${String((doc.attachments ?? []).length)}.`,
      );
    }
    const data = await session.vfs.readAttachment(path, attachment.id);    const target = flagString(args, 'to', 'o') ?? safeFileName(data.name);
    await writeBytes(resolveHostPath(target), data.data, flagBool(args, 'force', 'f'));
    session.print(`Saved ${formatBytes(data.data.byteLength)} to ${resolveHostPath(target)}.`);
  },
};

function numberOf(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Make a network-supplied name safe to use as a local filename.
 *
 * Path separators and `..` are removed outright rather than replaced, so no combination of
 * them can escape the target directory. This is the classic "zip slip" defence and it
 * applies to any attachment name that came from someone else's mail server.
 */
function safeFileName(name: string): string {
  const base = name.replace(/[\\/]/g, '_').replace(/\.\.+/g, '.').replace(/^[.\s]+/, '');
  const cleaned = base.replace(/[<>:"|?*\u0000-\u001F]/g, '_').trim();
  return cleaned === '' ? 'attachment' : cleaned.slice(0, 200);
}

async function writeText(target: string, text: string, force: boolean): Promise<void> {
  await writeFile(target, text, { encoding: 'utf8', flag: force ? 'w' : 'wx' }).catch(rethrowExists(target));
}

async function writeBytes(target: string, data: Uint8Array, force: boolean): Promise<void> {
  await writeFile(target, data, { flag: force ? 'w' : 'wx' }).catch(rethrowExists(target));
}

function rethrowExists(target: string): (error: unknown) => never {
  return (error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`${target} already exists. Pass --force to overwrite it, or --to to choose another name.`);
    }
    throw error;
  };
}

export const urlCommand: Command = {
  name: 'url',
  group: 'read',
  summary: 'Print the web link for an item so you can open it in a browser.',
  usage: 'url [path|number]',
  detail:
    'Prints the link instead of launching a browser. Launching one steals focus, which is\n' +
    'disorienting with a screen reader, and it does not work over SSH at all.',
  args: ['node'],
  maxPositional: 1,
  correction: quoteCorrection('url'),
  async run(session, args) {
    const token = args.positional[0];
    if (token === undefined) throw new Error('Which item? Try `url 1`.');
    const path = session.resolveTarget(token);

    const node = await session.vfs.stat(path);
    const fromMeta = node.meta?.['webLink'] ?? node.meta?.['webUrl'] ?? node.meta?.['url'];
    if (typeof fromMeta === 'string') {
      session.print(fromMeta);
      return;
    }

    if (node.kind === 'file') {
      const doc = await session.vfs.read(path);
      if (doc.webUrl !== undefined) {
        session.print(doc.webUrl);
        return;
      }
    }
    throw new Error('That item has no web link.');
  },
};

export const parentCommand: Command = {
  name: 'up',
  group: 'navigate',
  summary: 'Go up one folder.',
  usage: 'up',
  maxPositional: 0,
  async run(session) {
    const parent = vpath.dirname(session.cwd);
    session.setCwd(parent);
    session.print(parent);
  },
};

export const readCommands: readonly Command[] = [
  catCommand,
  statCommand,
  actionsCommand,
  doCommand,
  attachmentsCommand,
  saveCommand,
  urlCommand,
  parentCommand,
];
