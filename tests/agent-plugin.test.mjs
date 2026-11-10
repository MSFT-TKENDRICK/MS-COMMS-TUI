import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const readJson = async (path) => JSON.parse(await readFile(join(root, path), 'utf8'));

async function assertContained(path, pluginRoot, visited = new Set()) {
  const resolved = await realpath(path);
  const remainder = relative(pluginRoot, resolved);
  assert.ok(remainder !== '..' && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder),
    `${path} resolves outside the plugin`);
  if (!(await stat(resolved)).isDirectory() || visited.has(resolved)) return;
  visited.add(resolved);
  for (const entry of await readdir(resolved)) {
    await assertContained(join(resolved, entry), pluginRoot, visited);
  }
}

test('portable manifest and marketplace identify the same plugin', async () => {
  const manifest = await readJson('plugin.json');
  const catalog = await readJson('.github/plugin/marketplace.json');
  assert.equal(manifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.equal(manifest.name, 'ms-comms-tui');
  assert.equal(catalog.name, 'ms-comms');
  assert.deepEqual(catalog.plugins.map(({ name }) => name), [manifest.name]);
  assert.equal(catalog.plugins[0].source, './');
  assert.equal(catalog.plugins[0].version, manifest.version);
});

test('the packaged skill and its references remain inside the plugin root', async () => {
  const pluginRoot = await realpath(root);
  await assertContained(join(root, 'plugin.json'), pluginRoot);
  await assertContained(join(root, 'skills'), pluginRoot);
  const skills = await readdir(join(root, 'skills'), { withFileTypes: true });
  assert.deepEqual(skills.map(({ name }) => name), ['ms-comms-tui']);
  const skill = await readFile(join(root, 'skills', 'ms-comms-tui', 'SKILL.md'), 'utf8');
  assert.match(skill, /^name: ms-comms-tui$/m);
  for (const reference of ['commands.md', 'safety.md']) {
    await stat(join(root, 'skills', 'ms-comms-tui', 'references', reference));
    assert.ok(skill.includes(`references/${reference}`));
  }
});
