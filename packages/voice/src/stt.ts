/**
 * Speech to text over plain HTTP.
 *
 * Every engine here is reached with the runtime's own `fetch`, `FormData` and `Blob` rather
 * than a vendor SDK. Each one is a single multipart POST of about fifteen lines, so an SDK
 * per engine would be four packages to keep current for four functions we would still have
 * to read to debug.
 *
 * The default engine is Microsoft Foundry's LLM Speech API running MAI-Transcribe-1.5,
 * which is currently the strongest option available to us: 43 languages, fast enough that a
 * spoken command feels like a command rather than a request, and — the part that matters
 * most here — it accepts a phrase list. Almost everything said to this program is a proper
 * noun that no general recognizer has a prior for, so being able to say "these are the names
 * currently on screen" is worth more than a decimal point of benchmark word error rate.
 *
 * That API is *not* the OpenAI shape, which cost us a bug: `speechtotext/transcriptions:transcribe`
 * takes the audio and a JSON `definition` part, and answers with `combinedPhrases`. The
 * OpenAI-compatible path still exists as `foundry`, for a Whisper or gpt-4o-transcribe
 * deployment in the same tenant, and it is the same code that serves `openai` and `xai` —
 * one multipart request, three vendors.
 *
 * `azure-speech` exists for tenants that already have an Azure AI Speech resource and would
 * rather not provision anything new. `command` exists for a different reason entirely: it
 * shells out to a local model, so the audio never leaves the machine. Anyone dictating in an
 * open-plan office about an acquisition should have that option, and it should not be the
 * hard one to configure.
 *
 * Two rules hold across all of them:
 *
 * - Endpoints, models and paths are configuration, never constants. Hosted model names churn;
 *   a program that hard-codes one is broken by somebody else's release notes. The defaults are
 *   the best current answer, not an assumption.
 * - Keys arrive as `${env:NAME}` references resolved by the caller. Nothing in this file reads
 *   the environment or a config file, so a transcript request cannot pick up a credential the
 *   user did not deliberately hand it.
 */

import { spawn } from 'node:child_process';
import type { VoiceConfig } from '@mscomms/core';

export interface TranscriptionRequest {
  /** WAV bytes. 16 kHz mono is what every engine here is happiest with. */
  readonly audio: Uint8Array;
  /** BCP-47 hint. Engines that cannot use it ignore it. */
  readonly language?: string;
  /** Abort signal, so a held push-to-talk key that is released mid-flight stops the request. */
  readonly signal?: AbortSignal;
  /**
   * Names currently on screen, offered to the recognizer as a bias.
   *
   * A hint and never a filter: anything may still come back. Engines that cannot use it
   * ignore it, so callers do not have to know which engine is configured.
   */
  readonly phrases?: readonly string[];
}

export interface TranscriptionResult {
  readonly text: string;
  /** Present only when the engine reports one; absent is not zero. */
  readonly confidence?: number;
  readonly engine: string;
  readonly model?: string;
  readonly durationMs: number;
}

export interface Transcriber {
  /** Human-readable name for `voice status` and error messages. */
  readonly name: string;
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
}

/** Resolved, validated settings. Built by `resolveVoiceSettings` so failures are early. */
export interface VoiceSettings {
  readonly engine: NonNullable<VoiceConfig['engine']>;
  readonly endpoint: string;
  readonly model: string;
  readonly apiKey: string | undefined;
  readonly language: string;
  readonly region: string | undefined;
  readonly command: string | undefined;
  readonly commandArgs: readonly string[];
  readonly timeoutMs: number;
  readonly phraseBias: boolean;
}

const DEFAULTS: Record<NonNullable<VoiceConfig['engine']>, { endpoint: string; model: string }> = {
  // The resource host is per-tenant, so neither Foundry engine has a useful default endpoint.
  mai: { endpoint: '', model: 'mai-transcribe-1.5' },
  // A deployment name, which is whatever the tenant called it — there is nothing to guess.
  foundry: { endpoint: '', model: '' },
  'azure-speech': { endpoint: '', model: '' },
  openai: { endpoint: 'https://api.openai.com/v1', model: 'whisper-1' },
  xai: { endpoint: 'https://api.x.ai/v1', model: 'grok-audio-transcribe' },
  command: { endpoint: '', model: '' },
};

