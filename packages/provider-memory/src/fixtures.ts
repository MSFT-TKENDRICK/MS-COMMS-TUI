/**
 * Built-in fixtures.
 *
 * These exist for three jobs at once:
 *
 *  1. `mscomms demo` — a complete, working, zero-credential tour of the tool.
 *  2. The conformance and integration test corpus.
 *  3. A standing torture test for the name sanitizer. Real mailboxes contain subjects with
 *     slashes, emoji, right-to-left overrides, trailing dots, four hundred characters, and
 *     the literal string "CON". Every "X as a filesystem" project that shipped without
 *     handling those grew a bug report about it, so the demo data contains all of them and
 *     the demo itself doubles as the regression check.
 */

import type { MemoryItem } from './types.js';

const HOUR = 60;
const DAY = 24 * HOUR;

function message(
  id: string,
  title: string,
  author: string,
  agoMinutes: number,
  body: string,
  extra: Partial<MemoryItem> = {},
): MemoryItem {
  const handle = `${author.toLowerCase().replace(/[^a-z]+/g, '.')}@contoso.example`;
  return {
    id,
    title,
    subtype: 'message',
    author,
    authorId: handle,
    agoMinutes,
    summary: body.split('\n')[0]?.slice(0, 120) ?? '',
    body,
    format: 'text',
    ...extra,
  };
}

/** Bulk filler so listings actually page. Deterministic: no randomness anywhere. */
function filler(prefix: string, count: number, startAgo: number, step: number): MemoryItem[] {
  const people = ['Dana Whitfield', 'Priya Raman', 'Tom Okafor', 'Lena Björk', 'Sam Ito'];
  const topics = [
    'Weekly status',
    'Re: Weekly status',
    'Deployment window moved',
    'Notes from sync',
    'Reminder: timesheet',
    'Access request approved',
  ];
  return Array.from({ length: count }, (_, i) => {
    const person = people[i % people.length] as string;
    const topic = topics[i % topics.length] as string;
    return message(
      `${prefix}-${String(i).padStart(3, '0')}`,
      topic,
      person,
      startAgo + i * step,
      `${topic} for the week.\n\nNothing blocking. Details in the linked doc.\n\n-- ${person}`,
      i % 3 === 0 ? { flags: ['unread'] } : {},
    );
  });
}

const MAIL_INBOX: MemoryItem[] = [
  message(
    'msg-budget',
    'FY26 budget review — please read before Thursday',
    'Priya Raman',
    35,
    [
      'Hi all,',
      '',
      'The revised FY26 numbers are attached. Two things changed since the last pass:',
      '',
      '  1. Headcount moved from Q2 to Q3.',
      '  2. The tooling line item is now split by team.',
      '',
      'Please read before Thursday so the meeting can be a decision, not a readout.',
      '',
      'Priya',
    ].join('\n'),
    {
      flags: ['unread', 'important', 'attachment'],
      attachments: [
        {
          id: 'att-1',
          name: 'fy26-budget.csv',
          contentType: 'text/csv',
          text: 'team,category,amount\nplatform,tooling,120000\ndocs,tooling,18000\n',
        },
      ],
      meta: { conversationId: 'c-budget', importance: 'high', folder: 'Inbox' },
    },
  ),
  message(
    'msg-budget-2',
    'FY26 budget review — please read before Thursday',
    'Tom Okafor',
    22,
    'Replying so the thread has two messages with an identical subject.\n\nThis is the collision case: the second one gets a "~2" suffix, and that suffix is stable because it is keyed to the message id rather than to arrival order.',
    { flags: ['unread'], meta: { conversationId: 'c-budget', folder: 'Inbox' } },
  ),
  message(
    'msg-slash',
    'Q3/Q4 planning: infra/tooling split',
    'Dana Whitfield',
    3 * HOUR,
    'Subject contains slashes, which cannot survive into a path segment.\n\nThe sanitizer replaces them; `stat` still shows the true subject, and search still matches the original text.',
    { meta: { folder: 'Inbox' } },
  ),
  message(
    'msg-emoji',
    '🎉 Ship it — v2.4 is live',
    'Sam Ito',
    5 * HOUR,
    'Emoji in subjects are common and are perfectly legal in a filename.\n\nThey are kept as-is: stripping them would be lossy, and a screen reader announces them by name.',
    { flags: ['flagged'], meta: { folder: 'Inbox' } },
  ),
  message(
    'msg-con',
    'CON',
    'Lena Björk',
    9 * HOUR,
    'A message whose entire subject is a reserved Windows device name.\n\nWriting a file called CON on Windows has been a footgun since DOS. The sanitizer renames it; the original is preserved in the title.',
    { meta: { folder: 'Inbox' } },
  ),
  message(
    'msg-rtl',
    'Invoice \u202Efdp.exe',
    'unknown sender',
    11 * HOUR,
    'This subject contains U+202E RIGHT-TO-LEFT OVERRIDE, the classic filename-spoofing trick that makes "exe.pdf" render as "fdp.exe".\n\nIn a mail client that renders untrusted input as filenames, silently passing it through would be a security bug, so bidi control characters are stripped.',
    { flags: ['unread'], meta: { folder: 'Inbox', suspicious: true } },
  ),
  message(
    'msg-long',
    'Re: Re: Re: FWD: follow-up on the follow-up about the quarterly planning offsite logistics including room booking, catering, the projector situation, and whether we actually need the whole day',
    'Dana Whitfield',
    26 * HOUR,
    'Long subjects are truncated to a byte budget, not a character budget.\n\nTruncating by characters is the bug every naive implementation ships: one emoji is four bytes, so a 255-character name can be a 1020-byte filename that the filesystem rejects.',
    { meta: { folder: 'Inbox' } },
  ),
  message(
    'msg-trailing-dot',
    'Please review the deck.',
    'Priya Raman',
    2 * DAY,
    'Trailing dots and spaces are silently dropped by Windows, which makes two distinct names collide.\n\nThe sanitizer trims them explicitly instead of letting the platform do it invisibly.',
    { meta: { folder: 'Inbox' } },
  ),
  ...filler('msg-inbox', 18, 3 * DAY, 7 * HOUR),
];

