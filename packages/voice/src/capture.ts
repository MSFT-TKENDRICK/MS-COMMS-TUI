/**
 * Getting audio off the microphone without a native dependency.
 *
 * Node cannot open a capture device on its own, and every library that fixes that ships a
 * compiled binding. In a program that reads corporate mail, a compiled binding is a
 * meaningfully worse thing to install than a subprocess — it runs in our address space, it
 * has to be rebuilt per platform and per Node release, and it is a supply-chain surface for
 * the sake of a few seconds of PCM. So we spawn a recorder that the user's machine already
 * has, and read WAV from its stdout.
 *
 * That choice has a real cost: the user needs one of ffmpeg, sox or arecord installed. We pay
 * it deliberately, and in exchange the failure is honest and fixable — a missing program with
 * a name and an install command, rather than a native module that fails to load with a
 * message about symbol versions.
 *
 * The WAV fixing at the bottom of this file is not incidental. A recorder writing to a pipe
 * cannot know how long the recording will be, so it emits placeholder lengths in the RIFF
 * header. Some transcription services tolerate that; others read the header, believe it, and
 * transcribe either nothing or four bytes. We rewrite the two length fields once the stream
 * ends, when the real length is finally known.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

export interface CaptureOptions {
  /** Hard stop, so a stuck recorder cannot listen to a room forever. */
  readonly maxSeconds: number;
  /** Explicit recorder binary. Auto-detected when omitted. */
  readonly recorder?: string;
  /** Explicit arguments, which replace everything we would have chosen. */
  readonly recorderArgs?: readonly string[];
  /** Input device name, as the recorder understands it. */
  readonly device?: string;
  /** Release this to stop recording early — this is what push-to-talk hangs on. */
  readonly signal?: AbortSignal;
  readonly platform?: NodeJS.Platform;
}

export interface CaptureResult {
  readonly audio: Uint8Array;
  readonly recorder: string;
  readonly seconds: number;
}

export class NoRecorderError extends Error {
  readonly candidates: readonly string[];
  constructor(candidates: readonly string[], platform: NodeJS.Platform) {
    super(
      `No microphone recorder found. Voice input needs one of: ${candidates.join(', ')}.\n` +
        installHint(platform) +
        '\nAlready have one? Name it explicitly with `set voice.recorder <program>`.',
    );
    this.name = 'NoRecorderError';
    this.candidates = candidates;
  }
}

function installHint(platform: NodeJS.Platform): string {
  switch (platform) {
    case 'win32':
      return 'Install with: winget install Gyan.FFmpeg';
    case 'darwin':
      return 'Install with: brew install ffmpeg   (or: brew install sox)';
    default:
      return 'Install with: sudo apt install ffmpeg   (alsa-utils provides arecord)';
  }
}

/** Recorders we know how to drive, best first. */
const CANDIDATES: readonly string[] = ['ffmpeg', 'sox', 'rec', 'arecord'];

/**
 * Build the argument list for a recorder.
 *
 * Everything is pinned to 16 kHz mono 16-bit because that is what speech models want and
 * because anything richer is bytes we would upload and the model would discard. Exported so
 * `voice doctor` can show the user the exact command we would run — a diagnostic that says
 * what it did is worth far more than one that says whether it worked.
 */