/**
 * Turn config into settings, or explain exactly what is missing.
 *
 * Done once, up front, rather than at the moment of transcription: discovering that an API
 * key is missing after the user has already spoken is a small cruelty, and `voice status`
 * should be able to answer "will this work?" without recording anything.
 */
/**
 * The engine used when the config does not name one.
 *
 * Exported because more than one place needs to answer "what will this use?" — notably
 * `voice status`, which reports configuration *without* resolving it, since resolving throws
 * when something is missing and that is precisely the case it exists to describe. A second
 * copy of this literal drifted once already and made the status report contradict the
 * program.
 */
export const DEFAULT_VOICE_ENGINE = 'mai' as const;

export function resolveVoiceSettings(config: VoiceConfig, apiKey: string | undefined): VoiceSettings {
  const engine = config.engine ?? DEFAULT_VOICE_ENGINE;
  const defaults = DEFAULTS[engine];
  const endpoint = (config.endpoint ?? defaults.endpoint).replace(/\/+$/, '');
  const model = config.model ?? defaults.model;

  if (engine === 'command') {
    if (config.command === undefined || config.command.trim() === '') {
      throw new Error(
        'voice.engine is "command" but voice.command is not set. Point it at a local transcription binary that reads WAV on stdin and prints the text.',
      );
    }
  } else if (engine === 'azure-speech') {
    if (config.region === undefined && endpoint === '') {
      throw new Error('Azure AI Speech needs either voice.region (for example "eastus") or an explicit voice.endpoint.');
    }
    if (apiKey === undefined) {
      throw new Error('Azure AI Speech needs a key. Set voice.apiKey to "${env:AZURE_SPEECH_KEY}" and export that variable.');
    }
  } else {
    if (endpoint === '') {
      throw new Error(
        `voice.engine is "${engine}" but voice.endpoint is not set. Use your Foundry resource URL, for example "https://my-resource.cognitiveservices.azure.com".`,
      );
    }
    if (model === '') {
      // Only reachable for `foundry`, where the model is a deployment name the tenant chose.
      // Guessing one would produce a 404 that reads like an endpoint problem.
      throw new Error(
        'voice.engine is "foundry" but voice.model is not set. Use the name of your transcription deployment, or switch to "mai" for MAI-Transcribe-1.5.',
      );
    }
    if (apiKey === undefined) {
      throw new Error(
        `voice.engine is "${engine}" but no key resolved. Set voice.apiKey to a "\${env:NAME}" reference and export that variable.`,
      );
    }
  }

  return {
    engine,
    endpoint,
    model,
    apiKey,
    language: config.language ?? 'en-US',
    region: config.region,
    command: config.command,
    commandArgs: config.commandArgs ?? [],
    timeoutMs: Math.max(5, config.maxSeconds ?? 15) * 4000,
    phraseBias: config.phraseBias ?? true,
  };
}

/** Build the transcriber for a set of resolved settings. */
export function createTranscriber(settings: VoiceSettings): Transcriber {
  switch (settings.engine) {
    case 'command':
      return new CommandTranscriber(settings);
    case 'azure-speech':
      return new AzureSpeechTranscriber(settings);
    case 'mai':
      return new MaiTranscriber(settings);
    default:
      return new OpenAiCompatibleTranscriber(settings);
  }
}

/** The documented API version for `speechtotext/transcriptions:transcribe`. */
const LLM_SPEECH_API_VERSION = '2025-10-15';

/**
 * Microsoft Foundry's LLM Speech API, which is what actually serves MAI-Transcribe.
 *
 * Worth spelling out why this is not the class below. The audio part is named `audio`, not
 * `file`; everything else travels as a JSON `definition` part rather than as form fields;
 * the model goes inside `enhancedMode` rather than beside the audio; and the answer comes
 * back as `combinedPhrases`, not `text`. Pointing the OpenAI-shaped request at this endpoint
 * fails, which is exactly the bug this class exists to fix.
 */
