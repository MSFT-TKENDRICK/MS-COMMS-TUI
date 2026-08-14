/**
 * Configuration tests.
 *
 * The config file is the one piece of this system a user edits by hand, usually once, often
 * at speed, and always without reading the documentation first. Every test here is about a
 * mistake a real person will make, and whether the resulting message tells them how to fix
 * it or just says "Unexpected token }".
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_CONFIG,
  isSecretRef,
  parseJsonc,
  resolveAppPaths,
  stripJsonc,
  validateConfig,
} from '../config.js';
import { VfsError } from '../errors.js';

const minimal = {
  mounts: [{ path: '/mail', type: 'memory', options: { fixture: 'mail' } }],
};

describe('stripJsonc', () => {
  it('removes a line comment', () => {
    assert.equal(JSON.parse(stripJsonc('{"a": 1} // trailing')).a, 1);
  });

  it('removes a block comment', () => {
    assert.equal(JSON.parse(stripJsonc('{/* why */ "a": 1}')).a, 1);
  });

  it('removes a trailing comma in an object and an array', () => {
    assert.deepEqual(JSON.parse(stripJsonc('{"a": [1, 2,],}')), { a: [1, 2] });
  });

  it('leaves a // inside a string alone', () => {
    // The single most common way a naive comment stripper corrupts a config: every URL
    // contains "//".
    const text = '{"url": "https://example.com/feed.xml"}';
    assert.equal(JSON.parse(stripJsonc(text)).url, 'https://example.com/feed.xml');
  });

  it('leaves a /* inside a string alone', () => {
    assert.equal(JSON.parse(stripJsonc('{"glob": "src/*"}')).glob, 'src/*');
  });

  it('respects escaped quotes when tracking whether it is inside a string', () => {
    const text = '{"quote": "she said \\"hi // there\\"", "n": 1}';
    const parsed = JSON.parse(stripJsonc(text));
    assert.equal(parsed.quote, 'she said "hi // there"');
    assert.equal(parsed.n, 1);
  });

  it('preserves line numbers so a parse error still points at the right line', () => {
    // Stripping a comment must not delete the newline after it, or every error message
    // below that point sends the user to the wrong line.
    const text = '{\n// a comment\n"a": 1\n}';
    assert.equal(stripJsonc(text).split('\n').length, text.split('\n').length);
  });

  it('leaves a comma that is genuinely between values', () => {
    assert.deepEqual(JSON.parse(stripJsonc('[1, 2, 3]')), [1, 2, 3]);
  });

  it('handles a trailing comma followed by a comment', () => {
    assert.deepEqual(JSON.parse(stripJsonc('{"a": 1, // note\n}')), { a: 1 });
  });
});

describe('parseJsonc', () => {
  it('reports a syntax error as a config error, naming the file', () => {
    assert.throws(
      () => parseJsonc('{"a": }', '/home/me/config.jsonc'),
      (error: unknown) =>
        error instanceof VfsError &&
        error.code === 'ECONFIG' &&
        error.message.includes('/home/me/config.jsonc'),
    );
  });

  it('accepts an empty file as an empty object rather than failing', () => {
    assert.deepEqual(parseJsonc('   '), {});
  });
});

