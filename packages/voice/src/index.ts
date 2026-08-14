/**
 * Voice input for the message VFS.
 *
 * The package is arranged so the interesting part is the testable part:
 *
 * - `grammar` is pure. Transcript plus context in, command line out. Every phrase this
 *   program understands is decided here, and every one of them has a unit test.
 * - `stt` talks to a transcription service over `fetch`. Foundry with MAI-Transcribe-1.5 by
 *   default; Azure AI Speech, OpenAI, xAI and a local binary behind the same interface.
 * - `capture` spawns a recorder the machine already has, rather than linking a native one.
 * - `speak` uses the operating system's synthesizer, so nothing about a mailbox is read aloud
 *   by a server somewhere.
 * - `controller` sequences those four and hands the resulting command line to the caller.
 *
 * Nothing here can reach the VFS. Voice produces text that goes through the same dispatch as
 * typing, which is what keeps it honest.
 */

export {
  interpret,
  knownPhrases,
  normalize,
  parseSpokenNumber,
  type Interpretation,
  type InterpretationOk,
  type InterpretationRefused,
  type VoiceContext,
  type VoiceEntry,
} from './grammar.js';

export {
  buildTranscriptionUrl,
  createStubTranscriber,
  createTranscriber,
  resolveVoiceSettings,
  DEFAULT_VOICE_ENGINE,
  type Transcriber,
  type TranscriptionRequest,
  type TranscriptionResult,
  type VoiceSettings,
} from './stt.js';

export {
  captureUtterance,
  detectRecorder,
  finalizeWav,
  NoRecorderError,
  peakAmplitude,
  recorderArgsFor,
  type CaptureOptions,
  type CaptureResult,
} from './capture.js';

export { canSpeak, speak, type SpeakOptions } from './speak.js';

export {
  parseYesNo,
  stripWakeWord,
  VoiceController,
  type VoiceControllerOptions,
  type VoiceOutcome,
  type VoicePhase,
  type VoiceStatusEvent,
} from './controller.js';
