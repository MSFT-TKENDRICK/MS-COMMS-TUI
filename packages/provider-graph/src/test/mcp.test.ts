/**
 * The MCP-backed Graph transport.
 *
 * The interesting risk here is not the mapping — it is the *plumbing*. A stubbed client
 * that resolves canned objects would pass while the real transport deadlocked on framing,
 * hung the CLI on exit, or mistook a chunk boundary for a message boundary. So most of
 * this suite talks to a real child process over real pipes, speaking the real protocol,
 * and the fake server is written to be awkward on purpose: it splits messages across
 * writes and prints noise on stdout, both of which a real server is entitled to do.
 *
 * The one thing deliberately *not* tested here is the sign-in prompt, because there is
 * nothing to prompt: `resolveTransport` is what decides, and it is tested directly.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { NULL_LOGGER, isVfsError } from '@mscomms/core';

import { toRelativeGraphPath } from '../client.js';
import {
  McpGraphApi,
  McpStdioClient,
  describeMcpError,
  hasDiscoverableMcpServer,
  resolveMcpServer,
} from '../mcp.js';
import { resolveTransport, validateSharedOptions } from '../shared.js';
import { graphMailPlugin } from '../mail.js';

// ---------------------------------------------------------------------------
// A fake MCP server, as a real process
// ---------------------------------------------------------------------------

/**
 * Written to a temp file at test time rather than shipped beside the source, because the
 * suite runs from `dist` and only TypeScript is compiled into it.
 */
const FAKE_SERVER = `
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line === '') continue;
    handle(JSON.parse(line));
  }
});
// A server is entitled to exit when its stdin closes, and the transport relies on it.
process.stdin.on('end', () => { process.exit(0); });

// Messages may be split across writes, but two messages must never interleave, so the
// writes are drained one message at a time.
const queue = [];
let draining = false;
function drain() {
  if (draining) return;
  const next = queue.shift();
  if (next === undefined) return;
  draining = true;
  const cut = Math.max(1, Math.floor(next.length / 2));
  process.stdout.write(next.slice(0, cut));
  setTimeout(() => {
    process.stdout.write(next.slice(cut), () => {
      draining = false;
      drain();
    });
  }, 1);
}

/**
 * Replies land after \`delay\` ms, so a batch of concurrent requests is answered in a
 * different order than it was sent. A client that paired replies to requests by arrival
 * order rather than by id would pass every other test in this file and fail this one.
 */
function reply(id, result, delay = 0) {
  setTimeout(() => {
    queue.push(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
    drain();
  }, delay);
}

function handle(message) {
  if (message.method === 'initialize') {
    // Noise on stdout: real servers log here, and it must not break framing.
    queue.push('starting up, please wait\\n');
    drain();
    reply(message.id, { protocolVersion: '2024-11-05', serverInfo: { name: 'fake', version: '1' } });
    return;
  }
  if (message.method !== 'tools/call') return;

  const name = message.params.name;
  const args = message.params.arguments;

  if (name === 'fetch') {
    const path = args.entityUrls[0];
    if (path.includes('missing')) {
      reply(message.id, {
        content: [],
        structuredContent: {
          results: [{ data: null, statusCode: 400, error: { error: { code: 'ErrorItemNotFound', message: 'gone' } } }],
        },
        isError: true,
      });
      return;
    }
    if (path.includes('forbidden')) {
      reply(message.id, {
        content: [],
        structuredContent: { results: [{ data: null, statusCode: 403, error: 'no consent' }] },
        isError: true,
      });
      return;
    }
    if (path.startsWith('/me/textonly')) {
      // No structuredContent at all: the payload arrives as a JSON text block.
      reply(message.id, {
        content: [{ type: 'text', text: JSON.stringify({ results: [{ data: { ok: true }, statusCode: 200 }] }) }],
        isError: false,
      }, 40);
      return;
    }
    if (path.startsWith('/me/page2')) {
      reply(message.id, {
        content: [],
        structuredContent: { results: [{ data: { value: [{ id: 'c' }] }, statusCode: 200 }] },
        isError: false,
      });
      return;
    }
    reply(message.id, {
      content: [],
      structuredContent: {
        results: [
          {
            data: {
              value: [{ id: 'a' }, { id: 'b' }],
              '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/page2?x=1',
            },
            statusCode: 200,
          },
        ],
      },
      isError: false,
    }, 20);
    return;
  }

  if (name === 'fetch_blob') {
    reply(message.id, {
      content: [],
      structuredContent: {
        statusCode: 200,
        contentType: 'text/plain',
        sizeBytes: 5,
        base64Content: Buffer.from('hello').toString('base64'),
      },
      isError: false,
    });
    return;
  }

  if (name === 'do_action' || name === 'update_entity') {
    reply(message.id, {
      content: [],
      structuredContent: { results: [{ data: { echoed: args.jsonBody, tool: name }, statusCode: 200 }] },
      isError: false,
    });
    return;
  }

  if (name === 'never_answers') return; // Deliberately silent, for the timeout test.

  reply(message.id, { content: [{ type: 'text', text: 'unknown tool' }], isError: true });
}
`;

