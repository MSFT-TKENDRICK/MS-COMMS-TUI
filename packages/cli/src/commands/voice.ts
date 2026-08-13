/**
 * The `voice` command.
 *
 * One command with subcommands rather than eight top-level ones, because `help` is read
 * aloud: a screen reader user hearing the command list should hear "voice" once, not
 * "voice-on, voice-off, voice-once, voice-say, voice-status, voice-devices". The subcommands
 * are still individually completable, so nothing is harder to reach.
 *
 * `voice say` deserves a note. It takes a phrase as text and runs it through the exact same
 * grammar, confirmation and dispatch path that a spoken phrase takes — no microphone
 * involved. That makes the whole feature demonstrable, scriptable, and testable on a machine
 * with no audio hardware, and it means "why did it do that when I said X?" can be answered by
 * typing X rather than by saying it again and hoping.
 */

import {
  interpret,
  knownPhrases,
  detectRecorder,
  NoRecorderError,
  recorderArgsFor,
  canSpeak,
  speak,
  type VoiceOutcome,
} from '@mscomms/voice';
import { Dispatcher } from '../dispatch.js';
import { sanitizeForDisplay } from '../format.js';
import { DEFAULT_TALK_KEY, describeTalkKey, parseTalkKey, talkKeyConflict } from '../tui/keyboard.js';
import { PUSH_TO_TALK_DEFAULTS } from '../tui/push-to-talk.js';
import { VoiceService } from '../voice-service.js';
import type { Session } from '../session.js';
import type { Command, CommandArgs, CommandTable } from './types.js';

function flagBool(args: CommandArgs, ...names: readonly string[]): boolean {
  return names.some((name) => args.flags[name] === true || args.flags[name] === 'true');
}

/** Get or build the session's voice service. */
function serviceFor(session: Session, table: CommandTable): VoiceService {
  const existing = session.voice;
  if (existing instanceof VoiceService) return existing;
  const dispatcher = new Dispatcher(table);
  const service = new VoiceService(session, {
    dispatch: (line) => dispatcher.execute(session, line),
  });
  session.voice = service;
  return service;
}

/** Report an outcome the same way whichever route produced it. */
function reportOutcome(session: Session, outcome: VoiceOutcome): void {
  const heard = outcome.transcript.trim();
  if (heard !== '') session.status(`Heard: "${sanitizeForDisplay(heard)}"`);

  const interpretation = outcome.interpretation;
  if (!interpretation.ok) {
    session.print(interpretation.reason);
    if (interpretation.suggestions.length > 0) {
      session.print(`Try: ${interpretation.suggestions.map((item) => `"${item}"`).join(', ')}`);
    }
    return;
  }

  if (!outcome.ran) {
    session.print(
      outcome.note === 'declined'
        ? 'Cancelled. Nothing was run.'
        : `Understood as \`${interpretation.command}\` but did not run it.`,
    );
    return;
  }
  session.status(`Ran \`${interpretation.command}\``);
}

