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

// ---------------------------------------------------------------------------
// People — the org chart as folders
// ---------------------------------------------------------------------------

/**
 * The people fixture mirrors the shape of the `graph-people` provider closely enough to
 * learn the navigation on, without a tenant: sections at the root, a folder per person,
 * and inside it a profile, the three hierarchy facets, and a merged list of every mail and
 * chat exchanged with them.
 *
 * Two honest differences from the real thing, both consequences of the fixture engine
 * being deliberately simple. It sorts strictly by recency, so the priority order is faked
 * here by giving the messages that would rank first the most recent timestamps. And the
 * hierarchy is a finite tree rather than the real provider's cycle, because a fixture is
 * an eagerly indexed map and cannot contain one.
 */
interface DemoPerson {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly address: string;
  readonly department: string;
  readonly office: string;
  readonly managerId?: string;
  readonly reportIds?: readonly string[];
  readonly external?: boolean;
}

const ME = 'alex';

const STAFF: readonly DemoPerson[] = [
  {
    id: 'morgan',
    name: 'Morgan Ellis',
    title: 'Chief Technology Officer',
    address: 'morgan.ellis@contoso.example',
    department: 'Technology',
    office: 'Seattle / 21-1100',
    reportIds: ['dana'],
  },
  {
    id: 'dana',
    name: 'Dana Whitfield',
    title: 'Director of Engineering',
    address: 'dana.whitfield@contoso.example',
    department: 'Platform',
    office: 'Seattle / 18-2140',
    managerId: 'morgan',
    reportIds: [ME, 'priya', 'tom'],
  },
  {
    id: ME,
    name: 'Alex Kimura',
    title: 'Principal Engineer',
    address: 'alex.kimura@contoso.example',
    department: 'Platform',
    office: 'Seattle / 18-2208',
    managerId: 'dana',
    reportIds: ['lena', 'sam'],
  },
  {
    id: 'priya',
    name: 'Priya Raman',
    title: 'Engineering Manager',
    address: 'priya.raman@contoso.example',
    department: 'Platform',
    office: 'Bengaluru / 4-330',
    managerId: 'dana',
  },
  {
    id: 'tom',
    name: 'Tom Okafor',
    title: 'Staff Engineer',
    address: 'tom.okafor@contoso.example',
    department: 'Platform',
    office: 'Lagos / 2-014',
    managerId: 'dana',
  },
  {
    id: 'lena',
    name: 'Lena Björk',
    title: 'Senior Engineer',
    address: 'lena.bjork@contoso.example',
    department: 'Platform',
    office: 'Stockholm / 6-118',
    managerId: ME,
  },
  {
    id: 'sam',
    name: 'Sam Ito',
    title: 'Engineer',
    address: 'sam.ito@contoso.example',
    department: 'Platform',
    office: 'Tokyo / 9-405',
    managerId: ME,
  },
  {
    id: 'jordan',
    name: 'Jordan Reyes',
    title: 'Partner Solutions Architect',
    address: 'jordan.reyes@fabrikam.example',
    department: 'Fabrikam',
    office: 'Remote',
    external: true,
  },
];

function staff(id: string): DemoPerson {
  const found = STAFF.find((person) => person.id === id);
  if (found === undefined) throw new Error(`Demo fixture references unknown person "${id}".`);
  return found;
}

/** One exchanged message, already in the order the real provider would rank it. */
interface DemoComm {
  readonly channel: 'Mail' | 'Chat';
  readonly subject: string;
  readonly flags: readonly string[];
  readonly body: string;
}