const DEAF_SERVER = `
// Never answers, never exits: the shape of \`npx\` still resolving a package.
process.stdin.resume();
setInterval(() => {}, 1000);
`;

let dir: string;
let serverPath: string;
let deafServerPath: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'mscomms-mcp-test-'));
  serverPath = join(dir, 'fake-server.mjs');
  writeFileSync(serverPath, FAKE_SERVER, 'utf8');
  deafServerPath = join(dir, 'deaf-server.mjs');
  writeFileSync(deafServerPath, DEAF_SERVER, 'utf8');
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function connect(): { client: McpStdioClient; api: McpGraphApi } {
  const client = new McpStdioClient(
    { command: process.execPath, args: [serverPath], requestTimeoutMs: 15_000, startupTimeoutMs: 15_000 },
    NULL_LOGGER,
  );
  return { client, api: new McpGraphApi(client) };
}

// ---------------------------------------------------------------------------

describe('mcp transport: letting go of a server that is still starting', () => {
  it('leaves nothing holding the process open', async () => {
    const client = new McpStdioClient(
      { command: process.execPath, args: [deafServerPath], requestTimeoutMs: 30_000, startupTimeoutMs: 30_000 },
      NULL_LOGGER,
    );
    // Start the handshake so a child really is spawned, then walk away from it mid-flight,
    // which is what a user quitting a few seconds after launch does.
    const pending = client.warm().catch(() => false);
    await delay(300);
    client.close();
    await pending;

    // The regression this guards. Ending the child's stdin queues a *graceful* shutdown,
    // which stays referenced until the far end acknowledges it — and a server still being
    // resolved by `npx` acknowledges nothing for several seconds. The CLI would sit there
    // with all of its own work finished, waiting on a process it had already abandoned:
    // seven and a half seconds to quit, against twenty milliseconds once the server was up.
    // Destroying the pipe delivers the same end-of-file without anyone waiting for a reply.
    assert.ok(
      !process.getActiveResourcesInfo().includes('SimpleShutdownWrap'),
      'closing the transport should not leave a pending stream shutdown holding the process open',
    );
  });
});

// ---------------------------------------------------------------------------