class MaiTranscriber implements Transcriber {
  readonly name: string;
  readonly #settings: VoiceSettings;

  constructor(settings: VoiceSettings) {
    this.#settings = settings;
    this.name = `mai (${settings.model})`;
  }

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    const settings = this.#settings;
    const started = Date.now();

    const form = new FormData();
    // Copy into a fresh ArrayBuffer: the capture buffer may be a view onto a larger pool,
    // and Blob would otherwise send the whole pool.
    const bytes = new Uint8Array(request.audio.byteLength);
    bytes.set(request.audio);
    form.append('audio', new Blob([bytes], { type: 'audio/wav' }), 'utterance.wav');
    form.append('definition', JSON.stringify(buildMaiDefinition(settings, request)));

    const response = await fetchWithTimeout(
      `${settings.endpoint}/speechtotext/transcriptions:transcribe?api-version=${LLM_SPEECH_API_VERSION}`,
      {
        method: 'POST',
        headers: { 'ocp-apim-subscription-key': settings.apiKey ?? '' },
        body: form,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      },
      settings.timeoutMs,
    );

    if (!response.ok) throw new Error(await describeHttpFailure(response, settings));

    const payload = (await response.json()) as {
      combinedPhrases?: { text?: unknown }[];
      phrases?: { text?: unknown; confidence?: unknown }[];
    };
    // `combinedPhrases` is the whole utterance; `phrases` is the segmented form. Preferring
    // the combined one keeps punctuation and spacing the service decided on.
    const combined = payload.combinedPhrases?.[0]?.text;
    const text =
      typeof combined === 'string'
        ? combined.trim()
        : (payload.phrases ?? [])
            .map((phrase) => (typeof phrase.text === 'string' ? phrase.text : ''))
            .join(' ')
            .trim();
    const confidence = payload.phrases?.[0]?.confidence;
    return {
      text,
      ...(typeof confidence === 'number' ? { confidence } : {}),
      engine: 'mai',
      model: settings.model,
      durationMs: Date.now() - started,
    };
  }
}

/**
 * The `definition` part for an LLM Speech request.
 *
 * Separate and exported so a test can assert the shape without a network, which is the only
 * way this stays correct: nothing here can be checked against a live endpoint from a machine
 * with no Foundry resource.
 */
export function buildMaiDefinition(
  settings: VoiceSettings,
  request: Pick<TranscriptionRequest, 'language' | 'phrases'> = {},
): Record<string, unknown> {
  const language = request.language ?? settings.language;
  const phrases = settings.phraseBias ? normalizePhrases(request.phrases ?? []) : [];
  return {
    // Omitted entirely when unset, which is how the model is asked to identify the language
    // itself rather than being told to assume one.
    ...(language === '' ? {} : { locales: [language] }),
    ...(phrases.length === 0 ? {} : { phraseList: { phrases } }),
    enhancedMode: { enabled: true, model: settings.model },
  };
}

/** The service caps the list, so send the most specific names rather than an arbitrary prefix. */
const MAX_BIAS_PHRASES = 100;

/**
 * Tidy the on-screen names into a phrase list.
 *
 * Longer names first: a folder called "FY26 Budget Review" is the one a recognizer is least
 * likely to get unaided, while a truncated list that dropped it in favour of "Inbox" would
 * bias toward the word it was already going to guess.
 */
function normalizePhrases(phrases: readonly string[]): string[] {
  // Keyed on the lowercased form to dedupe, but the *original* spelling is what gets sent:
  // these are overwhelmingly proper nouns, and "contoso" is a worse hint than "Contoso".
  const seen = new Map<string, string>();
  for (const phrase of phrases) {
    const trimmed = phrase.trim();
    // Single characters and stray punctuation bias nothing and waste the budget.
    if (trimmed.length < 2 || !/[a-z]/i.test(trimmed)) continue;
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) seen.set(key, trimmed);
  }
  return [...seen.values()].sort((a, b) => b.length - a.length).slice(0, MAX_BIAS_PHRASES);
}

