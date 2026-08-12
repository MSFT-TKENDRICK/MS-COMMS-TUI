/**
 * The MCP-backed Graph transport.
 *
 * These tests exist because this class is the difference between "the tool works in a
 * tenant that forbids device-code sign-in" and "the tool does not work there at all", and
 * every interesting failure it has is a shape mismatch rather than a logic error. A fake
 * transport is used throughout: the real thing is a subprocess that talks to a cloud API,
 * and a suite that depended on either would fail on a machine that has neither.
 *
 * The error mapping cases matter most. The whole reason for routing through `graphFailure`
 * is that a 403 on Teams must produce the same "needs admin consent" diagnosis regardless
 * of which transport carried it; a silent regression there sends people to debug the wrong
 * problem.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { VfsError } from '@mscomms/core';
import { McpGraphClient, relativeUrl, flattenExpand } from '../mcp-graph.js';
import type { McpToolResult, McpTransport } from '../mcp-client.js';

interface Call {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

/** Records every tool call and answers from a script. */
function fakeTransport(replies: readonly (McpToolResult | Error)[]): {
  calls: Call[];
  transport: McpTransport;
} {
  const calls: Call[] = [];
  let index = 0;
  const transport: McpTransport = {
    async callTool(name, args) {
      calls.push({ name, args });
      const reply = replies[index++] ?? {};
      if (reply instanceof Error) throw reply;
      return reply;
    },
    dispose() {
      // Nothing to tear down.
    },
  };
  return { calls, transport };
}

/** The successful shape: one result per requested URL, each with its own status. */
function fetched(data: unknown, statusCode = 200): McpToolResult {
  return { structuredContent: { results: [{ data, statusCode }] } };
}

function failed(statusCode: number, error: unknown): McpToolResult {
  return { isError: true, structuredContent: { results: [{ data: null, error, statusCode }] } };
}

describe('relativeUrl', () => {
  it('strips the Graph origin from an absolute nextLink', () => {
    // Providers hand `@odata.nextLink` straight back as a cursor. These tools take a
    // relative path, so passing one through unchanged breaks page two of every listing.
    assert.equal(
      relativeUrl('https://graph.microsoft.com/v1.0/me/messages?$top=2&$skip=2'),
      '/me/messages?$top=2&$skip=2',
    );
  });

  it('strips a beta origin too', () => {
    assert.equal(relativeUrl('https://graph.microsoft.com/beta/me/people'), '/me/people');
  });

  it('leaves an already-relative path alone', () => {
    assert.equal(relativeUrl('/me/mailFolders?$top=100'), '/me/mailFolders?$top=100');
  });

  it('adds the leading slash a relative path is missing', () => {
    assert.equal(relativeUrl('me/messages'), '/me/messages');
  });
});

describe('flattenExpand', () => {
  it('drops the nested options the proxy rejects', () => {
    // Real failure: `400 Unsupported query parameters 'members($select=displayName)'`,
    // which made the whole Teams chat list unusable over this transport.
    assert.equal(
      flattenExpand('/me/chats?$expand=members($select=displayName)&$top=50'),
      '/me/chats?$expand=members&$top=50',
    );
  });

  it('leaves a plain expand alone', () => {
    assert.equal(flattenExpand('/me/chats?$expand=members&$top=50'), '/me/chats?$expand=members&$top=50');
  });

  it('leaves a URL with no expand alone', () => {
    assert.equal(flattenExpand('/me/messages?$select=subject'), '/me/messages?$select=subject');
  });

  it('does not touch parentheses elsewhere in the query', () => {
    // Graph puts key segments in parentheses, and `$filter` uses them for grouping.
    const url = "/me/messages?$filter=(isRead eq false) and (importance eq 'high')";
    assert.equal(flattenExpand(url), url);
  });

  it('handles several expanded relationships', () => {
    assert.equal(
      flattenExpand('/x?$expand=members($select=id),lastMessagePreview($select=body)'),
      '/x?$expand=members,lastMessagePreview',
    );
  });

  it('survives nested parentheses', () => {
    assert.equal(flattenExpand('/x?$expand=a($expand=b($select=c))&$top=1'), '/x?$expand=a&$top=1');
  });
});

describe('McpGraphClient.get', () => {
  it('asks the fetch tool for the requested URL', async () => {
    const { calls, transport } = fakeTransport([fetched({ displayName: 'Tyler' })]);
    const client = new McpGraphClient({ transport });

    const result = await client.get<{ displayName: string }>('/me?$select=displayName');

    assert.equal(calls[0]?.name, 'fetch');
    assert.deepEqual(calls[0]?.args, { entityUrls: ['/me?$select=displayName'] });
    assert.equal(result.displayName, 'Tyler');
  });

  it('returns the Graph payload verbatim', async () => {
    // $select, $filter and the odata annotations have to survive the round trip untouched,
    // because the providers parse them.
    const payload = { '@odata.context': 'ctx', value: [{ id: '1' }], '@odata.nextLink': 'next' };
    const { transport } = fakeTransport([fetched(payload)]);
    const client = new McpGraphClient({ transport });

    assert.deepEqual(await client.get('/me/messages'), payload);
  });

  it('accepts a tool that answers with JSON text instead of a structured result', async () => {
    const { transport } = fakeTransport([{ content: [{ type: 'text', text: '{"value":[{"id":"7"}]}' }] }]);
    const client = new McpGraphClient({ transport });

    const page = await client.getPage<{ id: string }>('/me/messages');
    assert.deepEqual(page.value, [{ id: '7' }]);
  });

  it('widens a nested expand the proxy would reject', async () => {
    const { calls, transport } = fakeTransport([fetched({ value: [] })]);
    const client = new McpGraphClient({ transport });

    await client.getPage('/me/chats?$expand=members($select=displayName)&$top=50');

    assert.deepEqual(calls[0]?.args, { entityUrls: ['/me/chats?$expand=members&$top=50'] });
  });
});