describe('mcp transport: talking to a real server process', () => {
  it('reads a Graph payload through the tool call', async () => {
    const { client, api } = connect();
    try {
      const page = await api.getPage<{ id: string }>('/me/mailFolders');
      assert.deepEqual(
        page.value.map((item) => item.id),
        ['a', 'b'],
      );
    } finally {
      client.close();
    }
  });

  it('carries @odata.nextLink through, so paging works', async () => {
    const { client, api } = connect();
    try {
      const first = await api.getPage<{ id: string }>('/me/mailFolders');
      assert.equal(first.nextLink, 'https://graph.microsoft.com/v1.0/me/page2?x=1');
      // The link is absolute; following it is the thing that breaks if it is not
      // reduced to a path before being handed to the server.
      const second = await api.getPage<{ id: string }>(first.nextLink ?? '');
      assert.deepEqual(
        second.value.map((item) => item.id),
        ['c'],
      );
    } finally {
      client.close();
    }
  });

  it('reads binary content', async () => {
    const { client, api } = connect();
    try {
      const bytes = await api.getBytes('/me/photo/$value');
      assert.equal(Buffer.from(bytes).toString('utf8'), 'hello');
    } finally {
      client.close();
    }
  });

  it('accepts a payload delivered as a JSON text block', async () => {
    const { client, api } = connect();
    try {
      const result = await api.get<{ ok: boolean }>('/me/textonly');
      assert.equal(result.ok, true);
    } finally {
      client.close();
    }
  });

  it('sends writes to the action tools', async () => {
    const { client, api } = connect();
    try {
      const posted = await api.post<{ echoed: unknown; tool: string }>('/me/sendMail', { subject: 'hi' });
      assert.equal(posted.tool, 'do_action');
      assert.deepEqual(posted.echoed, { subject: 'hi' });

      const patched = await api.patch<{ tool: string }>('/me/messages/1', { isRead: true });
      assert.equal(patched.tool, 'update_entity');
    } finally {
      client.close();
    }
  });

  it('runs several requests over one connection without confusing the replies', async () => {
    // The fake server splits every message across two writes and answers out of order,
    // so this fails if replies are correlated by arrival rather than by id.
    const { client, api } = connect();
    try {
      const [first, second, third] = await Promise.all([
        api.get<Record<string, unknown>>('/me/mailFolders'),
        api.get<{ ok: boolean }>('/me/textonly'),
        api.getBytes('/me/photo/$value'),
      ]);
      assert.ok(Array.isArray(first['value']));
      assert.equal(second.ok, true);
      assert.equal(Buffer.from(third).toString('utf8'), 'hello');
    } finally {
      client.close();
    }
  });

  it('reports a missing item as ENOENT rather than a bare status', async () => {
    const { client, api } = connect();
    try {
      await assert.rejects(
        () => api.get('/me/missing/1'),
        (error: unknown) => isVfsError(error) && error.code === 'ENOENT',
      );
    } finally {
      client.close();
    }
  });

  it('keeps the permission hint that tells a user to ask an admin', async () => {
    const { client, api } = connect();
    try {
      await assert.rejects(
        () => api.get('/chats/forbidden'),
        (error: unknown) =>
          isVfsError(error) &&
          error.code === 'EACCES' &&
          // The Teams-specific hint is the whole value of this path: "ask your tenant
          // admin" and "you typed the wrong id" are different problems.
          (error.hint ?? '').includes('administrator consent'),
      );
    } finally {
      client.close();
    }
  });

  it('gives up on a server that never answers', async () => {
    const client = new McpStdioClient(
      { command: process.execPath, args: [serverPath], requestTimeoutMs: 300, startupTimeoutMs: 15_000 },
      NULL_LOGGER,
    );
    try {
      await assert.rejects(
        () => client.call('never_answers', {}),
        (error: unknown) => isVfsError(error) && error.code === 'ETIMEDOUT',
      );
    } finally {
      client.close();
    }
  });

  it('fails clearly when the server cannot be started at all', async () => {
    const client = new McpStdioClient(
      { command: join(dir, 'no-such-server-binary'), args: [], startupTimeoutMs: 5_000 },
      NULL_LOGGER,
    );
    try {
      await assert.rejects(() => client.call('fetch', { entityUrls: ['/me'] }), (error: unknown) => isVfsError(error));
    } finally {
      client.close();
    }
  });

  it('honours an abort signal', async () => {
    const { client } = connect();
    try {
      const controller = new AbortController();
      const pending = client.call('never_answers', {}, controller.signal);
      controller.abort();
      await assert.rejects(() => pending, (error: unknown) => isVfsError(error));
    } finally {
      client.close();
    }
  });
});

// ---------------------------------------------------------------------------

