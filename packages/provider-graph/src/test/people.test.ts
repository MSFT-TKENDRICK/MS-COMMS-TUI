/**
 * The people graph, exercised against a fake tenant.
 *
 * `GraphPeopleProvider` takes a `GraphApi` in its constructor precisely so this file can
 * exist: every assertion below runs with no token, no network and no Microsoft 365 account,
 * which means the behaviour that actually matters — priority ordering, the shape of the
 * hierarchy, request cost, and what happens when a tenant withholds a scope — is pinned
 * down by tests rather than by hope.
 *
 * The fake tenant is deliberately small but not symmetric:
 *
 *   Morgan Ellis (no manager — the top of the tree, which Graph reports as a 404)
 *     └── Dana Whitfield
 *           ├── Alex Kimura  ← the signed-in user
 *           │     └── Lena Osei
 *           └── Priya Raman
 *
 * plus Jordan Reyes at a supplier, who has no directory object at all and exists only
 * because they sent mail. The mail fixtures are arranged so that **recency and priority
 * disagree**: the oldest message is the one that must lead, and the newest must sink. A
 * suite whose fixtures happened to sort the same way either direction would pass against a
 * provider that had no priority logic in it whatsoever.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MemoryStateStore,
  NULL_LOGGER,
  VfsError,
  isVfsError,
  parseQuery,
  type ProviderContext,
  type VNode,
} from '@mscomms/core';
import { conformanceTests } from '@mscomms/core/testing';

import type { GraphApi, GraphPage, GraphRequestOptions } from '../client.js';
import { GraphPeopleProvider, type GraphPeopleOptions } from '../people.js';

// ---------------------------------------------------------------------------
// The fake tenant
// ---------------------------------------------------------------------------

const ME_ID = 'user-alex';
const DANA_ID = 'user-dana';
const MORGAN_ID = 'user-morgan';
const LENA_ID = 'user-lena';
const PRIYA_ID = 'user-priya';

const ME_MAIL = 'alex.kimura@contoso.example';
const DANA_MAIL_ADDR = 'dana.whitfield@contoso.example';
const JORDAN_MAIL_ADDR = 'jordan.reyes@fabrikam.example';

interface FakeUser {
  id: string;
  displayName: string;
  mail: string;
  userPrincipalName: string;
  jobTitle: string;
  department: string;
  officeLocation: string;
  businessPhones: string[];
  companyName: string;
  city: string;
}

function user(id: string, displayName: string, mail: string, jobTitle: string): FakeUser {
  return {
    id,
    displayName,
    mail,
    userPrincipalName: mail,
    jobTitle,
    department: 'Platform',
    officeLocation: 'Building 4',
    businessPhones: ['+44 20 7946 0000'],
    companyName: 'Contoso',
    city: 'London',
  };
}

const ALEX = user(ME_ID, 'Alex Kimura', ME_MAIL, 'Engineer');
const DANA = user(DANA_ID, 'Dana Whitfield', DANA_MAIL_ADDR, 'Engineering Manager');
const MORGAN = user(MORGAN_ID, 'Morgan Ellis', 'morgan.ellis@contoso.example', 'Director');
const LENA = user(LENA_ID, 'Lena Osei', 'lena.osei@contoso.example', 'Engineer');
const PRIYA = user(PRIYA_ID, 'Priya Raman', 'priya.raman@contoso.example', 'Engineer');

const MANAGERS: Readonly<Record<string, FakeUser | undefined>> = {
  [ME_ID]: DANA,
  [LENA_ID]: ALEX,
  [PRIYA_ID]: DANA,
  [DANA_ID]: MORGAN,
  [MORGAN_ID]: undefined,
};

const REPORTS: Readonly<Record<string, readonly FakeUser[]>> = {
  [ME_ID]: [LENA],
  [DANA_ID]: [ALEX, PRIYA],
  [MORGAN_ID]: [DANA],
  [LENA_ID]: [],
  [PRIYA_ID]: [],
};

function mailFrom(
  id: string,
  from: { name: string; address: string },
  at: string,
  subject: string,
  conversationId: string,
  isRead: boolean,
): Record<string, unknown> {
  return {
    id,
    subject,
    bodyPreview: `Preview of ${subject}.`,
    receivedDateTime: at,
    sentDateTime: at,
    isRead,
    hasAttachments: false,
    importance: 'normal',
    conversationId,
    webLink: `https://outlook.example/${id}`,
    from: { emailAddress: { name: from.name, address: from.address } },
    toRecipients: [{ emailAddress: { name: 'Alex Kimura', address: ME_MAIL } }],
    body: { contentType: 'html', content: `<p>Body of <b>${subject}</b>.</p>` },
  };
}

function mailToMe(id: string, at: string, subject: string, conversationId: string, isRead: boolean): Record<string, unknown> {
  return mailFrom(id, { name: 'Dana Whitfield', address: DANA_MAIL_ADDR }, at, subject, conversationId, isRead);
}

/**
 * Alex's correspondence with Dana.
 *
 * Chronological order is m1 → m2 → m3 → m4, and the required priority order is exactly
 * that too — which is the *reverse* of what sorting by date would give, because a listing
 * sorted newest-first would lead with m4. That inversion is the whole point of the fixture.
 */
const MAIL_UNREAD = mailToMe('m1', '2026-08-09T08:00:00Z', 'Budget question', 'conv-budget', false);
const MAIL_UNANSWERED = mailToMe('m2', '2026-08-10T09:00:00Z', 'Design review', 'conv-review', true);
const MAIL_HANDLED = mailToMe('m3', '2026-08-10T11:00:00Z', 'Offsite plan', 'conv-offsite', true);
const MAIL_SENT: Record<string, unknown> = {
  ...mailFrom('m4', { name: 'Alex Kimura', address: ME_MAIL }, '2026-08-11T12:00:00Z', 'Offsite plan', 'conv-offsite', true),
  toRecipients: [{ emailAddress: { name: 'Dana Whitfield', address: DANA_MAIL_ADDR } }],
};
const DANA_MAIL = [MAIL_SENT, MAIL_HANDLED, MAIL_UNANSWERED, MAIL_UNREAD];

