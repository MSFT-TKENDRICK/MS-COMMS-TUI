/**
 * The exec plugin tier, run against the shared conformance suite.
 *
 * This is the test that matters most for the plugin story: it drives a real child process
 * over the real JSON-over-stdio protocol, using the same example plugin that ships in
 * `examples/notes-plugin.mjs` and that plugin authors will copy. If the contract holds
 * here, it holds for a plugin written in Python, Go, or bash.
 *
 * It runs in both transport modes. Persistent mode is what production uses; one-shot mode
 * is what a 15-line shell script will do, and it exercises a completely different set of
 * failure paths (fresh process per request, no state carried between calls).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { MemoryStateStore, NULL_LOGGER, type ProviderContext } from '@mscomms/core';
import { conformanceTests } from '@mscomms/core/testing';

import { ExecProvider } from '../provider.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// dist/test -> dist -> provider-exec -> packages -> repo root
const repoRoot = path.resolve(here, '..', '..', '..', '..');
const pluginPath = path.join(repoRoot, 'examples', 'notes-plugin.mjs');
// Point the plugin at a directory guaranteed to exist and to hold nested files.
const notesRoot = path.join(repoRoot, 'packages', 'core', 'src');

const context: ProviderContext = {
  mountPath: '/notes',
  logger: NULL_LOGGER,
  state: new MemoryStateStore(),
  cacheDir: '.',
  secret: () => Promise.resolve(undefined),
};

for (const oneshot of [false, true]) {
  describe(`conformance: exec provider (${oneshot ? 'one-shot' : 'persistent'} transport)`, () => {
    for (const testCase of conformanceTests({
      create: () =>
        new ExecProvider(
          {
            command: [process.execPath, pluginPath],
            env: { NOTES_ROOT: notesRoot },
            timeout: 30,
            oneshot,
          },
          context,
        ),
      offlineOnly: true,
      sampleQuery: 'vfs',
      // A child process per request is slow enough that walking every page of a large
      // directory would dominate the suite's runtime without testing anything new.
      maxPages: oneshot ? 3 : 10,
    })) {
      it(testCase.name, () => testCase.run());
    }
  });
}
