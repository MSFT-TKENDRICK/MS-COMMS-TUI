/**
 * The people graph as a filesystem.
 *
 * The other providers are organised around *where a message lives* — a mail folder, a
 * channel, a feed. That is the right shape for triage and the wrong shape for the question
 * people actually ask most often, which is not "what is in my inbox" but "what do I owe
 * Dana, and who is Dana anyway".
 *
 * So this mount is organised around *who*:
 *
 *   /people/Me/                                 the signed-in user
 *   /people/Org/<person>/                       the management chain, top-most first
 *   /people/Reports/<person>/                   direct reports
 *   /people/Colleagues/<person>/                everyone else reporting to your manager
 *   /people/Recent/<person>/                    people you actually correspond with
 *   /people/External/<person>/                  the subset of those outside your tenant
 *   /people/Directory/<person>/                 the tenant directory
 *
 * and a person is a directory:
 *
 *   /people/Recent/Dana Whitfield/
 *     profile.md                                job title, department, office, contacts
 *     manager/                                  a directory containing one person
 *     reports/                                  their direct reports
 *     peers/                                    the other reports of their manager
 *     2026-08-11T09-12 mail — FY26 budget.eml   unread
 *     2026-08-10T16-40 chat — can you look…md   unanswered
 *     …
 *
 * THREE DECISIONS ARE WORTH EXPLAINING.
 *
 * 1. THE COMMUNICATIONS ARE MERGED AND PRIORITY-ORDERED, NOT GROUPED BY CHANNEL.
 *    Sorting a person's messages into `mail/` and `chat/` subfolders reproduces exactly the
 *    problem the user has in the first place: the reason a reply gets missed is that it is
 *    in the channel they were not looking at. One list, newest-and-most-owed first, is the
 *    entire point. The rank is: unread, then unanswered (they spoke last in a thread and
 *    you have not replied), then messages that mention you, then everything else — and
 *    within each rank, newest first. Every rank is also a flag, so `is:unanswered` works,
 *    and `ls -l` states the reason in words rather than in colour.
 *
 * 2. THE HIERARCHY IS CYCLIC AND THAT IS DELIBERATE.
 *    `manager/` and `reports/` point at each other, so the tree is really a graph and
 *    `/people/Me/manager/…/reports/…` eventually comes back to you. That is what makes it
 *    navigable in both directions, which is the whole request. The engine's recursive walk
 *    is depth- and node-bounded, so `find` terminates; `tree` takes an explicit `--depth`.
 *    `Org/` exists so the common case — "who is above me" — is one flat listing rather than
 *    a climb.
 *
 * 3. THERE IS NO SERVER-SIDE `search`, ON PURPOSE.
 *    Declaring the capability would replace the engine's breadth-first walk for *every*
 *    `find` under this mount, and Graph has no single endpoint that can answer "unanswered
 *    messages from anyone in my org" — so the provider would have to quietly return less
 *    than the user asked for. Instead, `Directory` pushes a free-text query down into
 *    `$filter`, which is the one case Graph genuinely indexes: `ls /people/Directory -q
 *    dana` is a real directory lookup, and `find` still walks correctly everywhere else.
 */

import {
  VfsError,
  isVfsError,
  timestampPrefix,
  type ActionDescriptor,
  type ActionResult,
  type Capability,
  type ChangeEvent,
  type Document,
  type ListOptions,
  type ListPage,
  type MetaValue,
  type PollResult,
  type Provider,
  type ProviderContext,
  type ProviderPlugin,
  type Query,
  type ReadOptions,
  type VNode,
} from '@mscomms/core';
import type { GraphApi } from './client.js';
import { createClient, releaseClient, htmlToText, preview, type GraphSharedOptions } from './shared.js';

export interface GraphPeopleOptions extends GraphSharedOptions {
  readonly pageSize?: number;
  /** How many communications to merge into one person's listing. */
  readonly commsPerPerson?: number;
  /**
   * Enable the actions that write: sending mail, sending a chat, replying, marking read.
   *
   * Off by default, exactly as `graph-mail` is read-only by default. A tool that reads
   * corporate mail is easy to justify installing; a tool that can send mail as you is a
   * different conversation, and it should be one the user opts into rather than discovers.
   */
  readonly allowSend?: boolean;
  /** Include Teams chat in the merge. Turn off when the tenant blocks `Chat.Read`. */
  readonly chats?: boolean;
  /** How long the cheap cross-person signal index stays warm. */
  readonly signalTtlMs?: number;
  /** Safety valve on the climb up the management chain. */
  readonly maxChainDepth?: number;
}

// ---------------------------------------------------------------------------
// Graph shapes
// ---------------------------------------------------------------------------

interface GraphUser {
  readonly id: string;
  readonly displayName: string | null;
  readonly mail: string | null;
  readonly userPrincipalName: string | null;
  readonly jobTitle?: string | null;
  readonly department?: string | null;
  readonly officeLocation?: string | null;
  readonly mobilePhone?: string | null;
  readonly businessPhones?: readonly string[];
  readonly city?: string | null;
  readonly country?: string | null;
  readonly companyName?: string | null;
}

interface GraphRelevantPerson {
  readonly id: string | null;
  readonly displayName: string | null;
  readonly jobTitle: string | null;
  readonly companyName: string | null;
  readonly department: string | null;
  readonly officeLocation: string | null;
  readonly scoredEmailAddresses?: ReadonlyArray<{ address?: string; relevanceScore?: number }>;
  readonly personType?: { class?: string; subclass?: string };
}

interface EmailAddress {
  readonly name?: string;
  readonly address?: string;
}

interface MailMessage {
  readonly id: string;
  readonly subject: string | null;
  readonly bodyPreview: string | null;
  readonly receivedDateTime: string;
  readonly sentDateTime?: string | null;
  readonly isRead: boolean;
  readonly isDraft?: boolean;
  readonly hasAttachments?: boolean;
  readonly importance?: string;
  readonly conversationId: string | null;
  readonly webLink?: string | null;
  readonly from?: { emailAddress?: EmailAddress };
  readonly sender?: { emailAddress?: EmailAddress };
  readonly toRecipients?: ReadonlyArray<{ emailAddress?: EmailAddress }>;
  readonly ccRecipients?: ReadonlyArray<{ emailAddress?: EmailAddress }>;
  readonly body?: { contentType?: string; content?: string };
  readonly flag?: { flagStatus?: string };
}

interface ChatMessage {
  readonly id: string;
  readonly messageType?: string;
  readonly createdDateTime: string;
  readonly deletedDateTime?: string | null;
  readonly subject?: string | null;
  readonly importance?: string;
  readonly webUrl?: string | null;
  readonly from?: { user?: { id?: string; displayName?: string }; application?: { displayName?: string } };
  readonly body?: { contentType?: string; content?: string };
  readonly mentions?: ReadonlyArray<{ mentioned?: { user?: { id?: string } } }>;
}

interface ChatMember {
  readonly userId?: string | null;
  readonly displayName?: string | null;
  readonly email?: string | null;
}

interface Chat {
  readonly id: string;
  readonly topic: string | null;
  readonly chatType: string;
  readonly webUrl?: string | null;
  readonly lastUpdatedDateTime?: string | null;
  readonly members?: readonly ChatMember[];
  readonly viewpoint?: { lastMessageReadDateTime?: string | null; isHidden?: boolean };
  readonly lastMessagePreview?: {
    id?: string;
    createdDateTime?: string;
    body?: { content?: string; contentType?: string };
    from?: { user?: { id?: string; displayName?: string } };
  };
}

// ---------------------------------------------------------------------------
// The person model
// ---------------------------------------------------------------------------

/**
 * A person, whether or not they exist in the tenant directory.
 *
 * `key` is the identity the whole provider indexes by, and it has two forms because the
 * two populations are genuinely different: colleagues have a stable directory object id,
 * while somebody at a supplier who mailed you once has nothing but an address. Collapsing
 * them into one shape would mean either dropping external correspondents — half the point
 * of the mount — or inventing directory ids that do not exist.
 */
interface Person {
  readonly key: string;
  readonly displayName: string;
  readonly userId?: string;
  readonly address?: string;
  readonly jobTitle?: string;
  readonly department?: string;
  readonly officeLocation?: string;
  readonly companyName?: string;
  readonly phones?: readonly string[];
  readonly city?: string;
  readonly external: boolean;
}

function aadKey(userId: string): string {
  return `aad:${userId}`;
}

function smtpKey(address: string): string {
  return `smtp:${address.trim().toLowerCase()}`;
}