const JORDAN_MAIL = [
  mailFrom(
    'j1',
    { name: 'Jordan Reyes', address: JORDAN_MAIL_ADDR },
    '2026-08-11T14:00:00Z',
    'Contract renewal',
    'conv-contract',
    false,
  ),
];

const CHAT_ID = 'chat-dana';
const CHAT_READ_UP_TO = '2026-08-10T00:00:00Z';

function chatMessage(
  id: string,
  fromId: string,
  fromName: string,
  at: string,
  text: string,
  mentionsMe = false,
): Record<string, unknown> {
  return {
    id,
    messageType: 'message',
    createdDateTime: at,
    deletedDateTime: null,
    subject: null,
    webUrl: `https://teams.example/${id}`,
    from: { user: { id: fromId, displayName: fromName } },
    body: { contentType: 'html', content: `<div>${text}</div>` },
    ...(mentionsMe ? { mentions: [{ mentioned: { user: { id: ME_ID } } }] } : {}),
  };
}

const CHAT_UNREAD = chatMessage('c1', DANA_ID, 'Dana Whitfield', '2026-08-11T16:00:00Z', 'Ping about the rollout');
const CHAT_MENTION = chatMessage('c2', DANA_ID, 'Dana Whitfield', '2026-08-09T10:00:00Z', 'cc @Alex on this', true);
const CHAT_SENT = chatMessage('c3', ME_ID, 'Alex Kimura', '2026-08-08T07:00:00Z', 'Will pick it up tomorrow');
const DANA_CHAT = [CHAT_UNREAD, CHAT_MENTION, CHAT_SENT];

const CHAT_ROSTER = [
  {
    id: CHAT_ID,
    topic: null,
    chatType: 'oneOnOne',
    members: [
      { userId: ME_ID, displayName: 'Alex Kimura', email: ME_MAIL },
      { userId: DANA_ID, displayName: 'Dana Whitfield', email: DANA_MAIL_ADDR },
    ],
    viewpoint: { lastMessageReadDateTime: CHAT_READ_UP_TO },
    lastMessagePreview: {
      id: 'c1',
      createdDateTime: '2026-08-11T16:00:00Z',
      from: { user: { id: DANA_ID, displayName: 'Dana Whitfield' } },
    },
  },
  {
    // A group chat, present specifically to prove it is *not* attributed to anybody: a
    // thirty-person channel moving must never read as "Dana is waiting on you".
    id: 'chat-group',
    topic: 'Release train',
    chatType: 'group',
    members: [
      { userId: ME_ID, displayName: 'Alex Kimura', email: ME_MAIL },
      { userId: DANA_ID, displayName: 'Dana Whitfield', email: DANA_MAIL_ADDR },
      { userId: PRIYA_ID, displayName: 'Priya Raman', email: PRIYA.mail },
    ],
    viewpoint: { lastMessageReadDateTime: '2026-01-01T00:00:00Z' },
    lastMessagePreview: {
      id: 'g9',
      createdDateTime: '2026-08-12T09:00:00Z',
      from: { user: { id: PRIYA_ID, displayName: 'Priya Raman' } },
    },
  },
];

const RELEVANT_PEOPLE = [
  {
    id: DANA_ID,
    displayName: 'Dana Whitfield',
    jobTitle: 'Engineering Manager',
    companyName: 'Contoso',
    department: 'Platform',
    officeLocation: 'Building 4',
    scoredEmailAddresses: [{ address: DANA_MAIL_ADDR, relevanceScore: 9 }],
    personType: { class: 'Person', subclass: 'OrganizationUser' },
  },
  {
    id: PRIYA_ID,
    displayName: 'Priya Raman',
    jobTitle: 'Engineer',
    companyName: 'Contoso',
    department: 'Platform',
    officeLocation: 'Building 4',
    scoredEmailAddresses: [{ address: PRIYA.mail, relevanceScore: 4 }],
    personType: { class: 'Person', subclass: 'OrganizationUser' },
  },
];

// ---------------------------------------------------------------------------
// The fake transport
// ---------------------------------------------------------------------------

interface FakeOptions {
  /** URL fragments that should answer 403, as a withheld scope does. */
  readonly forbidden?: readonly string[];
  /** URL fragments that should answer 404. */
  readonly missing?: readonly string[];
  /** URL fragments that should answer 400, as mailbox search does when it is disabled. */
  readonly rejected?: readonly string[];
}

interface Write {
  readonly method: 'POST' | 'PATCH';
  readonly path: string;
  readonly body: unknown;
}

/**
 * A route table over the fixtures above.
 *
 * Matching is by fragment rather than by exact URL on purpose: the provider is free to
 * reorder `$select` or adjust `$top` without this file turning red, but a request to an
 * endpoint nobody taught it about still fails loudly rather than silently returning
 * nothing — an empty answer would make an ordering test pass for the wrong reason.
 */
class FakeGraph implements GraphApi {
  readonly requests: string[] = [];
  readonly writes: Write[] = [];
  readonly #options: FakeOptions;

  constructor(options: FakeOptions = {}) {
    this.#options = options;
  }

  get userRequests(): string[] {
    return this.requests.filter((path) => path.startsWith('/users'));
  }

  countOf(fragment: string): number {
    return this.requests.filter((path) => path.includes(fragment)).length;
  }