const CONVERSATIONS: Readonly<Record<string, readonly DemoComm[]>> = {
  dana: [
    {
      channel: 'Mail',
      subject: 'Re: Platform review — can you take the Thursday slot?',
      flags: ['unread', 'unanswered', 'important'],
      body: [
        'Alex,',
        '',
        'Morgan wants the platform review moved to Thursday and I would rather you presented',
        'the reliability numbers than me. Twenty minutes, no deck required.',
        '',
        'Can you take it?',
        '',
        'Dana',
      ].join('\n'),
    },
    {
      channel: 'Chat',
      subject: 'did you see the incident review notes?',
      flags: ['unread', 'unanswered'],
      body: 'did you see the incident review notes? the timeline section needs your eyes before I send it up',
    },
    {
      channel: 'Mail',
      subject: 'Headcount plan for next half',
      flags: ['unanswered'],
      body: [
        'Draft attached. I have pencilled you in for two additions rather than three, on the',
        'assumption that the migration lands. Push back if that is wrong.',
        '',
        'Dana',
      ].join('\n'),
    },
    {
      channel: 'Mail',
      subject: 'Re: One-to-one notes',
      flags: ['sent'],
      body: 'Thanks — agreed on all three. I will start on the second one this week.',
    },
  ],
  priya: [
    {
      channel: 'Chat',
      subject: '@Alex Kimura can you review the budget split?',
      flags: ['unread', 'unanswered', 'mention'],
      body: '@Alex Kimura can you review the budget split before I send it to Dana? mostly want a sanity check on the tooling line',
    },
    {
      channel: 'Mail',
      subject: 'FY26 budget review — please read before Thursday',
      flags: ['unread', 'important', 'attachment'],
      body: [
        'Hi all,',
        '',
        'The revised FY26 numbers are attached. Headcount moved from Q2 to Q3 and the tooling',
        'line item is now split by team.',
        '',
        'Priya',
      ].join('\n'),
    },
    {
      channel: 'Mail',
      subject: 'Re: Migration sequencing',
      flags: ['sent'],
      body: 'Sequencing looks right to me. The only ordering I feel strongly about is that the read path moves first.',
    },
  ],
  jordan: [
    {
      channel: 'Mail',
      subject: 'Integration questions before the pilot',
      flags: ['unread', 'unanswered', 'external'],
      body: [
        'Hi Alex,',
        '',
        'Three questions before we start the pilot next month:',
        '',
        '  1. Is the rate limit per tenant or per application?',
        '  2. Do you support webhook replay?',
        '  3. Who signs off on the data-handling addendum?',
        '',
        'Jordan Reyes',
        'Fabrikam',
      ].join('\n'),
    },
    {
      channel: 'Mail',
      subject: 'Re: Kickoff scheduling',
      flags: ['external', 'sent'],
      body: 'Either the 12th or the 14th works for us. Happy to host.',
    },
  ],
  lena: [
    {
      channel: 'Chat',
      subject: 'pushed the retry fix, want a second pair of eyes',
      flags: ['unread', 'unanswered'],
      body: 'pushed the retry fix, want a second pair of eyes on the backoff maths before I merge',
    },
    {
      channel: 'Mail',
      subject: 'Re: Holiday cover',
      flags: [],
      body: 'That works. I will pick up the on-call week and hand back on the 30th.',
    },
  ],
  sam: [
    {
      channel: 'Mail',
      subject: 'Question about the caching layer',
      flags: ['unanswered'],
      body: 'Is the cache meant to be authoritative for reads after a write, or is a stale read acceptable for a few seconds?',
    },
    {
      channel: 'Chat',
      subject: 'thanks for the walkthrough',
      flags: [],
      body: 'thanks for the walkthrough earlier, that made the ownership boundaries much clearer',
    },
  ],
  tom: [
    {
      channel: 'Mail',
      subject: 'Re: Deprecation timeline',
      flags: ['sent'],
      body: 'Agreed. Six months of overlap, then we remove it. I will write the announcement.',
    },
  ],
  morgan: [
    {
      channel: 'Mail',
      subject: 'Platform review — Thursday',
      flags: [],
      body: 'Looking forward to it. Keep it to the numbers and what you would change.',
    },
  ],
};

function profileItem(person: DemoPerson, prefix: string): MemoryItem {
  const manager = person.managerId === undefined ? undefined : staff(person.managerId);
  const reports = (person.reportIds ?? []).map((id) => staff(id).name);
  return {
    id: `${prefix}:profile`,
    title: 'profile',
    subtype: 'profile',
    agoMinutes: 0,
    format: 'markdown',
    summary: `${person.title} — ${person.address}`,
    body: [
      `# ${person.name}`,
      '',
      `${person.title}${person.external === true ? ' (external)' : ''}`,
      '',
      `- Email: ${person.address}`,
      `- Department: ${person.department}`,
      `- Office: ${person.office}`,
      `- Manager: ${manager?.name ?? 'none on record'}`,
      `- Direct reports: ${reports.length === 0 ? 'none' : reports.join(', ')}`,
      '',
      person.external === true
        ? 'This person is outside your organisation, so only correspondence is available — there is no hierarchy to walk.'
        : 'Use `cd manager`, `cd reports` or `cd peers` to keep walking the org chart.',
    ].join('\n'),
    meta: {
      address: person.address,
      jobTitle: person.title,
      department: person.department,
      office: person.office,
    },
  };
}

function commsItems(person: DemoPerson, prefix: string): MemoryItem[] {
  const conversation = CONVERSATIONS[person.id] ?? [];
  // Ages ascend with position so that the fixture engine's recency sort reproduces the
  // real provider's priority order: unread, then unanswered, then everything else, then
  // things you sent.
  return conversation.map((entry, index) => ({
    id: `${prefix}:c${String(index)}`,
    title: `${entry.channel} — ${entry.subject}`,
    subtype: entry.channel === 'Chat' ? 'chat' : 'message',
    agoMinutes: 12 + index * 47,
    author: entry.flags.includes('sent') ? 'Alex Kimura' : person.name,
    authorId: entry.flags.includes('sent') ? staff(ME).address : person.address,
    ...(entry.flags.length === 0 ? {} : { flags: entry.flags }),
    summary: entry.body.split('\n')[0]?.slice(0, 120) ?? '',
    body: entry.body,
    format: 'text' as const,
    meta: { channel: entry.channel.toLowerCase(), person: person.name, personAddress: person.address },
  }));
}

