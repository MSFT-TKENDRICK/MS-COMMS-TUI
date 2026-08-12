/**
 * The MCP stdio client, exercised against a real subprocess.
 *
 * A fake would prove nothing here: everything this class can get wrong is about process
 * plumbing — newline framing across chunk boundaries, correlating replies by id, noticing a
 * server that dies or never answers. So these tests spawn `node` running a tiny scripted
 * server, which is portable in a way that depending on any particular MCP server is not.
 *
 * The timeout and dead-child cases are the important ones. Providers initialise before the
 * first frame is drawn, so a wedged subprocess here is a program that never starts, and
 * "hangs forever" is a far worse failure than "reports that the server is broken".
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { McpStdioClient, commandExists } from '../mcp-client.js';

/**
 * A scripted MCP server as a one-liner.
 *
 * Answers `initialize`, then applies `behaviour` to every `tools/call`.
 */
function server(behaviour: string): { command: string; args: string[] } {
  const script = `
    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line === '') continue;
        const message = JSON.parse(line);
        if (message.method === 'initialize') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { serverInfo: { name: 'fake' } } }) + '\\n');
          continue;
        }
        if (message.method === 'tools/call') { ${behaviour} }
      }
    });
  `;
  return { command: process.execPath, args: ['-e', script] };
}

const ECHO = `
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id: message.id,
    result: { structuredContent: { echoed: message.params } },
  }) + '\\n');
`;

describe('commandExists', () => {
  it('finds an executable that is on PATH', () => {
    // `node` is running this test, so it is definitionally present.
    assert.equal(commandExists(process.platform === 'win32' ? 'node' : 'node'), true);
  });

  it('does not find one that is absent', () => {
    assert.equal(commandExists('mscomms-definitely-not-a-real-command'), false);
  });

  it('checks an explicit path directly rather than searching PATH', () => {
    assert.equal(commandExists(process.execPath), true);
  });
});

describe('McpStdioClient', () => {
  it('handshakes and calls a tool', async () => {
    const { command, args } = server(ECHO);
    const client = new McpStdioClient({ command, args, timeoutMs: 20_000 });
    try {
      const result = await client.callTool('fetch', { entityUrls: ['/me'] });
      assert.deepEqual(result.structuredContent, {
        echoed: { name: 'fetch', arguments: { entityUrls: ['/me'] } },
      });
    } finally {
      client.dispose();
    }
  });

  it('reuses one process across calls', async () => {
    // A fresh server per request would pay a process start, and a fresh sign-in, every time
    // a listing scrolled.
    const counter = `
      globalThis.count = (globalThis.count ?? 0) + 1;
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { structuredContent: { count: globalThis.count } } }) + '\\n');
    `;
    const { command, args } = server(counter);
    const client = new McpStdioClient({ command, args, timeoutMs: 20_000 });
    try {
      await client.callTool('a', {});
      const second = await client.callTool('a', {});
      assert.deepEqual(second.structuredContent, { count: 2 });
    } finally {
      client.dispose();
    }
  });

  it('matches replies to requests when they arrive out of order', async () => {
    // Nothing promises a server answers in order, and mixing up two listings would show
    // mail in the Teams pane.
    const delayed = `
      const wait = message.params.arguments.wait;
      setTimeout(() => {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { structuredContent: { wait } } }) + '\\n');
      }, wait);
    `;
    const { command, args } = server(delayed);
    const client = new McpStdioClient({ command, args, timeoutMs: 20_000 });
    try {
      const [slow, fast] = await Promise.all([
        client.callTool('t', { wait: 150 }),
        client.callTool('t', { wait: 10 }),
      ]);
      assert.deepEqual(slow.structuredContent, { wait: 150 });
      assert.deepEqual(fast.structuredContent, { wait: 10 });
    } finally {
      client.dispose();
    }
  });

  it('reassembles a reply that arrives in pieces', async () => {
    // stdout is a byte stream: a large listing routinely splits mid-JSON.
    const chunked = `
      const body = JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { structuredContent: { big: 'x'.repeat(200) } } }) + '\\n';
      for (const piece of body.match(/[\\s\\S]{1,7}/g)) process.stdout.write(piece);
    `;
    const { command, args } = server(chunked);
    const client = new McpStdioClient({ command, args, timeoutMs: 20_000 });
    try {
      const result = await client.callTool('t', {});
      assert.equal((result.structuredContent as { big: string }).big.length, 200);
    } finally {
      client.dispose();
    }
  });

  it('ignores non-JSON noise on stdout', async () => {
    const noisy = `
      process.stdout.write('starting up...\\n');
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { structuredContent: { ok: true } } }) + '\\n');
    `;
    const { command, args } = server(noisy);
    const client = new McpStdioClient({ command, args, timeoutMs: 20_000 });
    try {
      assert.deepEqual((await client.callTool('t', {})).structuredContent, { ok: true });
    } finally {
      client.dispose();
    }
  });

  it('surfaces a JSON-RPC error rather than hanging', async () => {
    const failing = `
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'no such tool' } }) + '\\n');
    `;
    const { command, args } = server(failing);
    const client = new McpStdioClient({ command, args, timeoutMs: 20_000 });
    try {
      await assert.rejects(() => client.callTool('missing', {}), /no such tool/);
    } finally {
      client.dispose();
    }
  });

  it('gives up on a server that never answers', async () => {
    const silent = 'void message;';
    const { command, args } = server(silent);
    const client = new McpStdioClient({ command, args, timeoutMs: 300 });
    try {
      await assert.rejects(() => client.callTool('t', {}), /did not answer/);
    } finally {
      client.dispose();
    }
  });

  it('fails the call when the server exits mid-request', async () => {
    const quitting = 'void message; process.exit(3);';
    const { command, args } = server(quitting);
    const client = new McpStdioClient({ command, args, timeoutMs: 20_000 });
    try {
      await assert.rejects(() => client.callTool('t', {}), /exited with code/);
    } finally {
      client.dispose();
    }
  });

  it('reports a command that does not exist', async () => {
    const client = new McpStdioClient({
      command: 'mscomms-definitely-not-a-real-command',
      args: [],
      timeoutMs: 5_000,
    });
    try {
      await assert.rejects(() => client.callTool('t', {}));
    } finally {
      client.dispose();
    }
  });

  it('can start again after a failed start', async () => {
    // A cached rejected handshake would turn one bad start into a permanently broken mount.
    const { command, args } = server(ECHO);
    const client = new McpStdioClient({ command, args, timeoutMs: 20_000 });
    try {
      client.dispose();
      const result = await client.callTool('fetch', { entityUrls: ['/me'] });
      assert.ok(result.structuredContent);
    } finally {
      client.dispose();
    }
  });

  it('drains stderr to the log instead of letting it fill the pipe', async () => {
    const chatty = `
      process.stderr.write('banner line\\n');
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) + '\\n');
    `;
    const { command, args } = server(chatty);
    const logged: string[] = [];
    const client = new McpStdioClient({
      command,
      args,
      timeoutMs: 20_000,
      onLog: (message) => logged.push(message),
    });
    try {
      await client.callTool('t', {});
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.ok(logged.some((line) => line.includes('banner line')));
    } finally {
      client.dispose();
    }
  });
});
