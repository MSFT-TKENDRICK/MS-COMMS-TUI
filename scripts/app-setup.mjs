/**
 * Provision a checkout the way the GitHub Copilot desktop app's Setup script expects.
 *
 * The app runs this once per workspace it creates, before the Run script, and a fresh
 * worktree has neither `node_modules` nor `dist` — both are gitignored — so every other
 * entry point in this repo fails until this has run.
 *
 * `node scripts/app-setup.mjs` rather than `npm install && npm run build` on purpose: the
 * app launches scripts through `cmd.exe /C` on Windows and `sh -c` elsewhere, and the two
 * disagree about quoting, `&&` and `$VAR` / `%VAR%`. Node is the one interpreter this repo
 * is guaranteed to have, so every platform decision is made here instead, where it can be
 * read and tested.
 *
 * Safe to re-run: npm and `tsc --build` are both incremental.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { build } from './lib/build.mjs';
import { ROOT, runNpm } from './lib/npm.mjs';

/** Matches the `engines.node` floor in package.json. */
const MINIMUM_NODE = [20, 11, 0];

function parseVersion(raw) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(raw);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isTooOld(version, minimum) {
  for (let i = 0; i < minimum.length; i += 1) {
    if (version[i] > minimum[i]) return false;
    if (version[i] < minimum[i]) return true;
  }
  return false;
}

function checkNode() {
  const version = parseVersion(process.version);
  if (version === null) return true;
  if (!isTooOld(version, MINIMUM_NODE)) return true;
  console.error(`Node ${MINIMUM_NODE.join('.')} or newer is required; this is ${process.version}.`);
  console.error('  Install a newer Node and run the Setup script again.');
  return false;
}

async function install() {
  // `npm ci` is the reproducible one, and cheap here: the only devDependencies are
  // TypeScript and its Node types. It refuses to run when the lockfile has drifted from
  // package.json, which is a real state to be in during dependency work and not a reason to
  // leave the workspace unusable — so fall back rather than stopping.
  if (existsSync(join(ROOT, 'package-lock.json'))) {
    const code = await runNpm(['ci'], { label: 'install' });
    if (code === 0) return 0;
    console.log('npm ci did not succeed; falling back to npm install.');
  }
  return runNpm(['install'], { label: 'install' });
}

async function main() {
  if (!checkNode()) return 1;

  console.log(`Setting up MS-COMMS-TUI in ${ROOT}`);

  const installed = await install();
  if (installed !== 0) {
    console.error('Dependency install failed; not attempting the build.');
    return installed;
  }

  const built = await build();
  if (built !== 0) {
    console.error('Build failed. Fix the TypeScript errors above and run the Setup script again.');
    return built;
  }

  console.log('');
  console.log('Ready. From here:');
  console.log('  npm start                        the shell — type `demo` for sample data');
  console.log('  npm test                         the test suite');
  console.log('  npm run msh -- --help            one-shot commands');
  return 0;
}

process.exitCode = await main();
