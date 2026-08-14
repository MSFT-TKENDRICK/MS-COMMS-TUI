/**
 * Tests for `set voice.*`.
 *
 * This exists because of a specific defect, and the tests are shaped to stop it coming
 * back. Two error messages — the non-interactive confirmation refusal and the missing
 * recorder report — tell the user to run `set voice.autoRun` and `set voice.recorder`.
 * For a while neither worked: `set` knew only display settings and answered "there is no
 * setting called that". A suggested fix that fails is worse than no suggestion, because it
 * costs a round trip and teaches something false, so the last test here checks the
 * messages and the setting names against each other rather than trusting either alone.
 *
 * The other thing pinned here is that these settings are readable *before* voice is
 * turned on. The advice appears in an error you hit while trying to use voice, so a
 * version that only worked after `voice on` would be useless exactly when it is needed.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NULL_LOGGER, PluginRegistry, DEFAULT_CONFIG, type AppConfig, type AppPaths } from '@mscomms/core';
import { resolveVoiceSettings } from '@mscomms/voice';

import { Session } from '../session.js';
import { VoiceService } from '../voice-service.js';
import { CommandTable } from '../commands/types.js';
import { voiceCommands } from '../commands/voice.js';

function tmp(name: string): string {
  return `${process.cwd()}/.test-tmp/voice-settings/${name}`;
}

const PATHS: AppPaths = {
  configFile: tmp('cfg/config.jsonc'),
  configDir: tmp('cfg'),
  dataDir: tmp('data'),
  cacheDir: tmp('cache'),
  stateDir: tmp('state'),
  notificationsFile: tmp('state/notifications.json'),
  logFile: tmp('state/log.jsonl'),
};

function sessionWith(voice: AppConfig['voice'] = {}): Session {
  return new Session({
    config: { ...DEFAULT_CONFIG, voice },
    registry: new PluginRegistry(NULL_LOGGER),
    logger: NULL_LOGGER,
    paths: PATHS,
    mode: 'plain',
    color: false,
    width: 100,
    write: () => undefined,
    writeError: () => undefined,
  });
}

describe('voice settings on the session', () => {
  it('starts from the config file', () => {
    const session = sessionWith({ autoRun: true, language: 'en-GB' });
    assert.equal(session.voiceSettings.autoRun, true);
    assert.equal(session.voiceSettings.language, 'en-GB');
  });

  it('is a copy, so changing it does not rewrite the loaded config', () => {
    // The config is what `doctor` reports and what the file says. A session-scoped change
    // that silently edited it would make those two disagree with no way to tell.
    const session = sessionWith({ autoRun: false });
    session.setVoiceOption('autoRun', 'on');
    assert.equal(session.voiceSettings.autoRun, true);
    assert.equal(session.config.voice.autoRun, false);
  });

  it('can be changed before voice has ever been turned on', () => {
    // The whole point: the advice arrives in an error you hit while trying to use voice.
    const session = sessionWith();
    assert.equal(session.voice, undefined);
    assert.match(session.setVoiceOption('autoRun', 'on'), /on for this session/);
    assert.equal(session.voiceSettings.autoRun, true);
  });
});

describe('reading on/off values', () => {
  for (const word of ['on', 'true', 'yes', '1']) {
    it(`treats "${word}" as on`, () => {
      const session = sessionWith();
      session.setVoiceOption('autoRun', word);
      assert.equal(session.voiceSettings.autoRun, true);
    });
  }

  for (const word of ['off', 'false', 'no', '0']) {
    it(`treats "${word}" as off`, () => {
      const session = sessionWith({ autoRun: true });
      session.setVoiceOption('autoRun', word);
      assert.equal(session.voiceSettings.autoRun, false);
    });
  }

  // The setting decides whether spoken changes are confirmed. Reading an unrecognized
  // word as "off" would be the safe direction; reading it as "on" would not, and the only
  // way to never do the second is to refuse everything that is not unambiguous.
  for (const word of ['maybe', 'sure', 'ok', '', 'onn', 'y']) {
    it(`refuses "${word}" rather than guessing`, () => {
      const session = sessionWith();
      assert.throws(() => session.setVoiceOption('autoRun', word), /on or off/);
      assert.equal(session.voiceSettings.autoRun, undefined);
    });
  }

  it('is not case sensitive', () => {
    const session = sessionWith();
    session.setVoiceOption('autoRun', 'ON');
    assert.equal(session.voiceSettings.autoRun, true);
  });
});

describe('refusing settings that should not be set here', () => {
  it('will not take an API key, and says why', () => {
    // A key typed at a prompt is in scrollback and shell history immediately. Accepting it
    // would quietly undo the reason config holds a ${env:NAME} reference instead.
    const session = sessionWith();
    assert.throws(() => session.setVoiceOption('apiKey', 'sk-live-abcdef'), /scrollback and shell history/);
    assert.equal(session.voiceSettings.apiKey, undefined);
  });

  it('does not echo the key it just refused', () => {
    const session = sessionWith();
    try {
      session.setVoiceOption('apiKey', 'sk-live-abcdef');
      assert.fail('should have refused');
    } catch (error) {
      assert.doesNotMatch((error as Error).message, /sk-live-abcdef/, 'the refusal must not repeat the secret');
    }
  });

  it('names the settings that do exist when given one that does not', () => {
    const session = sessionWith();
    assert.throws(() => session.setVoiceOption('nonsense', '1'), /autoRun/);
  });

  it('refuses an engine it has no transcriber for', () => {
    const session = sessionWith();
    assert.throws(() => session.setVoiceOption('engine', 'dictaphone'), /foundry/);
    assert.equal(session.voiceSettings.engine, undefined);
  });

  it('refuses a number that is not one', () => {
    const session = sessionWith();
    assert.throws(() => session.setVoiceOption('maxSeconds', 'ten'), /number of seconds/);
    assert.throws(() => session.setVoiceOption('maxSeconds', '0'), /number of seconds/);
    assert.throws(() => session.setVoiceOption('maxSeconds', '-5'), /number of seconds/);
  });
});

describe('continuous mode', () => {
  it('refuses without a wake word, and names the command that sets one', () => {
    // Continuous listening with no wake word means every word said near the machine is a
    // candidate command. Refusing is the only safe default, but a refusal that does not
    // say how to proceed just moves the dead end.
    const session = sessionWith();
    assert.throws(() => session.setVoiceOption('mode', 'continuous'), /set voice\.wakeWord/);
    assert.equal(session.voiceSettings.mode, undefined);
  });

  it('allows it once a wake word exists', () => {
    const session = sessionWith();
    session.setVoiceOption('wakeWord', 'computer');
    session.setVoiceOption('mode', 'continuous');
    assert.equal(session.voiceSettings.mode, 'continuous');
  });

  it('allows push mode with no wake word', () => {
    const session = sessionWith();
    session.setVoiceOption('mode', 'push');
    assert.equal(session.voiceSettings.mode, 'push');
  });
});

describe('clearing a setting', () => {
  it('an empty value restores the default', () => {
    // How somebody undoes a device or recorder guess that stopped the microphone working,
    // without having to restart the program and lose where they were.
    const session = sessionWith({ device: 'Microphone (Bad Guess)' });
    assert.match(session.setVoiceOption('device', ''), /back to its default/);
    assert.equal(session.voiceSettings.device, undefined);
    assert.ok(!('device' in session.voiceSettings), 'the key should be gone, not set to empty');
  });

  it('leaves the config file value behind for the next run', () => {
    const session = sessionWith({ recorder: 'sox' });
    session.setVoiceOption('recorder', '');
    assert.equal(session.voiceSettings.recorder, undefined);
    assert.equal(session.config.voice.recorder, 'sox');
  });
});

describe('push-to-talk settings', () => {
  it('takes the three modes and refuses anything else', () => {
    const session = sessionWith();
    for (const mode of ['auto', 'hold', 'toggle'] as const) {
      session.setVoiceOption('pushToTalk', mode);
      assert.equal(session.voiceSettings.pushToTalk, mode);
    }
    assert.throws(() => session.setVoiceOption('pushToTalk', 'hodl'), /"auto", "hold" or "toggle"/);
  });

  it('validates the talk key when it is set, not when it is first pressed', () => {
    // A key that cannot be parsed fails by doing nothing at all. Accepting it here would
    // mean the mistake surfaces later, as a hold that silently does not work, with nothing
    // on screen connecting the two.
    const session = sessionWith();
    assert.throws(() => session.setVoiceOption('talkKey', 'ctrl+spcae'), /cannot read/);
    assert.equal(session.voiceSettings.talkKey, undefined);
  });

  it('echoes the key back in the spelling the help screen uses', () => {
    // "ctrl+t" in, "Ctrl+T" out. The confirmation should match what the user will go looking
    // for on the help screen, or the two read as different keys.
    const session = sessionWith();
    assert.match(session.setVoiceOption('talkKey', 'ctrl+t'), /Ctrl\+T/);
    assert.equal(session.voiceSettings.talkKey, 'ctrl+t');
  });

  it('clears back to the default key by name, not silently', () => {
    const session = sessionWith({ talkKey: 'alt+v' });
    assert.match(session.setVoiceOption('talkKey', ''), /Ctrl\+Space/);
    assert.equal(session.voiceSettings.talkKey, undefined);
  });

  it('refuses a key the terminal cannot tell apart from Enter, and says which key is in the way', () => {
    // Ctrl+M is the byte Enter sends. Taken as the talk key, the pane would open the
    // microphone on every Enter and never submit a line — a config that looks accepted and
    // breaks the one key nobody can work without.
    const session = sessionWith();
    assert.throws(() => session.setVoiceOption('talkKey', 'ctrl+m'), /sends it as Enter/);
    assert.equal(session.voiceSettings.talkKey, undefined);

    for (const [key, blocked] of [
      ['ctrl+i', /Tab/],
      ['ctrl+h', /Backspace/],
      ['ctrl+j', /line feed/],
      ['ctrl+c', /always cancels/],
      ['ctrl+[', /Escape/],
    ] as const) {
      assert.throws(() => session.setVoiceOption('talkKey', key), blocked, key);
    }

    // The refusal is specific to the collision, not to the Ctrl+letter shape.
    session.setVoiceOption('talkKey', 'ctrl+k');
    assert.equal(session.voiceSettings.talkKey, 'ctrl+k');
  });

  it('allows a zero release delay but not a negative one', () => {
    const session = sessionWith();
    session.setVoiceOption('releaseDelayMs', '0');
    assert.equal(session.voiceSettings.releaseDelayMs, 0);
    assert.throws(() => session.setVoiceOption('releaseDelayMs', '-1'), /zero or more/);
    assert.throws(() => session.setVoiceOption('releaseDelayMs', 'soon'), /milliseconds/);
  });
});

describe('`voice status` on the push-to-talk settings', () => {
  /**
   * Driven through the real command rather than a helper, because the lines being checked are
   * printed by the command and not by `describe()`.
   */
  async function statusLines(voice: AppConfig['voice']): Promise<string> {
    const lines: string[] = [];
    const session = new Session({
      config: { ...DEFAULT_CONFIG, voice },
      registry: new PluginRegistry(NULL_LOGGER),
      logger: NULL_LOGGER,
      paths: PATHS,
      mode: 'plain',
      color: false,
      width: 100,
      write: (text) => lines.push(text),
      writeError: (text) => lines.push(text),
    });
    const table = new CommandTable();
    table.registerAll(voiceCommands(table));
    const command = table.get('voice');
    assert.ok(command);
    await command.run(session, { positional: ['status'], flags: {}, raw: 'voice status' });
    return lines.join('');
  }

  it('says which talk key is actually in force', async () => {
    assert.match(await statusLines({ talkKey: 'ctrl+t' }), /Talk key:\s+Ctrl\+T/);
  });

  it('says so when the config names a key it cannot use, instead of silently substituting one', async () => {
    // `set voice.talkKey ctrl+m` is refused to the user's face. A config file is edited by
    // hand and gets no such refusal, so without this the user has a file that plainly says
    // Ctrl+M and a Ctrl+M that does nothing, with nothing connecting the two.
    const status = await statusLines({ talkKey: 'ctrl+m' });
    assert.match(status, /Talk key:\s+Ctrl\+Space/);
    assert.match(status, /voice\.talkKey in your config is "ctrl\+m"/);
    assert.match(status, /sends as Enter/);

    const typo = await statusLines({ talkKey: 'ctrl+spcae' });
    assert.match(typo, /cannot read as a key/);
    assert.match(typo, /Using Ctrl\+Space instead/);
  });

  it('says nothing extra when the configured key is fine', async () => {
    assert.ok(!(await statusLines({ talkKey: 'ctrl+t' })).includes('Note:'));
    assert.ok(!(await statusLines({})).includes('Note:'));
  });
});