describe('validateConfig', () => {
  it('accepts a minimal config and fills in the defaults', () => {
    const config = validateConfig(minimal);
    assert.equal(config.mounts.length, 1);
    assert.equal(config.ui.dateStyle, DEFAULT_CONFIG.ui.dateStyle);
  });

  it('rejects a config that is not an object', () => {
    for (const bad of [[], 'a string', 42, null]) {
      assert.throws(
        () => validateConfig(bad),
        (error: unknown) => error instanceof VfsError && error.code === 'ECONFIG',
      );
    }
  });

  it('requires a mount path to be absolute', () => {
    assert.throws(
      () => validateConfig({ mounts: [{ path: 'mail', type: 'memory' }] }),
      (error: unknown) => error instanceof VfsError && /absolute|start/i.test(error.message),
    );
  });

  it('rejects a mount with no type, and says what is missing', () => {
    assert.throws(
      () => validateConfig({ mounts: [{ path: '/mail' }] }),
      (error: unknown) => error instanceof VfsError && /type/i.test(error.message),
    );
  });

  it('rejects two mounts at the same path', () => {
    // Otherwise one of the two silently wins and the user's mail is simply absent.
    assert.throws(
      () =>
        validateConfig({
          mounts: [
            { path: '/mail', type: 'memory' },
            { path: '/mail', type: 'rss' },
          ],
        }),
      (error: unknown) => error instanceof VfsError && error.code === 'ECONFIG',
    );
  });

  it('rejects a mount at the root, and explains why', () => {
    assert.throws(
      () => validateConfig({ mounts: [{ path: '/', type: 'memory' }] }),
      (error: unknown) => error instanceof VfsError && error.hint !== undefined,
    );
  });

  it('normalizes a mount path with a trailing slash', () => {
    const config = validateConfig({ mounts: [{ path: '/mail/', type: 'memory' }] });
    assert.equal(config.mounts[0]?.path, '/mail');
  });

  it('carries provider options through untouched', () => {
    // The core cannot know what a provider's options mean, so it must not "helpfully"
    // reshape them.
    const options = { url: 'https://example.com/feed.xml', nested: { deep: [1, 2] } };
    const config = validateConfig({ mounts: [{ path: '/f', type: 'rss', options }] });
    assert.deepEqual(config.mounts[0]?.options, options);
  });

  it('reports an unknown top-level setting without throwing the rest of the file away', () => {
    // Two failure modes, and this has to avoid both. Silently dropping "savedQueries" leaves
    // a user unable to tell a typo from a broken feature. But refusing the file outright is
    // worse than it sounds: one stale key took every mount with it, so a machine with four
    // working sources reported that it had none — and `doctor`, the command that exists to
    // explain that, died on the same error.
    const config = validateConfig({
      ...minimal,
      mounts: [{ path: '/f', type: 'rss', options: { url: 'https://example.com/feed.xml' } }],
      savedQueries: [{ name: 'unread', query: 'is:unread' }],
    });
    assert.equal(config.mounts.length, 1, 'the rest of the config still loads');
    assert.equal(config.warnings?.length, 1);
    assert.match(config.warnings?.[0] ?? '', /savedQueries/);
  });

  it('suggests the right setting when the key is a near miss', () => {
    const config = validateConfig({ mount: [] });
    assert.match(config.warnings?.[0] ?? '', /Did you mean "mounts"/);
  });

  it('lists the known settings when the key is not close to anything', () => {
    const config = validateConfig({ enableTelemetryPlease: true });
    assert.match(config.warnings?.[0] ?? '', /mounts/);
  });

  it('names every unknown setting, not just the first one', () => {
    // A user who has two stale keys should learn that in one pass rather than one per run.
    const config = validateConfig({ ...minimal, snapshot: {}, telemetry: true });
    assert.equal(config.warnings?.length, 2);
  });

  it('says nothing when every setting is known', () => {
    // The warning list has to stay empty in the ordinary case, or the startup line that
    // prints it becomes noise everyone learns to scroll past.
    assert.equal(validateConfig({ ...minimal }).warnings, undefined);
  });

  it('allows a $schema key so editors can offer completion', () => {
    assert.doesNotThrow(() => validateConfig({ $schema: './schema.json', ...minimal }));
  });

  it('rejects a saved query with no query text', () => {
    assert.throws(
      () => validateConfig({ ...minimal, queries: [{ name: 'unread' }] }),
      (error: unknown) => error instanceof VfsError && error.code === 'ECONFIG',
    );
  });

  it('rejects a poll interval that would busy-loop against the API', () => {
    for (const intervalMs of [0, -1, 10]) {
      assert.throws(
        () => validateConfig({ ...minimal, watches: [{ id: 'i', path: '/mail', intervalMs }] }),
        (error: unknown) => error instanceof VfsError && error.code === 'ECONFIG',
        `intervalMs ${String(intervalMs)} should have been rejected`,
      );
    }
  });

  it('accepts a sensible poll interval', () => {
    const config = validateConfig({ ...minimal, watches: [{ id: 'i', path: '/mail', intervalMs: 60_000 }] });
    assert.equal(config.watches[0]?.intervalMs, 60_000);
  });

  it('names the offending file in the error when a source path is given', () => {
    assert.throws(
      () => validateConfig({ mounts: 'nope' }, '/etc/mscomms.jsonc'),
      (error: unknown) => error instanceof VfsError && error.message.includes('/etc/mscomms.jsonc'),
    );
  });

  it('accepts a config with no mounts at all', () => {
    // A first run with an empty config should start and say so, not refuse to launch.
    const config = validateConfig({});
    assert.deepEqual(config.mounts, []);
  });

  it('accepts every voice engine the program offers, including the default', () => {
    // This rejected "mai" while `starter-config.ts` recommended it and the docs named it as
    // the default — so copying the program's own example into a config file made the program
    // refuse to start. Enumerated here rather than spot-checked, because the failure was a
    // list in one file drifting from a list in another.
    for (const engine of ['mai', 'foundry', 'azure-speech', 'openai', 'xai', 'command']) {
      assert.equal(validateConfig({ ...minimal, voice: { engine } }).voice.engine, engine);
    }
    assert.throws(
      () => validateConfig({ ...minimal, voice: { engine: 'whisper' } }),
      (error: unknown) => error instanceof VfsError && error.message.includes('whisper'),
    );
  });

  it('refuses push-to-talk settings a config file cannot mean', () => {
    assert.throws(
      () => validateConfig({ ...minimal, voice: { pushToTalk: 'hodl' } }),
      (error: unknown) => error instanceof VfsError && error.message.includes('hodl'),
    );
    // Negative is not a slower stop, it is a stop in the past.
    assert.throws(
      () => validateConfig({ ...minimal, voice: { releaseDelayMs: -1 } }),
      (error: unknown) => error instanceof VfsError && error.code === 'ECONFIG',
    );
    assert.throws(
      () => validateConfig({ ...minimal, voice: { releaseDelayMs: 'soon' } }),
      (error: unknown) => error instanceof VfsError && error.code === 'ECONFIG',
    );
    assert.equal(validateConfig({ ...minimal, voice: { releaseDelayMs: 0 } }).voice.releaseDelayMs, 0);
    for (const mode of ['auto', 'hold', 'toggle']) {
      assert.equal(validateConfig({ ...minimal, voice: { pushToTalk: mode } }).voice.pushToTalk, mode);
    }
  });
});