/** Every identifier a person might be recognised by, for signal lookups. */
function keysOf(person: Person): string[] {
  const keys: string[] = [person.key];
  if (person.userId !== undefined) keys.push(aadKey(person.userId));
  if (person.address !== undefined) keys.push(smtpKey(person.address));
  return keys;
}

function domainOf(address: string | undefined): string {
  if (address === undefined) return '';
  const at = address.lastIndexOf('@');
  return at === -1 ? '' : address.slice(at + 1).toLowerCase();
}

function personFromUser(user: GraphUser, homeDomains: ReadonlySet<string>): Person {
  const address = user.mail ?? user.userPrincipalName ?? undefined;
  const phones = (user.businessPhones ?? []).filter((phone) => phone.length > 0);
  if (user.mobilePhone !== null && user.mobilePhone !== undefined && user.mobilePhone !== '') {
    phones.push(user.mobilePhone);
  }
  return {
    key: aadKey(user.id),
    displayName: user.displayName ?? address ?? user.id,
    userId: user.id,
    ...(address === undefined ? {} : { address }),
    ...(nullable(user.jobTitle) === undefined ? {} : { jobTitle: user.jobTitle as string }),
    ...(nullable(user.department) === undefined ? {} : { department: user.department as string }),
    ...(nullable(user.officeLocation) === undefined ? {} : { officeLocation: user.officeLocation as string }),
    ...(nullable(user.companyName) === undefined ? {} : { companyName: user.companyName as string }),
    ...(nullable(user.city) === undefined ? {} : { city: user.city as string }),
    ...(phones.length === 0 ? {} : { phones }),
    // A directory object is only "external" when its address is not one of ours; guests in
    // the tenant have a directory id but a foreign domain, and calling them internal would
    // be actively misleading in a listing.
    external: homeDomains.size > 0 && !homeDomains.has(domainOf(address)),
  };
}

function personFromRelevant(entry: GraphRelevantPerson, homeDomains: ReadonlySet<string>): Person | undefined {
  const address = (entry.scoredEmailAddresses ?? []).find((e) => (e.address ?? '') !== '')?.address;
  const name = nullable(entry.displayName) ?? address;
  if (name === undefined) return undefined;
  const userId = nullable(entry.id);
  const external =
    entry.personType?.subclass === 'PersonalContact' ||
    entry.personType?.subclass === 'Guest' ||
    (homeDomains.size > 0 && !homeDomains.has(domainOf(address)));
  return {
    key: userId === undefined ? smtpKey(address ?? name) : aadKey(userId),
    displayName: name,
    ...(userId === undefined ? {} : { userId }),
    ...(address === undefined ? {} : { address }),
    ...(nullable(entry.jobTitle) === undefined ? {} : { jobTitle: entry.jobTitle as string }),
    ...(nullable(entry.department) === undefined ? {} : { department: entry.department as string }),
    ...(nullable(entry.officeLocation) === undefined ? {} : { officeLocation: entry.officeLocation as string }),
    ...(nullable(entry.companyName) === undefined ? {} : { companyName: entry.companyName as string }),
    external,
  };
}

function personFromAddress(address: EmailAddress | undefined, homeDomains: ReadonlySet<string>): Person | undefined {
  const mail = address?.address;
  if (mail === undefined || mail === '') return undefined;
  return {
    key: smtpKey(mail),
    displayName: address?.name !== undefined && address.name !== '' ? address.name : mail,
    address: mail,
    external: homeDomains.size > 0 && !homeDomains.has(domainOf(mail)),
  };
}

function nullable(value: string | null | undefined): string | undefined {
  return value === null || value === undefined || value === '' ? undefined : value;
}

// ---------------------------------------------------------------------------
// Communications
// ---------------------------------------------------------------------------

type Channel = 'mail' | 'chat';

interface Comm {
  readonly id: string;
  readonly channel: Channel;
  readonly title: string;
  readonly at: Date;
  readonly fromMe: boolean;
  readonly unread: boolean;
  readonly mention: boolean;
  readonly threadKey: string;
  readonly author: string;
  readonly authorId?: string;
  readonly summary?: string;
  readonly extraFlags?: readonly string[];
  readonly meta: Readonly<Record<string, MetaValue>>;
}

/** The rank a communication is listed at. Lower sorts first. */
const RANK_UNREAD = 0;
const RANK_UNANSWERED = 1;
const RANK_MENTION = 2;
const RANK_OTHER = 3;
const RANK_SENT = 4;

/**
 * Decide what is owed, then order by it.
 *
 * "Unanswered" is a property of a *thread*, not of a message: a colleague who sent four
 * messages in a row is owed one reply, and flagging all four would drown the genuinely
 * distinct conversations underneath them. So the newest message in each thread is examined,
 * and it is unanswered only if it came from them.
 */
function rankComms(comms: readonly Comm[]): VNode[] {
  const newestInThread = new Map<string, Comm>();
  for (const comm of comms) {
    const seen = newestInThread.get(comm.threadKey);
    if (seen === undefined || comm.at.getTime() > seen.at.getTime()) newestInThread.set(comm.threadKey, comm);
  }

  const unanswered = new Set<string>();
  for (const comm of newestInThread.values()) {
    if (!comm.fromMe) unanswered.add(comm.id);
  }

  const ranked = comms.map((comm) => {
    const isUnanswered = unanswered.has(comm.id);
    const rank = comm.unread
      ? RANK_UNREAD
      : isUnanswered
        ? RANK_UNANSWERED
        : comm.mention
          ? RANK_MENTION
          : comm.fromMe
            ? RANK_SENT
            : RANK_OTHER;
    return { comm, rank, unanswered: isUnanswered };
  });

  ranked.sort((a, b) => (a.rank === b.rank ? b.comm.at.getTime() - a.comm.at.getTime() : a.rank - b.rank));

  return ranked.map(({ comm, rank, unanswered: isUnanswered }) => {
    const flags: string[] = [...(comm.extraFlags ?? [])];
    if (comm.unread) flags.push('unread');
    if (isUnanswered) flags.push('unanswered');
    if (comm.mention) flags.push('mention');
    if (comm.fromMe) flags.push('sent');

    const extension = comm.channel === 'mail' ? '.eml' : '.md';
    return {
      name: `${timestampPrefix(comm.at, true)} ${comm.channel} — ${comm.title}${extension}`,
      kind: 'file' as const,
      subtype: comm.channel === 'mail' ? 'message' : 'chat-message',
      title: comm.title,
      id: `${comm.channel}:${comm.id}`,
      mtime: comm.at,
      ...(flags.length === 0 ? {} : { flags }),
      ...(comm.summary === undefined ? {} : { summary: comm.summary }),
      author: comm.author,
      ...(comm.authorId === undefined ? {} : { authorId: comm.authorId }),
      meta: { ...comm.meta, channel: comm.channel, priority: rank, direction: comm.fromMe ? 'sent' : 'received' },
    };
  });
}

// ---------------------------------------------------------------------------
// The cross-person signal index
// ---------------------------------------------------------------------------

/**
 * What is known about a person from three cheap, mailbox-wide requests.
 *
 * It exists so that *listing people* can be priority-ordered too. Working it out per person
 * would mean one request per row, which turns `ls /people/Recent` into thirty round trips;
 * working it out from unread mail, the chat roster and recent sent items costs three, and
 * they are shared by every listing until the TTL expires.
 */
interface Signal {
  unreadMail: number;
  unreadChat: number;
  lastInboundAt?: number;
  lastOutboundAt?: number;
  chatId?: string;
  chatTopic?: string;
}

interface SignalIndex {
  readonly byKey: Map<string, Signal>;
  readonly at: number;
}

function emptySignal(): Signal {
  return { unreadMail: 0, unreadChat: 0 };
}