export function recorderArgsFor(
  recorder: string,
  options: { maxSeconds: number; device?: string; platform: NodeJS.Platform },
): string[] {
  const seconds = String(Math.max(1, Math.round(options.maxSeconds)));
  const base = recorder.replace(/\.exe$/i, '').split(/[\\/]/).pop() ?? recorder;

  switch (base) {
    case 'ffmpeg': {
      const input =
        options.platform === 'win32'
          ? ['-f', 'dshow', '-i', `audio=${options.device ?? 'default'}`]
          : options.platform === 'darwin'
            ? ['-f', 'avfoundation', '-i', `:${options.device ?? '0'}`]
            : ['-f', 'alsa', '-i', options.device ?? 'default'];
      return [
        '-hide_banner',
        '-loglevel', 'error',
        '-nostdin',
        ...input,
        '-ac', '1',
        '-ar', '16000',
        '-sample_fmt', 's16',
        '-t', seconds,
        '-f', 'wav',
        'pipe:1',
      ];
    }
    case 'sox':
    case 'rec': {
      const prefix = base === 'sox' ? ['-d'] : [];
      return [
        '-q',
        ...prefix,
        '-c', '1',
        '-r', '16000',
        '-b', '16',
        '-e', 'signed-integer',
        '-t', 'wav',
        '-',
        'trim', '0', seconds,
      ];
    }
    case 'arecord':
      return [
        '-q',
        '-f', 'S16_LE',
        '-c', '1',
        '-r', '16000',
        '-t', 'wav',
        '-d', seconds,
        ...(options.device === undefined ? [] : ['-D', options.device]),
      ];
    default:
      // An unknown recorder the user named themselves: run it bare and trust them. They
      // supplied it on purpose, and guessing flags for a program we do not know would fail
      // more confusingly than passing none.
      return [];
  }
}

/** Find a usable recorder, or explain what to install. */
export async function detectRecorder(platform: NodeJS.Platform = process.platform): Promise<string> {
  for (const candidate of CANDIDATES) {
    if (await canRun(candidate, platform)) return candidate;
  }
  throw new NoRecorderError(CANDIDATES, platform);
}

const probeCache = new Map<string, boolean>();

function canRun(program: string, platform: NodeJS.Platform): Promise<boolean> {
  const cached = probeCache.get(program);
  if (cached !== undefined) return Promise.resolve(cached);
  return new Promise<boolean>((resolve) => {
    const finder = platform === 'win32' ? 'where' : 'which';
    const child = spawn(finder, [program], { stdio: 'ignore', shell: false });
    const settle = (found: boolean): void => {
      probeCache.set(program, found);
      resolve(found);
    };
    child.on('error', () => settle(false));
    child.on('close', (code) => settle(code === 0));
  });
}

/**
 * Record one utterance.
 *
 * Resolves when the recorder stops — either because `maxSeconds` elapsed or because the
 * caller aborted, which is the normal path for push-to-talk. Abort is a stop, not a failure:
 * releasing the key means "I have finished speaking", and the audio recorded up to that point
 * is exactly the audio we want.
 */
