import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MemoryStateStore,
  NULL_LOGGER,
  VfsError,
  isVfsError,
  type ProviderContext,
  type VNode,
} from '@mscomms/core';

import type { GraphApi, GraphPage, GraphRequestOptions } from '../client.js';
import { GraphChatProvider } from '../chat.js';
import { GraphMailProvider } from '../mail.js';

interface Write {
  readonly method: 'POST' | 'PATCH';
  readonly path: string;
  readonly body: unknown;
}

class FakeGraph implements GraphApi {
  readonly writes: Write[] = [];

  async get<T>(path: string, _options?: GraphRequestOptions): Promise<T> {
    throw VfsError.unsupported(`GET ${path}`, 'fake');
  }

  async getPage<T>(path: string, _options?: GraphRequestOptions): Promise<GraphPage<T>> {
    throw VfsError.unsupported(`GET ${path}`, 'fake');
  }

  async getBytes(path: string, _options?: GraphRequestOptions): Promise<Uint8Array> {
    throw VfsError.unsupported(`Bytes from ${path}`, 'fake');
  }

  async post<T>(path: string, body: unknown, _options?: GraphRequestOptions): Promise<T> {
    this.writes.push({ method: 'POST', path, body });
    return {} as T;
  }

  async patch<T>(path: string, body: unknown, _options?: GraphRequestOptions): Promise<T> {
    this.writes.push({ method: 'PATCH', path, body });
    return {} as T;
  }
}

function context(mountPath: string): ProviderContext {
  return {
    mountPath,
    state: new MemoryStateStore(),
    logger: NULL_LOGGER,
    cacheDir: '.mscomms-test-cache',
    secret: async () => undefined,
  };
}

function mailProvider(options: { allowSend?: boolean } = {}): { provider: GraphMailProvider; graph: FakeGraph } {
  const graph = new FakeGraph();
  const provider = new GraphMailProvider(options, context('/mail'), graph);
  return { provider, graph };
}

function chatProvider(options: { allowSend?: boolean } = {}): { provider: GraphChatProvider; graph: FakeGraph } {
  const graph = new FakeGraph();
  const provider = new GraphChatProvider(options, context('/teams'), graph);
  return { provider, graph };
}

const unreadMail: VNode = {
  name: 'budget.eml',
  kind: 'file',
  subtype: 'message',
  title: 'FY26 budget review',
  id: 'message-1',
  flags: ['unread'],
  meta: { folderId: 'inbox', webLink: 'https://outlook.example/message-1' },
};

const readFlaggedMail: VNode = {
  ...unreadMail,
  id: 'message-2',
  flags: ['flagged'],
};

describe('graph-mail actions', () => {
  it('offers read or unread based on the current message flags', async () => {
    const { provider } = mailProvider();
    assert.ok((await provider.actions(unreadMail)).some((action) => action.name === 'read'));
    assert.ok(!(await provider.actions(unreadMail)).some((action) => action.name === 'unread'));
    assert.ok((await provider.actions(readFlaggedMail)).some((action) => action.name === 'unread'));
    assert.ok(!(await provider.actions(readFlaggedMail)).some((action) => action.name === 'read'));
  });

  it('replies with the comment Graph expects', async () => {
    const { provider, graph } = mailProvider({ allowSend: true });
    const result = await provider.invoke('reply', unreadMail, { body: 'I will review this today.' });
    assert.equal(result.message, 'Replied to "FY26 budget review".');
    assert.deepEqual(graph.writes, [
      { method: 'POST', path: '/me/messages/message-1/reply', body: { comment: 'I will review this today.' } },
    ]);
  });

  it('forwards to comma-separated recipients as Graph recipients', async () => {
    const { provider, graph } = mailProvider({ allowSend: true });
    await provider.invoke('forward', unreadMail, { to: 'a@example.test, b@example.test', body: 'FYI.' });
    assert.equal(graph.writes[0]?.path, '/me/messages/message-1/forward');
    assert.deepEqual(graph.writes[0]?.body, {
      comment: 'FYI.',
      toRecipients: [
        { emailAddress: { address: 'a@example.test' } },
        { emailAddress: { address: 'b@example.test' } },
      ],
    });
  });

  it('refuses writes without allowSend before making an HTTP request', async () => {
    const { provider, graph } = mailProvider();
    await assert.rejects(
      () => provider.invoke('reply', unreadMail, { body: 'No write should happen.' }),
      (error: unknown) => {
        assert.ok(isVfsError(error));
        assert.equal(error.code, 'ENOTSUP');
        assert.match(error.hint ?? '', /allowSend/);
        assert.match(error.hint ?? '', /Mail\.ReadWrite/);
        return true;
      },
    );
    assert.deepEqual(graph.writes, []);
  });

  it('still allows the URL action without allowSend', async () => {
    const { provider, graph } = mailProvider();
    const result = await provider.invoke('url', unreadMail, {});
    assert.equal(result.message, 'https://outlook.example/message-1');
    assert.deepEqual(graph.writes, []);
  });
});

const chatNode: VNode = {
  name: 'Launch planning',
  kind: 'dir',
  subtype: 'chat',
  title: 'Launch planning',
  id: 'chat-1',
};

const channelNode: VNode = {
  name: 'General',
  kind: 'dir',
  subtype: 'channel',
  title: 'General',
  id: 'channel-1',
  meta: { teamId: 'team-1' },
};

const channelReply: VNode = {
  name: '001 Alex.md',
  kind: 'file',
  subtype: 'reply',
  title: 'Looks good',
  id: 'reply-1',
  meta: { teamId: 'team-1', channelId: 'channel-1', threadId: 'root-1', webUrl: 'https://teams.example/reply-1' },
};

describe('graph-chat actions', () => {
  it('sends to chats and channels through the matching endpoints', async () => {
    const { provider, graph } = chatProvider({ allowSend: true });
    await provider.invoke('send', chatNode, { body: 'Hello chat.' });
    await provider.invoke('send', channelNode, { body: 'Hello channel.' });
    assert.deepEqual(graph.writes.map((write) => write.path), [
      '/chats/chat-1/messages',
      '/teams/team-1/channels/channel-1/messages',
    ]);
  });

  it('replies to the containing channel thread', async () => {
    const { provider, graph } = chatProvider({ allowSend: true });
    await provider.invoke('reply', channelReply, { body: 'Agreed.' });
    assert.deepEqual(graph.writes, [
      {
        method: 'POST',
        path: '/teams/team-1/channels/channel-1/messages/root-1/replies',
        body: { body: { contentType: 'text', content: 'Agreed.' } },
      },
    ]);
  });

  it('refuses writes without allowSend before making an HTTP request', async () => {
    const { provider, graph } = chatProvider();
    await assert.rejects(
      () => provider.invoke('send', chatNode, { body: 'No write should happen.' }),
      (error: unknown) => {
        assert.ok(isVfsError(error));
        assert.equal(error.code, 'ENOTSUP');
        assert.match(error.hint ?? '', /allowSend/);
        assert.match(error.hint ?? '', /ChatMessage\.Send/);
        return true;
      },
    );
    assert.deepEqual(graph.writes, []);
  });
});