describe('McpGraphClient error mapping', () => {
  it('reports a 404 as ENOENT', async () => {
    const { transport } = fakeTransport([failed(404, { error: { code: 'ErrorItemNotFound' } })]);
    const client = new McpGraphClient({ transport });

    await assert.rejects(
      () => client.get('/me/messages/gone'),
      (error: VfsError) => error.code === 'ENOENT',
    );
  });

  it('reports a 401 as EAUTH', async () => {
    const { transport } = fakeTransport([failed(401, 'unauthorised')]);
    const client = new McpGraphClient({ transport });

    await assert.rejects(
      () => client.get('/me/messages'),
      (error: VfsError) => error.code === 'EAUTH',
    );
  });

  it('keeps the admin-consent hint for a 403 on Teams', async () => {
    const { transport } = fakeTransport([failed(403, { error: { message: 'Forbidden' } })]);
    const client = new McpGraphClient({ transport });

    await assert.rejects(
      () => client.get('/me/chats'),
      (error: VfsError) =>
        error.code === 'EACCES' && (error.hint ?? '').includes('administrator consent'),
    );
  });

  it('unwraps the Graph error envelope for the message', async () => {
    // Graph nests the useful text one level down; showing the wrapper instead is useless.
    const { transport } = fakeTransport([failed(403, { error: { code: 'AccessDenied', message: 'No mailbox' } })]);
    const client = new McpGraphClient({ transport });

    await assert.rejects(
      () => client.get('/me/messages'),
      (error: VfsError) => error.message.includes('No mailbox'),
    );
  });

  it('treats a plain-string error as the message', async () => {
    const { transport } = fakeTransport([failed(400, 'Access denied for GET path: /me/nope')]);
    const client = new McpGraphClient({ transport });

    await assert.rejects(
      () => client.get('/me/nope'),
      (error: VfsError) => error.message.includes('Access denied'),
    );
  });

  it('turns a dead server into a network error rather than a crash', async () => {
    const { transport } = fakeTransport([new Error('spawn ENOENT')]);
    const client = new McpGraphClient({ transport });

    await assert.rejects(
      () => client.get('/me'),
      (error: VfsError) => error.code === 'ENETWORK' && (error.hint ?? '').includes('signed in'),
    );
  });

  it('treats a null payload as a failure even when the status looks fine', async () => {
    const { transport } = fakeTransport([{ structuredContent: { results: [{ data: null, statusCode: 200 }] } }]);
    const client = new McpGraphClient({ transport });

    await assert.rejects(() => client.get('/me'), VfsError);
  });
});