  async get<T>(path: string, _options?: GraphRequestOptions): Promise<T> {
    return (await this.#route(path)) as T;
  }

  async getPage<T>(path: string, _options?: GraphRequestOptions): Promise<GraphPage<T>> {
    const body = (await this.#route(path)) as { value?: unknown };
    return { value: (body.value ?? []) as T[] };
  }

  async getBytes(path: string, _options?: GraphRequestOptions): Promise<Uint8Array> {
    throw VfsError.unsupported(`Bytes from ${path}`, 'fake');
  }

  async post<T>(path: string, body: unknown, _options?: GraphRequestOptions): Promise<T> {
    this.writes.push({ method: 'POST', path, body });
    if (path === '/chats') return { id: 'chat-new' } as T;
    return {} as T;
  }

  async patch<T>(path: string, body: unknown, _options?: GraphRequestOptions): Promise<T> {
    this.writes.push({ method: 'PATCH', path, body });
    return {} as T;
  }

  async #route(path: string): Promise<Record<string, unknown>> {
    this.requests.push(path);

    for (const fragment of this.#options.forbidden ?? []) {
      if (path.includes(fragment)) {
        throw new VfsError('EACCES', `The tenant withholds access to ${fragment}.`);
      }
    }
    for (const fragment of this.#options.missing ?? []) {
      if (path.includes(fragment)) throw new VfsError('ENOENT', `${fragment} does not exist.`);
    }
    for (const fragment of this.#options.rejected ?? []) {
      if (path.includes(fragment)) throw new VfsError('EINVAL', `${fragment} is not enabled here.`);
    }

    const [route = '', search = ''] = splitOnce(path, '?');
    const query = new URLSearchParams(search);

    if (route === '/me') return { ...ALEX };

    if (route === '/me/people') return { value: RELEVANT_PEOPLE };
    if (route === '/me/chats') return { value: CHAT_ROSTER };

    if (route === '/me/mailFolders/inbox/messages') {
      return { value: [MAIL_UNREAD, ...JORDAN_MAIL] };
    }
    if (route === '/me/mailFolders/sentitems/messages') return { value: [MAIL_SENT] };

    if (route === '/me/messages') {
      const term = decodeURIComponent(query.get('$search') ?? query.get('$filter') ?? '');
      if (term.includes(DANA_MAIL_ADDR)) return { value: DANA_MAIL };
      if (term.includes(JORDAN_MAIL_ADDR)) return { value: JORDAN_MAIL };
      return { value: [] };
    }

    const single = /^\/me\/messages\/([^/]+)$/.exec(route);
    if (single !== null) {
      const id = decodeURIComponent(single[1] as string);
      const found = [...DANA_MAIL, ...JORDAN_MAIL].find((message) => message['id'] === id);
      if (found === undefined) throw new VfsError('ENOENT', `No message ${id}.`);
      return found;
    }

    const chatMessages = /^\/chats\/([^/]+)\/messages$/.exec(route);
    if (chatMessages !== null) {
      return { value: decodeURIComponent(chatMessages[1] as string) === CHAT_ID ? DANA_CHAT : [] };
    }

    const chatMessageOne = /^\/chats\/([^/]+)\/messages\/([^/]+)$/.exec(route);
    if (chatMessageOne !== null) {
      const id = decodeURIComponent(chatMessageOne[2] as string);
      const found = DANA_CHAT.find((message) => message['id'] === id);
      if (found === undefined) throw new VfsError('ENOENT', `No chat message ${id}.`);
      return found;
    }

    if (route === '/users') {
      const filter = decodeURIComponent(query.get('$filter') ?? '');
      const everyone = [ALEX, DANA, MORGAN, LENA, PRIYA];
      if (filter === '') return { value: everyone };
      const term = /startswith\(displayName,'([^']*)'\)/.exec(filter)?.[1] ?? '';
      return {
        value: everyone.filter((candidate) =>
          candidate.displayName.toLowerCase().startsWith(term.toLowerCase()),
        ),
      };
    }

    const manager = /^\/users\/([^/]+)\/manager$/.exec(route);
    if (manager !== null) {
      const found = MANAGERS[decodeURIComponent(manager[1] as string)];
      // Graph reports "this person is the top of the tree" as a 404, not as an empty body.
      if (found === undefined) throw new VfsError('ENOENT', 'No manager.');
      return { ...found };
    }

    const reports = /^\/users\/([^/]+)\/directReports$/.exec(route);
    if (reports !== null) {
      return { value: [...(REPORTS[decodeURIComponent(reports[1] as string)] ?? [])] };
    }

    throw new Error(`FakeGraph has no route for ${path}`);
  }
}

