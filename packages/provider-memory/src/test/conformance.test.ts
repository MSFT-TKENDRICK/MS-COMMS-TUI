/**
 * The memory provider, run against the shared conformance suite.
 *
 * This is the reference implementation, so it is held to the contract in every
 * configuration the engine can put it in: with and without native search, across all
 * fixtures, with pages small enough to force real cursor paging, and — the case everyone
 * forgets — against an entirely empty backend.
 */

import { describe, it } from 'node:test';

import { conformanceTests } from '@mscomms/core/testing';

import { MemoryProvider } from '../provider.js';
import type { MemoryProviderOptions } from '../types.js';

// A pinned clock, so every relative timestamp in the fixtures is reproducible.
const now = (): number => Date.UTC(2026, 7, 11, 12, 0, 0);

interface Configuration {
  readonly label: string;
  readonly options: MemoryProviderOptions;
  readonly sampleQuery?: string;
}

const configurations: readonly Configuration[] = [
  { label: 'mail fixture, client-side search', options: { fixture: 'mail', nativeSearch: false } },
  { label: 'mail fixture, native search', options: { fixture: 'mail', nativeSearch: true } },
  { label: 'mail fixture, tiny pages', options: { fixture: 'mail', pageSize: 2 } },
  { label: 'chat fixture', options: { fixture: 'chat' }, sampleQuery: 'is:unread' },
  { label: 'issues fixture', options: { fixture: 'issues' }, sampleQuery: 'kind:file' },
  // An empty backend is the case every provider forgets. `ls` on a brand-new mailbox must
  // be a clean empty listing, not a crash and not a hang.
  { label: 'empty fixture', options: { fixture: 'empty' } },
];

for (const configuration of configurations) {
  describe(`conformance: memory provider (${configuration.label})`, () => {
    for (const testCase of conformanceTests({
      create: () => new MemoryProvider({ ...configuration.options, now }),
      offlineOnly: true,
      ...(configuration.sampleQuery === undefined ? {} : { sampleQuery: configuration.sampleQuery }),
    })) {
      it(testCase.name, () => testCase.run());
    }
  });
}
