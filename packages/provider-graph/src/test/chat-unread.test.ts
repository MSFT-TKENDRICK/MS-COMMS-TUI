/**
 * Teams read state.
 *
 * Teams had no notion of unread at all: no flag on a message, no count on a chat, nothing on
 * the `Chats` folder. The whole mount was silent, which is how a user came to report that
 * "Teams had 0 counters" — there was nothing there to render.
 *
 * The only read state Graph offers is `chat.viewpoint.lastMessageReadDateTime`, a watermark
 * saying where you had read up to. Everything below derives from that one field, so these
 * tests are mostly about the edges of a watermark: missing, in the future, and the awkward
 * case of your own messages, which Graph leaves sitting above the line for a while after you
 * send them.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MemoryStateStore, NULL_LOGGER, VfsError, type ProviderContext, type VNode } from '@mscomms/core';

import type { GraphApi, GraphPage, GraphRequestOptions } from '../client.js';
import { GraphChatProvider } from '../chat.js';

const ME = 'user-me';
const THEM = 'user-them';

const READ_UP_TO = '2024-05-01T09:00:00Z';
const BEFORE = '2024-05-01T08:00:00Z';
const AFTER_1 = '2024-05-01T10:00:00Z';
const AFTER_2 = '2024-05-01T11:00:00Z';

interface FakeChat {
  readonly id: string;
  readonly topic: string | null;
  readonly chatType?: string;
  readonly lastUpdatedDateTime?: string | null;
  readonly viewpoint?: { lastMessageReadDateTime?: string | null } | null;
  readonly lastMessagePreview?: {
    createdDateTime?: string;
    body?: { content?: string };
    from?: { user?: { displayName?: string; id?: string } };
  } | null;
}

interface FakeMessage {
  readonly id: string;
  readonly createdDateTime: string;
  readonly fromId?: string;
  readonly text?: string;
}

interface FakeOptions {
  readonly chats?: readonly FakeChat[];
  readonly messages?: readonly FakeMessage[];
  /** Make `/me` fail, which is what an under-scoped token does. */
  readonly meFails?: boolean;
}

class FakeGraph implements GraphApi {
  readonly requests: string[] = [];
  readonly #options: FakeOptions;

  constructor(options: FakeOptions = {}) {
    this.#options = options;
  }

  countOf(fragment: string): number {
    return this.requests.filter((path) => path.includes(fragment)).length;
  }

