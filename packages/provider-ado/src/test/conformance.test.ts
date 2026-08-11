/**
 * The Azure DevOps Boards provider, run against the shared conformance suite.
 *
 * Two configurations, because the two ways a mount can be set up take different code paths
 * at the root: an explicit `projects` list (what a single-project PAT needs, and what skips
 * discovery entirely) and organization-wide discovery.
 *
 * Everything runs against the fake organization in `fake-ado.ts`, so the suite needs no
 * network, no credentials and no Azure DevOps tenant.
 */

import { describe, it } from 'node:test';

import { conformanceTests } from '@mscomms/core/testing';

import { AdoBoardsProvider } from '../provider.js';
import { createFakeAdo, PROJECT, testContext } from './fake-ado.js';

const configurations = [
  { label: 'explicit project list', projects: [PROJECT] as readonly string[] | undefined },
  { label: 'organization-wide discovery', projects: undefined },
];

for (const configuration of configurations) {
  describe(`conformance: azure devops boards (${configuration.label})`, () => {
    for (const testCase of conformanceTests({
      create: () =>
        new AdoBoardsProvider(
          {
            organization: 'contoso',
            auth: 'pat',
            token: 'fake-token',
            transport: createFakeAdo().transport,
            // Small enough that every listing level has to page for real.
            pageSize: 2,
            ...(configuration.projects === undefined ? {} : { projects: configuration.projects }),
          },
          testContext(),
        ),
      offlineOnly: true,
      sampleQuery: 'kind:file',
    })) {
      it(testCase.name, () => testCase.run());
    }
  });
}