export function voiceCommands(table: CommandTable): readonly Command[] {
  const voice: Command = {
    name: 'voice',
    aliases: ['mic', 'listen'],
    group: 'system',
    summary: 'Control the message tree by speaking, instead of typing.',
    usage: 'voice <on|off|once|say|status|help|devices|test> [words...]',
    args: ['command', 'query'],
    detail: [
      'Subcommands:',
      '',
      '  voice on         Start listening. Push-to-talk by default: hold Ctrl+Space in the',
      '                   pane and speak, tap it to lock the microphone on, or run',
      '                   `voice once` for a single phrase.',
      '  voice off        Stop listening and release the microphone.',
      '  voice once       Record one phrase and act on it.',
      '  voice say <...>  Run a phrase through the voice grammar without a microphone.',
      '  voice status     What is configured, what is connected, and what was last heard.',
      '  voice help       Every phrase the grammar understands.',
      '  voice devices    Which recorder was found and the exact command it will run.',
      '  voice test       Check the microphone and the transcription service end to end.',
      '  voice test <...> Show what a phrase would run, without running it.',
      '',
      'Anything that changes something is read back and confirmed before it runs. That is on',
      'purpose: a misheard word in a text editor is a typo you can see, and a misheard word',
      'here is a message that has been archived. `set voice.autoRun on` skips the',
      'confirmation, but understand what you are turning off. Navigation is never confirmed.',
      '',
      'Everything spoken becomes an ordinary command line and goes through the same dispatch',
      'as typing, so it is journaled, undoable with `undo`, and shown by `history` marked as',
      'having come from the microphone. Voice can do nothing the keyboard cannot.',
      '',
      'Speech recognition runs on Microsoft Foundry with MAI-Transcribe-1.5 by default. Set',
      '`voice.engine` to `command` to use a local model instead, in which case no audio ever',
      'leaves the machine.',
    ].join('\n'),
    examples: ['voice on', 'voice once', 'voice say "go to inbox"', 'voice say "mark three as read"', 'voice status'],
    flags: [
      { name: 'continuous', description: 'Listen until told to stop. Requires a wake word.', aliases: ['c'] },
      { name: 'dry-run', description: 'Show what a phrase would run without running it.', aliases: ['n'] },
    ],
    async run(session, args) {
      const subcommand = (args.positional[0] ?? 'status').toLowerCase();
      const service = serviceFor(session, table);

      switch (subcommand) {
        case 'on':
        case 'start':
          return startListening(session, service, flagBool(args, 'continuous', 'c'));

        case 'off':
        case 'stop':
          if (!service.enabled) {
            session.print('Voice was already off.');
            return;
          }
          service.disable();
          session.print('Voice is off. The microphone has been released.');
          return;

        case 'once':
        case 'push':
          return listenOnce(session, service);

        case 'say':
        case 'as': {
          const phrase = args.positional.slice(1).join(' ').trim();
          if (phrase === '') {
            throw new Error('Say what? For example: voice say "go to inbox".');
          }
          if (flagBool(args, 'dry-run', 'n')) {
            return explainPhrase(session, service, phrase);
          }
          const outcome = await service.handleTranscript(phrase);
          reportOutcome(session, outcome);
          return;
        }

        case 'status':
          session.print(service.describe());
          // The other half of "why will voice not work": a transcriber is no use without
          // something to record with. Awaited here rather than folded into `describe()`,
          // which stays synchronous because the pane footer redraws with it.
          session.print(await recorderLine(session));
          for (const line of pushToTalkLine(session)) session.print(line);
          return;

        case 'help':
        case 'phrases':
          printPhrases(session);
          return;

        case 'devices':
        case 'doctor':
          return reportDevices(session);

        case 'test': {
          // A phrase means "test this phrase", which is the obvious reading and the one
          // that needs neither a microphone nor a key. Dropping it and running the
          // hardware check instead would be the silent-surplus-argument bug in miniature.
          const phrase = args.positional.slice(1).join(' ').trim();
          if (phrase !== '') return explainPhrase(session, service, phrase);
          return runSelfTest(session, service);
        }

        default:
          throw new Error(
            `I do not know "voice ${sanitizeForDisplay(subcommand)}". Try on, off, once, say, status, help, devices or test.`,
          );
      }
    },
  };

  return [voice];
}

async function startListening(session: Session, service: VoiceService, continuous: boolean): Promise<void> {
  await service.enable();
  const mode = continuous || session.voiceSettings.mode === 'continuous';

  if (!mode) {
    const key = describeTalkKey(
      session.voiceSettings.talkKey === undefined
        ? DEFAULT_TALK_KEY
        : (parseTalkKey(session.voiceSettings.talkKey) ?? DEFAULT_TALK_KEY),
    );
    session.print(
      [
        'Voice is on, push-to-talk.',
        `Say one thing at a time with \`voice once\`, or hold ${key} in the pane and speak while you hold it.`,
        `Tapping ${key} instead locks the microphone on until you tap it again.`,
        'Say "what can I say" for the phrase list, or "stop listening" to finish.',
      ].join('\n'),
    );
    return;
  }

  const wakeWord = session.voiceSettings.wakeWord;
  session.print(`Listening continuously. Start each command with "${wakeWord ?? '?'}". Say "stop listening" to finish.`);
  // Not awaited: continuous mode runs until stopped, and awaiting it here would wedge the
  // REPL on a loop whose whole purpose is to keep accepting other input.
  void service.listenContinuously().catch((error: unknown) => {
    session.writeError(`Voice stopped: ${error instanceof Error ? error.message : String(error)}\n`);
  });
}

