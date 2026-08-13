/**
 * The GitHub provider, run against the shared conformance suite.
 *
 * Two configurations, because a token is the thing that changes the shape of the tree:
 * authenticated mounts gain the GraphQL-only folders (discussions and projects), and those
 * folders page over `pageInfo` cursors rather than `Link` headers. Running both means the
 * two cursor dialects are checked against the same rules — that paging terminates, that
 * names stay stable between listings, and that a cursor never comes back forever.
 *
 * Everything runs against the fake in `fake-github.ts`, so the suite needs no network, no
 * credentials and no GitHub account.
 */

import { describe, it } from 'node:test';

import { conformanceTests } from '@mscomms/core/testing';

import { GitHubProvider } from '../provider.js';
import { createFakeGitHub, OWNER, REPO, testContext } from './fake-github.js';

const configurations = [
  { label: 'authenticated', token: 'fake-token', notifications: true },
  { label: 'anonymous', token: '', notifications: false },
];

for (const configuration of configurations) {
  describe(`conformance: github (${configuration.label})`, () => {
    for (const testCase of conformanceTests({
      create: () =>
        new GitHubProvider(
          {
            repos: [`${OWNER}/${REPO}`],
            owners: ['acme'],
            token: configuration.token,
            state: 'all',
            includeNotifications: configuration.notifications,
            transport: createFakeGitHub({ pageDiscussions: true }).transport,
          },
          testContext(),
        ),
      offlineOnly: true,
      sampleQuery: 'is:open',
    })) {
      it(testCase.name, () => testCase.run());
    }
  });
}