  async get<T>(path: string, _options?: GraphRequestOptions): Promise<T> {
    this.requests.push(path);
    if (path === '/me') {
      if (this.#options.meFails === true) throw VfsError.unsupported('/me', 'fake');
      return { id: ME, displayName: 'Me' } as T;
    }
    throw VfsError.notFound(path);
  }

  async getPage<T>(path: string, _options?: GraphRequestOptions): Promise<GraphPage<T>> {
    this.requests.push(path);
    if (path.startsWith('/me/chats?')) {
      return { value: (this.#options.chats ?? []).map(fullChat) as T[] };
    }
    if (path.includes('/messages')) {
      return {
        value: (this.#options.messages ?? []).map((message) => ({
          id: message.id,
          createdDateTime: message.createdDateTime,
          lastModifiedDateTime: message.createdDateTime,
          messageType: 'message',
          importance: 'normal',
          body: { contentType: 'text', content: message.text ?? 'hello' },
          from: { user: { id: message.fromId ?? THEM, displayName: message.fromId === ME ? 'Me' : 'Them' } },
        })) as T[],
      };
    }
    return { value: [] };
  }

  async getBytes(path: string): Promise<Uint8Array> {
    throw VfsError.unsupported(`Bytes from ${path}`, 'fake');
  }

  async post<T>(_path: string, _body: unknown): Promise<T> {
    return {} as T;
  }

  async patch<T>(_path: string, _body: unknown): Promise<T> {
    return {} as T;
  }
}

function fullChat(chat: FakeChat): Record<string, unknown> {
  return {
    id: chat.id,
    topic: chat.topic,
    chatType: chat.chatType ?? 'oneOnOne',
    lastUpdatedDateTime: chat.lastUpdatedDateTime ?? AFTER_1,
    members: [{ displayName: 'Them' }],
    ...(chat.viewpoint === undefined ? {} : { viewpoint: chat.viewpoint }),
    ...(chat.lastMessagePreview === undefined
      ? {}
      : {
          lastMessagePreview:
            chat.lastMessagePreview === null
              ? null
              : {
                  createdDateTime: chat.lastMessagePreview.createdDateTime ?? AFTER_1,
                  body: { content: chat.lastMessagePreview.body?.content ?? 'hello' },
                  from: {
                    user: {
                      displayName: chat.lastMessagePreview.from?.user?.displayName ?? 'Them',
                      id: chat.lastMessagePreview.from?.user?.id ?? THEM,
                    },
                  },
                },
        }),
  };
}

function context(): ProviderContext {
  return {
    mountPath: '/teams',
    mountId: 'teams',
    state: new MemoryStateStore(),
    logger: NULL_LOGGER,
    config: {},
  } as unknown as ProviderContext;
}

function providerWith(options: FakeOptions): { provider: GraphChatProvider; api: FakeGraph } {
  const api = new FakeGraph(options);
  const provider = new GraphChatProvider({ chatsOnly: true }, context(), api);
  return { provider, api };
}

const CHATS_DIR: VNode = {
  name: 'Chats',
  kind: 'dir',
  subtype: 'section',
  title: 'Chats',
  id: 'section:chats',
  meta: { section: 'chats' },
};

function chatDir(id: string, readUpTo?: string): VNode {
  return {
    name: 'Them',
    kind: 'dir',
    subtype: 'chat',
    title: 'Them',
    id,
    meta: { chatType: 'oneOnOne', ...(readUpTo === undefined ? {} : { readUpTo }) },
  };
}

async function listChats(provider: GraphChatProvider): Promise<readonly VNode[]> {
  const page = await provider.list(CHATS_DIR, {});
  return page.entries;
}

describe('teams: a chat that has moved since you read it', () => {
  it('marks a chat whose last message arrived after the watermark', async () => {
    const { provider } = providerWith({
      chats: [
        {
          id: 'chat-1',
          topic: 'Deploy',
          viewpoint: { lastMessageReadDateTime: READ_UP_TO },
          lastMessagePreview: { createdDateTime: AFTER_1 },
        },
      ],
    });

    const [chat] = await listChats(provider);
    assert.ok(chat?.flags?.includes('unread'), 'something was said after you last looked');
  });

  it('leaves a chat alone when the last word is one you have already read', async () => {
    const { provider } = providerWith({
      chats: [
        {
          id: 'chat-1',
          topic: 'Deploy',
          viewpoint: { lastMessageReadDateTime: READ_UP_TO },
          lastMessagePreview: { createdDateTime: BEFORE },
        },
      ],
    });

    const [chat] = await listChats(provider);
    assert.ok(!(chat?.flags ?? []).includes('unread'));
  });

  it('does not count your own message as something waiting for you', async () => {
    // Graph moves the watermark lazily, so the message you just sent sits above the line.
    // Without this, every chat you had spoken in most recently would read as unread — which
    // is most of them, and the counter would be noise.
    const { provider } = providerWith({
      chats: [
        {
          id: 'chat-1',
          topic: 'Deploy',
          viewpoint: { lastMessageReadDateTime: READ_UP_TO },
          lastMessagePreview: { createdDateTime: AFTER_1, from: { user: { id: ME, displayName: 'Me' } } },
        },
      ],
    });

    const [chat] = await listChats(provider);
    assert.ok(!(chat?.flags ?? []).includes('unread'), 'you have read your own message by writing it');
  });

  it('treats a chat you have never opened as unread', async () => {
    // No watermark is not "nothing new", it is the state a chat is in before you have ever
    // looked at it, which is precisely when you most want to be told.
    const { provider } = providerWith({
      chats: [{ id: 'chat-1', topic: 'Deploy', lastMessagePreview: { createdDateTime: AFTER_1 } }],
    });

    const [chat] = await listChats(provider);
    assert.ok(chat?.flags?.includes('unread'));
  });

  it('says nothing about a chat with no messages in it at all', async () => {
    const { provider } = providerWith({
      chats: [{ id: 'chat-1', topic: 'Empty', viewpoint: { lastMessageReadDateTime: READ_UP_TO }, lastMessagePreview: null }],
    });

    const [chat] = await listChats(provider);
    assert.ok(!(chat?.flags ?? []).includes('unread'));
  });

  it('never invents a count, because Graph does not have one', async () => {
    // Teams reports whether a chat has moved, never by how much. A `1` here would be a
    // guess wearing the clothes of a measurement; the real number arrives when the messages
    // are listed and the engine totals them onto this row.
    const { provider } = providerWith({
      chats: [
        {
          id: 'chat-1',
          topic: 'Deploy',
          viewpoint: { lastMessageReadDateTime: READ_UP_TO },
          lastMessagePreview: { createdDateTime: AFTER_1 },
        },
      ],
    });

    const [chat] = await listChats(provider);
    assert.equal(chat?.unreadCount, undefined);
  });

  it('carries the watermark down so the messages can be judged without asking again', async () => {
    const { provider } = providerWith({
      chats: [
        {
          id: 'chat-1',
          topic: 'Deploy',
          viewpoint: { lastMessageReadDateTime: READ_UP_TO },
          lastMessagePreview: { createdDateTime: AFTER_1 },
        },
      ],
    });

    const [chat] = await listChats(provider);
    assert.equal(chat?.meta?.['readUpTo'], new Date(READ_UP_TO).toISOString());
  });

  it('ignores a watermark Graph could not parse rather than throwing', async () => {
    const { provider } = providerWith({
      chats: [
        {
          id: 'chat-1',
          topic: 'Deploy',
          viewpoint: { lastMessageReadDateTime: 'not a date' },
          lastMessagePreview: { createdDateTime: AFTER_1 },
        },
      ],
    });

    const [chat] = await listChats(provider);
    assert.ok(chat?.flags?.includes('unread'), 'unreadable is treated as never read');
    assert.equal(chat?.meta?.['readUpTo'], undefined, 'and nothing bogus is passed down');
  });
});

describe('teams: the messages inside a chat', () => {
  it('flags the ones that arrived after you last read', async () => {
    const { provider } = providerWith({
      messages: [
        { id: 'm1', createdDateTime: BEFORE },
        { id: 'm2', createdDateTime: AFTER_1 },
        { id: 'm3', createdDateTime: AFTER_2 },
      ],
    });

    const page = await provider.list(chatDir('chat-1', READ_UP_TO), {});
    const unread = page.entries.filter((entry) => (entry.flags ?? []).includes('unread'));
    assert.equal(unread.length, 2, 'the two that came after the line');
  });

  it('excludes your own, so a chat you replied in last is not permanently lit up', async () => {
    const { provider } = providerWith({
      messages: [
        { id: 'm1', createdDateTime: AFTER_1, fromId: THEM },
        { id: 'm2', createdDateTime: AFTER_2, fromId: ME },
      ],
    });

    const page = await provider.list(chatDir('chat-1', READ_UP_TO), {});
    const unread = page.entries.filter((entry) => (entry.flags ?? []).includes('unread'));
    assert.deepEqual(
      unread.map((entry) => entry.id),
      ['m1'],
    );
  });

  it('asks who you are once, not once per chat', async () => {
    // This is a request the user waits on, added to a path that had none. Paying it per
    // listing would make every folder in Teams a round trip slower to satisfy a decoration.
    const { provider, api } = providerWith({
      messages: [{ id: 'm1', createdDateTime: AFTER_1 }],
    });

    await provider.list(chatDir('chat-1', READ_UP_TO), {});
    await provider.list(chatDir('chat-2', READ_UP_TO), {});
    await provider.list(chatDir('chat-3', READ_UP_TO), {});

    assert.equal(api.countOf('/me?'), 0);
    assert.equal(
      api.requests.filter((path) => path === '/me').length,
      1,
      'identity is a session-long fact, so it is fetched once',
    );
  });

  it('still lists the chat when the tenant will not say who you are', async () => {
    // An under-scoped token must cost you a slightly over-eager counter, not the messages.
    const { provider } = providerWith({
      meFails: true,
      messages: [
        { id: 'm1', createdDateTime: AFTER_1, fromId: THEM },
        { id: 'm2', createdDateTime: AFTER_2, fromId: ME },
      ],
    });

    const page = await provider.list(chatDir('chat-1', READ_UP_TO), {});
    assert.equal(page.entries.length, 2, 'the messages arrive regardless');
    assert.equal(
      page.entries.filter((entry) => (entry.flags ?? []).includes('unread')).length,
      2,
      'without an identity, your own message counts too — an over-count, not an outage',
    );
  });

  it('treats every message as unread in a chat that was never opened', async () => {
    const { provider } = providerWith({
      messages: [
        { id: 'm1', createdDateTime: BEFORE },
        { id: 'm2', createdDateTime: AFTER_1 },
      ],
    });

    const page = await provider.list(chatDir('chat-1'), {});
    assert.equal(page.entries.filter((entry) => (entry.flags ?? []).includes('unread')).length, 2);
  });

  it('keeps the other flags a message already carried', async () => {
    const { provider } = providerWith({ messages: [{ id: 'm1', createdDateTime: AFTER_1 }] });
    const page = await provider.list(chatDir('chat-1', READ_UP_TO), {});
    const flags = page.entries[0]?.flags ?? [];
    assert.ok(flags.includes('unread'));
  });
});
