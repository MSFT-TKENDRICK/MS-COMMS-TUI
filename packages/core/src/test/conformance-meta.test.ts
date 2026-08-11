/**
 * Tests for the conformance suite itself.
 *
 * A contract test that passes everything is worse than no contract test, because it
 * creates confidence rather than measuring it. Each case here is a provider that is wrong
 * in one specific, chosen way, and the assertion is that the suite notices.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { conformanceTests } from '../testing/conformance.js';
import type { Capability, ListPage, Provider, VNode } from '../provider.js';

type Flaw =
  | 'duplicate-names'
  | 'endless-cursor'
  | 'lying-capabilities'
  | 'unlocatable-search'
  | 'unstable-names'
  | 'slash-in-name'
  | 'noisy-cold-poll';

/** A provider that is correct except in exactly one respect. */
function brokenProvider(flaw: Flaw): Provider {
  let listCount = 0;

  const capabilities = new Set<Capability>(['list']);
  if (flaw === 'lying-capabilities') capabilities.add('read');
  if (flaw === 'unlocatable-search') capabilities.add('search');
  if (flaw === 'noisy-cold-poll') capabilities.add('poll');

  const provider = {
    id: 'broken',
    displayName: 'Broken',
    capabilities: capabilities as ReadonlySet<Capability>,

    list(_parent: VNode | null, options: { cursor?: string }): Promise<ListPage> {
      listCount += 1;
      if (flaw === 'duplicate-names') {
        return Promise.resolve({
          entries: [
            { name: 'note.eml', id: '1', kind: 'file', title: 'a' },
            // Differs only by case, which is a collision on Windows and macOS.
            { name: 'NOTE.eml', id: '2', kind: 'file', title: 'b' },
          ],
        });
      }
      if (flaw === 'endless-cursor') {
        const n = Number(options.cursor ?? '0');
        return Promise.resolve({
          entries: [{ name: `item-${String(n)}.eml`, id: String(n), kind: 'file', title: 'x' }],
          cursor: String(n + 1),
        });
      }
      if (flaw === 'unstable-names') {
        // Renumbering between two identical listings. `ls` then `cat 3` opens the wrong
        // message, and the user has no way to notice.
        return Promise.resolve({
          entries: [{ name: `item-${String(listCount)}.eml`, id: String(listCount), kind: 'file', title: 'x' }],
        });
      }
      if (flaw === 'slash-in-name') {
        return Promise.resolve({
          entries: [{ name: 'Q3/Q4 forecast.eml', id: '1', kind: 'file', title: 'Q3/Q4 forecast' }],
        });
      }
      return Promise.resolve({ entries: [{ name: 'a.eml', id: '1', kind: 'file', title: 'a' }] });
    },

    search(): Promise<ListPage> {
      // A hit with neither path nor parentPath. The engine's only available guess is that
      // it lives directly under the search root, which is wrong for every nested hit.
      return Promise.resolve({
        entries: [{ name: 'deep.eml', id: '9', kind: 'file', title: 'deep' }],
      });
    },

    poll(): Promise<{ changes: { type: 'created'; path: string; at: Date }[]; cursor: string }> {
      // Reporting everything as new on a cold start turns the first `watch` into a
      // notification storm.
      return Promise.resolve({
        changes: [{ type: 'created' as const, path: 'a.eml', at: new Date() }],
        cursor: '1',
      });
    },
  };

  if (flaw !== 'unlocatable-search') delete (provider as { search?: unknown }).search;
  if (flaw !== 'noisy-cold-poll') delete (provider as { poll?: unknown }).poll;

  return provider as unknown as Provider;
}

async function expectCaseToFail(flaw: Flaw, nameFragment: string, maxPages?: number): Promise<void> {
  const cases = conformanceTests({
    create: () => brokenProvider(flaw),
    ...(maxPages === undefined ? {} : { maxPages }),
  });
  const found = cases.find((testCase) => testCase.name.includes(nameFragment));
  assert.ok(found !== undefined, `no conformance case matching "${nameFragment}"`);
  await assert.rejects(
    () => found.run(),
    `the "${found.name}" check passed a provider with the "${flaw}" flaw`,
  );
}

describe('the conformance suite', () => {
  it('contains a substantial number of checks', () => {
    const cases = conformanceTests({ create: () => brokenProvider('duplicate-names') });
    assert.ok(cases.length > 15, `expected a substantial suite, got ${String(cases.length)} cases`);
  });

  it('gives every check a distinct name', () => {
    const cases = conformanceTests({ create: () => brokenProvider('duplicate-names') });
    const names = new Set(cases.map((testCase) => testCase.name));
    assert.equal(names.size, cases.length, 'two conformance checks share a name');
  });

  it('catches duplicate names within a directory', async () => {
    await expectCaseToFail('duplicate-names', 'unique name');
  });

  it('catches paging that never terminates', async () => {
    await expectCaseToFail('endless-cursor', 'terminates paging', 5);
  });

  it('catches a capability that is declared but not implemented', async () => {
    await expectCaseToFail('lying-capabilities', 'implements every capability');
  });

  it('catches search results that cannot be located', async () => {
    await expectCaseToFail('unlocatable-search', 'located');
  });

  it('catches names that change between identical listings', async () => {
    await expectCaseToFail('unstable-names', 'same names and ids');
  });

  it('catches a separator smuggled into a name', async () => {
    await expectCaseToFail('slash-in-name', 'lists the mount root');
  });

  it('catches a cold poll that reports every existing item as new', async () => {
    await expectCaseToFail('noisy-cold-poll', 'cold start');
  });
});