describe('validateConfig: cache', () => {
  const withCache = (cache: unknown): unknown => ({ ...minimal, cache });

  it('defaults to no cache block at all', () => {
    assert.deepEqual(validateConfig(minimal).cache, {});
  });

  it('accepts a full cache block and keeps every field', () => {
    const config = validateConfig(
      withCache({
        enabled: true,
        path: '/tmp/snapshot.db',
        driver: 'libsql',
        recent: 500,
        ttlMs: 60_000,
        intervalMs: 120_000,
        depth: 2,
        bodies: 25,
        vectors: true,
        prefetch: true,
        prefetchConcurrency: 3,
        audit: true,
      }),
    );
    assert.equal(config.cache.driver, 'libsql');
    assert.equal(config.cache.recent, 500);
    assert.equal(config.cache.vectors, true);
    assert.equal(config.cache.audit, true);
    assert.equal(config.cache.path, '/tmp/snapshot.db');
  });

  it('accepts every driver it advertises', () => {
    for (const driver of ['auto', 'libsql', 'node-sqlite']) {
      assert.equal(validateConfig(withCache({ driver })).cache.driver, driver);
    }
  });

  it('rejects a driver it does not have, and lists the ones it does', () => {
    assert.throws(
      () => validateConfig(withCache({ driver: 'postgres' })),
      (error: unknown) =>
        error instanceof VfsError &&
        error.code === 'ECONFIG' &&
        error.message.includes('libsql') &&
        error.message.includes('node-sqlite'),
    );
  });

  it('no longer offers a driver that reaches a database off this machine', () => {
    assert.throws(
      () => validateConfig(withCache({ driver: 'libsql-remote' })),
      (error: unknown) => error instanceof VfsError && error.code === 'ECONFIG',
    );
  });

  describe('the snapshot is local, and says so', () => {
    // These keys are rejected rather than ignored. `validateCache` builds its result from
    // the keys it knows about, so an unrecognised one would be dropped in silence — and
    // "I configured replication and nothing happened" leaves somebody believing their
    // mail is somewhere it is not.
    for (const key of ['syncUrl', 'authToken', 'syncInterval', 'syncIntervalMs']) {
      it(`rejects cache.${key} instead of quietly dropping it`, () => {
        assert.throws(
          () => validateConfig(withCache({ [key]: 'libsql://mail-org.turso.io' })),
          (error: unknown) =>
            error instanceof VfsError && error.code === 'ECONFIG' && error.message.includes(`cache.${key}`),
        );
      });
    }

    it('says why, not just no', () => {
      assert.throws(
        () => validateConfig(withCache({ syncUrl: 'libsql://mail-org.turso.io' })),
        (error: unknown) => error instanceof VfsError && /local to this machine/i.test(error.message),
      );
    });
  });

  it('rejects negative numbers', () => {
    for (const key of ['recent', 'ttlMs', 'intervalMs', 'depth', 'bodies', 'prefetchConcurrency']) {
      assert.throws(
        () => validateConfig(withCache({ [key]: -1 })),
        (error: unknown) => error instanceof VfsError && error.message.includes(`cache.${key}`),
        `expected cache.${key} to reject -1`,
      );
    }
  });

  it('rejects numbers that are not numbers', () => {
    for (const bad of ['100', null, {}, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => validateConfig(withCache({ recent: bad })),
        (error: unknown) => error instanceof VfsError && error.code === 'ECONFIG',
        `expected cache.recent to reject ${JSON.stringify(bad) ?? String(bad)}`,
      );
    }
  });

  it('accepts zero, because "cache nothing" is a real answer', () => {
    // bodies: 0 means "index headers but never pre-download a message" — the setting
    // someone on a metered connection actually wants.
    assert.equal(validateConfig(withCache({ bodies: 0 })).cache.bodies, 0);
  });

  it('rejects a flag that is not a boolean', () => {
    for (const key of ['enabled', 'vectors', 'prefetch']) {
      assert.throws(
        () => validateConfig(withCache({ [key]: 'yes' })),
        (error: unknown) => error instanceof VfsError && error.message.includes(`cache.${key}`),
        `expected cache.${key} to reject "yes"`,
      );
    }
  });

  it('rejects a blank path rather than quietly writing somewhere unexpected', () => {
    assert.throws(
      () => validateConfig(withCache({ path: '  ' })),
      (error: unknown) => error instanceof VfsError && error.message.includes('cache.path'),
    );
  });

  it('rejects a cache block that is not an object', () => {
    assert.throws(
      () => validateConfig(withCache('on')),
      (error: unknown) => error instanceof VfsError && error.code === 'ECONFIG',
    );
  });

  it('says which file the bad cache setting is in', () => {
    assert.throws(
      () => validateConfig(withCache({ driver: 'nope' }), '/etc/mscomms.jsonc'),
      (error: unknown) => error instanceof VfsError && error.message.includes('/etc/mscomms.jsonc'),
    );
  });
});