function splitOnce(value: string, separator: string): [string, string | undefined] {
  const at = value.indexOf(separator);
  return at === -1 ? [value, undefined] : [value.slice(0, at), value.slice(at + 1)];
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function context(): ProviderContext {
  return {
    mountPath: '/people',
    logger: NULL_LOGGER,
    state: new MemoryStateStore(),
    cacheDir: '.',
    secret: () => Promise.resolve(undefined),
  };
}

interface Harness {
  readonly provider: GraphPeopleProvider;
  readonly graph: FakeGraph;
}

async function harness(
  options: GraphPeopleOptions = {},
  fake: FakeOptions = {},
): Promise<Harness> {
  const graph = new FakeGraph(fake);
  const provider = new GraphPeopleProvider(options, context(), graph);
  await provider.init();
  return { provider, graph };
}

/** Walk a path of names from the mount root, using the same steps the engine would. */
async function walk(provider: GraphPeopleProvider, ...names: readonly string[]): Promise<VNode> {
  let parent: VNode | null = null;
  for (const name of names) {
    const resolved: VNode | undefined = await provider.resolveChild(parent, name);
    if (resolved !== undefined) {
      parent = resolved;
      continue;
    }
    const page = await provider.list(parent, {});
    const found = page.entries.find((entry) => entry.name === name);
    assert.ok(found !== undefined, `no child called "${name}" under ${parent?.name ?? '(root)'}`);
    parent = found;
  }
  assert.ok(parent !== null, 'walk needs at least one name');
  return parent;
}

async function names(provider: GraphPeopleProvider, ...path: readonly string[]): Promise<string[]> {
  const parent = path.length === 0 ? null : await walk(provider, ...path);
  const page = await provider.list(parent, {});
  return page.entries.map((entry) => entry.name);
}

/** The person nodes' titles, which is what a listing of people is really asserting about. */
async function titles(provider: GraphPeopleProvider, ...path: readonly string[]): Promise<string[]> {
  const parent = path.length === 0 ? null : await walk(provider, ...path);
  const page = await provider.list(parent, {});
  return page.entries.map((entry) => entry.title);
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

describe('graph-people: layout', () => {
  it('offers the sections in the order they are most likely to be wanted', async () => {
    const { provider } = await harness();
    assert.deepEqual(await names(provider), [
      'Me',
      'Org',
      'Reports',
      'Colleagues',
      'Recent',
      'External',
      'Directory',
    ]);
  });

  it('lists the root without touching the network', async () => {
    const { provider, graph } = await harness();
    await provider.list(null, {});
    assert.deepEqual(graph.requests, [], 'the mount root should cost nothing');
  });

  it('pages the root rather than over-serving a limit', async () => {
    const { provider } = await harness();
    const first = await provider.list(null, { limit: 2 });
    assert.equal(first.entries.length, 2);
    assert.ok(first.cursor !== undefined, 'a truncated root listing must hand back a cursor');

    const second = await provider.list(null, { limit: 2, cursor: first.cursor as string });
    assert.deepEqual(
      second.entries.map((entry) => entry.name),
      ['Reports', 'Colleagues'],
    );
  });

  it('treats a nonsense root cursor as the beginning rather than an error', async () => {
    const { provider } = await harness();
    const page = await provider.list(null, { limit: 1, cursor: 'not-a-real-cursor' });
    assert.deepEqual(page.entries.map((entry) => entry.name), ['Me']);
  });

  it('gives a person a profile file and the three hierarchy folders', async () => {
    const { provider } = await harness();
    const entries = await names(provider, 'Recent', 'Dana Whitfield');
    assert.deepEqual(entries.slice(0, 4), ['profile.md', 'manager', 'reports', 'peers']);
    assert.ok(entries.length > 4, 'a person should also list their communications');
  });

  it('makes Me the person, not a folder containing them', async () => {
    const { provider } = await harness();
    // `cd /people/Me` lands on Alex's own card, so `profile.md` is directly inside it.
    assert.deepEqual(await names(provider, 'Me'), ['profile.md', 'manager', 'reports', 'peers']);
  });

  it('does not list a conversation with yourself', async () => {
    const { provider } = await harness();
    const entries = await names(provider, 'Me');
    assert.ok(!entries.some((name) => name.includes('mail —')), entries.join(', '));
  });

  it('resolves the fixed child names without issuing a request', async () => {
    const { provider, graph } = await harness();
    const dana = await walk(provider, 'Recent', 'Dana Whitfield');
    const before = graph.requests.length;
    for (const name of ['profile.md', 'manager', 'reports', 'peers']) {
      assert.ok((await provider.resolveChild(dana, name)) !== undefined, name);
    }
    assert.equal(graph.requests.length, before, 'walking to a facet should not cost a round trip');
  });

  it('returns undefined for a child that does not exist', async () => {
    const { provider } = await harness();
    const dana = await walk(provider, 'Recent', 'Dana Whitfield');
    assert.equal(await provider.resolveChild(dana, 'grandmanager'), undefined);
  });
});

// ---------------------------------------------------------------------------
// The hierarchy
// ---------------------------------------------------------------------------

describe('graph-people: hierarchy', () => {
  it('walks up the management chain', async () => {
    const { provider } = await harness();
    assert.deepEqual(await titles(provider, 'Me', 'manager'), ['Dana Whitfield']);
    assert.deepEqual(await titles(provider, 'Me', 'manager', 'Dana Whitfield', 'manager'), ['Morgan Ellis']);
  });

  it('walks back down again, so the graph is genuinely navigable in both directions', async () => {
    const { provider } = await harness();
    assert.deepEqual(await titles(provider, 'Me', 'manager', 'Dana Whitfield', 'reports'), [
      'Alex Kimura',
      'Priya Raman',
    ]);
  });

  it('closes the cycle: your manager\'s reports contain you', async () => {
    const { provider } = await harness();
    const me = await walk(
      provider,
      'Me',
      'manager',
      'Dana Whitfield',
      'reports',
      'Alex Kimura',
      'manager',
      'Dana Whitfield',
    );
    assert.equal(me.title, 'Dana Whitfield');
  });

  it('excludes you from your own peers', async () => {
    const { provider } = await harness();
    assert.deepEqual(await titles(provider, 'Me', 'peers'), ['Priya Raman']);
  });

  it('lists Org top-most first and leaves it in hierarchy order', async () => {
    const { provider } = await harness();
    // Not priority order: the chain's meaning *is* its order, and re-ranking it by unread
    // count would put Dana above the director for a reason nobody asked about.
    assert.deepEqual(await titles(provider, 'Org'), ['Morgan Ellis', 'Dana Whitfield', 'Alex Kimura']);
  });

  it('treats the 404 at the top of the tree as an absence, not a failure', async () => {
    const { provider } = await harness();
    assert.deepEqual(await titles(provider, 'Org', 'Morgan Ellis', 'manager'), []);
  });

  it('honours maxChainDepth', async () => {
    const { provider } = await harness({ maxChainDepth: 1 });
    assert.deepEqual(await titles(provider, 'Org'), ['Dana Whitfield', 'Alex Kimura']);
  });

  it('lists your own reports', async () => {
    const { provider } = await harness();
    assert.deepEqual(await titles(provider, 'Reports'), ['Lena Osei']);
  });

  it('lists colleagues as everybody else reporting to your manager', async () => {
    const { provider } = await harness();
    assert.deepEqual(await titles(provider, 'Colleagues'), ['Priya Raman']);
  });
});

// ---------------------------------------------------------------------------
// Priority
// ---------------------------------------------------------------------------

describe('graph-people: priority ordering', () => {
  it('leads with what is owed, not with what is newest', async () => {
    const { provider } = await harness({ chats: false });
    const entries = await names(provider, 'Recent', 'Dana Whitfield');
    const comms = entries.slice(4).map(subjectOf);
    // Chronologically this is oldest-first — the exact opposite of a date sort.
    assert.deepEqual(comms, ['Budget question', 'Design review', 'Offsite plan', 'Offsite plan']);

    const page = await provider.list(await walk(provider, 'Recent', 'Dana Whitfield'), {});
    const flagged = page.entries.slice(4);
    assert.deepEqual(flagged[0]?.flags, ['unread', 'unanswered']);
    assert.deepEqual(flagged[1]?.flags, ['unanswered']);
    assert.equal(flagged[2]?.flags, undefined, 'a thread you answered owes nothing');
    assert.deepEqual(flagged[3]?.flags, ['sent']);
  });

  it('treats unanswered as a property of the thread, not of every message in it', async () => {
    const { provider } = await harness({ chats: false });
    const page = await provider.list(await walk(provider, 'Recent', 'Dana Whitfield'), {});
    const offsite = page.entries.filter((entry) => entry.title === 'Offsite plan');
    assert.equal(offsite.length, 2);
    // Dana wrote first and Alex replied, so neither message in that thread is owed a reply
    // even though one of them came from Dana.
    for (const entry of offsite) {
      assert.ok(!(entry.flags ?? []).includes('unanswered'), entry.name);
    }
  });

  it('exposes the rank as metadata so a client can group by it', async () => {
    const { provider } = await harness({ chats: false });
    const page = await provider.list(await walk(provider, 'Recent', 'Dana Whitfield'), {});
    const ranks = page.entries.slice(4).map((entry) => entry.meta?.['priority']);
    assert.deepEqual(ranks, [0, 1, 3, 4]);
    const sorted = [...ranks].sort((a, b) => Number(a) - Number(b));
    assert.deepEqual(ranks, sorted, 'entries must already be in priority order');
  });

  it('merges channels rather than grouping them, so a reply cannot hide in the other app', async () => {
    const { provider } = await harness();
    const page = await provider.list(await walk(provider, 'Recent', 'Dana Whitfield'), {});
    const comms = page.entries.slice(4);
    const channels = comms.map((entry) => entry.meta?.['channel']);
    assert.deepEqual(channels, ['chat', 'mail', 'mail', 'chat', 'mail', 'mail', 'chat']);
    assert.deepEqual(comms.map((entry) => entry.meta?.['priority']), [0, 0, 1, 2, 3, 4, 4]);
  });

  it('ranks a mention above ordinary traffic but below what is unanswered', async () => {
    const { provider } = await harness();
    const page = await provider.list(await walk(provider, 'Recent', 'Dana Whitfield'), {});
    const mention = page.entries.find((entry) => (entry.flags ?? []).includes('mention'));
    assert.ok(mention !== undefined, 'the mention should be flagged');
    assert.equal(mention.meta?.['priority'], 2);
  });

  it('orders people by what they are owed too', async () => {
    const { provider } = await harness();
    const page = await provider.list(await walk(provider, 'Recent'), {});
    assert.deepEqual(page.entries.map((entry) => entry.title), [
      'Dana Whitfield',
      'Jordan Reyes',
      'Priya Raman',
    ]);
    assert.deepEqual(page.entries[0]?.flags, ['unread', 'unanswered']);
    assert.deepEqual(page.entries[1]?.flags, ['unread', 'unanswered', 'external']);
    assert.equal(page.entries[2]?.flags, undefined);
  });

  it('counts unread across both channels on the person', async () => {
    const { provider } = await harness();
    const page = await provider.list(await walk(provider, 'Recent'), {});
    const dana = page.entries[0];
    assert.equal(dana?.unreadCount, 2);
    assert.equal(dana?.meta?.['unreadMail'], 1);
    assert.equal(dana?.meta?.['unreadChat'], 1);
  });

  it('does not attribute a group chat to a person in it', async () => {
    const { provider } = await harness();
    const page = await provider.list(await walk(provider, 'Colleagues'), {});
    const priya = page.entries.find((entry) => entry.title === 'Priya Raman');
    // Priya posted in the group chat more recently than anything else in the fixture; if
    // group chats counted, she would show unread here.
    assert.equal(priya?.meta?.['unreadChat'], 0);
    assert.equal(priya?.unreadCount, undefined);
  });

  it('caps a person\'s communications at commsPerPerson', async () => {
    const { provider } = await harness({ commsPerPerson: 2 });
    const entries = await names(provider, 'Recent', 'Dana Whitfield');
    assert.equal(entries.length, 4 + 2, entries.join(', '));
  });
});

// ---------------------------------------------------------------------------
// External correspondents
// ---------------------------------------------------------------------------

describe('graph-people: external correspondents', () => {
  it('lists somebody who exists only because they sent mail', async () => {
    const { provider } = await harness();
    assert.deepEqual(await titles(provider, 'External'), ['Jordan Reyes']);
  });

  it('does not offer hierarchy folders for somebody with no directory object', async () => {
    const { provider } = await harness();
    const entries = await names(provider, 'External', 'Jordan Reyes');
    assert.equal(entries[0], 'profile.md');
    assert.ok(!entries.includes('manager'), entries.join(', '));
    assert.ok(!entries.includes('reports'), entries.join(', '));
  });

  it('still shows their correspondence', async () => {
    const { provider } = await harness();
    const entries = await names(provider, 'External', 'Jordan Reyes');
    assert.deepEqual(entries.slice(1).map(subjectOf), ['Contract renewal']);
  });

  it('explains in the profile why there is nothing to walk', async () => {
    const { provider } = await harness();
    const profile = await walk(provider, 'External', 'Jordan Reyes', 'profile.md');
    const document = await provider.read(profile, {});
    assert.match(document.body, /Not in the directory/);
    assert.ok(document.headers.some(([label, value]) => label === 'Organisation' && value === 'external'));
  });
});

// ---------------------------------------------------------------------------
// The directory
// ---------------------------------------------------------------------------

describe('graph-people: directory', () => {
  it('pushes a free-text lookup into a startswith filter', async () => {
    const { provider, graph } = await harness();
    const directory = await walk(provider, 'Directory');
    const page = await provider.list(directory, { query: parseQuery('Lena') });
    assert.deepEqual(page.entries.map((entry) => entry.title), ['Lena Osei']);
    const request = graph.requests.find((path) => path.startsWith('/users?'));
    assert.ok(request !== undefined);
    assert.match(decodeURIComponent(request), /startswith\(displayName,'Lena'\)/);
  });

  it('never claims to have applied the query, because startswith is not contains', async () => {
    const { provider } = await harness();
    const directory = await walk(provider, 'Directory');
    const page = await provider.list(directory, { query: parseQuery('Lena') });
    // Over-claiming would stop the engine re-filtering, silently hiding anybody whose name
    // *contains* the term rather than starting with it.
    assert.equal(page.appliedQuery, undefined);
  });

  it('lists the directory unfiltered when no query is given', async () => {
    const { provider } = await harness();
    const page = await provider.list(await walk(provider, 'Directory'), {});
    assert.equal(page.entries.length, 5);
  });

  it('escapes a quote in the search term rather than breaking the filter', async () => {
    const { provider, graph } = await harness();
    const directory = await walk(provider, 'Directory');
    // Built by hand rather than parsed: the query language reads `'` as a quote character,
    // so the only way an apostrophe reaches the provider is from a `name:` term.
    await provider.list(directory, { query: { type: 'text', value: "O'Brien" } });
    const request = graph.requests.find((path) => path.includes('$filter'));
    assert.ok(request !== undefined);
    assert.match(decodeURIComponent(request), /startswith\(displayName,'O''Brien'\)/);
  });
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

describe('graph-people: reading', () => {
  it('renders a profile as markdown, because the node is called profile.md', async () => {
    const { provider } = await harness();
    const profile = await walk(provider, 'Me', 'profile.md');
    const document = await provider.read(profile, {});
    assert.equal(document.format, 'markdown');
    assert.equal(document.title, 'Alex Kimura');
    const labels = document.headers.map(([label]) => label);
    for (const expected of ['Name', 'Title', 'Mail', 'Manager', 'Reports', 'Organisation']) {
      assert.ok(labels.includes(expected), `${expected} missing from ${labels.join(', ')}`);
    }
    assert.ok(document.headers.some(([label, value]) => label === 'Manager' && value === 'Dana Whitfield'));
    assert.match(document.body, /- Lena Osei/);
  });

  it('summarises what is outstanding at the top of a profile', async () => {
    const { provider } = await harness();
    const profile = await walk(provider, 'Recent', 'Dana Whitfield', 'profile.md');
    const document = await provider.read(profile, {});
    assert.match(document.body, /^Outstanding: 1 unread mail;/);
    assert.match(document.body, /waiting on you/);
  });

  it('converts an HTML mail body to text', async () => {
    const { provider } = await harness({ chats: false });
    const page = await provider.list(await walk(provider, 'Recent', 'Dana Whitfield'), {});
    const message = page.entries[4] as VNode;
    const document = await provider.read(message, {});
    assert.equal(document.body.trim(), 'Body of Budget question.');
    assert.ok(!document.body.includes('<'), document.body);
    assert.equal(document.threadId, 'conv-budget');
    assert.ok(document.headers.some(([label, value]) => label === 'Channel' && value === 'mail'));
  });

  it('reads a chat message through its chat', async () => {
    const { provider } = await harness();
    const page = await provider.list(await walk(provider, 'Recent', 'Dana Whitfield'), {});
    const chat = page.entries.find((entry) => entry.subtype === 'chat-message') as VNode;
    const document = await provider.read(chat, {});
    assert.equal(document.body, 'Ping about the rollout');
    assert.equal(document.threadId, CHAT_ID);
    assert.ok(document.headers.some(([label, value]) => label === 'From' && value === 'Dana Whitfield'));
  });

  it('refuses to read a directory', async () => {
    const { provider } = await harness();
    const dana = await walk(provider, 'Recent', 'Dana Whitfield');
    await assert.rejects(
      () => provider.read(dana, {}),
      (error: unknown) => isVfsError(error) && error.code === 'EISDIR',
    );
  });
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

describe('graph-people: actions', () => {
  it('offers mail and chat on a person', async () => {
    const { provider } = await harness();
    const dana = await walk(provider, 'Recent', 'Dana Whitfield');
    const actions = await provider.actions(dana);
    assert.deepEqual(actions.map((action) => action.name), ['mail', 'chat', 'url']);
    const mail = actions[0];
    assert.deepEqual(mail?.params?.map((param) => param.name), ['subject', 'body']);
    assert.ok(mail?.params?.every((param) => param.required === true));
  });

  it('offers mark-as-read on an unread message and mark-as-unread on a read one', async () => {
    const { provider } = await harness({ chats: false });
    const page = await provider.list(await walk(provider, 'Recent', 'Dana Whitfield'), {});
    const unread = page.entries[4] as VNode;
    const read = page.entries[5] as VNode;
    assert.ok((await provider.actions(unread)).some((action) => action.name === 'read'));
    assert.ok((await provider.actions(read)).some((action) => action.name === 'unread'));
  });

  it('refuses to write when the mount is read-only, and says how to change that', async () => {
    const { provider, graph } = await harness();
    const dana = await walk(provider, 'Recent', 'Dana Whitfield');
    await assert.rejects(
      () => provider.invoke('mail', dana, { subject: 'Hello', body: 'Hi' }),
      (error: unknown) => {
        assert.ok(isVfsError(error));
        assert.equal(error.code, 'ENOTSUP');
        // Both halves matter: the config switch alone leaves you with a token that cannot
        // send, and the scope alone leaves you with a mount that will not try.
        assert.match(error.hint ?? '', /allowSend/);
        assert.match(error.hint ?? '', /Mail\.Send/);
        return true;
      },
    );
    assert.deepEqual(graph.writes, [], 'a refused action must not have written anything first');
  });

  it('still allows the read-only url action on a read-only mount', async () => {
    const { provider } = await harness();
    const dana = await walk(provider, 'Recent', 'Dana Whitfield');
    const result = await provider.invoke('url', dana, {});
    assert.equal(result.message, `mailto:${DANA_MAIL_ADDR}`);
  });

  it('sends mail to the person the node stands for', async () => {
    const { provider, graph } = await harness({ allowSend: true });
    const dana = await walk(provider, 'Recent', 'Dana Whitfield');
    const result = await provider.invoke('mail', dana, { subject: 'Budget', body: 'Numbers attached.' });
    assert.equal(result.ok, true);
    assert.equal(graph.writes.length, 1);
    const write = graph.writes[0] as Write;
    assert.equal(write.path, '/me/sendMail');
    const body = write.body as { message: { toRecipients: Array<{ emailAddress: { address: string } }> } };
    assert.equal(body.message.toRecipients[0]?.emailAddress.address, DANA_MAIL_ADDR);
  });

  it('requires the parameters it declared', async () => {
    const { provider } = await harness({ allowSend: true });
    const dana = await walk(provider, 'Recent', 'Dana Whitfield');
    await assert.rejects(
      () => provider.invoke('mail', dana, { subject: 'Budget' }),
      (error: unknown) => isVfsError(error) && error.code === 'EINVAL',
    );
  });

  it('reuses an existing one-to-one chat instead of starting a second one', async () => {
    const { provider, graph } = await harness({ allowSend: true });
    const dana = await walk(provider, 'Recent', 'Dana Whitfield');
    await provider.invoke('chat', dana, { body: 'On my way' });
    assert.deepEqual(graph.writes.map((write) => write.path), [`/chats/${CHAT_ID}/messages`]);
  });

  it('starts a chat when there is not one already', async () => {
    const { provider, graph } = await harness({ allowSend: true });
    const lena = await walk(provider, 'Reports', 'Lena Osei');
    await provider.invoke('chat', lena, { body: 'Welcome aboard' });
    assert.deepEqual(graph.writes.map((write) => write.path), ['/chats', '/chats/chat-new/messages']);
    const created = graph.writes[0]?.body as { chatType: string; members: Array<Record<string, unknown>> };
    assert.equal(created.chatType, 'oneOnOne');
    assert.equal(created.members.length, 2);
  });

  it('refuses to start a chat with somebody who has no directory object', async () => {
    const { provider, graph } = await harness({ allowSend: true });
    const jordan = await walk(provider, 'External', 'Jordan Reyes');
    await assert.rejects(
      () => provider.invoke('chat', jordan, { body: 'Hello' }),
      (error: unknown) => {
        assert.ok(isVfsError(error));
        assert.match(error.hint ?? '', /mail/);
        return true;
      },
    );
    assert.deepEqual(graph.writes, []);
  });

  it('replies on the channel the message arrived on', async () => {
    const { provider, graph } = await harness({ allowSend: true });
    const page = await provider.list(await walk(provider, 'Recent', 'Dana Whitfield'), {});
    const mail = page.entries.find((entry) => entry.subtype === 'message') as VNode;
    const chat = page.entries.find((entry) => entry.subtype === 'chat-message') as VNode;

    await provider.invoke('reply', mail, { body: 'Looking now' });
    await provider.invoke('reply', chat, { body: 'Same' });

    assert.deepEqual(graph.writes.map((write) => write.path), [
      '/me/messages/m1/reply',
      `/chats/${CHAT_ID}/messages`,
    ]);
  });

  it('marks mail read with a PATCH, not a POST', async () => {
    const { provider, graph } = await harness({ allowSend: true, chats: false });
    const page = await provider.list(await walk(provider, 'Recent', 'Dana Whitfield'), {});
    const unread = page.entries[4] as VNode;
    await provider.invoke('read', unread, {});
    assert.deepEqual(graph.writes, [{ method: 'PATCH', path: '/me/messages/m1', body: { isRead: true } }]);
  });

  it('rejects an unknown action', async () => {
    const { provider } = await harness({ allowSend: true });
    const dana = await walk(provider, 'Recent', 'Dana Whitfield');
    await assert.rejects(
      () => provider.invoke('teleport', dana, {}),
      (error: unknown) => isVfsError(error) && error.code === 'ENOTSUP',
    );
  });
});

// ---------------------------------------------------------------------------
// Request cost
// ---------------------------------------------------------------------------

describe('graph-people: request cost', () => {
  it('costs a fixed number of requests to rank people, not one per person', async () => {
    const { provider, graph } = await harness();
    await provider.list(await walk(provider, 'Recent'), {});
    // The signal index is three mailbox-wide requests shared by every row. Listing the
    // three people must not add per-person round trips on top.
    assert.equal(graph.countOf('/me/mailFolders/inbox/messages?$filter=isRead eq false&$top=100'), 1);
    assert.equal(graph.countOf('/me/mailFolders/sentitems/messages'), 1);
    assert.equal(graph.countOf('/me/chats?'), 1);
    assert.equal(graph.countOf('/me/messages?$search'), 0, 'listing people must not fetch their mail');
  });

  it('keeps the signal index warm across listings', async () => {
    const { provider, graph } = await harness({ signalTtlMs: 60_000 });
    await provider.list(await walk(provider, 'Recent'), {});
    const after = graph.countOf('/me/mailFolders/sentitems/messages');
    await provider.list(await walk(provider, 'Colleagues'), {});
    await provider.list(await walk(provider, 'Reports'), {});
    assert.equal(graph.countOf('/me/mailFolders/sentitems/messages'), after, 'the index should be cached');
  });

  it('rebuilds the signal index once the TTL has expired', async () => {
    const { provider, graph } = await harness({ signalTtlMs: 0 });
    await provider.list(await walk(provider, 'Recent'), {});
    const after = graph.countOf('/me/mailFolders/sentitems/messages');
    await provider.list(await walk(provider, 'Recent'), {});
    assert.ok(graph.countOf('/me/mailFolders/sentitems/messages') > after, 'a zero TTL should not cache');
  });

  it('fetches the signed-in user once, however much is asked of the mount', async () => {
    const { provider, graph } = await harness();
    await provider.list(await walk(provider, 'Org'), {});
    await provider.list(await walk(provider, 'Reports'), {});
    assert.equal(graph.countOf('/me?$select'), 1);
  });

  it('skips Teams entirely when chats are turned off', async () => {
    const { provider, graph } = await harness({ chats: false });
    await provider.list(await walk(provider, 'Recent', 'Dana Whitfield'), {});
    assert.equal(graph.countOf('/chats'), 0);
    assert.equal(graph.countOf('/me/chats'), 0);
  });
});

// ---------------------------------------------------------------------------
// Degradation
// ---------------------------------------------------------------------------

describe('graph-people: degradation', () => {
  it('still lists correspondents when the tenant withholds directory reads', async () => {
    const { provider } = await harness({}, { forbidden: ['/me/people'] });
    // `/me/people` is the nicest source, but unread senders are folded in regardless, so
    // the mount stays useful rather than failing.
    assert.deepEqual(await titles(provider, 'Recent'), ['Dana Whitfield', 'Jordan Reyes']);
  });

  it('survives a tenant that blocks the chat roster', async () => {
    const { provider } = await harness({}, { forbidden: ['/me/chats'] });
    const entries = await names(provider, 'Recent', 'Dana Whitfield');
    assert.deepEqual(entries.slice(4).map(subjectOf), [
      'Budget question',
      'Design review',
      'Offsite plan',
      'Offsite plan',
    ]);
  });

  it('treats a forbidden reports call as nobody rather than as an error', async () => {
    const { provider } = await harness({}, { forbidden: ['/directReports'] });
    assert.deepEqual(await titles(provider, 'Reports'), []);
    assert.deepEqual(await titles(provider, 'Me', 'peers'), []);
  });

  it('falls back to a from-filter when mailbox search is disabled', async () => {
    const { provider, graph } = await harness({ chats: false }, { rejected: ['$search'] });
    const entries = await names(provider, 'Recent', 'Dana Whitfield');
    assert.ok(entries.length > 4, 'the fallback should still return mail');
    assert.equal(graph.countOf('$filter=from%2FemailAddress%2Faddress'), 1);
  });

  it('degrades the user property set rather than the request when $select is refused', async () => {
    // `User.ReadBasic.All` answers a rich `$select` with a flat 403 rather than by omitting
    // the fields, so the retry is the difference between a working mount and no mount.
    const { provider, graph } = await harness({}, { forbidden: ['jobTitle'] });
    assert.deepEqual(await titles(provider, 'Org'), ['Morgan Ellis', 'Dana Whitfield', 'Alex Kimura']);
    assert.ok(graph.requests.some((path) => path.includes('$select=id,displayName,mail,userPrincipalName')));
  });

  it('reports a listing as empty rather than throwing when everything is forbidden', async () => {
    const { provider } = await harness({}, { forbidden: ['/me/people', '/me/mailFolders', '/me/chats'] });
    assert.deepEqual(await titles(provider, 'Recent'), []);
  });
});

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

describe('graph-people: polling', () => {
  it('reports no changes on a cold start but hands back a resumable cursor', async () => {
    const { provider } = await harness();
    const dana = await walk(provider, 'Recent', 'Dana Whitfield');
    const first = await provider.poll(dana, undefined, {});
    assert.deepEqual(first.changes, []);
    assert.ok(typeof first.cursor === 'string' && !Number.isNaN(Date.parse(first.cursor)));
  });

  it('reports nothing new when polled again with its own cursor', async () => {
    const { provider } = await harness();
    const dana = await walk(provider, 'Recent', 'Dana Whitfield');
    const first = await provider.poll(dana, undefined, {});
    const second = await provider.poll(dana, first.cursor, {});
    assert.deepEqual(second.changes, []);
    assert.equal(second.cursor, first.cursor);
  });

  it('reports what arrived after an older cursor, and never your own messages', async () => {
    const { provider } = await harness();
    const dana = await walk(provider, 'Recent', 'Dana Whitfield');
    const result = await provider.poll(dana, '2026-08-09T12:00:00Z', {});
    const nodes = result.changes.map((change) => change.node).filter((node): node is VNode => node !== undefined);
    assert.equal(nodes.length, result.changes.length, 'every change should carry its node');
    assert.deepEqual(nodes.map((node) => node.title), ['Ping about the rollout', 'Design review', 'Offsite plan']);
    for (const node of nodes) {
      assert.ok(!(node.flags ?? []).includes('sent'), node.name);
    }
  });

  it('treats an unparseable cursor as a cold start rather than a crash', async () => {
    const { provider } = await harness();
    const dana = await walk(provider, 'Recent', 'Dana Whitfield');
    const result = await provider.poll(dana, 'v1|not-a-date', {});
    assert.deepEqual(result.changes, []);
    assert.ok(typeof result.cursor === 'string');
  });

  it('refuses to watch something with no notion of arrival', async () => {
    const { provider } = await harness();
    const profile = await walk(provider, 'Me', 'profile.md');
    await assert.rejects(
      () => provider.poll(profile, undefined, {}),
      (error: unknown) => isVfsError(error) && error.code === 'ENOTSUP',
    );
  });

  it('answers at the mount root, where the sections never change', async () => {
    const { provider } = await harness();
    const result = await provider.poll(null, undefined, {});
    assert.deepEqual(result.changes, []);
    assert.ok(typeof result.cursor === 'string');
  });

  it('watches a whole section, reporting only people who wrote to you', async () => {
    const { provider } = await harness();
    const recent = await walk(provider, 'Recent');
    const result = await provider.poll(recent, '2026-08-11T15:00:00Z', {});
    // Dana's chat landed at 16:00, Jordan's mail at 14:00, and Alex's own outgoing mail at
    // 12:00 must not register at all.
    assert.deepEqual(
      result.changes.map((change) => change.node?.title),
      ['Dana Whitfield'],
    );
  });

  it('does not report a section change for your own outgoing mail', async () => {
    const { provider } = await harness({ chats: false });
    const recent = await walk(provider, 'Recent');
    // With chats off, Dana's newest activity is Alex's own 12:00 send; only Jordan's
    // inbound 14:00 mail counts as news.
    const result = await provider.poll(recent, '2026-08-11T13:00:00Z', {});
    assert.deepEqual(
      result.changes.map((change) => change.node?.title),
      ['Jordan Reyes'],
    );
  });
});

// ---------------------------------------------------------------------------
// The shared provider contract
// ---------------------------------------------------------------------------

describe('conformance: graph-people provider', () => {
  for (const testCase of conformanceTests({
    create: () => new GraphPeopleProvider({}, context(), new FakeGraph()),
    offlineOnly: true,
    sampleQuery: 'is:unanswered',
  })) {
    it(testCase.name, () => testCase.run());
  }
});

/** Pull the subject back out of a generated file name, which carries date and channel. */
function subjectOf(name: string): string {
  const dash = name.indexOf(' — ');
  const trimmed = dash === -1 ? name : name.slice(dash + 3);
  return trimmed.replace(/\.(eml|md)$/, '');
}