describe('McpGraphClient.getPage', () => {
  it('splits the collection from its continuation link', async () => {
    const { transport } = fakeTransport([
      fetched({ value: [{ id: 'a' }, { id: 'b' }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/messages?$skip=2' }),
    ]);
    const client = new McpGraphClient({ transport });

    const page = await client.getPage<{ id: string }>('/me/messages');

    assert.deepEqual(page.value.map((entry) => entry.id), ['a', 'b']);
    assert.equal(page.nextLink, 'https://graph.microsoft.com/v1.0/me/messages?$skip=2');
  });

  it('answers an empty page when Graph omits the collection', async () => {
    const { transport } = fakeTransport([fetched({ '@odata.context': 'ctx' })]);
    const client = new McpGraphClient({ transport });

    assert.deepEqual((await client.getPage('/me/messages')).value, []);
  });

  it('follows a returned nextLink as a relative URL', async () => {
    const { calls, transport } = fakeTransport([fetched({ value: [] })]);
    const client = new McpGraphClient({ transport });

    await client.getPage('https://graph.microsoft.com/v1.0/me/messages?$skip=2');

    assert.deepEqual(calls[0]?.args, { entityUrls: ['/me/messages?$skip=2'] });
  });
});

describe('McpGraphClient writes', () => {
  it('routes sendMail to the action tool', async () => {
    // `/me/sendMail` invokes a function; `/chats/{id}/messages` creates a collection member.
    // The servers model those as different tools, so picking the wrong one fails outright.
    const { calls, transport } = fakeTransport([{ structuredContent: { statusCode: 202 } }]);
    const client = new McpGraphClient({ transport });

    await client.post('/me/sendMail', { message: { subject: 'hi' } });

    assert.equal(calls[0]?.name, 'do_action');
    assert.equal(calls[0]?.args['actionUrl'], '/me/sendMail');
  });

  it('routes a reply to the action tool', async () => {
    const { calls, transport } = fakeTransport([{ structuredContent: { statusCode: 202 } }]);
    const client = new McpGraphClient({ transport });

    await client.post('/me/messages/abc/reply', { comment: 'ok' });

    assert.equal(calls[0]?.name, 'do_action');
  });

  it('routes posting a chat message to the create tool', async () => {
    const { calls, transport } = fakeTransport([{ structuredContent: { data: { id: 'm1' }, statusCode: 201 } }]);
    const client = new McpGraphClient({ transport });

    const created = await client.post<{ id: string }>('/chats/19:abc/messages', { body: { content: 'hi' } });

    assert.equal(calls[0]?.name, 'create_entity');
    assert.equal(calls[0]?.args['parentUrl'], '/chats/19:abc/messages');
    assert.equal(created.id, 'm1');
  });

  it('answers an empty object when a write returns no body', async () => {
    const { transport } = fakeTransport([{ structuredContent: { statusCode: 202 } }]);
    const client = new McpGraphClient({ transport });

    assert.deepEqual(await client.post('/me/sendMail', {}), {});
  });

  it('sends a patch to the update tool', async () => {
    const { calls, transport } = fakeTransport([{ structuredContent: { statusCode: 200, data: {} } }]);
    const client = new McpGraphClient({ transport });

    await client.patch('/me/messages/abc', { isRead: true });

    assert.equal(calls[0]?.name, 'update_entity');
    assert.deepEqual(calls[0]?.args, { entityUrl: '/me/messages/abc', jsonBody: { isRead: true } });
  });

  it('surfaces a rejected write as a Graph failure', async () => {
    const { transport } = fakeTransport([failed(403, { error: { message: 'Nope' } })]);
    const client = new McpGraphClient({ transport });

    await assert.rejects(
      () => client.patch('/me/messages/abc', { isRead: true }),
      (error: VfsError) => error.code === 'EACCES',
    );
  });
});

describe('McpGraphClient.getBytes', () => {
  it('decodes the base64 an attachment comes back as', async () => {
    const encoded = Buffer.from('hello attachment').toString('base64');
    const { calls, transport } = fakeTransport([{ structuredContent: { contentBase64: encoded } }]);
    const client = new McpGraphClient({ transport });

    const bytes = await client.getBytes('/me/messages/1/attachments/2/$value');

    assert.equal(calls[0]?.name, 'fetch_blob');
    assert.equal(Buffer.from(bytes).toString('utf8'), 'hello attachment');
  });

  it('finds the content when the server nests it', async () => {
    const encoded = Buffer.from('nested').toString('base64');
    const { transport } = fakeTransport([{ structuredContent: { result: { data: encoded } } }]);
    const client = new McpGraphClient({ transport });

    assert.equal(Buffer.from(await client.getBytes('/x/$value')).toString('utf8'), 'nested');
  });

  it('explains an empty download instead of returning zero bytes', async () => {
    const { transport } = fakeTransport([{ structuredContent: {} }]);
    const client = new McpGraphClient({ transport });

    await assert.rejects(() => client.getBytes('/x/$value'), VfsError);
  });

  it('reads the key the reference server actually uses', async () => {
    // Observed shape: `{ base64Content, contentType, sizeBytes, statusCode }`. None of the
    // other spellings appear, so getting this wrong makes every attachment undownloadable.
    const encoded = Buffer.from('real bytes').toString('base64');
    const { transport } = fakeTransport([
      { structuredContent: { base64Content: encoded, contentType: 'image/png', sizeBytes: 10, statusCode: 200 } },
    ]);
    const client = new McpGraphClient({ transport });

    assert.equal(Buffer.from(await client.getBytes('/x/$value')).toString('utf8'), 'real bytes');
  });

  it('repeats the server’s refusal rather than inventing one', async () => {
    // A refused download sends an empty string plus an explanation, so "no content" and
    // "not allowed" are distinguishable and the second is far more useful to report.
    const { transport } = fakeTransport([
      {
        structuredContent: {
          base64Content: '',
          error: 'Access denied for the requested path.',
          sizeBytes: 0,
          statusCode: 403,
        },
      },
    ]);
    const client = new McpGraphClient({ transport });

    await assert.rejects(
      () => client.getBytes('/x'),
      (error: VfsError) => {
        assert.equal(error.code, 'EACCES');
        assert.match(error.message, /Access denied/);
        return true;
      },
    );
  });
});

describe('McpGraphClient tool names', () => {
  it('honours overridden tool names', async () => {
    // Another server with the same passthrough shape should not need a code change.
    const { calls, transport } = fakeTransport([fetched({ ok: true })]);
    const client = new McpGraphClient({ transport, tools: { fetch: 'graph_get' } });

    await client.get('/me');

    assert.equal(calls[0]?.name, 'graph_get');
  });
});
