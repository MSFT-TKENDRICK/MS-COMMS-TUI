/**
 * Tests for the parts of voice that are not the grammar: audio framing, settings
 * resolution, and the two small parsers that decide whether we act on what we heard.
 *
 * These are the places where a bug is silent rather than loud. A WAV with a lying length
 * header uploads fine and comes back as an empty transcript; a confirmation parser that is
 * a shade too generous turns a cough into "yes" on a command that archives mail.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { finalizeWav, peakAmplitude } from '../capture.js';
import { parseYesNo, stripWakeWord } from '../controller.js';
import { buildMaiDefinition, buildTranscriptionUrl, createStubTranscriber, resolveVoiceSettings, type VoiceSettings } from '../stt.js';

/**
 * Build a WAV whose header claims `declared` data bytes regardless of how many there are,
 * which is exactly what a streaming recorder writes before it knows the answer.
 */
function wav(samples: readonly number[], declared: number, riffSize = 0xffffffff): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((value, index) => data.writeInt16LE(value, index * 2));

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(riffSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(declared, 40);
  return Buffer.concat([header, data]);
}

describe('repairing a piped WAV', () => {
  it('rewrites a placeholder data length to what actually arrived', () => {
    // 0xFFFFFFFF is what a streaming encoder writes when it cannot know the length yet.
    const fixed = Buffer.from(finalizeWav(wav([1, 2, 3, 4], 0xffffffff)));
    assert.equal(fixed.readUInt32LE(40), 8);
  });

  it('rewrites a zero data length too', () => {
    const fixed = Buffer.from(finalizeWav(wav([1, 2, 3, 4], 0)));
    assert.equal(fixed.readUInt32LE(40), 8);
  });

  it('fixes the RIFF size to match, so the file is not self-contradictory', () => {
    const fixed = Buffer.from(finalizeWav(wav([1, 2, 3, 4], 0)));
    assert.equal(fixed.readUInt32LE(4), fixed.byteLength - 8);
  });

  it('leaves an already-correct header alone', () => {
    const original = wav([1, 2, 3, 4], 8, 44 + 8 - 8);
    const fixed = Buffer.from(finalizeWav(original));
    assert.equal(fixed.readUInt32LE(40), 8);
    assert.deepEqual(fixed, original);
  });

  it('truncates to the declared length when the header is honest and shorter', () => {
    const fixed = Buffer.from(finalizeWav(wav([1, 2, 3, 4], 4)));
    assert.equal(fixed.byteLength, 48);
  });

  it('passes a non-RIFF stream through untouched', () => {
    // A user-supplied recorder may legitimately emit something else, and mangling it
    // would be worse than forwarding it and letting the service complain.
    const raw = Buffer.from('OggS not a wav at all, but long enough to reach the header check');
    assert.deepEqual(Buffer.from(finalizeWav(raw)), raw);
  });

  it('passes a stream too short to contain a header through untouched', () => {
    const raw = Buffer.from('RIFF');
    assert.deepEqual(Buffer.from(finalizeWav(raw)), raw);
  });
});

describe('telling silence from a misunderstanding', () => {
  // These are different problems with different fixes — a microphone that is muted versus a
  // phrase the grammar does not know — so they must not produce the same message.
  it('reports near-zero for silence', () => {
    const silent = finalizeWav(wav(new Array(400).fill(0), 0));
    assert.ok(peakAmplitude(silent) < 0.001, 'silence should not register as speech');
  });

  it('reports a real level for loud audio', () => {
    const loud = finalizeWav(wav(new Array(400).fill(0).map((_, i) => (i % 2 === 0 ? 12000 : -12000)), 0));
    assert.ok(peakAmplitude(loud) > 0.1, 'speech-level audio should register');
  });

  it('does not mistake the header for audio', () => {
    const silent = finalizeWav(wav(new Array(400).fill(0), 0));
    assert.equal(peakAmplitude(silent), 0);
  });
});

describe('the wake word', () => {
  it('removes the wake word and returns what followed', () => {
    assert.equal(stripWakeWord('computer go to inbox', 'computer'), 'go to inbox');
  });

  it('tolerates the comma a recognizer inserts after it', () => {
    assert.equal(stripWakeWord('Computer, go to inbox', 'computer'), 'go to inbox');
  });

  it('ignores case, because a transcript capitalizes the first word', () => {
    assert.equal(stripWakeWord('Computer go to inbox', 'computer'), 'go to inbox');
  });

  it('stays quiet when the wake word is absent', () => {
    // This is how continuous mode avoids acting on half of a meeting.
    assert.equal(stripWakeWord('go to inbox', 'computer'), undefined);
  });

  it('passes everything through when no wake word is configured', () => {
    assert.equal(stripWakeWord('go to inbox', ''), 'go to inbox');
  });

  it('returns an empty remainder when the wake word was said alone', () => {
    assert.equal(stripWakeWord('computer', 'computer'), '');
  });
});