describe('mcp transport: choosing a transport', () => {
  const saved = { ...process.env };

  function isolate(): void {
    delete process.env['MSCOMMS_GRAPH_MCP_COMMAND'];
    delete process.env['MSCOMMS_GRAPH_TOKEN'];
  }

  after(() => {
    process.env['MSCOMMS_GRAPH_MCP_COMMAND'] = saved['MSCOMMS_GRAPH_MCP_COMMAND'];
    process.env['MSCOMMS_GRAPH_TOKEN'] = saved['MSCOMMS_GRAPH_TOKEN'];
    if (saved['MSCOMMS_GRAPH_MCP_COMMAND'] === undefined) delete process.env['MSCOMMS_GRAPH_MCP_COMMAND'];
    if (saved['MSCOMMS_GRAPH_TOKEN'] === undefined) delete process.env['MSCOMMS_GRAPH_TOKEN'];
  });

  it('prefers an available server over asking the user to sign in', () => {
    isolate();
    const configPath = join(dir, 'found.json');
    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { workiq: { command: 'npx', args: ['-y', 'server'] } } }),
      'utf8',
    );
    assert.equal(resolveTransport({ mcp: { configPath } }), 'mcp');
  });

  it('falls back to signing in when there is no server', () => {
    isolate();
    const configPath = join(dir, 'empty.json');
    writeFileSync(configPath, JSON.stringify({ mcpServers: {} }), 'utf8');
    assert.equal(resolveTransport({ mcp: { configPath } }), 'device-code');
  });

  it('lets a user ask for the sign-in flow even when a server exists', () => {
    isolate();
    const configPath = join(dir, 'found.json');
    assert.equal(resolveTransport({ transport: 'device-code', mcp: { configPath } }), 'device-code');
  });

  it('lets a user demand the server even when discovery would not find one', () => {
    isolate();
    assert.equal(resolveTransport({ transport: 'mcp', mcp: { configPath: join(dir, 'empty.json') } }), 'mcp');
  });

  it('defers to a supplied token, which also avoids a prompt', () => {
    isolate();
    process.env['MSCOMMS_GRAPH_TOKEN'] = 'a-token';
    const configPath = join(dir, 'found.json');
    assert.equal(resolveTransport({ mcp: { configPath } }), 'device-code');
  });

  it('ignores a blank token rather than treating it as configured', () => {
    isolate();
    process.env['MSCOMMS_GRAPH_TOKEN'] = '   ';
    const configPath = join(dir, 'found.json');
    assert.equal(resolveTransport({ mcp: { configPath } }), 'mcp');
  });
});

// ---------------------------------------------------------------------------

describe('mcp transport: finding the server', () => {
  function isolate(): void {
    delete process.env['MSCOMMS_GRAPH_MCP_COMMAND'];
  }

  it('takes an explicit command as given', () => {
    isolate();
    const resolved = resolveMcpServer({ command: 'my-server', args: ['--stdio'] });
    assert.equal(resolved.command, 'my-server');
    assert.deepEqual(resolved.args, ['--stdio']);
  });

  it('reads a command out of the environment', () => {
    isolate();
    process.env['MSCOMMS_GRAPH_MCP_COMMAND'] = 'node server.mjs --stdio';
    try {
      const resolved = resolveMcpServer({});
      assert.equal(resolved.command, 'node');
      assert.deepEqual(resolved.args, ['server.mjs', '--stdio']);
    } finally {
      isolate();
    }
  });

  it('reads the launch command out of an MCP config file', () => {
    isolate();
    const configPath = join(dir, 'servers.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          other: { command: 'wrong', args: [] },
          workiq: { command: 'npx', args: ['-y', '@microsoft/workiq@latest', 'mcp'], env: { A: '1' } },
        },
      }),
      'utf8',
    );
    const resolved = resolveMcpServer({ configPath });
    assert.equal(resolved.command, 'npx');
    assert.deepEqual(resolved.args, ['-y', '@microsoft/workiq@latest', 'mcp']);
    assert.deepEqual(resolved.env, { A: '1' });
  });

  it('picks the named server rather than whichever one is listed first', () => {
    isolate();
    const configPath = join(dir, 'servers.json');
    const resolved = resolveMcpServer({ configPath, server: 'other' });
    assert.equal(resolved.command, 'wrong');
  });

  it('survives a config file that is missing or malformed', () => {
    isolate();
    const broken = join(dir, 'broken.json');
    writeFileSync(broken, '{ not json', 'utf8');
    assert.equal(hasDiscoverableMcpServer({ configPath: broken }), false);
    assert.equal(hasDiscoverableMcpServer({ configPath: join(dir, 'absent.json') }), false);
    // Still resolves to something runnable rather than throwing.
    assert.equal(typeof resolveMcpServer({ configPath: broken }).command, 'string');
  });
});