describe('resolveAppPaths', () => {
  it('follows XDG on Linux', () => {
    const paths = resolveAppPaths(
      { XDG_CONFIG_HOME: '/home/me/.config', XDG_DATA_HOME: '/home/me/.local/share', HOME: '/home/me' },
      'linux',
    );
    assert.ok(paths.configFile.startsWith('/home/me/.config'), paths.configFile);
    assert.ok(paths.cacheDir.startsWith('/home/me/.local/share'), paths.cacheDir);
  });

  it('falls back to ~/.config when XDG is unset', () => {
    const paths = resolveAppPaths({ HOME: '/home/me' }, 'linux');
    assert.ok(paths.configFile.includes('.config'));
  });

  it('uses APPDATA on Windows', () => {
    const paths = resolveAppPaths(
      { APPDATA: 'C:\\Users\\me\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', USERPROFILE: 'C:\\Users\\me' },
      'win32',
    );
    assert.ok(paths.configFile.includes('AppData'));
  });

  it('honours an explicit override above everything else', () => {
    const paths = resolveAppPaths({ MSCOMMS_CONFIG: '/tmp/custom.jsonc', HOME: '/home/me' }, 'linux');
    assert.equal(paths.configFile, '/tmp/custom.jsonc');
  });

  it('keeps state out of the cache directory', () => {
    // Sync cursors live in state. If a cache-clearing script wipes them, the next poll
    // reports every message as new and the user gets a notification storm.
    const paths = resolveAppPaths({ HOME: '/home/me' }, 'linux');
    assert.notEqual(paths.cacheDir, paths.stateDir);
  });

  it('never returns an empty path on any platform', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const paths = resolveAppPaths({}, platform);
      assert.ok(paths.configFile.length > 0, `${platform} config path was empty`);
      assert.ok(paths.cacheDir.length > 0, `${platform} cache path was empty`);
      assert.ok(paths.stateDir.length > 0, `${platform} state path was empty`);
    }
  });
});

describe('isSecretRef', () => {
  it('recognises an environment reference', () => {
    assert.equal(isSecretRef('${env:GITHUB_TOKEN}'), true);
  });

  it('recognises a file reference', () => {
    assert.equal(isSecretRef('${file:~/.secrets/token}'), true);
  });

  it('does not treat a literal token as a reference', () => {
    // The point of the check: a literal in the config is a secret sitting in a file that
    // gets synced, backed up, and pasted into support tickets.
    assert.equal(isSecretRef('ghp_abcdef0123456789'), false);
  });

  it('is not confused by a colon inside a value', () => {
    assert.equal(isSecretRef('https://example.com'), false);
  });

  it('rejects a half-written reference rather than guessing', () => {
    assert.equal(isSecretRef('${env:GITHUB_TOKEN'), false);
    assert.equal(isSecretRef('env:GITHUB_TOKEN'), false);
  });

  it('tolerates surrounding whitespace', () => {
    assert.equal(isSecretRef('  ${env:TOKEN}  '), true);
  });
});