async function listenOnce(session: Session, service: VoiceService): Promise<void> {
  session.status('Listening… (speak now)');
  const outcome = await service.listenOnce();
  reportOutcome(session, outcome);
}

async function explainPhrase(session: Session, service: VoiceService, phrase: string): Promise<void> {
  const interpretation = interpret(phrase, service.context());
  if (!interpretation.ok) {
    session.print(`"${sanitizeForDisplay(phrase)}" → refused: ${interpretation.reason}`);
    if (interpretation.suggestions.length > 0) {
      session.print(`Try: ${interpretation.suggestions.map((item) => `"${item}"`).join(', ')}`);
    }
    return;
  }
  session.print(
    [
      `"${sanitizeForDisplay(phrase)}"`,
      `  runs:    ${interpretation.command}`,
      `  meaning: ${interpretation.intent}`,
      `  rule:    ${interpretation.rule}`,
      `  confirm: ${interpretation.mutating ? 'yes — this changes something' : 'no'}`,
    ].join('\n'),
  );
}

function printPhrases(session: Session): void {
  session.print('Phrases voice understands:\n');
  for (const group of knownPhrases()) {
    session.print(`  ${group.rule}`);
    for (const example of group.examples) session.print(`    "${example}"`);
    session.print('');
  }
  session.print('Anything else: say "command" followed by a literal command line.');
}

/**
 * One line saying whether anything on this machine can record.
 *
 * Reports the failure rather than throwing it: `voice status` is what someone runs to find
 * out what is wrong, so it has to survive every individual thing being wrong.
 */
async function recorderLine(session: Session): Promise<string> {
  const configured = session.voiceSettings.recorder;
  if (configured !== undefined) return `  Recorder: ${configured} (set in config)`;
  try {
    return `  Recorder: ${await detectRecorder()}`;
  } catch (error) {
    if (error instanceof NoRecorderError) {
      return '  Recorder: none found — install ffmpeg or sox, or `set voice.recorder <program>`';
    }
    throw error;
  }
}

/**
 * How the talk key is set up, and — the part people actually need — whether holding it will
 * work here.
 *
 * Stated plainly rather than optimistically. Whether a terminal reports key releases is not
 * something a user can be expected to know, and it is the difference between "hold to talk"
 * and "press to start, press to stop". Reported for the current terminal, since that is the
 * one the answer is about, and hedged when there is no terminal at all — a pipe cannot be
 * asked, and guessing would be worse than saying so.
 */
function pushToTalkLine(session: Session): readonly string[] {
  const config = session.voiceSettings;
  const configured = config.talkKey === undefined ? undefined : parseTalkKey(config.talkKey);
  const spec = configured ?? DEFAULT_TALK_KEY;
  const mode = config.pushToTalk ?? PUSH_TO_TALK_DEFAULTS.mode;
  const delay = Math.max(0, config.releaseDelayMs ?? PUSH_TO_TALK_DEFAULTS.releaseDelayMs);
  const key = describeTalkKey(spec);
  const held = mode !== 'toggle' && !(mode === 'auto' && terminalReportsKeyReleases() === false);

  // `set voice.talkKey` refuses a key it cannot use, but a config file is edited by hand and
  // is not offered that refusal. The fallback would otherwise be invisible: a key pressed
  // repeatedly while nothing happens, and a config file that plainly says which key it
  // should be. This is the one place that can say the two disagree.
  const rejected: string[] = [];
  if (config.talkKey !== undefined && configured === undefined) {
    const conflict = talkKeyConflict(config.talkKey);
    const why = conflict === undefined ? 'which I cannot read as a key' : `which a terminal sends as ${conflict}`;
    rejected.push(`  Note:     voice.talkKey in your config is "${config.talkKey}", ${why}. Using ${key} instead.`);
  }

  if (!held) {
    const why =
      mode === 'toggle'
        ? 'voice.pushToTalk is set to toggle'
        : 'this terminal cannot report key releases, so holding is not available';
    return [
      `  Talk key: ${key} in the pane — press to start, press again to stop`,
      `  Release:  ${why}`,
      ...rejected,
    ];
  }

  return [
    `  Talk key: ${key} in the pane — hold to talk, tap to lock the microphone on`,
    delay > 0
      ? `  Release:  keeps recording ${String(delay)}ms after the key comes up`
      : '  Release:  stops the moment the key comes up',
    ...rejected,
  ];
}