export async function captureUtterance(options: CaptureOptions): Promise<CaptureResult> {
  const platform = options.platform ?? process.platform;
  const recorder = options.recorder ?? (await detectRecorder(platform));
  const args =
    options.recorderArgs !== undefined
      ? [...options.recorderArgs]
      : recorderArgsFor(recorder, {
          maxSeconds: options.maxSeconds,
          ...(options.device === undefined ? {} : { device: options.device }),
          platform,
        });

  const started = Date.now();
  return new Promise<CaptureResult>((resolve, reject) => {
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(recorder, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(new Error(`Could not start ${recorder}: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let stopped = false;
    let abortedByCaller = false;

    // A belt-and-braces stop a little past the recorder's own limit, in case it ignores it.
    const hardStop = setTimeout(() => stop(), (options.maxSeconds + 2) * 1000);

    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      clearTimeout(hardStop);
      // SIGINT rather than SIGKILL: ffmpeg and sox both flush and close the stream cleanly on
      // interrupt, and a truncated final buffer is a transcript with a clipped last word.
      child.kill(platform === 'win32' ? 'SIGTERM' : 'SIGINT');
    };

    const onAbort = (): void => {
      abortedByCaller = true;
      stop();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));

    child.on('error', (error) => {
      clearTimeout(hardStop);
      options.signal?.removeEventListener('abort', onAbort);
      reject(
        error.message.includes('ENOENT')
          ? new NoRecorderError([recorder], platform)
          : new Error(`${recorder} failed: ${error.message}`),
      );
    });

    child.on('close', (code, signal) => {
      clearTimeout(hardStop);
      options.signal?.removeEventListener('abort', onAbort);
      const raw = Buffer.concat(chunks);
      const stderr = Buffer.concat(errChunks).toString('utf8').trim();

      // A non-zero exit we did not cause is a real failure worth surfacing.
      const killedByUs = stopped || signal !== null;
      if (code !== 0 && code !== null && !killedByUs) {
        reject(new Error(`${recorder} exited ${code}${stderr === '' ? '' : `: ${stderr}`}`));
        return;
      }
      if (raw.byteLength <= WAV_HEADER_MIN) {
        reject(
          new Error(
            abortedByCaller
              ? 'No audio was captured — the key was released before recording started.'
              : `No audio was captured by ${recorder}.${stderr === '' ? '' : ` It said: ${stderr}`}`,
          ),
        );
        return;
      }

      resolve({
        audio: finalizeWav(raw),
        recorder,
        seconds: (Date.now() - started) / 1000,
      });
    });
  });
}

const WAV_HEADER_MIN = 44;

/**
 * Repair the length fields of a WAV written to a pipe.
 *
 * A streaming encoder writes the header before it knows how much audio there will be, so it
 * writes a placeholder — often `0xFFFFFFFF`, sometimes `0`. Both are lies by the time we have
 * the bytes. We walk the chunk list, find `data`, and write the two lengths that are now
 * knowable. Anything that is not a RIFF/WAVE stream is passed through untouched, because a
 * user-supplied recorder may legitimately emit something else and mangling it would be worse
 * than forwarding it.
 */
export function finalizeWav(raw: Buffer): Uint8Array {
  if (raw.byteLength < WAV_HEADER_MIN) return new Uint8Array(raw);
  if (raw.toString('ascii', 0, 4) !== 'RIFF' || raw.toString('ascii', 8, 12) !== 'WAVE') {
    return new Uint8Array(raw);
  }

  const buffer = Buffer.from(raw);
  let offset = 12;
  while (offset + 8 <= buffer.byteLength) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const declared = buffer.readUInt32LE(offset + 4);
    const available = buffer.byteLength - (offset + 8);

    if (id === 'data') {
      const actual = declared === 0 || declared > available ? available : declared;
      buffer.writeUInt32LE(actual, offset + 4);
      buffer.writeUInt32LE(offset + 8 + actual - 8, 4);
      return new Uint8Array(buffer.subarray(0, offset + 8 + actual));
    }

    if (declared === 0 || declared > available) break;
    // Chunks are word-aligned; an odd length is followed by a pad byte.
    offset += 8 + declared + (declared % 2);
  }

  // No usable `data` chunk found. Fix the RIFF size at least, so the file is not self-
  // contradictory, and let the service decide what it can make of the rest.
  buffer.writeUInt32LE(buffer.byteLength - 8, 4);
  return new Uint8Array(buffer);
}

/** Rough loudness of 16-bit PCM, used to tell "silent" from "did not understand". */
export function peakAmplitude(wav: Uint8Array): number {
  const buffer = Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength);
  let dataStart = WAV_HEADER_MIN;
  if (buffer.byteLength > 12 && buffer.toString('ascii', 0, 4) === 'RIFF') {
    let offset = 12;
    while (offset + 8 <= buffer.byteLength) {
      const id = buffer.toString('ascii', offset, offset + 4);
      const size = buffer.readUInt32LE(offset + 4);
      if (id === 'data') {
        dataStart = offset + 8;
        break;
      }
      if (size === 0 || size > buffer.byteLength - offset - 8) break;
      offset += 8 + size + (size % 2);
    }
  }

  let peak = 0;
  // Every 64th sample: enough to tell speech from silence, cheap enough to run per utterance.
  for (let index = dataStart; index + 1 < buffer.byteLength; index += 128) {
    const sample = Math.abs(buffer.readInt16LE(index));
    if (sample > peak) peak = sample;
  }
  return peak / 32768;
}
