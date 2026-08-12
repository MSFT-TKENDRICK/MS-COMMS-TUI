/**
 * The starter config is the first file most people ever see, and `mscomms init` writes it
 * without checking it. That combination let it drift: for a while every mount used
 * `"provider"` where the validator wants `"type"`, so `init` produced a config that
 * `doctor` immediately rejected.
 *
 * These tests close that gap by running the file through the same validators the real
 * loader uses, including the commented-out examples. The commented blocks matter most:
 * they are the ones people uncomment, and they are the ones nothing else exercises.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseJsonc, validateConfig } from '@mscomms/core';

import { builtinRegistry } from '../index.js';
import { STARTER_CONFIG } from '../starter-config.js';

/**
 * Uncomment every commented-out mount so the examples get validated too.
 *
 * Each example is a `//`-prefixed object: a line that is just `{`, then its body, then a
 * line that is just `},`. Tracking that shape rather than pattern-matching individual
 * lines keeps prose out of the result — a comment line can quite reasonably begin with a
 * quote, and guessing line by line gets that wrong.
 */
function uncommentExamples(source: string): string {
  const out: string[] = [];
  let depth = 0;
  for (const line of source.split('\n')) {
    const match = /^(\s*)\/\/ ?(.*)$/.exec(line);
    if (match === null) {
      out.push(line);
      continue;
    }
    const [, indent = '', body = ''] = match;
    const trimmed = body.trim();
    if (depth === 0 && trimmed !== '{') {
      out.push(line); // Prose above or between the examples.
      continue;
    }
    depth += (trimmed.match(/[{[]/g) ?? []).length - (trimmed.match(/[}\]]/g) ?? []).length;
    out.push(`${indent}${body}`);
  }
  return out.join('\n');
}

describe('starter config', () => {
  it('is valid JSONC', () => {
    const parsed = parseJsonc(STARTER_CONFIG, 'starter-config.ts');
    assert.equal(typeof parsed, 'object');
    assert.notEqual(parsed, null);
  });

  it('passes the same validation `mscomms doctor` runs', () => {
    const config = validateConfig(parseJsonc(STARTER_CONFIG), 'starter-config.ts');
    assert.ok(config.mounts.length > 0, 'the starter config should mount something out of the box');
  });

  it('mounts a provider type that is actually registered', () => {
    const config = validateConfig(parseJsonc(STARTER_CONFIG));
    const registry = builtinRegistry();
    for (const mount of config.mounts) {
      assert.ok(
        registry.has(mount.type),
        `mount ${mount.path} uses type "${mount.type}", which no builtin plugin provides`,
      );
    }
  });

  it('mounts options the provider accepts', () => {
    const config = validateConfig(parseJsonc(STARTER_CONFIG));
    const registry = builtinRegistry();
    for (const mount of config.mounts) {
      const plugin = registry.get(mount.type);
      // Throws if the options are wrong, which is the assertion.
      plugin.validateOptions?.(mount.options ?? {});
    }
  });

  describe('commented-out examples', () => {
    const revived = validateConfig(parseJsonc(uncommentExamples(STARTER_CONFIG)));

    it('include every builtin provider, so nothing is undiscoverable', () => {
      const registry = builtinRegistry();
      const shown = new Set(revived.mounts.map((mount) => mount.type));
      for (const plugin of registry.all) {
        assert.ok(
          shown.has(plugin.type),
          `"${plugin.type}" is registered but the starter config never mentions it, so nobody will find it`,
        );
      }
    });

    it('name provider types that exist', () => {
      const registry = builtinRegistry();
      for (const mount of revived.mounts) {
        assert.ok(registry.has(mount.type), `example mount ${mount.path} uses unknown type "${mount.type}"`);
      }
    });

    it('pass each provider\u2019s own option validation', () => {
      const registry = builtinRegistry();
      for (const mount of revived.mounts) {
        const plugin = registry.get(mount.type);
        assert.doesNotThrow(
          () => plugin.validateOptions?.(mount.options ?? {}),
          `example options for "${mount.type}" are not valid`,
        );
      }
    });

    it('mount Azure DevOps boards', () => {
      const ado = revived.mounts.find((mount) => mount.type === 'ado-boards');
      assert.ok(ado !== undefined, 'the starter config should show how to mount Azure DevOps boards');
      assert.equal(ado.path, '/ado');
      assert.equal((ado.options as { organization?: unknown } | undefined)?.organization, 'contoso');
    });
  });
});