/**
 * The OpenAI-compatible multipart shape, which Foundry, OpenAI and xAI all speak.
 *
 * Foundry wants `api-key`; the others want `Authorization: Bearer`. We send whichever suits
 * the engine rather than both, because sending a credential to a host that did not ask for it
 * is how keys end up in somebody else's logs.
 */
class OpenAiCompatibleTranscriber implements Transcriber {
  readonly name: string;
  readonly #settings: VoiceSettings;

  constructor(settings: VoiceSettings) {
    this.#settings = settings;
    this.name = `${settings.engine} (${settings.model})`;
  }

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    const settings = this.#settings;
    const started = Date.now();

    const form = new FormData();
    // Copy into a fresh ArrayBuffer: the capture buffer may be a view onto a larger pool,
    // and Blob would otherwise send the whole pool.
    const bytes = new Uint8Array(request.audio.byteLength);
    bytes.set(request.audio);
    form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'utterance.wav');
    form.append('model', settings.model);
    form.append('response_format', 'json');
    const language = request.language ?? settings.language;
    // The API wants a bare language code; a BCP-47 tag with a region is rejected by some hosts.
    if (language !== '') form.append('language', language.split('-')[0] ?? language);

    const headers: Record<string, string> =
      settings.engine === 'foundry'
        ? { 'api-key': settings.apiKey ?? '' }
        : { authorization: `Bearer ${settings.apiKey ?? ''}` };

    const url = buildTranscriptionUrl(settings);
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers,
      body: form,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    }, settings.timeoutMs);

    if (!response.ok) {
      throw new Error(await describeHttpFailure(response, settings));
    }

    const payload = (await response.json()) as { text?: unknown; confidence?: unknown };
    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    const confidence = typeof payload.confidence === 'number' ? payload.confidence : undefined;
    return {
      text,
      ...(confidence === undefined ? {} : { confidence }),
      engine: settings.engine,
      model: settings.model,
      durationMs: Date.now() - started,
    };
  }
}

/**
 * Build the transcription URL.
 *
 * If the configured endpoint already names a path we use it verbatim — hosted API surfaces
 * move, and a user who has the current one in their hand should not have to wait for us to
 * ship a release before they can use it.
 */
export function buildTranscriptionUrl(settings: VoiceSettings): string {
  const endpoint = settings.endpoint;
  if (/\/(?:transcriptions|recognize|speech)\b/.test(endpoint)) return endpoint;
  if (/\/v\d+$/.test(endpoint)) return `${endpoint}/audio/transcriptions`;
  return `${endpoint}/openai/v1/audio/transcriptions`;
}

/** The classic Azure AI Speech REST endpoint: raw WAV in, JSON out. */
class AzureSpeechTranscriber implements Transcriber {
  readonly name = 'azure-speech';
  readonly #settings: VoiceSettings;

  constructor(settings: VoiceSettings) {
    this.#settings = settings;
  }

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    const settings = this.#settings;
    const started = Date.now();
    const base =
      settings.endpoint !== ''
        ? settings.endpoint
        : `https://${settings.region ?? 'eastus'}.stt.speech.microsoft.com`;
    const language = request.language ?? settings.language;
    const url = `${base}/speech/recognition/conversation/cognitiveservices/v1?language=${encodeURIComponent(language)}&format=detailed`;