/**
 * A guess at whether the terminal will report key releases, from what it says it is.
 *
 * A guess and not an answer: the real test is asking the terminal and waiting for a reply,
 * which the pane does and a status line cannot — `voice status` returns in the time it takes
 * to print, and blocking it on an escape-code round trip to report a nicety would be a bad
 * trade. So this errs toward saying nothing: `undefined` means "no opinion", and only a
 * confident no is reported, because telling somebody hold will not work when it would is
 * worse than staying quiet.
 */
function terminalReportsKeyReleases(): boolean | undefined {
  if (process.env['TERM'] === 'dumb') return false;
  const program = process.env['TERM_PROGRAM']?.toLowerCase() ?? '';
  if (program === 'apple_terminal' || program === 'vscode') return false;
  return undefined;
}

async function reportDevices(session: Session): Promise<void> {
  const config = session.voiceSettings;
  try {
    const recorder = config.recorder ?? (await detectRecorder());
    const argv =
      config.recorderArgs ??
      recorderArgsFor(recorder, {
        maxSeconds: config.maxSeconds ?? 15,
        ...(config.device === undefined ? {} : { device: config.device }),
        platform: process.platform,
      });
    session.print(`Recorder: ${recorder}`);
    session.print(`Command:  ${recorder} ${argv.join(' ')}`);
    session.print(
      config.device === undefined
        ? 'Device:   default (set `voice.device` to choose another)'
        : `Device:   ${config.device}`,
    );
  } catch (error) {
    if (error instanceof NoRecorderError) {
      session.print(error.message);
      return;
    }
    throw error;
  }
  session.print(
    canSpeak()
      ? 'Speech out: available through the operating system voice.'
      : 'Speech out: no synthesizer found on this platform; confirmations will be on screen only.',
  );
}

/**
 * Prove the whole chain works, and say which link failed when it does not.
 *
 * Split into named steps on purpose. "Voice does not work" has four completely different
 * causes — no recorder, no microphone permission, bad credentials, wrong model name — and
 * they need four different fixes. A single pass/fail would send everybody to the same wrong
 * place first.
 */
async function runSelfTest(session: Session, service: VoiceService): Promise<void> {
  session.print('Checking voice setup.\n');

  const config = session.voiceSettings;
  let recorder: string | undefined;
  try {
    recorder = config.recorder ?? (await detectRecorder());
    session.print(`  [ok]   Recorder found: ${recorder}`);
  } catch (error) {
    session.print(`  [fail] ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  try {
    await service.enable();
    const settings = service.settings;
    session.print(`  [ok]   Engine configured: ${settings?.engine ?? '?'} / ${settings?.model || 'default'}`);
  } catch (error) {
    session.print(`  [fail] ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  session.print('  [..]   Recording three seconds — please say "go to inbox".');
  try {
    const outcome = await service.listenOnce();
    if (outcome.transcript === '') {
      session.print('  [fail] Nothing was transcribed. Check the microphone level and that the right device is selected.');
      return;
    }
    session.print(`  [ok]   Transcribed: "${sanitizeForDisplay(outcome.transcript)}"`);
    session.print(
      outcome.interpretation.ok
        ? `  [ok]   Understood as \`${outcome.interpretation.command}\``
        : `  [warn] Heard you, but: ${outcome.interpretation.reason}`,
    );
  } catch (error) {
    session.print(`  [fail] ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  if (config.speak === true) {
    const spoke = await speak('Voice is working.', { wait: true });
    session.print(spoke ? '  [ok]   Spoke a confirmation.' : '  [warn] Could not reach a speech synthesizer.');
  }
  session.print('\nVoice is ready.');
}
