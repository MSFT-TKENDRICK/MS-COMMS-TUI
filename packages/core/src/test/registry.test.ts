import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildMounts,
  MemoryStateStore,
  PluginRegistry,
  type MountConfig,
  type Provider,
  type ProviderPlugin,
} from '../index.js';

/**
 * Mount options that nothing reads.
 *
 * The failure being pinned here is a real one: an option a provider does not understand is
 * accepted in silence, so the file says one thing and the program does another and nothing
 * ever mentions it. Someone who configures a behaviour that never runs has no way to tell
 * that from a behaviour that ran and did nothing — the mount comes up looking healthy either
 * way, and the config keeps saying what they meant.
 */

function stubProvider(): Provider {
  return {
    displayName: 'Stub',
    list: () => Promise.resolve({ entries: [] }),
    read: () => Promise.resolve({ body: '' }),
  } as unknown as Provider;
}

function plugin(overrides: Partial<ProviderPlugin<unknown>> = {}): ProviderPlugin<unknown> {
  return {
    type: 'stub',
    displayName: 'Stub',
    create: () => stubProvider(),
    ...overrides,
  };
}

async function build(
  used: ProviderPlugin<unknown>,
  options: Record<string, unknown>,
): Promise<readonly string[] | undefined> {
  const registry = new PluginRegistry();
  registry.register(used);
  const config: MountConfig = { path: '/stub', type: used.type, options };
  const [result] = await buildMounts([config], {
    registry,
    stateFor: () => new MemoryStateStore(),
    cacheDirFor: () => '.',
  });
  assert.ok(result !== undefined);
  assert.ok(result.mount !== undefined, 'the mount should still come up');
  return result.ignoredOptions;
}

describe('mount options a provider never reads', () => {
  it('names the option, because "some config was ignored" is the problem, not the fix', async () => {
    const ignored = await build(
      plugin({ optionKeys: ['clientId', 'tenantId'] }),
      { clientId: 'abc', proxyUrl: 'http://localhost' },
    );
    assert.deepEqual(ignored, ['proxyUrl']);
  });

  it('still mounts, since an option nobody reads is not a reason to lose the source', async () => {
    const registry = new PluginRegistry();
    registry.register(plugin({ optionKeys: ['clientId'] }));
    const [result] = await buildMounts([{ path: '/stub', type: 'stub', options: { nope: 1 } }], {
      registry,
      stateFor: () => new MemoryStateStore(),
      cacheDirFor: () => '.',
    });
    assert.ok(result?.mount !== undefined);
    assert.equal(result.error, undefined);
  });

  it('reports every unread option, not just the first one found', async () => {
    const ignored = await build(plugin({ optionKeys: ['clientId'] }), {
      clientId: 'abc',
      proxyUrl: 'http://localhost',
      retries: 3,
    });
    assert.deepEqual(ignored, ['proxyUrl', 'retries']);
  });

  it('says nothing when every option is one the provider reads', async () => {
    const ignored = await build(plugin({ optionKeys: ['clientId', 'scopes'] }), {
      clientId: 'abc',
      scopes: ['Mail.Read'],
    });
    assert.equal(ignored, undefined);
  });

  // A provider is allowed to take open-ended options — the RSS mount carries arbitrary
  // nested structure through to its feed definitions. Complaining about config that works
  // would be the same sin as staying quiet about config that does not.
  it('stays silent for a plugin that never declared what it reads', async () => {
    const ignored = await build(plugin(), { anything: { nested: true }, at: 'all' });
    assert.equal(ignored, undefined);
  });

  it('does not trip over a mount with no options at all', async () => {
    const ignored = await build(plugin({ optionKeys: ['clientId'] }), {});
    assert.equal(ignored, undefined);
  });
});