function peopleFolder(
  id: string,
  title: string,
  ids: readonly string[],
  order = 0,
): MemoryItem {
  return {
    id,
    title,
    subtype: 'folder',
    // The fixture engine sorts newest first, so `order` is expressed as an age: it is the
    // only lever a fixture has for saying "these folders have a meaningful sequence".
    agoMinutes: order,
    refs: ids.map((personId) => `person:${personId}`),
  };
}

/**
 * Every person, defined exactly once.
 *
 * The hierarchy is then expressed entirely in references, which is what makes the demo a
 * faithful model rather than a convenient approximation: `Colleagues/Priya Raman` and
 * `Me/peers/Priya Raman` are not two copies of Priya, they are Priya. Her unanswered chat
 * has one id, so `find` reports it once, `stat` agrees whichever way you walked there, and
 * marking it read from one path marks it read from all of them.
 *
 * It is also genuinely cyclic — `Me/manager/Dana Whitfield/reports/` contains you — which
 * is the one property a tree-shaped fixture could never demonstrate.
 */
function personItem(person: DemoPerson): MemoryItem {
  const prefix = `person:${person.id}`;
  const children: MemoryItem[] = [profileItem(person, prefix)];

  if (person.external !== true) {
    if (person.managerId !== undefined) {
      children.push(peopleFolder(`${prefix}:manager`, 'manager', [person.managerId], 0));
    }
    if ((person.reportIds ?? []).length > 0) {
      children.push(peopleFolder(`${prefix}:reports`, 'reports', person.reportIds ?? [], 1));
    }
    const manager = person.managerId === undefined ? undefined : staff(person.managerId);
    const peers = (manager?.reportIds ?? []).filter((id) => id !== person.id);
    if (peers.length > 0) {
      children.push(peopleFolder(`${prefix}:peers`, 'peers', peers, 2));
    }
  }

  children.push(...commsItems(person, prefix));

  return {
    id: prefix,
    title: person.name,
    subtype: 'person',
    // A person is only as urgent as the most urgent thing they are waiting on, and the
    // fixture engine's one ordering lever is age — so urgency is expressed as one. This is
    // how the demo shows people ranked by what needs an answer rather than alphabetically.
    agoMinutes: urgency(person) * 10 + STAFF.findIndex((entry) => entry.id === person.id),
    ...(person.external === true ? { flags: ['external'] } : {}),
    summary: `${person.title} — ${person.address}`,
    meta: { address: person.address, jobTitle: person.title, department: person.department },
    children,
  };
}

/** 0 is "needs you most". Mirrors the real provider's unread-then-unanswered ranking. */
function urgency(person: DemoPerson): number {
  const comms = CONVERSATIONS[person.id] ?? [];
  if (comms.some((comm) => comm.flags.includes('unread') && comm.flags.includes('unanswered'))) return 0;
  if (comms.some((comm) => comm.flags.includes('unread'))) return 1;
  if (comms.some((comm) => comm.flags.includes('unanswered'))) return 2;
  return 3;
}

/**
 * `Me` is the person directory, not a folder containing one — the same shortcut the real
 * provider takes, because `cd Me` then `cd manager` is how you actually navigate.
 */
const ME_SECTION: MemoryItem = {
  id: 'people-me',
  title: 'Me',
  subtype: 'section',
  agoMinutes: 0,
  summary: 'You: your profile, your manager and your reports.',
  refs: (personItem(staff(ME)).children ?? []).map((child) => child.id),
};

const PEOPLE: MemoryItem[] = [
  ME_SECTION,
  peopleFolder('people-org', 'Org', ['dana', 'morgan'], 1),
  peopleFolder('people-reports', 'Reports', ['lena', 'sam'], 2),
  peopleFolder('people-colleagues', 'Colleagues', ['priya', 'tom'], 3),
  peopleFolder('people-recent', 'Recent', ['dana', 'priya', 'jordan', 'lena', 'sam'], 4),
  peopleFolder('people-external', 'External', ['jordan'], 5),
  {
    // The definitions live here, so the Directory is every person's canonical location and
    // the path a search hit reports.
    id: 'people-directory',
    title: 'Directory',
    subtype: 'folder',
    agoMinutes: 6,
    children: STAFF.map((person) => personItem(person)),
  },
];

export const FIXTURES: Readonly<Record<string, readonly MemoryItem[]>> = {
  mail: MAIL,
  chat: CHAT,
  issues: ISSUES,
  people: PEOPLE,
  empty: [],
};
