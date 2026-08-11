/**
 * Capability negotiation between a plugin's `initialize` and the mount's config.
 *
 * The rule under test: config `capabilities` is a ceiling, not a hint. It exists because
 * the alternative — a user writing `"capabilities": ["list", "read"]` and then being
 * offered a destructive action anyway — is a config file contradicted by the program, and
 * this project treats silent config failure as a bug rather than a nuance.
 *
 * These tests drive a real child process, because the whole point is the handshake, and a
 * mocked handshake would test the mock.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { MemoryStateStore, NULL_LOGGER, type Capability, type ProviderContext } from '@mscomms/core';

import { ExecProvider } from '../provider.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');
const pluginPath = path.join(repoRoot, 'examples', 'notes-plugin.mjs');
const notesRoot = path.join(repoRoot, 'packages', 'core', 'src');

function context(): ProviderContext {
  return {
    mountPath: '/notes',
    logger: NULL_LOGGER,
    state: new MemoryStateStore(),
    cacheDir: '.',
    secret: () => Promise.resolve(undefined),
  };
}

/**
 * A plugin that declares exactly what it is told to, so each test states its own premise
 * instead of depending on what the example plugin happens to support this week.
 */
function fakePlugin(declared: readonly string[] | null): readonly string[] {
  const body =
    declared === null
      ? `const caps = undefined;`
      : `const caps = ${JSON.stringify(declared)};`;
  return [
    process.execPath,
    '-e',
    `${body}
     let buf = '';
     process.stdin.on('data', (c) => {
       buf += c;
       let i;
       while ((i = buf.indexOf('\\n')) !== -1) {
         const line = buf.slice(0, i);
         buf = buf.slice(i + 1);
         if (line.trim() === '') continue;
         const req = JSON.parse(line);
         let result = {};
         if (req.method === 'initialize') {
           result = { protocol: 1, displayName: 'Fake', ...(caps === undefined ? {} : { capabilities: caps }) };
         } else if (req.method === 'list') {
           result = { entries: [{ name: 'a.txt', kind: 'file', id: 'a' }] };
         } else if (req.method === 'read') {
           result = { body: 'hello', format: 'text' };
         } else if (req.method === 'search') {
           result = { entries: [] };
         } else if (req.method === 'actions') {
           result = [{ name: 'nuke', label: 'Nuke', destructive: true }];
         }
         process.stdout.write(JSON.stringify({ id: req.id, result }) + '\\n');
       }
     });`,
  ];
}

async function capsOf(
  declared: readonly string[] | null,
  configured?: readonly Capability[],
): Promise<string[]> {
  const provider = new ExecProvider(
    {
      command: fakePlugin(declared),
      timeout: 30,
      ...(configured === undefined ? {} : { capabilities: configured }),
    },
    context(),
  );
  try {
    await provider.init();
    return [...provider.capabilities].sort();
  } finally {
    await provider.dispose();
  }
}

describe('exec capability negotiation', () => {
  it('accepts what the plugin declares when the mount says nothing', async () => {
    assert.deepEqual(await capsOf(['list', 'read', 'search', 'actions']), [
      'actions',
      'list',
      'read',
      'search',
    ]);
  });

  it('treats the mount config as a ceiling, not a hint', async () => {
    // The regression this file exists for: the plugin offers actions, the user did not
    // allow them, and the user wins.
    assert.deepEqual(await capsOf(['list', 'read', 'search', 'actions'], ['list', 'read']), [
      'list',
      'read',
    ]);
  });

  it('does not grant a capability the plugin never claimed', async () => {
    // Config is a ceiling, not a floor. Claiming `search` here would make the engine call
    // a method the plugin has no handler for.
    assert.deepEqual(await capsOf(['list', 'read'], ['list', 'read', 'search']), ['list', 'read']);
  });

  it('falls back to the configured list when the plugin declares nothing', async () => {
    // The original documented purpose of the option, which must keep working: a one-shot
    // script that cannot be bothered to implement `initialize`.
    assert.deepEqual(await capsOf(null, ['list', 'read', 'search']), ['list', 'read', 'search']);
  });

  it('assumes list and read when neither side says anything', async () => {
    assert.deepEqual(await capsOf(null), ['list', 'read']);
  });

  it('honours an empty declaration from the plugin', async () => {
    // A plugin that says it can do nothing is being honest, not broken.
    assert.deepEqual(await capsOf([], ['list', 'read']), []);
  });

  it('removes the optional method, not just the capability name', async () => {
    // The capability set and the object shape have to agree. The engine checks
    // `'actions' in provider`, so leaving a withheld method installed would let a
    // restricted mount invoke it anyway.
    const provider = new ExecProvider(
      { command: fakePlugin(['list', 'read', 'search', 'actions']), timeout: 30, capabilities: ['list', 'read'] },
      context(),
    );
    try {
      await provider.init();
      assert.equal('search' in provider, false);
      assert.equal('actions' in provider, false);
      assert.equal('invoke' in provider, false);
    } finally {
      await provider.dispose();
    }
  });

  it('installs the optional method when the capability survives', async () => {
    const provider = new ExecProvider(
      { command: fakePlugin(['list', 'read', 'search']), timeout: 30, capabilities: ['list', 'read', 'search'] },
      context(),
    );
    try {
      await provider.init();
      assert.equal('search' in provider, true);
      assert.equal(typeof provider.search, 'function');
    } finally {
      await provider.dispose();
    }
  });
});
