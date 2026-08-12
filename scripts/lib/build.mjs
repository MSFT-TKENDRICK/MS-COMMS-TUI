/**
 * Bringing `dist/` up to date, from any state a checkout can be found in.
 *
 * `tsc --build` decides what to recompile from the `.tsbuildinfo` files next to each
 * package's tsconfig, and those files outlive the output they describe: delete a `dist/`
 * without deleting its `.tsbuildinfo` — `git clean` a subdirectory, interrupt a build, copy
 * a tree without it — and TypeScript will cheerfully report that everything is up to date
 * while the compiled package is simply gone. Downstream packages then fail to resolve it,
 * which reads as a dependency problem rather than the stale-cache problem it is.
 *
 * So before building, check the two against each other and clean when they disagree.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, runNpm } from './npm.mjs';

const PACKAGES = join(ROOT, 'packages');

/** Workspace packages whose incremental build state claims output that is not on disk. */
export function stalePackages() {
  let entries;
  try {
    entries = readdirSync(PACKAGES, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(PACKAGES, entry.name))
    .filter((dir) => existsSync(join(dir, 'tsconfig.tsbuildinfo')) && !existsSync(join(dir, 'dist')))
    .map((dir) => dir.slice(PACKAGES.length + 1));
}

/**
 * Compile every workspace package. Resolves to an exit code.
 *
 * `silent` suppresses npm's own banner — `--silent` is consumed by npm rather than
 * forwarded — so an up-to-date build says nothing at all while a broken one still prints
 * tsc's errors through the inherited stdio.
 */
export async function build({ silent = false } = {}) {
  const stale = stalePackages();
  if (stale.length > 0) {
    console.log(`Compiled output is missing for ${stale.join(', ')} but the build cache still`);
    console.log('claims it exists, so the cache is being cleared before building.');
    const cleaned = await runNpm(['run', 'clean', '--silent'], { label: 'clean', echo: !silent });
    if (cleaned !== 0) console.log('Clean did not succeed; attempting the build anyway.');
  }

  const args = silent ? ['run', 'build', '--silent'] : ['run', 'build'];
  return runNpm(args, { label: 'build', echo: !silent });
}