    const bytes = new Uint8Array(request.audio.byteLength);
    bytes.set(request.audio);

    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'ocp-apim-subscription-key': settings.apiKey ?? '',
        'content-type': 'audio/wav; codecs=audio/pcm; samplerate=16000',
        accept: 'application/json',
      },
      body: bytes,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    }, settings.timeoutMs);

    if (!response.ok) throw new Error(await describeHttpFailure(response, settings));

    const payload = (await response.json()) as {
      RecognitionStatus?: string;
      DisplayText?: string;
      NBest?: { Display?: string; Confidence?: number }[];
    };
    if (payload.RecognitionStatus === 'NoMatch') {
      return { text: '', engine: 'azure-speech', durationMs: Date.now() - started };
    }
    const best = payload.NBest?.[0];
    const text = (payload.DisplayText ?? best?.Display ?? '').trim();
    const confidence = best?.Confidence;
    return {
      text,
      ...(confidence === undefined ? {} : { confidence }),
      engine: 'azure-speech',
      durationMs: Date.now() - started,
    };
  }
}

/**
 * A local binary, for people who will not send mailbox audio to anybody.
 *
 * WAV goes in on stdin, the transcript comes back on stdout. That is deliberately the
 * dumbest possible contract, so it can be satisfied by a whisper.cpp wrapper, a Python
 * script, or a two-line shell function, without this file knowing which.
 */
class CommandTranscriber implements Transcriber {
  readonly name: string;
  readonly #settings: VoiceSettings;

  constructor(settings: VoiceSettings) {
    this.#settings = settings;
    this.name = `command (${settings.command ?? '?'})`;
  }

  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    const settings = this.#settings;
    const started = Date.now();
    return new Promise<TranscriptionResult>((resolve, reject) => {
      const child = spawn(settings.command as string, [...settings.commandArgs], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`${settings.command} did not finish within ${Math.round(settings.timeoutMs / 1000)}s.`));
      }, settings.timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(new Error(`Could not run ${settings.command}: ${error.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          const detail = Buffer.concat(err).toString('utf8').trim();
          reject(new Error(`${settings.command} exited ${code ?? '?'}${detail === '' ? '' : `: ${detail}`}`));
          return;
        }
        resolve({
          text: Buffer.concat(out).toString('utf8').trim(),
          engine: 'command',
          durationMs: Date.now() - started,
        });
      });

      request.signal?.addEventListener('abort', () => child.kill(), { once: true });
      child.stdin.on('error', () => {
        /* Killed before the write drained; the close handler reports it. */
      });
      child.stdin.end(Buffer.from(request.audio));
    });
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const caller = init.signal;
  caller?.addEventListener('abort', () => controller.abort(), { once: true });
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted && caller?.aborted !== true) {
      throw new Error(`Transcription timed out after ${Math.round(timeoutMs / 1000)}s.`);
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not reach the transcription service: ${detail}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Explain an HTTP failure in terms of what to change.
 *
 * A bare "401" tells a user nothing they can act on. The status codes an audio endpoint
 * actually returns map cleanly onto four different fixes, and saying which one is the whole
 * difference between a config a person can repair and one they abandon.
 */
async function describeHttpFailure(response: Response, settings: VoiceSettings): Promise<string> {
  let body = '';
  try {
    body = (await response.text()).slice(0, 400).trim();
  } catch {
    /* A body we cannot read is not worth failing twice over. */
  }
  const suffix = body === '' ? '' : ` Response: ${body}`;
  switch (response.status) {
    case 401:
    case 403:
      return `The transcription service rejected the key (${response.status}). Check voice.apiKey and that the environment variable it names is exported.${suffix}`;
    case 404:
      return `The transcription endpoint was not found (404). Check voice.endpoint and voice.model — "${settings.model}" may not be deployed on that resource.${suffix}`;
    case 413:
      return `The clip was too large (413). Lower voice.maxSeconds.${suffix}`;
    case 429:
      return `Rate limited by the transcription service (429). Wait a moment and try again.${suffix}`;
    default:
      return `Transcription failed (${response.status} ${response.statusText}).${suffix}`;
  }
}

/** A transcriber that returns canned text. Used by tests and by `voice test`. */
export function createStubTranscriber(text: string | (() => string)): Transcriber {
  return {
    name: 'stub',
    async transcribe(): Promise<TranscriptionResult> {
      return { text: typeof text === 'function' ? text() : text, engine: 'stub', durationMs: 0 };
    },
  };
}