function signalFor(index: SignalIndex, person: Person): Signal | undefined {
  for (const key of keysOf(person)) {
    const found = index.byKey.get(key);
    if (found !== undefined) return found;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const USER_SELECT =
  'id,displayName,mail,userPrincipalName,jobTitle,department,officeLocation,mobilePhone,businessPhones,city,country,companyName';
const USER_SELECT_BASIC = 'id,displayName,mail,userPrincipalName';
const MAIL_SELECT =
  'id,subject,bodyPreview,receivedDateTime,sentDateTime,isRead,hasAttachments,importance,conversationId,from,toRecipients,flag,webLink';

const SECTIONS: ReadonlyArray<{ name: string; section: string; summary: string }> = [
  { name: 'Me', section: 'me', summary: 'You: your profile, your manager and your reports.' },
  { name: 'Org', section: 'org', summary: 'Your management chain, top-most first.' },
  { name: 'Reports', section: 'reports', summary: 'People who report to you.' },
  { name: 'Colleagues', section: 'colleagues', summary: 'Everyone else who reports to your manager.' },
  { name: 'Recent', section: 'recent', summary: 'People you correspond with, most owed first.' },
  { name: 'External', section: 'external', summary: 'Correspondents outside your organisation.' },
  { name: 'Directory', section: 'directory', summary: 'The tenant directory. Use `ls -q <name>` to look someone up.' },
];

export class GraphPeopleProvider implements Provider {
  readonly id: string;
  readonly displayName = 'People';
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(['list', 'read', 'poll', 'actions']);

  readonly #options: GraphPeopleOptions;
  readonly #context: ProviderContext;
  #client: GraphApi | undefined;
  /** A client handed in by a test is not ours to release. */
  #ownsClient = false;
  #me: Promise<Person> | undefined;
  #signals: Promise<SignalIndex> | undefined;
  #people = new Map<string, Person>();

  constructor(options: GraphPeopleOptions, context: ProviderContext, client?: GraphApi) {
    this.#options = options;
    this.#context = context;
    this.id = `graph-people:${context.mountPath}`;
    this.#client = client;
  }

  async init(): Promise<void> {
    if (this.#client !== undefined) return;
    this.#client = createClient(this.#options, this.#context.state, this.#context.logger);
    this.#ownsClient = true;
  }

  /** Release the shared MCP server so a one-shot command can exit. See the mail provider. */
  async dispose(): Promise<void> {
    if (!this.#ownsClient) return;
    this.#ownsClient = false;
    this.#client = undefined;
    releaseClient(this.#options);
  }

  get #api(): GraphApi {
    if (this.#client === undefined) throw VfsError.config('The people mount was not initialised.');
    return this.#client;
  }

  get #commsPerPerson(): number {
    return Math.max(1, Math.min(this.#options.commsPerPerson ?? 25, 100));
  }

  // -------------------------------------------------------------------------
  // Identity
  // -------------------------------------------------------------------------

  async #self(): Promise<Person> {
    this.#me ??= (async () => {
      const user = await this.#getUser('/me');
      const person = personFromUser(user, new Set());
      const home = domainOf(person.address);
      return home === '' ? person : { ...person, external: false };
    })().catch((error: unknown) => {
      this.#me = undefined;
      throw error;
    });
    return this.#me;
  }

  async #homeDomains(): Promise<ReadonlySet<string>> {
    const me = await this.#self();
    const domain = domainOf(me.address);
    return domain === '' ? new Set<string>() : new Set([domain]);
  }

  /**
   * Fetch a user, degrading the property set rather than the request.
   *
   * `User.ReadBasic.All` — the scope a user can consent to without an administrator — does
   * not cover job title, department or office, and Graph answers a `$select` naming them
   * with a flat 403 rather than by omitting them. Asking for everything and retrying with
   * the basics means a tenant that grants only the basic scope gets names and addresses
   * instead of an unusable mount, and one that grants `User.Read.All` gets the full card.
   */
  async #getUser(path: string, signal?: AbortSignal): Promise<GraphUser> {
    const options = signal === undefined ? {} : { signal };
    try {
      return await this.#api.get<GraphUser>(`${path}?$select=${USER_SELECT}`, options);
    } catch (error) {
      if (isVfsError(error) && error.code === 'EACCES') {
        this.#context.logger.debug('falling back to the basic user property set', { path });
        return this.#api.get<GraphUser>(`${path}?$select=${USER_SELECT_BASIC}`, options);
      }
      throw error;
    }
  }

  #remember(person: Person): Person {
    for (const key of keysOf(person)) this.#people.set(key, person);
    return person;
  }

  /** Recover the full person behind a node, which may have been produced long ago. */
  async #personOf(node: VNode): Promise<Person> {
    const key = typeof node.meta?.['personKey'] === 'string' ? (node.meta['personKey'] as string) : undefined;
    if (key === undefined) throw VfsError.invalid(`"${node.name}" is not a person.`);

    const known = this.#people.get(key);
    if (known !== undefined) return known;

    // Rebuilt from the node itself: a node survives a restart in the engine's cache, and
    // it carries everything needed to act on the person even when this process has never
    // fetched them.
    const meta = node.meta ?? {};
    const userId = typeof meta['userId'] === 'string' ? meta['userId'] : undefined;
    const address = typeof meta['address'] === 'string' ? meta['address'] : undefined;
    const person: Person = {
      key,
      displayName: node.title,
      ...(userId === undefined ? {} : { userId }),
      ...(address === undefined ? {} : { address }),
      ...(typeof meta['jobTitle'] === 'string' ? { jobTitle: meta['jobTitle'] } : {}),
      ...(typeof meta['department'] === 'string' ? { department: meta['department'] } : {}),
      ...(typeof meta['officeLocation'] === 'string' ? { officeLocation: meta['officeLocation'] } : {}),
      ...(typeof meta['companyName'] === 'string' ? { companyName: meta['companyName'] } : {}),
      external: meta['external'] === true,
    };
    return this.#remember(person);
  }

  // -------------------------------------------------------------------------
  // Signals
  // -------------------------------------------------------------------------

  async #signalIndex(signal?: AbortSignal): Promise<SignalIndex> {
    const ttl = this.#options.signalTtlMs ?? 60_000;
    const pending = this.#signals;
    if (pending !== undefined) {
      const resolved = await pending.catch(() => undefined);
      if (resolved !== undefined && Date.now() - resolved.at < ttl) return resolved;
    }

    this.#signals = this.#buildSignals(signal).catch((error: unknown) => {
      this.#signals = undefined;
      throw error;
    });
    return this.#signals;
  }

  async #buildSignals(signal?: AbortSignal): Promise<SignalIndex> {
    const options = signal === undefined ? {} : { signal };
    const byKey = new Map<string, Signal>();
    const touch = (key: string): Signal => {
      let entry = byKey.get(key);
      if (entry === undefined) {
        entry = emptySignal();
        byKey.set(key, entry);
      }
      return entry;
    };
    /**
     * One entry shared by every identifier a person is known by.
     *
     * The two sources name the same human differently: the mailbox only ever knows an
     * address, while the chat roster hands back a directory id. Left as separate entries
     * they become two half-people — a colleague with unread mail under one key and unread
     * chat under another, so whichever the lookup happened to find first was the only half
     * that got counted.
     */
    const alias = (keys: readonly string[]): Signal => {
      let entry: Signal | undefined;
      for (const key of keys) {
        const found = byKey.get(key);
        if (found !== undefined) {
          entry = found;
          break;
        }
      }
      entry ??= emptySignal();
      for (const key of keys) byKey.set(key, entry);
      return entry;
    };
    const inbound = (entry: Signal, at: number): void => {
      if (entry.lastInboundAt === undefined || at > entry.lastInboundAt) entry.lastInboundAt = at;
    };
    const outbound = (entry: Signal, at: number): void => {
      if (entry.lastOutboundAt === undefined || at > entry.lastOutboundAt) entry.lastOutboundAt = at;
    };

    const unread = await this.#degrade(
      () =>
        this.#api.getPage<MailMessage>(
          `/me/mailFolders/inbox/messages?$filter=isRead eq false&$top=100&$select=id,from,receivedDateTime,conversationId`,
          options,
        ),
      'unread mail',
    );
    for (const message of unread?.value ?? []) {
      const address = message.from?.emailAddress?.address;
      if (address === undefined || address === '') continue;
      const entry = touch(smtpKey(address));
      entry.unreadMail += 1;
      inbound(entry, Date.parse(message.receivedDateTime));
    }

    const sent = await this.#degrade(
      () =>
        this.#api.getPage<MailMessage>(
          `/me/mailFolders/sentitems/messages?$top=100&$orderby=sentDateTime desc&$select=id,toRecipients,ccRecipients,sentDateTime,receivedDateTime,conversationId`,
          options,
        ),
      'sent mail',
    );
    for (const message of sent?.value ?? []) {
      const at = Date.parse(message.sentDateTime ?? message.receivedDateTime);
      if (!Number.isFinite(at)) continue;
      for (const recipient of [...(message.toRecipients ?? []), ...(message.ccRecipients ?? [])]) {
        const address = recipient.emailAddress?.address;
        if (address !== undefined && address !== '') outbound(touch(smtpKey(address)), at);
      }
    }

    if (this.#options.chats !== false) {
      const me = await this.#self();
      for (const chat of await this.#chatRoster(signal)) {
        const others = (chat.members ?? []).filter(
          (member) => nullable(member.userId) !== undefined && member.userId !== me.userId,
        );
        // Group chats deliberately do not attribute to a person: "Dana has unread messages"
        // must mean Dana wrote to you, not that a thirty-person chat Dana is also in moved.
        if (chat.chatType !== 'oneOnOne' || others.length !== 1) continue;
        const other = others[0] as ChatMember;
        const keys = [aadKey(other.userId as string)];
        const email = nullable(other.email);
        if (email !== undefined) keys.push(smtpKey(email));

        const last = chat.lastMessagePreview;
        const at = last?.createdDateTime === undefined ? NaN : Date.parse(last.createdDateTime);
        const readUpTo =
          chat.viewpoint?.lastMessageReadDateTime === null || chat.viewpoint?.lastMessageReadDateTime === undefined
            ? undefined
            : Date.parse(chat.viewpoint.lastMessageReadDateTime);
        const fromMe = last?.from?.user?.id === me.userId;

        const entry = alias(keys);
        entry.chatId = chat.id;
        if (nullable(chat.topic) !== undefined) entry.chatTopic = chat.topic as string;
        if (!Number.isFinite(at)) continue;
        if (fromMe) outbound(entry, at);
        else {
          inbound(entry, at);
          if (readUpTo === undefined || at > readUpTo) entry.unreadChat += 1;
        }
      }
    }

    return { byKey, at: Date.now() };
  }

  #chats: Promise<readonly Chat[]> | undefined;

  async #chatRoster(signal?: AbortSignal): Promise<readonly Chat[]> {
    this.#chats ??= (async () => {
      const page = await this.#degrade(
        () =>
          this.#api.getPage<Chat>(
            '/me/chats?$expand=members&$top=50',
            signal === undefined ? {} : { signal },
          ),
        'the chat roster',
      );
      return page?.value ?? [];
    })().catch((error: unknown) => {
      this.#chats = undefined;
      throw error;
    });
    return this.#chats;
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  async list(parent: VNode | null, options: ListOptions): Promise<ListPage> {
    if (parent === null) {
      // The sections are a fixed, tiny list, but they still have to page: the shared
      // conformance suite asks for two entries and means it, and a mount that quietly
      // returns seven when asked for two is a mount the engine cannot budget for.
      const start = sectionCursor(options.cursor);
      const limit = Math.max(1, options.limit ?? SECTIONS.length);
      const window = SECTIONS.slice(start, start + limit);
      const end = start + window.length;
      return {
        entries: window.map((section) => ({
          name: section.name,
          kind: 'dir' as const,
          subtype: 'section',
          title: section.name,
          id: `section:${section.section}`,
          summary: section.summary,
          meta: { section: section.section },
        })),
        ...(end >= SECTIONS.length ? {} : { cursor: `sections:${String(end)}` }),
      };
    }

    switch (parent.subtype) {
      case 'section':
        return this.#listSection(parent, options);
      case 'person':
        return this.#listPerson(parent, options);
      case 'people':
        return this.#listFacet(parent, options);
      default:
        throw VfsError.notDirectory(parent.path ?? parent.name);
    }
  }

  async #listSection(parent: VNode, options: ListOptions): Promise<ListPage> {
    const section = parent.meta?.['section'];
    switch (section) {
      case 'me': {
        // `Me` is the person, not a folder containing them: `cd /people/Me` should put you
        // on your own card, next to your own manager and reports.
        return this.#listPerson(await this.#personNode(await this.#self()), options);
      }
      case 'org':
        return this.#peoplePage(await this.#chain(options.signal), { ordered: true });
      case 'reports': {
        const me = await this.#self();
        return this.#peoplePage(await this.#directReports(me, options.signal));
      }
      case 'colleagues':
        return this.#peoplePage(await this.#peers(await this.#self(), options.signal));
      case 'recent':
        return this.#peoplePage(await this.#relevant(options.signal));
      case 'external':
        return this.#peoplePage((await this.#relevant(options.signal)).filter((person) => person.external));
      case 'directory':
        return this.#listDirectory(options);
      default:
        throw VfsError.notDirectory(parent.path ?? parent.name);
    }
  }

  /**
   * A person's own directory: their card, the three hierarchy views, then everything they
   * have said to you and you to them.
   */
  async #listPerson(parent: VNode, options: ListOptions): Promise<ListPage> {
    const person = await this.#personOf(parent);
    const entries: VNode[] = [profileNode(person)];

    if (person.userId !== undefined) {
      entries.push(
        facetNode('manager', 'manager', person),
        facetNode('reports', 'reports', person),
        facetNode('peers', 'peers', person),
      );
    }

    const me = await this.#self();
    if (person.key === me.key) {
      // Your own "conversation with yourself" is not a thing; the hierarchy views are.
      return { entries };
    }

    const comms = await this.#commsWith(person, options.signal);
    entries.push(...rankComms(comms).slice(0, options.limit ?? this.#commsPerPerson));
    return { entries };
  }

  async #listFacet(parent: VNode, options: ListOptions): Promise<ListPage> {
    const person = await this.#personOf(parent);
    switch (parent.meta?.['facet']) {
      case 'manager': {
        const manager = await this.#manager(person, options.signal);
        return this.#peoplePage(manager === undefined ? [] : [manager]);
      }
      case 'reports':
        return this.#peoplePage(await this.#directReports(person, options.signal));
      case 'peers':
        return this.#peoplePage(await this.#peers(person, options.signal));
      default:
        throw VfsError.notDirectory(parent.path ?? parent.name);
    }
  }

  /**
   * The tenant directory.
   *
   * A free-text query becomes a `startswith` filter rather than `$search`, because
   * `$search` on `/users` requires the `ConsistencyLevel: eventual` header plus `$count`,
   * and tenants that have not enabled advanced queries answer it with a 400 that reads
   * like a bug in this tool. `startswith` works everywhere and covers the case people
   * actually type: the beginning of a name or an address.
   */
  async #listDirectory(options: ListOptions): Promise<ListPage> {
    const limit = Math.max(1, Math.min(options.limit ?? this.#options.pageSize ?? 50, 100));
    const term = options.query === undefined ? undefined : firstTextTerm(options.query);

    let path: string;
    if (term === undefined) {
      path = `/users?$select=${USER_SELECT_BASIC}&$top=${String(limit)}&$orderby=displayName`;
    } else {
      const escaped = term.replace(/'/g, "''");
      const filter = `startswith(displayName,'${escaped}') or startswith(givenName,'${escaped}') or startswith(surname,'${escaped}') or startswith(mail,'${escaped}') or startswith(userPrincipalName,'${escaped}')`;
      path = `/users?$select=${USER_SELECT_BASIC}&$top=${String(limit)}&$filter=${encodeURIComponent(filter)}`;
    }

    const page = await this.#api.getPage<GraphUser>(
      options.cursor ?? path,
      options.signal === undefined ? {} : { signal: options.signal },
    );
    const homeDomains = await this.#homeDomains();
    const people = page.value.map((user) => this.#remember(personFromUser(user, homeDomains)));
    const built = await this.#peoplePage(people, { parentPath: 'Directory' });
    // `appliedQuery` is deliberately never set. `startswith` is a prefix match and the
    // query language's free text is a substring match, so the engine must still filter.
    // Over-claiming here would silently hide people whose surname contains the term.
    return {
      ...built,
      ...(page.nextLink === undefined ? {} : { cursor: page.nextLink }),
    };
  }

  /**
   * Turn people into nodes, most-owed first.
   *
   * The same ordering rule as a person's messages, one level up: somebody with unread mail
   * outranks somebody merely waiting on a reply, who outranks everybody else. `ordered`
   * turns it off for the management chain, where the hierarchy *is* the meaningful order.
   */
  async #peoplePage(
    people: readonly Person[],
    options: { ordered?: boolean; parentPath?: string } = {},
  ): Promise<ListPage> {
    const index = await this.#degrade(() => this.#signalIndex(), 'communication signals');
    const nodes = people.map((person) =>
      personNode(person, index === undefined ? undefined : signalFor(index, person), options.parentPath),
    );

    if (options.ordered === true) return { entries: nodes };

    const rankOf = (node: VNode): number => {
      const flags = node.flags ?? [];
      if (flags.includes('unread')) return RANK_UNREAD;
      if (flags.includes('unanswered')) return RANK_UNANSWERED;
      return RANK_OTHER;
    };
    const sorted = [...nodes].sort((a, b) => {
      const byRank = rankOf(a) - rankOf(b);
      if (byRank !== 0) return byRank;
      const byRecency = (b.mtime?.getTime() ?? 0) - (a.mtime?.getTime() ?? 0);
      return byRecency !== 0 ? byRecency : a.title.localeCompare(b.title);
    });
    return { entries: sorted };
  }

  async #personNode(person: Person): Promise<VNode> {
    const index = await this.#degrade(() => this.#signalIndex(), 'communication signals');
    return personNode(person, index === undefined ? undefined : signalFor(index, person));
  }

  /**
   * The fast path the engine uses when walking a path.
   *
   * Without it, `cd /people/Recent/Dana Whitfield/manager` would list Dana's *messages* —
   * three network requests and a merge — purely to discover a directory whose existence is
   * a fixed property of every person. Answering the four fixed names directly makes
   * navigating the hierarchy cost one request per level instead of four.
   */
  async resolveChild(parent: VNode | null, name: string): Promise<VNode | undefined> {
    if (parent === null || parent.subtype !== 'person') return undefined;
    const person = await this.#personOf(parent);
    if (name === 'profile.md') return profileNode(person);
    if (person.userId === undefined) return undefined;
    if (name === 'manager' || name === 'reports' || name === 'peers') return facetNode(name, name, person);
    return undefined;
  }

  // -------------------------------------------------------------------------
  // The hierarchy
  // -------------------------------------------------------------------------

  async #manager(person: Person, signal?: AbortSignal): Promise<Person | undefined> {
    if (person.userId === undefined) return undefined;
    const homeDomains = await this.#homeDomains();
    const user = await this.#degrade(
      () => this.#getUser(`/users/${encodeURIComponent(person.userId as string)}/manager`, signal),
      `the manager of ${person.displayName}`,
      // The top of the tree legitimately has no manager, and Graph says so with a 404.
      ['ENOENT'],
    );
    return user === undefined ? undefined : this.#remember(personFromUser(user, homeDomains));
  }

  async #directReports(person: Person, signal?: AbortSignal): Promise<readonly Person[]> {
    if (person.userId === undefined) return [];
    const homeDomains = await this.#homeDomains();
    const page = await this.#degrade(
      () =>
        this.#api.getPage<GraphUser>(
          `/users/${encodeURIComponent(person.userId as string)}/directReports?$select=${USER_SELECT}&$top=100`,
          signal === undefined ? {} : { signal },
        ),
      `the reports of ${person.displayName}`,
      ['ENOENT'],
    );
    return (page?.value ?? [])
      .filter((user) => typeof user.id === 'string')
      .map((user) => this.#remember(personFromUser(user, homeDomains)));
  }

  async #peers(person: Person, signal?: AbortSignal): Promise<readonly Person[]> {
    const manager = await this.#manager(person, signal);
    if (manager === undefined) return [];
    const reports = await this.#directReports(manager, signal);
    return reports.filter((report) => report.key !== person.key);
  }

  /** The climb from the top of the organisation down to the signed-in user. */
  async #chain(signal?: AbortSignal): Promise<readonly Person[]> {
    const maxDepth = Math.max(1, Math.min(this.#options.maxChainDepth ?? 12, 30));
    const me = await this.#self();
    const chain: Person[] = [me];
    const seen = new Set<string>([me.key]);

    let current = me;
    for (let depth = 0; depth < maxDepth; depth += 1) {
      const manager = await this.#manager(current, signal);
      // A directory with a reporting loop in it is rare but real, and it must not become
      // an infinite climb.
      if (manager === undefined || seen.has(manager.key)) break;
      seen.add(manager.key);
      chain.push(manager);
      current = manager;
    }

    return chain.reverse();
  }

  /** People worth listing: whoever Graph considers relevant, plus anyone with unread mail. */
  async #relevant(signal?: AbortSignal): Promise<readonly Person[]> {
    const homeDomains = await this.#homeDomains();
    const me = await this.#self();
    const people = new Map<string, Person>();

    const page = await this.#degrade(
      () =>
        this.#api.getPage<GraphRelevantPerson>(
          '/me/people?$top=50',
          signal === undefined ? {} : { signal },
        ),
      'your frequent contacts',
    );
    for (const entry of page?.value ?? []) {
      const person = personFromRelevant(entry, homeDomains);
      if (person !== undefined && person.key !== me.key) people.set(person.key, this.#remember(person));
    }

    // `/me/people` is relevance-ranked and lags: somebody who mailed you for the first time
    // an hour ago is exactly who you want at the top of this list and is exactly who it
    // omits. Unread inbox senders are therefore folded in regardless.
    //
    // Deduping is by address rather than by key, because `/me/people` hands back directory
    // objects keyed `aad:<id>` while a raw sender is only ever `smtp:<address>`. Keying
    // alone would list the same colleague twice under two different names.
    const seenAddresses = new Set<string>();
    for (const person of people.values()) {
      if (person.address !== undefined) seenAddresses.add(smtpKey(person.address));
    }
    if (me.address !== undefined) seenAddresses.add(smtpKey(me.address));

    const unread = await this.#degrade(
      () =>
        this.#api.getPage<MailMessage>(
          '/me/mailFolders/inbox/messages?$filter=isRead eq false&$top=50&$select=id,from,receivedDateTime',
          signal === undefined ? {} : { signal },
        ),
      'unread mail',
    );
    for (const message of unread?.value ?? []) {
      const person = personFromAddress(message.from?.emailAddress, homeDomains);
      if (person === undefined || person.key === me.key) continue;
      const address = person.address === undefined ? undefined : smtpKey(person.address);
      if (address !== undefined && seenAddresses.has(address)) continue;
      if (address !== undefined) seenAddresses.add(address);
      people.set(person.key, this.#remember(person));
    }

    return [...people.values()];
  }

  // -------------------------------------------------------------------------
  // Communications
  // -------------------------------------------------------------------------

  async #commsWith(person: Person, signal?: AbortSignal): Promise<readonly Comm[]> {
    const me = await this.#self();
    const [mail, chat] = await Promise.all([
      this.#mailWith(person, me, signal),
      this.#options.chats === false ? Promise.resolve([]) : this.#chatWith(person, me, signal),
    ]);
    return [...mail, ...chat];
  }

  /**
   * Mail in both directions.
   *
   * `$search="participants:addr"` is one request for a whole correspondence — sent and
   * received, every folder — where `$filter` needs one per direction and cannot express
   * "to or from" at all. It returns relevance order rather than date order and forbids
   * `$orderby`, which costs nothing here because the merge re-sorts by priority anyway.
   * The `$filter` path remains as a fallback for tenants where mailbox search is disabled.
   */
  async #mailWith(person: Person, me: Person, signal?: AbortSignal): Promise<Comm[]> {
    const address = person.address;
    if (address === undefined) return [];
    const options = signal === undefined ? {} : { signal };
    const top = this.#commsPerPerson;

    const search = encodeURIComponent(`"participants:${address.replace(/"/g, '')}"`);
    let messages: readonly MailMessage[];
    try {
      const page = await this.#api.getPage<MailMessage>(
        `/me/messages?$search=${search}&$select=${MAIL_SELECT}&$top=${String(top)}`,
        options,
      );
      messages = page.value;
    } catch (error) {
      if (!isVfsError(error)) throw error;
      this.#context.logger.debug('mailbox search unavailable, falling back to a from-filter', {
        message: error.message,
      });
      const filter = encodeURIComponent(`from/emailAddress/address eq '${address.replace(/'/g, "''")}'`);
      const page = await this.#degrade(
        () =>
          this.#api.getPage<MailMessage>(
            `/me/messages?$filter=${filter}&$orderby=receivedDateTime desc&$select=${MAIL_SELECT}&$top=${String(top)}`,
            options,
          ),
        `mail with ${person.displayName}`,
      );
      messages = page?.value ?? [];
    }

    const mine = smtpKey(me.address ?? '');
    return messages.map((message) => {
      const from = message.from?.emailAddress ?? message.sender?.emailAddress;
      const fromAddress = from?.address;
      const fromMe = fromAddress !== undefined && smtpKey(fromAddress) === mine;
      const at = new Date(message.receivedDateTime ?? message.sentDateTime ?? Date.now());
      const extraFlags: string[] = [];
      if (message.hasAttachments === true) extraFlags.push('attachment');
      if (message.importance === 'high') extraFlags.push('important');
      if (message.flag?.flagStatus === 'flagged') extraFlags.push('flagged');

      return {
        id: message.id,
        channel: 'mail' as const,
        title: nullable(message.subject) ?? '(no subject)',
        at,
        fromMe,
        unread: !fromMe && !message.isRead,
        mention: false,
        threadKey: `mail:${nullable(message.conversationId) ?? message.id}`,
        author: from?.name ?? fromAddress ?? '(unknown)',
        ...(fromAddress === undefined ? {} : { authorId: fromAddress }),
        ...(nullable(message.bodyPreview) === undefined
          ? {}
          : { summary: preview(message.bodyPreview as string) }),
        ...(extraFlags.length === 0 ? {} : { extraFlags }),
        meta: {
          messageId: message.id,
          ...(nullable(message.conversationId) === undefined
            ? {}
            : { conversationId: message.conversationId as string }),
          ...(nullable(message.webLink) === undefined ? {} : { webLink: message.webLink as string }),
          ...(person.address === undefined ? {} : { personAddress: person.address }),
        },
      };
    });
  }

  async #chatWith(person: Person, me: Person, signal?: AbortSignal): Promise<Comm[]> {
    const chat = await this.#chatFor(person, me, signal);
    if (chat === undefined) return [];

    const readUpTo =
      chat.viewpoint?.lastMessageReadDateTime === null || chat.viewpoint?.lastMessageReadDateTime === undefined
        ? undefined
        : Date.parse(chat.viewpoint.lastMessageReadDateTime);

    const page = await this.#degrade(
      () =>
        this.#api.getPage<ChatMessage>(
          `/chats/${encodeURIComponent(chat.id)}/messages?$top=${String(this.#commsPerPerson)}`,
          signal === undefined ? {} : { signal },
        ),
      `chat with ${person.displayName}`,
    );

    return (page?.value ?? [])
      .filter((message) => message.deletedDateTime == null && (message.messageType ?? 'message') === 'message')
      .map((message) => {
        const raw = message.body?.content ?? '';
        const text = (message.body?.contentType ?? '').toLowerCase() === 'html' ? htmlToText(raw) : raw;
        const at = new Date(message.createdDateTime);
        const fromMe = message.from?.user?.id !== undefined && message.from.user.id === me.userId;
        const line = preview(text, 60);
        return {
          id: message.id,
          channel: 'chat' as const,
          title: nullable(message.subject) ?? (line === '' ? '(no text)' : line),
          at,
          fromMe,
          unread: !fromMe && (readUpTo === undefined || at.getTime() > readUpTo),
          mention: (message.mentions ?? []).some((mention) => mention.mentioned?.user?.id === me.userId),
          threadKey: `chat:${chat.id}`,
          author: message.from?.user?.displayName ?? message.from?.application?.displayName ?? '(unknown)',
          ...(person.address === undefined || fromMe ? {} : { authorId: person.address }),
          ...(text === '' ? {} : { summary: preview(text) }),
          meta: {
            chatId: chat.id,
            messageId: message.id,
            ...(nullable(message.webUrl) === undefined ? {} : { webUrl: message.webUrl as string }),
          },
        };
      });
  }

  async #chatFor(person: Person, me: Person, signal?: AbortSignal): Promise<Chat | undefined> {
    if (person.userId === undefined && person.address === undefined) return undefined;
    for (const chat of await this.#chatRoster(signal)) {
      if (chat.chatType !== 'oneOnOne') continue;
      const others = (chat.members ?? []).filter((member) => member.userId !== me.userId);
      if (others.length !== 1) continue;
      const other = others[0] as ChatMember;
      if (person.userId !== undefined && other.userId === person.userId) return chat;
      const email = nullable(other.email);
      if (person.address !== undefined && email !== undefined && smtpKey(email) === smtpKey(person.address)) {
        return chat;
      }
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async read(node: VNode, options: ReadOptions): Promise<Document> {
    if (node.subtype === 'profile') return this.#readProfile(node, options);
    if (node.subtype === 'message') return this.#readMail(node, options);
    if (node.subtype === 'chat-message') return this.#readChat(node, options);
    throw VfsError.isDirectory(node.path ?? node.name);
  }

  async #readProfile(node: VNode, options: ReadOptions): Promise<Document> {
    const person = await this.#personOf(node);
    const [manager, reports] = await Promise.all([
      this.#manager(person, options.signal),
      this.#directReports(person, options.signal),
    ]);
    const index = await this.#degrade(() => this.#signalIndex(options.signal), 'communication signals');
    const signal = index === undefined ? undefined : signalFor(index, person);

    const headers: Array<readonly [string, string]> = [['Name', person.displayName]];
    if (person.jobTitle !== undefined) headers.push(['Title', person.jobTitle]);
    if (person.department !== undefined) headers.push(['Department', person.department]);
    if (person.companyName !== undefined) headers.push(['Company', person.companyName]);
    if (person.address !== undefined) headers.push(['Mail', person.address]);
    for (const phone of person.phones ?? []) headers.push(['Phone', phone]);
    if (person.officeLocation !== undefined) headers.push(['Office', person.officeLocation]);
    if (person.city !== undefined) headers.push(['City', person.city]);
    if (manager !== undefined) headers.push(['Manager', manager.displayName]);
    headers.push(['Reports', reports.length === 0 ? 'none' : String(reports.length)]);
    headers.push(['Organisation', person.external ? 'external' : 'internal']);

    const lines: string[] = [];
    const owed = describeSignal(signal);
    lines.push(owed);
    lines.push('');
    if (reports.length > 0) {
      lines.push('Direct reports:');
      lines.push('');
      for (const report of reports) {
        lines.push(`- ${report.displayName}${report.jobTitle === undefined ? '' : ` — ${report.jobTitle}`}`);
      }
      lines.push('');
    }
    lines.push(
      person.userId === undefined
        ? 'Not in the directory, so there is no manager or reports to walk. Everything known about them comes from the messages you have exchanged.'
        : 'Use `cd manager`, `cd reports` or `cd peers` from this person\'s folder to walk the hierarchy.',
    );

    return {
      title: person.displayName,
      headers,
      body: lines.join('\n'),
      // The node is called `profile.md`, so the body has to actually be markdown or the name
      // is a lie — hence `-` bullets above rather than `•`.
      format: 'markdown',
      ...(person.address === undefined ? {} : { webUrl: `mailto:${person.address}` }),
    };
  }

  async #readMail(node: VNode, options: ReadOptions): Promise<Document> {
    const id = messageIdOf(node);
    const message = await this.#api.get<MailMessage>(
      `/me/messages/${encodeURIComponent(id)}?$select=${MAIL_SELECT},body,ccRecipients`,
      options.signal === undefined ? {} : { signal: options.signal },
    );
    const raw = message.body?.content ?? message.bodyPreview ?? '';
    const body = (message.body?.contentType ?? '').toLowerCase() === 'html' ? htmlToText(raw) : raw;

    const headers: Array<readonly [string, string]> = [
      ['Channel', 'mail'],
      ['From', formatAddress(message.from?.emailAddress)],
      ['To', (message.toRecipients ?? []).map((r) => formatAddress(r.emailAddress)).join(', ')],
    ];
    if ((message.ccRecipients ?? []).length > 0) {
      headers.push(['Cc', (message.ccRecipients ?? []).map((r) => formatAddress(r.emailAddress)).join(', ')]);
    }
    headers.push(['Date', new Date(message.receivedDateTime).toISOString()]);
    headers.push(['Subject', nullable(message.subject) ?? '(no subject)']);

    return {
      title: nullable(message.subject) ?? '(no subject)',
      headers,
      body,
      format: 'text',
      ...(nullable(message.webLink) === undefined ? {} : { webUrl: message.webLink as string }),
      ...(nullable(message.conversationId) === undefined
        ? {}
        : { threadId: message.conversationId as string }),
    };
  }

  async #readChat(node: VNode, options: ReadOptions): Promise<Document> {
    const chatId = node.meta?.['chatId'];
    if (typeof chatId !== 'string') throw VfsError.invalid('That chat message is missing its chat id.');
    const message = await this.#api.get<ChatMessage>(
      `/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageIdOf(node))}`,
      options.signal === undefined ? {} : { signal: options.signal },
    );
    const raw = message.body?.content ?? '';
    const body = (message.body?.contentType ?? '').toLowerCase() === 'html' ? htmlToText(raw) : raw;
    const author = message.from?.user?.displayName ?? message.from?.application?.displayName ?? '(unknown)';

    return {
      title: nullable(message.subject) ?? `${author}: ${preview(body, 60)}`,
      headers: [
        ['Channel', 'chat'],
        ['From', author],
        ['Date', new Date(message.createdDateTime).toISOString()],
      ],
      body: body === '' ? '(no text content)' : body,
      format: 'text',
      ...(nullable(message.webUrl) === undefined ? {} : { webUrl: message.webUrl as string }),
      threadId: chatId,
    };
  }

  // -------------------------------------------------------------------------
  // Change detection
  // -------------------------------------------------------------------------

  /**
   * Watch one person across every channel, or a whole section of people.
   *
   * The cursor is the timestamp of the newest thing already seen, which is resumable from
   * cold and needs no server-side subscription — and watching *a person* rather than a
   * folder is the thing neither Outlook nor Teams will do for you.
   */
  async poll(parent: VNode | null, cursor: string | undefined, options: { signal?: AbortSignal }): Promise<PollResult> {
    const parsed = cursor === undefined ? Number.NaN : Date.parse(cursor);
    // A cursor persisted by an older version, or one that is simply not a date, means
    // "start again" rather than "fail": the alternative is a watch that stays broken until
    // somebody works out how to clear its state.
    const since = Number.isFinite(parsed) ? parsed : undefined;

    // The mount root is a fixed list of section names, so there is genuinely nothing here
    // that can have changed. It still has to answer, because the engine polls whatever it
    // was pointed at and a refusal would reach the user as an error rather than as "nothing
    // new".
    if (parent === null) return { changes: [], cursor: new Date().toISOString() };

    switch (parent.subtype) {
      case 'person':
        return this.#pollPerson(parent, since, options);
      case 'section':
      case 'people':
        return this.#pollPeople(parent, since, options);
      default:
        throw VfsError.unsupported(`Watching "${parent.name}"`, this.id);
    }
  }

  async #pollPerson(
    parent: VNode,
    since: number | undefined,
    options: { signal?: AbortSignal },
  ): Promise<PollResult> {
    const person = await this.#personOf(parent);
    const nodes = rankComms(await this.#commsWith(person, options.signal));

    const changes: ChangeEvent[] = [];
    let newest = since ?? 0;
    for (const node of nodes) {
      const at = node.mtime?.getTime() ?? 0;
      if (at > newest) newest = at;
      if (since === undefined || at <= since) continue;
      // Your own outgoing messages are not news.
      if ((node.flags ?? []).includes('sent')) continue;
      changes.push({ type: 'created', path: node.name, node, at: node.mtime ?? new Date() });
    }

    return { changes, cursor: new Date(newest === 0 ? Date.now() : newest).toISOString() };
  }

  /**
   * Watch a section: report the people who have written to you since the last poll.
   *
   * Keyed on *inbound* time rather than on the node's mtime, because mtime moves when you
   * send as well, and being notified about your own outgoing mail is pure noise.
   */
  async #pollPeople(
    parent: VNode,
    since: number | undefined,
    options: { signal?: AbortSignal },
  ): Promise<PollResult> {
    const page = await this.list(parent, options.signal === undefined ? {} : { signal: options.signal });

    const changes: ChangeEvent[] = [];
    let newest = since ?? 0;
    for (const node of page.entries) {
      if (node.subtype !== 'person') continue;
      const raw = node.meta?.['lastInboundAt'];
      const at = typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
      if (!Number.isFinite(at)) continue;
      if (at > newest) newest = at;
      if (since === undefined || at <= since) continue;
      changes.push({ type: 'updated', path: node.name, node, at: new Date(at) });
    }

    return { changes, cursor: new Date(newest === 0 ? Date.now() : newest).toISOString() };
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  async actions(node: VNode): Promise<readonly ActionDescriptor[]> {
    if (node.subtype === 'person') {
      return [
        {
          name: 'mail',
          label: 'Send an email',
          description: 'Compose and send a message to this person.',
          params: [
            { name: 'subject', type: 'string', label: 'Subject', required: true },
            { name: 'body', type: 'text', label: 'Message', required: true },
          ],
        },
        {
          name: 'chat',
          label: 'Send a Teams chat',
          description: 'Send a one-to-one chat message, starting the chat if there is not one already.',
          params: [{ name: 'body', type: 'text', label: 'Message', required: true }],
        },
        { name: 'url', label: 'Show the mail address as a link' },
      ];
    }

    if (node.subtype === 'message' || node.subtype === 'chat-message') {
      const flags = node.flags ?? [];
      const actions: ActionDescriptor[] = [
        {
          name: 'reply',
          label: 'Reply',
          description: 'Reply on the same channel this message arrived on.',
          params: [{ name: 'body', type: 'text', label: 'Reply', required: true }],
        },
      ];
      if (node.subtype === 'message') {
        actions.push(flags.includes('unread') ? { name: 'read', label: 'Mark as read' } : { name: 'unread', label: 'Mark as unread' });
      }
      actions.push({ name: 'url', label: 'Show the web URL' });
      return actions;
    }

    if (node.subtype === 'profile') return [{ name: 'url', label: 'Show the mail address as a link' }];
    return [];
  }

  async invoke(action: string, node: VNode, params: Readonly<Record<string, MetaValue>>): Promise<ActionResult> {
    if (action === 'url') return this.#urlAction(node);

    this.#requireSend(action);

    switch (action) {
      case 'mail':
        return this.#sendMail(node, params);
      case 'chat':
        return this.#sendChat(node, params);
      case 'reply':
        return this.#reply(node, params);
      case 'read':
      case 'unread':
        return this.#setRead(node, action === 'read');
      default:
        throw VfsError.unsupported(`Action "${action}"`, this.id);
    }
  }

  /**
   * The gate on everything that writes.
   *
   * Named as one place rather than repeated per action so there is no way to add a writing
   * action later and forget it, and so the message can name both halves of what is needed:
   * the config switch *and* the Graph scope, because having one without the other produces
   * a failure that is otherwise very hard to diagnose.
   */
  #requireSend(action: string): void {
    if (this.#options.allowSend === true) return;
    throw new VfsError(
      'ENOTSUP',
      `"${action}" is disabled: the ${this.id} mount is read-only.`,
      {
        hint:
          'Set "allowSend": true on this mount in your config, then re-run `login` so consent ' +
          'covers Mail.Send, Chat.ReadWrite and ChatMessage.Send.',
      },
    );
  }

  async #urlAction(node: VNode): Promise<ActionResult> {
    const web = node.meta?.['webLink'] ?? node.meta?.['webUrl'];
    if (typeof web === 'string') return { ok: true, message: web };
    const address = node.meta?.['address'] ?? node.meta?.['personAddress'];
    if (typeof address === 'string') return { ok: true, message: `mailto:${address}` };
    throw VfsError.invalid('That item has no link.');
  }

  async #sendMail(node: VNode, params: Readonly<Record<string, MetaValue>>): Promise<ActionResult> {
    const person = await this.#personOf(node);
    if (person.address === undefined) {
      throw VfsError.invalid(`No mail address is known for ${person.displayName}.`);
    }
    const subject = requireText(params, 'subject');
    const body = requireText(params, 'body');

    await this.#api.post('/me/sendMail', {
      message: {
        subject,
        body: { contentType: 'Text', content: body },
        toRecipients: [{ emailAddress: { address: person.address } }],
      },
      saveToSentItems: true,
    });
    this.#invalidateSignals();
    return {
      ok: true,
      message: `Sent "${subject}" to ${person.displayName}.`,
      invalidates: [node.path ?? person.displayName],
    };
  }

  async #sendChat(node: VNode, params: Readonly<Record<string, MetaValue>>): Promise<ActionResult> {
    const person = await this.#personOf(node);
    const body = requireText(params, 'body');
    const me = await this.#self();

    let chat = await this.#chatFor(person, me, undefined);
    if (chat === undefined) {
      if (person.userId === undefined) {
        throw VfsError.invalid(
          `${person.displayName} is not in the directory, so a Teams chat cannot be started with them.`,
          'Use the `mail` action instead.',
        );
      }
      const created = await this.#api.post<{ id: string }>('/chats', {
        chatType: 'oneOnOne',
        members: [me.userId, person.userId].map((userId) => ({
          '@odata.type': '#microsoft.graph.aadUserConversationMember',
          roles: ['owner'],
          'user@odata.bind': `https://graph.microsoft.com/v1.0/users('${String(userId)}')`,
        })),
      });
      chat = { id: created.id, topic: null, chatType: 'oneOnOne' };
      // The roster is now wrong in a way that matters: the next send would create a second
      // chat with the same person.
      this.#chats = undefined;
    }

    await this.#api.post(`/chats/${encodeURIComponent(chat.id)}/messages`, {
      body: { contentType: 'text', content: body },
    });
    this.#invalidateSignals();
    return {
      ok: true,
      message: `Sent a chat message to ${person.displayName}.`,
      invalidates: [node.path ?? person.displayName],
    };
  }

  async #reply(node: VNode, params: Readonly<Record<string, MetaValue>>): Promise<ActionResult> {
    const body = requireText(params, 'body');

    if (node.subtype === 'message') {
      await this.#api.post(`/me/messages/${encodeURIComponent(messageIdOf(node))}/reply`, { comment: body });
      this.#invalidateSignals();
      return { ok: true, message: `Replied to "${node.title}".`, invalidates: [parentOf(node)] };
    }

    if (node.subtype === 'chat-message') {
      const chatId = node.meta?.['chatId'];
      if (typeof chatId !== 'string') throw VfsError.invalid('That chat message is missing its chat id.');
      await this.#api.post(`/chats/${encodeURIComponent(chatId)}/messages`, {
        body: { contentType: 'text', content: body },
      });
      this.#invalidateSignals();
      return { ok: true, message: 'Replied in the chat.', invalidates: [parentOf(node)] };
    }

    throw VfsError.invalid('That is not something you can reply to.');
  }

  async #setRead(node: VNode, read: boolean): Promise<ActionResult> {
    if (node.subtype !== 'message') {
      throw VfsError.unsupported('Marking chat messages read', this.id);
    }
    await this.#api.patch(`/me/messages/${encodeURIComponent(messageIdOf(node))}`, { isRead: read });
    this.#invalidateSignals();
    return {
      ok: true,
      message: `Marked "${node.title}" as ${read ? 'read' : 'unread'}.`,
      invalidates: [parentOf(node)],
    };
  }

  #invalidateSignals(): void {
    this.#signals = undefined;
    this.#chats = undefined;
  }

  /**
   * Run a call, turning "the tenant will not let you do this" into an absence rather than
   * an error. A user whose administrator withholds `User.Read.All` should still get their
   * mail-derived people list, not a mount that fails on every listing.
   */
  async #degrade<T>(
    operation: () => Promise<T>,
    what: string,
    alsoIgnore: readonly string[] = [],
  ): Promise<T | undefined> {
    try {
      return await operation();
    } catch (error) {
      if (isVfsError(error) && (error.code === 'EACCES' || error.code === 'ENOTSUP' || alsoIgnore.includes(error.code))) {
        this.#context.logger.warn(`could not read ${what}`, { hint: error.hint });
        return undefined;
      }
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Node construction
// ---------------------------------------------------------------------------

function personNode(person: Person, signal: Signal | undefined, parentPath?: string): VNode {
  const unread = (signal?.unreadMail ?? 0) + (signal?.unreadChat ?? 0);
  const unanswered =
    signal?.lastInboundAt !== undefined &&
    (signal.lastOutboundAt === undefined || signal.lastOutboundAt < signal.lastInboundAt);

  const flags: string[] = [];
  if (unread > 0) flags.push('unread');
  if (unanswered) flags.push('unanswered');
  if (person.external) flags.push('external');

  const lastAt = Math.max(signal?.lastInboundAt ?? 0, signal?.lastOutboundAt ?? 0);
  const summary = [person.jobTitle, person.department].filter((part) => part !== undefined).join(' — ');

  return {
    name: person.displayName,
    kind: 'dir',
    subtype: 'person',
    title: person.displayName,
    id: `person:${person.key}`,
    ...(lastAt > 0 ? { mtime: new Date(lastAt) } : {}),
    ...(flags.length === 0 ? {} : { flags }),
    ...(summary === '' ? {} : { summary }),
    author: person.displayName,
    ...(person.address === undefined ? {} : { authorId: person.address }),
    ...(unread > 0 ? { unreadCount: unread } : {}),
    ...(parentPath === undefined ? {} : { parentPath }),
    meta: {
      personKey: person.key,
      ...(person.userId === undefined ? {} : { userId: person.userId }),
      ...(person.address === undefined ? {} : { address: person.address }),
      ...(person.jobTitle === undefined ? {} : { jobTitle: person.jobTitle }),
      ...(person.department === undefined ? {} : { department: person.department }),
      ...(person.officeLocation === undefined ? {} : { officeLocation: person.officeLocation }),
      ...(person.companyName === undefined ? {} : { companyName: person.companyName }),
      external: person.external,
      unreadMail: signal?.unreadMail ?? 0,
      unreadChat: signal?.unreadChat ?? 0,
      unanswered,
      // Separately from `mtime`, which is the last activity in either direction, because
      // watching a section has to distinguish "they wrote to you" from "you wrote to them".
      ...(signal?.lastInboundAt === undefined
        ? {}
        : { lastInboundAt: new Date(signal.lastInboundAt).toISOString() }),
      ...(signal?.lastOutboundAt === undefined
        ? {}
        : { lastOutboundAt: new Date(signal.lastOutboundAt).toISOString() }),
    },
  };
}

function profileNode(person: Person): VNode {
  const summary = [person.jobTitle, person.department, person.officeLocation]
    .filter((part) => part !== undefined)
    .join(' — ');
  return {
    name: 'profile.md',
    kind: 'file',
    subtype: 'profile',
    title: `${person.displayName} — profile`,
    id: `profile:${person.key}`,
    ...(summary === '' ? {} : { summary }),
    author: person.displayName,
    ...(person.address === undefined ? {} : { authorId: person.address }),
    meta: {
      personKey: person.key,
      ...(person.userId === undefined ? {} : { userId: person.userId }),
      ...(person.address === undefined ? {} : { address: person.address }),
      external: person.external,
    },
  };
}

function facetNode(name: string, facet: string, person: Person): VNode {
  const summary =
    facet === 'manager'
      ? `Who ${person.displayName} reports to.`
      : facet === 'reports'
        ? `Who reports to ${person.displayName}.`
        : `The other people who report to ${person.displayName}'s manager.`;
  return {
    name,
    kind: 'dir',
    subtype: 'people',
    title: name,
    id: `facet:${facet}:${person.key}`,
    summary,
    meta: {
      facet,
      personKey: person.key,
      ...(person.userId === undefined ? {} : { userId: person.userId }),
      ...(person.address === undefined ? {} : { address: person.address }),
      external: person.external,
    },
  };
}

function describeSignal(signal: Signal | undefined): string {
  if (signal === undefined) return 'No recent correspondence.';
  const parts: string[] = [];
  if (signal.unreadMail > 0) parts.push(`${String(signal.unreadMail)} unread mail`);
  if (signal.unreadChat > 0) parts.push(`${String(signal.unreadChat)} unread chat message(s)`);
  if (
    signal.lastInboundAt !== undefined &&
    (signal.lastOutboundAt === undefined || signal.lastOutboundAt < signal.lastInboundAt)
  ) {
    parts.push('they spoke last and are waiting on you');
  }
  if (parts.length === 0) return 'Nothing outstanding.';
  return `Outstanding: ${parts.join('; ')}.`;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Strip the `mail:` / `chat:` prefix a merged listing adds to keep ids unique. */
function messageIdOf(node: VNode): string {
  const stored = node.meta?.['messageId'];
  if (typeof stored === 'string') return stored;
  const colon = node.id.indexOf(':');
  return colon === -1 ? node.id : node.id.slice(colon + 1);
}

/**
 * Decode the root listing's cursor.
 *
 * A cursor persisted by an older version, or typed by a person, must not become a crash —
 * anything unrecognised simply means "start at the beginning", which is the one answer that
 * is always safe.
 */
function sectionCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const match = /^sections:(\d+)$/.exec(cursor);
  if (match === null) return 0;
  const at = Number.parseInt(match[1] as string, 10);
  return Number.isFinite(at) && at >= 0 && at < SECTIONS.length ? at : 0;
}

function parentOf(node: VNode): string {
  const path = node.path;
  if (path === undefined) return node.name;
  const slash = path.lastIndexOf('/');
  return slash <= 0 ? path : path.slice(0, slash);
}

function formatAddress(address: EmailAddress | undefined): string {
  if (address === undefined) return '(unknown)';
  if (address.name === undefined) return address.address ?? '(unknown)';
  if (address.address === undefined) return address.name;
  return `${address.name} <${address.address}>`;
}

function requireText(params: Readonly<Record<string, MetaValue>>, name: string): string {
  const value = params[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw VfsError.invalid(`The "${name}" parameter is required.`, `Try \`do <item> ${name}="…"\`.`);
  }
  return value;
}

/** The first free-text term in a query, which is what a directory lookup can push down. */
function firstTextTerm(query: Query): string | undefined {
  switch (query.type) {
    case 'text':
      return query.value;
    case 'term':
      return query.field === 'name' || query.field === 'author' || query.field === 'subject'
        ? query.value
        : undefined;
    case 'and':
    case 'or': {
      for (const clause of query.clauses) {
        const found = firstTextTerm(clause);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

export const graphPeoplePlugin: ProviderPlugin<GraphPeopleOptions> = {
  type: 'graph-people',
  displayName: 'People (Microsoft Graph)',
  description:
    'The corporate hierarchy as folders, and every conversation with a person in one list, most owed first.',
  validateOptions(raw) {
    return (raw ?? {}) as GraphPeopleOptions;
  },
  create(options, context) {
    return new GraphPeopleProvider(options, context);
  },
};