describe('reading a spoken yes or no', () => {
  for (const yes of ['yes', 'Yes.', 'yeah', 'yep', 'sure', 'go ahead', 'do it', 'confirm']) {
    it(`treats "${yes}" as yes`, () => {
      assert.equal(parseYesNo(yes), true);
    });
  }

  for (const no of ['no', 'No!', 'nope', 'nah', 'cancel', 'stop', 'never mind']) {
    it(`treats "${no}" as no`, () => {
      assert.equal(parseYesNo(no), false);
    });
  }

  for (const unclear of ['hmm', 'i think so', 'maybe', 'yes but not that one', '', 'what', 'yes no']) {
    it(`refuses to decide on "${unclear}"`, () => {
      // Anything ambiguous must reach the keyboard. Treating a cough as "yes" archives mail.
      assert.equal(parseYesNo(unclear), undefined);
    });
  }
});

describe('resolving voice settings', () => {
  it('defaults to the Microsoft transcription model', () => {
    const settings = resolveVoiceSettings({ endpoint: 'https://x.cognitiveservices.azure.com' }, 'key');
    assert.equal(settings.engine, 'mai');
    assert.equal(settings.model, 'mai-transcribe-1.5');
  });

  it('requires a deployment name for the OpenAI-compatible Foundry surface', () => {
    // That surface serves whatever the tenant deployed, under whatever they named it. A
    // guessed default would 404 in a way that reads like a broken endpoint.
    assert.throws(
      () => resolveVoiceSettings({ engine: 'foundry', endpoint: 'https://x.services.ai.azure.com' }, 'key'),
      /voice\.model is not set/,
    );
  });

  it('biases toward on-screen names unless asked not to', () => {
    assert.equal(resolveVoiceSettings({ endpoint: 'https://x.cognitiveservices.azure.com' }, 'k').phraseBias, true);
    assert.equal(
      resolveVoiceSettings({ endpoint: 'https://x.cognitiveservices.azure.com', phraseBias: false }, 'k').phraseBias,
      false,
    );
  });

  it('says what is missing before anything is recorded, not after', () => {
    // Discovering the key is absent once the user has already spoken is a small cruelty.
    assert.throws(
      () => resolveVoiceSettings({ endpoint: 'https://x.services.ai.azure.com' }, undefined),
      /no key resolved/i,
    );
  });

  it('names the setting that is missing, not just that something is', () => {
    assert.throws(() => resolveVoiceSettings({}, 'key'), /voice\.endpoint/);
  });

  it('requires a binary when the engine is a local command', () => {
    assert.throws(() => resolveVoiceSettings({ engine: 'command' }, undefined), /voice\.command/);
  });

  it('accepts a local command engine with no key at all, since nothing leaves the machine', () => {
    const settings = resolveVoiceSettings({ engine: 'command', command: 'whisper-cli' }, undefined);
    assert.equal(settings.command, 'whisper-cli');
    assert.equal(settings.apiKey, undefined);
  });

  it('accepts an Azure Speech region in place of an endpoint', () => {
    const settings = resolveVoiceSettings({ engine: 'azure-speech', region: 'eastus' }, 'key');
    assert.equal(settings.region, 'eastus');
  });

  it('rejects Azure Speech with neither a region nor an endpoint', () => {
    assert.throws(() => resolveVoiceSettings({ engine: 'azure-speech' }, 'key'), /region/i);
  });

  it('trims a trailing slash so the URL is not built with a double one', () => {
    const settings = resolveVoiceSettings({ endpoint: 'https://x.services.ai.azure.com/' }, 'key');
    assert.equal(settings.endpoint, 'https://x.services.ai.azure.com');
  });
});