const MAIL: MemoryItem[] = [
  {
    id: 'folder-inbox',
    title: 'Inbox',
    subtype: 'folder',
    meta: { wellKnownName: 'inbox' },
    children: [
      ...MAIL_INBOX,
      {
        id: 'folder-projects',
        title: 'Projects',
        subtype: 'folder',
        children: [
          message(
            'msg-proj-1',
            'Design review: virtual filesystem naming',
            'Tom Okafor',
            4 * HOUR,
            'Notes from the review.\n\nAgreed: hierarchy for navigation, query for filtering, and both available from day one. Pure-folder tools lose to query tools; pure-query tools are hard to explore.',
            { flags: ['unread'], meta: { folder: 'Projects' } },
          ),
          message(
            'msg-proj-2',
            'Accessibility findings',
            'Lena Björk',
            2 * DAY,
            'Summary: full-screen TUIs are hostile to screen readers for mechanical reasons, not stylistic ones.\n\nThe alternate screen buffer destroys scrollback, full-frame repaints fragment speech, and ANSI carries no semantics. A line-oriented mode is not a fallback, it is the correct default.',
            { meta: { folder: 'Projects' } },
          ),
        ],
      },
      {
        id: 'folder-newsletters',
        title: 'Newsletters',
        subtype: 'folder',
        children: filler('msg-news', 12, 6 * HOUR, 18 * HOUR),
      },
    ],
  },
  {
    id: 'folder-sent',
    title: 'Sent Items',
    subtype: 'folder',
    meta: { wellKnownName: 'sentitems' },
    children: [
      message(
        'msg-sent-1',
        'Re: FY26 budget review',
        'You',
        20,
        'Reading it now. Two questions about the tooling split; will bring them Thursday.',
        { meta: { folder: 'Sent Items' } },
      ),
      ...filler('msg-sent', 6, DAY, 2 * DAY),
    ],
  },
  {
    id: 'folder-drafts',
    title: 'Drafts',
    subtype: 'folder',
    meta: { wellKnownName: 'drafts' },
    children: [
      message('msg-draft-1', 'Untitled', 'You', 90, 'Half-written thought. Do not send.', {
        flags: ['draft'],
        meta: { folder: 'Drafts' },
      }),
    ],
  },
  {
    id: 'folder-archive',
    title: 'Archive',
    subtype: 'folder',
    meta: { wellKnownName: 'archive' },
    children: filler('msg-arch', 30, 10 * DAY, 12 * HOUR),
  },
];