// ---------------------------------------------------------------------------

describe('mcp transport: reading Graph URLs and errors', () => {
  it('reduces an absolute Graph URL to a path', () => {
    assert.equal(toRelativeGraphPath('https://graph.microsoft.com/v1.0/me/messages?$top=2'), '/me/messages?$top=2');
    assert.equal(toRelativeGraphPath('https://graph.microsoft.com/beta/me/messages'), '/me/messages');
    assert.equal(toRelativeGraphPath('/me/messages'), '/me/messages');
    assert.equal(toRelativeGraphPath('me/messages'), '/me/messages');
  });

  it('refuses a URL that is not Graph at all', () => {
    assert.throws(
      () => toRelativeGraphPath('https://example.com/steal'),
      (error: unknown) => isVfsError(error),
    );
  });

  it('unwraps the error envelope Graph actually sends', () => {
    assert.deepEqual(describeMcpError({ error: { code: 'ErrorItemNotFound', message: 'gone' } }), {
      detail: 'gone',
      code: 'ErrorItemNotFound',
    });
    assert.deepEqual(describeMcpError({ code: 'X', message: 'y' }), { detail: 'y', code: 'X' });
    assert.deepEqual(describeMcpError('plain'), { detail: 'plain', code: '' });
    assert.deepEqual(describeMcpError(undefined), { detail: '', code: '' });
    // Anything else still produces something a user can read.
    assert.equal(typeof describeMcpError({ weird: true }).detail, 'string');
  });
});

// ---------------------------------------------------------------------------

describe('mcp transport: rejecting a mistyped transport', () => {
  /**
   * These options are otherwise cast through unchecked, so without validation a typo
   * would be dropped in silence and reappear as an unexplained sign-in prompt — the
   * exact failure this transport exists to prevent.
   */
  it('names the valid values when the transport is misspelled', () => {
    assert.throws(
      () => {
        validateSharedOptions({ transport: 'MCP' });
      },
      (error: unknown) => isVfsError(error) && error.message.includes('"mcp"'),
    );
  });

  it('rejects a transport that is not a string at all', () => {
    assert.throws(() => {
      validateSharedOptions({ transport: true });
    }, isVfsError);
  });

  it('rejects an mcp block that is not an object', () => {
    assert.throws(() => {
      validateSharedOptions({ mcp: 'npx workiq' });
    }, isVfsError);
    assert.throws(() => {
      validateSharedOptions({ mcp: { command: 42 } });
    }, isVfsError);
    assert.throws(() => {
      validateSharedOptions({ mcp: { args: 'one two' } });
    }, isVfsError);
  });

  it('accepts what the starter config documents', () => {
    for (const value of ['auto', 'mcp', 'device-code']) {
      assert.doesNotThrow(() => {
        validateSharedOptions({ transport: value });
      });
    }
    assert.doesNotThrow(() => {
      validateSharedOptions({ mcp: { command: 'npx', args: ['-y', 'server'] }, pageSize: 50 });
    });
    assert.doesNotThrow(() => {
      validateSharedOptions(undefined);
    });
  });

  it('is wired into the mount validation, not just available to it', () => {
    // The plugin is where a config file is actually checked; a validator nobody calls
    // would pass every test above and protect nothing.
    assert.throws(() => graphMailPlugin.validateOptions?.({ transport: 'nope' }), isVfsError);
    assert.doesNotThrow(() => graphMailPlugin.validateOptions?.({ transport: 'mcp' }));
  });
});