describe('the advice in error messages', () => {
  /**
   * Every `set voice.X` named in a message the user can actually hit must work.
   *
   * Kept as a list rather than scraped from the sources because the point is to fail when
   * somebody adds new advice without checking it, and a scraper would happily agree with a
   * message that names a setting nobody implemented.
   */
  const advertised = ['autoRun', 'recorder', 'wakeWord', 'command'];

  for (const name of advertised) {
    it(`\`set voice.${name}\` works, because an error message tells someone to run it`, () => {
      const session = sessionWith();
      const value = name === 'autoRun' ? 'on' : 'something';
      assert.doesNotThrow(() => session.setVoiceOption(name, value));
    });
  }
});

describe('`voice status` before voice is on', () => {
  /**
   * A service with no dispatcher: `describe()` reads configuration and touches nothing else,
   * which is the property being checked as much as the text it returns.
   */
  function statusFor(voice: AppConfig['voice']): string {
    const session = sessionWith(voice);
    return new VoiceService(session, { dispatch: () => Promise.resolve() }).describe();
  }

  it('reports the configuration rather than only saying "off"', () => {
    // "Off" is exactly when somebody is trying to find out why it will not turn on, so a
    // status that stops there sends them to `voice on` — which needs a microphone they may
    // not have — to learn anything at all.
    const status = statusFor({ engine: 'foundry', endpoint: 'https://x.services.ai.azure.com' });
    assert.match(status, /Voice is off/);
    assert.match(status, /Engine:\s+foundry/);
    assert.match(status, /Endpoint:\s+https:\/\/x\.services\.ai\.azure\.com/);
  });

  it('names the engine that would actually be used when the config names none', () => {
    // This reported "foundry" while the resolver had moved to "mai", so the screen and the
    // program disagreed about what a user was configuring. Both now read one constant.
    const settings = resolveVoiceSettings({ endpoint: 'https://x.cognitiveservices.azure.com' }, 'key');
    assert.match(statusFor({}), new RegExp(`Engine:\\s+${settings.engine}`));
  });

  it('says whether on-screen names are being sent as recognition hints', () => {
    assert.match(statusFor({}), /Bias:\s+on/);
    assert.match(statusFor({ phraseBias: false }), /Bias:\s+off/);
  });

  it('says a key reference resolved without printing what it resolved to', () => {
    process.env['MSCOMMS_TEST_VOICE_KEY'] = 'sk-live-do-not-print';
    try {
      const status = statusFor({ apiKey: '${env:MSCOMMS_TEST_VOICE_KEY}' });
      assert.match(status, /resolved/);
      assert.doesNotMatch(status, /sk-live-do-not-print/, 'the key must never reach the screen');
    } finally {
      delete process.env['MSCOMMS_TEST_VOICE_KEY'];
    }
  });

  it('says when the variable a key names was never exported', () => {
    delete process.env['MSCOMMS_TEST_VOICE_ABSENT'];
    const status = statusFor({ apiKey: '${env:MSCOMMS_TEST_VOICE_ABSENT}' });
    assert.match(status, /not set in this environment/);
  });

  it('treats an exported but empty variable as missing', () => {
    // An empty string authenticates nothing, and "resolved" here would send someone looking
    // for the problem at the endpoint instead of at their shell profile.
    process.env['MSCOMMS_TEST_VOICE_EMPTY'] = '';
    try {
      assert.match(statusFor({ apiKey: '${env:MSCOMMS_TEST_VOICE_EMPTY}' }), /not set in this environment/);
    } finally {
      delete process.env['MSCOMMS_TEST_VOICE_EMPTY'];
    }
  });

  it('asks for a binary, not an endpoint, when the engine is a local command', () => {
    const status = statusFor({ engine: 'command' });
    assert.match(status, /Command:\s+not set/);
    assert.doesNotMatch(status, /Endpoint/, 'a local engine has no endpoint to report');
    assert.doesNotMatch(status, /Key:/, 'a local engine needs no key');
  });

  it('says so when a local engine keeps audio on the machine', () => {
    assert.match(statusFor({ engine: 'command', command: 'whisper-cli' }), /stays on this machine/);
  });

  it('reflects a setting changed during the session, not the file it started from', () => {
    const session = sessionWith({ autoRun: false });
    const service = new VoiceService(session, { dispatch: () => Promise.resolve() });
    assert.match(service.describe(), /on for anything that changes something/);
    session.setVoiceOption('autoRun', 'on');
    assert.match(service.describe(), /run immediately/);
  });
});