const CHAT: MemoryItem[] = [
  {
    id: 'chats',
    title: 'Chats',
    subtype: 'folder',
    children: [
      {
        id: 'chat-dm-priya',
        title: 'Priya Raman',
        subtype: 'chat',
        meta: { chatType: 'oneOnOne' },
        children: [
          message('chat-1', 'are you around for 10 min?', 'Priya Raman', 12, 'are you around for 10 min?', {
            subtype: 'message',
            flags: ['unread'],
            format: 'text',
          }),
          message('chat-2', 'the budget thread got long', 'Priya Raman', 11, 'the budget thread got long, want to just call?', {
            subtype: 'message',
            flags: ['unread'],
          }),
          message('chat-3', 'yep, dialling now', 'You', 9, 'yep, dialling now'),
        ],
      },
      {
        id: 'chat-group-release',
        title: 'Release crew',
        subtype: 'chat',
        meta: { chatType: 'group', memberCount: 6 },
        children: [
          message('chat-r1', 'build 2412 is green', 'Sam Ito', 45, 'build 2412 is green ✅'),
          message('chat-r2', 'promoting to ring 1', 'Dana Whitfield', 40, 'promoting to ring 1 now, shout if that is wrong'),
          message('chat-r3', '@you can you sign off on the release notes?', 'Tom Okafor', 30, '@you can you sign off on the release notes?', {
            flags: ['unread', 'mention'],
          }),
        ],
      },
    ],
  },
  {
    id: 'teams',
    title: 'Teams',
    subtype: 'folder',
    children: [
      {
        id: 'team-platform',
        title: 'Platform Engineering',
        subtype: 'team',
        children: [
          {
            id: 'channel-general',
            title: 'General',
            subtype: 'channel',
            children: [
              {
                id: 'post-1',
                title: 'Deprecating the legacy sync endpoint',
                subtype: 'thread',
                author: 'Dana Whitfield',
                agoMinutes: 3 * HOUR,
                summary: 'Deprecating the legacy sync endpoint on the 30th.',
                children: [
                  message('post-1-a', 'Deprecating the legacy sync endpoint', 'Dana Whitfield', 3 * HOUR, 'It goes read-only on the 30th and off two weeks later. Migration guide is pinned.'),
                  message('post-1-b', 'Re: Deprecating the legacy sync endpoint', 'Priya Raman', 2 * HOUR, 'Two internal callers left. Both have owners. Tracking in the issue.', { flags: ['unread'] }),
                ],
              },
              {
                id: 'post-2',
                title: 'Office hours moved to Wednesdays',
                subtype: 'thread',
                author: 'Sam Ito',
                agoMinutes: 2 * DAY,
                children: [
                  message('post-2-a', 'Office hours moved to Wednesdays', 'Sam Ito', 2 * DAY, 'Same link, same hour, one day earlier.'),
                ],
              },
            ],
          },
          {
            id: 'channel-incidents',
            title: 'Incidents',
            subtype: 'channel',
            children: [
              {
                id: 'post-3',
                title: 'INC-4471: elevated 429s from the graph gateway',
                subtype: 'thread',
                author: 'Lena Björk',
                agoMinutes: 55,
                children: [
                  message('post-3-a', 'INC-4471: elevated 429s', 'Lena Björk', 55, 'Throttling started at 09:12. Backoff is holding. No data loss.', { flags: ['unread', 'important'] }),
                ],
              },
            ],
          },
        ],
      },
    ],
  },
];

const ISSUES: MemoryItem[] = [
  {
    id: 'repo-issues',
    title: 'issues',
    subtype: 'folder',
    children: [
      {
        id: 'issue-12',
        title: '#12 Listing a 200k-message folder hangs',
        subtype: 'issue',
        author: 'Dana Whitfield',
        agoMinutes: 6 * HOUR,
        flags: ['open', 'unread'],
        summary: 'Paging is not optional at this size.',
        body: 'Expected: `ls` returns promptly.\nActual: it tries to enumerate everything.\n\nThere is no version of readdir(3) that is pleasant at 200k entries; the listing has to be capped and paged.',
        meta: { number: 12, state: 'open', labels: 'bug,performance', comments: 3 },
      },
      {
        id: 'issue-13',
        title: '#13 Add a --json output mode',
        subtype: 'issue',
        author: 'Priya Raman',
        agoMinutes: 2 * DAY,
        flags: ['open'],
        body: 'If the tool prints structured output, everything downstream of it becomes someone else\u2019s problem in the good way: jq, awk, grep, and any script anyone already has.',
        meta: { number: 13, state: 'open', labels: 'enhancement', comments: 1 },
      },
      {
        id: 'issue-9',
        title: '#9 Names collide when two messages share a subject',
        subtype: 'issue',
        author: 'Tom Okafor',
        agoMinutes: 20 * DAY,
        flags: ['closed'],
        body: 'Fixed by keying the deduplication suffix to the item id rather than to arrival order.',
        meta: { number: 9, state: 'closed', labels: 'bug', comments: 7 },
      },
    ],
  },
  {
    id: 'repo-pulls',
    title: 'pulls',
    subtype: 'folder',
    children: [
      {
        id: 'pr-14',
        title: '#14 Cap default listings and add cursor paging',
        subtype: 'issue',
        author: 'Dana Whitfield',
        agoMinutes: 4 * HOUR,
        flags: ['open', 'unread'],
        body: 'Caps the default listing, adds an opaque cursor, and reports the total when the backend gives one.',
        meta: { number: 14, state: 'open', draft: false, comments: 2 },
      },
    ],
  },
];

export const FIXTURES: Readonly<Record<string, readonly MemoryItem[]>> = {
  mail: MAIL,
  chat: CHAT,
  issues: ISSUES,
  empty: [],
};
