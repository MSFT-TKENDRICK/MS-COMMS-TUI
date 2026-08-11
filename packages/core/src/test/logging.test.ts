/**
 * Logger tests.
 *
 * This file exists because `--verbose` shipped producing a single unreadable run-on line:
 * the default writer appended the newline, so an injected writer silently did not, and the
 * only injected writer in the repo was the one users actually hit. Line framing now belongs
 * to the logger, and these tests hold it there.
 *
 * That failure mode matters more than it looks. Diagnostic output that arrives as one
 * 2,000-character line is unreadable in a terminal and considerably worse through speech,
 * where there is no visual scan to fall back on.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, afterEach } from 'node:test';

import { ConsoleLogger, NULL_LOGGER } from '../logging.js';

function capture(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mscomms-log-'));
  temps.push(dir);
  return dir;
}

describe('ConsoleLogger line framing', () => {
  it('terminates every line it hands to an injected writer', () => {
    // The regression. Without this, consecutive records concatenate into one line.
    const sink = capture();
    const logger = new ConsoleLogger({ level: 'debug', write: sink.write });
    logger.debug('one');
    logger.info('two');
    assert.deepEqual(sink.lines, ['[debug] one\n', '[info] two\n']);
  });

  it('produces output that splits back into one record per line', () => {
    const sink = capture();
    const logger = new ConsoleLogger({ level: 'debug', write: sink.write });
    logger.debug('a');
    logger.warn('b');
    logger.error('c');
    const split = sink.lines.join('').split('\n').filter((l) => l !== '');
    assert.equal(split.length, 3);
    for (const line of split) assert.match(line, /^\[(debug|info|warn|error)\] /);
  });

  it('emits exactly one newline even when the message contains none', () => {
    const sink = capture();
    new ConsoleLogger({ level: 'debug', write: sink.write }).info('no newline here');
    assert.equal((sink.lines[0]?.match(/\n/g) ?? []).length, 1);
    assert.equal(sink.lines[0]?.endsWith('\n'), true);
  });
});

describe('ConsoleLogger levels', () => {
  it('defaults to warn, so debug and info are silent', () => {
    const sink = capture();
    const logger = new ConsoleLogger({ write: sink.write });
    logger.debug('no');
    logger.info('no');
    logger.warn('yes');
    logger.error('yes');
    assert.equal(sink.lines.length, 2);
  });

  it('passes everything at debug', () => {
    const sink = capture();
    const logger = new ConsoleLogger({ level: 'debug', write: sink.write });
    logger.debug('a');
    logger.info('b');
    logger.warn('c');
    logger.error('d');
    assert.equal(sink.lines.length, 4);
  });

  it('silences everything at silent, including error', () => {
    const sink = capture();
    const logger = new ConsoleLogger({ level: 'silent', write: sink.write });
    logger.debug('a');
    logger.error('d');
    assert.equal(sink.lines.length, 0);
  });

  it('labels each record with its level', () => {
    const sink = capture();
    const logger = new ConsoleLogger({ level: 'debug', write: sink.write });
    logger.warn('careful');
    assert.equal(sink.lines[0], '[warn] careful\n');
  });
});

describe('ConsoleLogger metadata', () => {
  it('appends metadata as JSON', () => {
    const sink = capture();
    new ConsoleLogger({ level: 'debug', write: sink.write }).info('mounted', { path: '/mail' });
    assert.equal(sink.lines[0], '[info] mounted {"path":"/mail"}\n');
  });

  it('omits the metadata entirely when there is none', () => {
    const sink = capture();
    new ConsoleLogger({ level: 'debug', write: sink.write }).info('plain');
    assert.equal(sink.lines[0], '[info] plain\n');
  });

  it('survives a circular structure rather than throwing inside the logger', () => {
    // A logger that throws turns a diagnostic into an outage.
    const sink = capture();
    const cyclic: Record<string, unknown> = { name: 'a' };
    cyclic['self'] = cyclic;
    new ConsoleLogger({ level: 'debug', write: sink.write }).info('cycle', cyclic);
    assert.match(sink.lines[0] ?? '', /\[circular\]/);
    assert.equal(sink.lines[0]?.endsWith('\n'), true);
  });

  it('survives a BigInt, which JSON.stringify refuses by default', () => {
    const sink = capture();
    new ConsoleLogger({ level: 'debug', write: sink.write }).info('big', { n: 10n });
    assert.equal(sink.lines[0], '[info] big {"n":"10"}\n');
  });
});

describe('ConsoleLogger child loggers', () => {
  it('prefixes records with the child scope', () => {
    const sink = capture();
    const child = new ConsoleLogger({ level: 'debug', write: sink.write }).child('graph');
    child.info('token refreshed');
    assert.equal(sink.lines[0], '[info] graph: token refreshed\n');
  });

  it('nests prefixes with a colon', () => {
    const sink = capture();
    const child = new ConsoleLogger({ level: 'debug', write: sink.write }).child('graph').child('mail');
    child.info('listed');
    assert.equal(sink.lines[0], '[info] graph:mail: listed\n');
  });

  it('inherits the level, so a child cannot become chattier than its parent', () => {
    const sink = capture();
    const child = new ConsoleLogger({ level: 'warn', write: sink.write }).child('scope');
    child.debug('quiet');
    child.info('quiet');
    child.warn('loud');
    assert.equal(sink.lines.length, 1);
  });

  it('inherits the writer, so child output is not lost', () => {
    const sink = capture();
    new ConsoleLogger({ level: 'debug', write: sink.write }).child('x').error('boom');
    assert.equal(sink.lines.length, 1);
  });
});

describe('ConsoleLogger file output', () => {
  it('appends one JSON object per line, in the order they were logged', async () => {
    const dir = await tempDir();
    const file = join(dir, 'log.jsonl');
    const logger = new ConsoleLogger({ level: 'debug', write: () => undefined, file });
    logger.info('first', { a: 1 });
    logger.warn('second');
    await logger.flush();

    const lines = (await readFile(file, 'utf8')).split('\n').filter((l) => l !== '');
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0] as string) as Record<string, unknown>;
    assert.equal(first['message'], 'first');
    assert.equal(first['level'], 'info');
    assert.equal(first['a'], 1);
    assert.equal(typeof first['ts'], 'string');
    assert.equal((JSON.parse(lines[1] as string) as Record<string, unknown>)['message'], 'second');
  });

  it('keeps many rapid records in order', async () => {
    // The regression: un-awaited appends complete in whatever order the filesystem
    // finishes them, which for a log is a lie about what happened when.
    const file = join(await tempDir(), 'burst.jsonl');
    const logger = new ConsoleLogger({ level: 'debug', write: () => undefined, file });
    for (let i = 0; i < 50; i += 1) logger.info(`m${String(i)}`);
    await logger.flush();

    const messages = (await readFile(file, 'utf8'))
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => (JSON.parse(l) as Record<string, unknown>)['message']);
    assert.deepEqual(
      messages,
      Array.from({ length: 50 }, (_v, i) => `m${String(i)}`),
    );
  });

  it('keeps a parent and its child in order in a shared file', async () => {
    // `child()` returns a separate instance. A per-instance queue would let these two
    // interleave, so the queue is keyed by file.
    const file = join(await tempDir(), 'shared.jsonl');
    const parent = new ConsoleLogger({ level: 'debug', write: () => undefined, file });
    const child = parent.child('graph');
    parent.info('p1');
    child.info('c1');
    parent.info('p2');
    child.info('c2');
    await parent.flush();
    await child.flush();

    const messages = (await readFile(file, 'utf8'))
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => (JSON.parse(l) as Record<string, unknown>)['message']);
    assert.deepEqual(messages, ['p1', 'c1', 'p2', 'c2']);
  });

  it('does not throw when the log file cannot be written', async () => {
    // A read-only or missing directory must degrade to "no file log", never to a crash.
    const logger = new ConsoleLogger({
      level: 'debug',
      write: () => undefined,
      file: join(await tempDir(), 'no', 'such', 'dir', 'log.jsonl'),
    });
    assert.doesNotThrow(() => logger.error('still fine'));
    await logger.flush();
  });

  it('still writes to the stream when a file is configured', async () => {
    const sink = capture();
    const logger = new ConsoleLogger({ level: 'debug', write: sink.write, file: join(await tempDir(), 'l.jsonl') });
    logger.info('both');
    assert.equal(sink.lines[0], '[info] both\n');
    await logger.flush();
  });

  it('resolves flush immediately when no file is configured', async () => {
    const logger = new ConsoleLogger({ level: 'debug', write: () => undefined });
    logger.info('nowhere');
    await logger.flush();
  });
});

describe('NULL_LOGGER', () => {
  it('accepts every method and produces nothing', () => {
    assert.doesNotThrow(() => {
      NULL_LOGGER.debug('a', { x: 1 });
      NULL_LOGGER.info('b');
      NULL_LOGGER.warn('c');
      NULL_LOGGER.error('d');
    });
  });

  it('returns a usable logger from child', () => {
    assert.doesNotThrow(() => NULL_LOGGER.child('scope').error('quiet'));
  });
});