describe('building the transcription URL', () => {
  function settings(endpoint: string): VoiceSettings {
    // The OpenAI-compatible surface, which is the only one this URL builder serves — `mai`
    // has a single documented path and does not go through here.
    return resolveVoiceSettings({ engine: 'foundry', model: 'whisper', endpoint }, 'key');
  }

  it('appends the OpenAI-compatible path to a bare resource host', () => {
    assert.equal(
      buildTranscriptionUrl(settings('https://x.services.ai.azure.com')),
      'https://x.services.ai.azure.com/openai/v1/audio/transcriptions',
    );
  });

  it('appends only the audio path when the endpoint already names a version', () => {
    assert.equal(buildTranscriptionUrl(settings('https://x.example/v1')), 'https://x.example/v1/audio/transcriptions');
  });

  it('uses a full path verbatim when the user supplied one', () => {
    // Hosted API surfaces move. Someone holding the current path should not have to wait
    // for a release of this program before they can use it.
    const url = 'https://x.example/some/future/path/transcriptions';
    assert.equal(buildTranscriptionUrl(settings(url)), url);
  });
});

/**
 * The LLM Speech request body.
 *
 * Pinned in a test because it cannot be checked any other way from here: there is no Foundry
 * resource on this machine, and the failure mode of getting it wrong is a 400 at the moment
 * somebody speaks for the first time. The shape is taken from Microsoft's own documented
 * example for `speechtotext/transcriptions:transcribe`.
 */
describe('the MAI transcription request', () => {
  function settings(overrides: Parameters<typeof resolveVoiceSettings>[0] = {}): VoiceSettings {
    return resolveVoiceSettings({ endpoint: 'https://x.cognitiveservices.azure.com', ...overrides }, 'key');
  }

  it('asks for the model through enhancedMode, which is where this API takes it', () => {
    // Not a top-level `model` field: that is the OpenAI shape, and sending it here silently
    // transcribes with the default model instead of the one that was configured.
    assert.deepEqual(buildMaiDefinition(settings()).enhancedMode, {
      enabled: true,
      model: 'mai-transcribe-1.5',
    });
  });

  it('names the configured locale', () => {
    assert.deepEqual(buildMaiDefinition(settings({ language: 'de-DE' })).locales, ['de-DE']);
  });

  it('omits locales entirely when no language is set, rather than sending an empty list', () => {
    // Absent means "identify the language"; an empty list is not the same request.
    assert.equal('locales' in buildMaiDefinition(settings({ language: '' })), false);
  });

  it('passes the names on screen as a phrase list', () => {
    const definition = buildMaiDefinition(settings(), { phrases: ['Contoso Deal Review', 'Rehaan'] });
    assert.deepEqual(definition['phraseList'], { phrases: ['Contoso Deal Review', 'Rehaan'] });
  });

  it('sends no phrase list at all when biasing is off', () => {
    const definition = buildMaiDefinition(settings({ phraseBias: false }), { phrases: ['Contoso'] });
    assert.equal('phraseList' in definition, false);
  });

  it('omits the phrase list when there is nothing on screen', () => {
    assert.equal('phraseList' in buildMaiDefinition(settings(), { phrases: [] }), false);
  });

  it('drops duplicates case-insensitively so the budget is spent on distinct names', () => {
    const definition = buildMaiDefinition(settings(), { phrases: ['Inbox', 'inbox', 'INBOX'] });
    assert.deepEqual(definition['phraseList'], { phrases: ['Inbox'] });
  });

  it('drops single characters and pure punctuation, which bias nothing', () => {
    const definition = buildMaiDefinition(settings(), { phrases: ['a', '—', '..', 'Budget'] });
    assert.deepEqual(definition['phraseList'], { phrases: ['Budget'] });
  });

  it('keeps the longest names when there are more than the service will take', () => {
    // A truncated list should hold the names a recognizer is least likely to get unaided,
    // not whichever ones happened to be listed first.
    const many = Array.from({ length: 200 }, (_, index) => `name${index}`);
    const definition = buildMaiDefinition(settings(), { phrases: [...many, 'An Unusually Long Folder Name'] });
    const list = (definition['phraseList'] as { phrases: string[] }).phrases;
    assert.equal(list.length, 100);
    assert.equal(list[0], 'An Unusually Long Folder Name');
  });
});

describe('the stub transcriber', () => {
  it('returns the text it was given, so the pipeline is testable without a microphone', async () => {
    const stub = createStubTranscriber('go to inbox');
    const result = await stub.transcribe({ audio: new Uint8Array(0) });
    assert.equal(result.text, 'go to inbox');
  });

  it('can vary its answer across calls', async () => {
    const lines = ['go to inbox', 'open three'];
    let index = 0;
    const stub = createStubTranscriber(() => lines[index++] ?? '');
    assert.equal((await stub.transcribe({ audio: new Uint8Array(0) })).text, 'go to inbox');
    assert.equal((await stub.transcribe({ audio: new Uint8Array(0) })).text, 'open three');
  });
});
