import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  NavigationPredictor,
  PREFETCH_PRIORITY,
  PrefetchQueue,
  type PrefetchTask,
} from '../prefetch.js';
import type { VNode } from '../provider.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** A task that records the order it ran in and resolves immediately. */
function task(key: string, priority: number, log: string[], overrides: Partial<PrefetchTask> = {}): PrefetchTask {
  return {
    key,
    priority,
    path: `/mail/${key}`,
    run: async () => {
      log.push(key);
    },
    ...overrides,
  };
}

/** A task that blocks until the returned `release` is called. */
function gate(key: string, priority: number): { task: PrefetchTask; release: () => void; started: Promise<void> } {
  let release!: () => void;
  let markStarted!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  return {
    release,
    started,
    task: {
      key,
      priority,
      path: `/mail/${key}`,
      run: async () => {
        markStarted();
        await blocked;
      },
    },
  };
}

function node(name: string, overrides: Partial<VNode> = {}): VNode {
  return {
    id: name,
    name,
    kind: 'file',
    title: name,
    path: `/mail/Inbox/${name}`,
    ...overrides,
  } as VNode;
}

// ---------------------------------------------------------------------------
// PrefetchQueue
// ---------------------------------------------------------------------------

describe('PrefetchQueue: ordering', () => {
  it('runs the most important work first', async () => {
    const log: string[] = [];
    const queue = new PrefetchQueue({ concurrency: 1 });

    // Scheduled worst-first so a queue that ignored priority would produce the input order.
    queue.schedule(task('sibling', PREFETCH_PRIORITY.sibling, log));
    queue.schedule(task('child', PREFETCH_PRIORITY.child, log));
    queue.schedule(task('page', PREFETCH_PRIORITY.nextPage, log));
    await queue.idle();

    assert.deepEqual(log, ['page', 'child', 'sibling']);
  });

  it('keeps equal priorities in arrival order', async () => {
    const log: string[] = [];
    const queue = new PrefetchQueue({ concurrency: 1 });

    for (const key of ['a', 'b', 'c', 'd']) queue.schedule(task(key, PREFETCH_PRIORITY.document, log));
    await queue.idle();

    // Without the sequence tiebreak a stable-looking sort can still starve the oldest task.
    assert.deepEqual(log, ['a', 'b', 'c', 'd']);
  });

  it('honours the concurrency ceiling', async () => {
    const first = gate('one', 0);
    const second = gate('two', 0);
    const third = gate('three', 0);
    const queue = new PrefetchQueue({ concurrency: 2 });

    queue.schedule(first.task);
    queue.schedule(second.task);
    queue.schedule(third.task);
    await Promise.all([first.started, second.started]);

    // Two in flight, one still waiting: speculation must not saturate a shared rate limit.
    assert.equal(queue.stats.running, 2);
    assert.equal(queue.stats.queued, 1);

    first.release();
    second.release();
    third.release();
    await queue.idle();
    assert.equal(queue.stats.completed, 3);
  });
});

describe('PrefetchQueue: deduplication', () => {
  it('ignores a key already queued', async () => {
    const log: string[] = [];
    const queue = new PrefetchQueue({ concurrency: 1 });
    const blocker = gate('blocker', -1);

    queue.schedule(blocker.task);
    await blocker.started;

    assert.equal(queue.schedule(task('dup', 0, log)), true);
    assert.equal(queue.schedule(task('dup', 0, log)), false);

    blocker.release();
    await queue.idle();
    assert.deepEqual(log, ['dup']);
  });

  it('ignores a key already in flight', async () => {
    const running = gate('inflight', 0);
    const queue = new PrefetchQueue({ concurrency: 1 });

    queue.schedule(running.task);
    await running.started;

    // The same folder predicted twice from two listings must not be fetched twice.
    assert.equal(queue.schedule({ ...running.task, run: async () => {} }), false);

    running.release();
    await queue.idle();
    assert.equal(queue.stats.issued, 1);
  });

  it('allows the same key again once it has finished', async () => {
    const log: string[] = [];
    const queue = new PrefetchQueue({ concurrency: 1 });

    queue.schedule(task('again', 0, log));
    await queue.idle();
    assert.equal(queue.schedule(task('again', 0, log)), true);
    await queue.idle();

    // Dedupe is about not doing the same work twice at once, not a permanent blocklist:
    // a directory refetched an hour later is a legitimate second fetch.
    assert.deepEqual(log, ['again', 'again']);
  });
});

describe('PrefetchQueue: bounds', () => {
  it('drops the worst-ranked work when the queue overflows', async () => {
    const log: string[] = [];
    const queue = new PrefetchQueue({ concurrency: 1, maxQueued: 3 });
    const blocker = gate('blocker', -1);
    queue.schedule(blocker.task);
    await blocker.started;

    queue.schedule(task('keep-a', PREFETCH_PRIORITY.nextPage, log));
    queue.schedule(task('keep-b', PREFETCH_PRIORITY.document, log));
    queue.schedule(task('keep-c', PREFETCH_PRIORITY.child, log));
    queue.schedule(task('drop', PREFETCH_PRIORITY.sibling, log));

    assert.equal(queue.stats.queued, 3);

    blocker.release();
    await queue.idle();

    // The bound sheds the least likely guess, not the newest one: an unbounded prefetch
    // queue in a long session is a memory leak that also spends API quota on stale guesses.
    assert.deepEqual(log, ['keep-a', 'keep-b', 'keep-c']);
    assert.equal(queue.stats.canceled, 1);
  });
});

describe('PrefetchQueue: cancellation', () => {
  it('cancels everything by default', async () => {
    const log: string[] = [];
    const queue = new PrefetchQueue({ concurrency: 1 });
    const blocker = gate('blocker', -1);
    queue.schedule(blocker.task);
    await blocker.started;

    queue.schedule(task('a', PREFETCH_PRIORITY.nextPage, log));
    queue.schedule(task('b', PREFETCH_PRIORITY.sibling, log));

    assert.equal(queue.cancel(), 2);

    blocker.release();
    await queue.idle();
    assert.deepEqual(log, []);
  });

  it('keeps work more important than minPriority', async () => {
    const log: string[] = [];
    const queue = new PrefetchQueue({ concurrency: 1 });
    const blocker = gate('blocker', -1);
    queue.schedule(blocker.task);
    await blocker.started;

    queue.schedule(task('page', PREFETCH_PRIORITY.nextPage, log));
    queue.schedule(task('body', PREFETCH_PRIORITY.document, log));
    queue.schedule(task('sibling', PREFETCH_PRIORITY.sibling, log));

    queue.cancel({ minPriority: PREFETCH_PRIORITY.document });

    blocker.release();
    await queue.idle();

    // Navigating away invalidates guesses about where the user *might* have gone, but the
    // next page of the folder they are standing in is still one `more` away.
    assert.deepEqual(log, ['page']);
  });

  it('exempts tasks the caller wants kept', async () => {
    const log: string[] = [];
    const queue = new PrefetchQueue({ concurrency: 1 });
    const blocker = gate('blocker', -1);
    queue.schedule(blocker.task);
    await blocker.started;

    queue.schedule(task('mail', PREFETCH_PRIORITY.child, log));
    queue.schedule(task('teams', PREFETCH_PRIORITY.child, log));

    queue.cancel({ keep: (candidate) => candidate.key === 'mail' });

    blocker.release();
    await queue.idle();
    assert.deepEqual(log, ['mail']);
  });

  it('aborts running work when asked', async () => {
    const queue = new PrefetchQueue({ concurrency: 1 });
    let aborted = false;
    let started!: () => void;
    const hasStarted = new Promise<void>((resolve) => {
      started = resolve;
    });

    queue.schedule({
      key: 'long',
      priority: 0,
      path: '/mail/Inbox',
      run: async (signal) => {
        started();
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            resolve();
          });
        });
      },
    });

    await hasStarted;
    queue.cancel({ includeRunning: true });
    await queue.idle();

    // Shutdown must not wait on a speculative HTTP request nobody is going to read.
    assert.equal(aborted, true);
  });

  it('refuses new work after disposal', () => {
    const queue = new PrefetchQueue();
    queue.dispose();
    assert.equal(queue.schedule(task('late', 0, [])), false);
  });
});

describe('PrefetchQueue: failure handling', () => {
  it('swallows errors and keeps draining', async () => {
    const log: string[] = [];
    const queue = new PrefetchQueue({ concurrency: 1 });

    queue.schedule({
      key: 'boom',
      priority: PREFETCH_PRIORITY.nextPage,
      path: '/mail/Inbox',
      run: async () => {
        throw new Error('429 Too Many Requests');
      },
    });
    queue.schedule(task('after', PREFETCH_PRIORITY.document, log));

    // No rejection escapes: nobody asked for this fetch, so its failure is not the
    // user's problem, and one bad guess must not stall every later one.
    await queue.idle();

    assert.deepEqual(log, ['after']);
    assert.equal(queue.stats.failed, 1);
    assert.equal(queue.stats.completed, 1);
  });

  it('resolves idle immediately when there is nothing to do', async () => {
    await new PrefetchQueue().idle();
  });
});

/**
 * Yielding to the person at the keyboard.
 *
 * Priority orders the queue; it does not make the queue get out of the way. Once a warm task
 * has been handed to a transport that serialises everything down one pipe — which is what
 * MCP is — the user's own request queues up behind it and priority no longer applies,
 * because the work has already left. Cancelling does not help either: a request that has
 * been sent cannot be unsent.
 *
 * So the foreground takes a hold for as long as it is outstanding, and the worst case
 * becomes "one task already in flight" instead of "everything the predictor guessed at".
 * Navigating into a folder and back out took 2.6 seconds against a provider that answers in
 * 0.9; that gap was entirely this.
 */
describe('PrefetchQueue: yielding to the foreground', () => {
  it('starts nothing new while a hold is outstanding', async () => {
    const log: string[] = [];
    const queue = new PrefetchQueue({ concurrency: 2 });

    const release = queue.hold();
    queue.schedule(task('guess', PREFETCH_PRIORITY.nextPage, log));

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(log, [], 'the guess must wait; somebody is waiting on something real');

    release();
    await queue.idle();
    assert.deepEqual(log, ['guess'], 'and runs once nobody is');
  });

  it('lets a task already in flight finish rather than stranding it', async () => {
    const running = gate('inflight', PREFETCH_PRIORITY.nextPage);
    const queue = new PrefetchQueue({ concurrency: 1 });

    queue.schedule(running.task);
    await running.started;

    // Taking a hold now must not deadlock the queue on the task it already started.
    const release = queue.hold();
    running.release();
    release();
    await queue.idle();

    assert.equal(queue.stats.completed, 1);
  });

  it('counts holds, so two overlapping requests do not release each other', async () => {
    const log: string[] = [];
    const queue = new PrefetchQueue({ concurrency: 1 });

    const first = queue.hold();
    const second = queue.hold();
    queue.schedule(task('guess', PREFETCH_PRIORITY.nextPage, log));

    first();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(log, [], 'one request finishing does not mean the other has');

    second();
    await queue.idle();
    assert.deepEqual(log, ['guess']);
  });

  it('ignores a release called twice, which would otherwise let the count go negative', async () => {
    const log: string[] = [];
    const queue = new PrefetchQueue({ concurrency: 1 });

    const first = queue.hold();
    const second = queue.hold();
    first();
    first();
    queue.schedule(task('guess', PREFETCH_PRIORITY.nextPage, log));

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(log, [], 'the second release was not a real one and must not count');

    second();
    await queue.idle();
    assert.deepEqual(log, ['guess']);
  });

  it('does not report itself idle while it is holding work back', async () => {
    // `idle()` means "nothing left to do", and a held queue with a full backlog has plenty.
    // Getting this wrong would make every test that waits on the queue pass early.
    const log: string[] = [];
    const queue = new PrefetchQueue({ concurrency: 1 });

    const release = queue.hold();
    queue.schedule(task('guess', PREFETCH_PRIORITY.nextPage, log));

    let settled = false;
    const waiting = queue.idle().then(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(settled, false, 'there is queued work, so this is not idle');

    release();
    await waiting;
    assert.deepEqual(log, ['guess']);
  });

  it('speculates one request at a time by default', async () => {
    // Not a tuning constant. Whatever is already in flight cannot be recalled, so this
    // number *is* the foreground's worst-case wait, measured in whole provider round trips.
    // At two, against a source answering in 900ms, a keypress cost 2.5 seconds — 1.6 of it
    // spent waiting for guesses nobody had asked for.
    const started: string[] = [];
    const queue = new PrefetchQueue();
    const first = gate('one', PREFETCH_PRIORITY.nextPage);
    const second = gate('two', PREFETCH_PRIORITY.nextPage);

    queue.schedule({ ...first.task, run: async (s) => { started.push('one'); await first.task.run(s); } });
    queue.schedule({ ...second.task, run: async (s) => { started.push('two'); await second.task.run(s); } });

    await first.started;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(started, ['one'], 'the second must not have been sent yet');

    first.release();
    second.release();
    await queue.idle();
    assert.deepEqual(started, ['one', 'two'], 'and follows once the first is done');
  });
});

// ---------------------------------------------------------------------------
// NavigationPredictor
// ---------------------------------------------------------------------------

describe('NavigationPredictor: static predictions', () => {
  it('ranks the next page above everything else', () => {
    const predictor = new NavigationPredictor();
    const targets = predictor.predict('/mail/Inbox', [node('1')], { cursor: 'page-2' });

    const first = targets[0];
    assert.equal(first?.reason, 'next-page');
    assert.equal(first?.cursor, 'page-2');
    assert.equal(first?.path, '/mail/Inbox');
  });

  it('omits the next page when the listing is complete', () => {
    const predictor = new NavigationPredictor();
    const targets = predictor.predict('/mail/Inbox', [node('1')]);
    assert.equal(
      targets.some((target) => target.reason === 'next-page'),
      false,
    );
  });

  it('warms bodies before subdirectories', () => {
    const predictor = new NavigationPredictor();
    const targets = predictor.predict('/mail/Inbox', [
      node('Sub', { kind: 'dir', path: '/mail/Inbox/Sub' }),
      node('msg'),
    ]);

    const reasons = targets.map((target) => target.reason);
    assert.ok(reasons.indexOf('document') < reasons.indexOf('child'));
  });

  it('caps how much of a listing it warms', () => {
    const predictor = new NavigationPredictor({ documents: 2, children: 1 });
    const entries = [
      ...Array.from({ length: 20 }, (_unused, index) => node(`msg-${index}`)),
      ...Array.from({ length: 5 }, (_unused, index) =>
        node(`dir-${index}`, { kind: 'dir', path: `/mail/Inbox/dir-${index}` }),
      ),
    ];

    const targets = predictor.predict('/mail/Inbox', entries);

    // A 500-message folder must not turn into 500 speculative body fetches.
    assert.equal(targets.filter((target) => target.reason === 'document').length, 2);
    assert.equal(targets.filter((target) => target.reason === 'child').length, 1);
  });

  it('warms the first entries listed, which are the ones on screen', () => {
    const predictor = new NavigationPredictor({ documents: 2 });
    const targets = predictor.predict('/mail/Inbox', [node('a'), node('b'), node('c')]);
    assert.deepEqual(
      targets.filter((target) => target.reason === 'document').map((target) => target.path),
      ['/mail/Inbox/a', '/mail/Inbox/b'],
    );
  });

  it('derives a path when an entry does not carry one', () => {
    const predictor = new NavigationPredictor();
    const bare = { id: 'x', name: 'msg', kind: 'file', title: 'msg' } as VNode;
    const targets = predictor.predict('/mail/Inbox', [bare]);
    assert.equal(targets[0]?.path, '/mail/Inbox/msg');
  });

  it('warms siblings last and never itself', () => {
    const predictor = new NavigationPredictor();
    const targets = predictor.predict('/mail/Inbox', [], {
      siblings: ['/mail/Inbox', '/mail/Archive', '/mail/Sent'],
    });

    assert.deepEqual(
      targets.map((target) => target.path),
      ['/mail/Archive', '/mail/Sent'],
    );
  });
});

describe('NavigationPredictor: learning', () => {
  it('learns the edge between two visits', () => {
    const predictor = new NavigationPredictor();
    predictor.record('/mail/Inbox');
    predictor.record('/mail/Archive');

    assert.deepEqual(predictor.transitions(), [{ from: '/mail/Inbox', to: '/mail/Archive', count: 1 }]);
  });

  it('does not learn an edge from a path to itself', () => {
    const predictor = new NavigationPredictor();
    predictor.record('/mail/Inbox');
    predictor.record('/mail/Inbox');
    assert.deepEqual(predictor.transitions(), []);
  });

  it('normalises paths before learning them', () => {
    const predictor = new NavigationPredictor();
    predictor.record('/mail/Inbox/');
    predictor.record('//mail//Archive');

    assert.deepEqual(predictor.transitions(), [{ from: '/mail/Inbox', to: '/mail/Archive', count: 1 }]);
  });

  it('predicts the most travelled edge first', () => {
    const predictor = new NavigationPredictor({ learned: 1 });
    predictor.learn('/mail/Inbox', '/mail/Archive', 2);
    predictor.learn('/mail/Inbox', '/mail/Sent', 9);

    const learned = predictor.predict('/mail/Inbox', []).filter((target) => target.reason === 'learned');
    assert.deepEqual(
      learned.map((target) => target.path),
      ['/mail/Sent'],
    );
  });

  it('breaks ties by path so predictions are stable across runs', () => {
    const predictor = new NavigationPredictor({ learned: 2 });
    predictor.learn('/mail/Inbox', '/mail/Zebra', 3);
    predictor.learn('/mail/Inbox', '/mail/Alpha', 3);

    const learned = predictor.predict('/mail/Inbox', []).filter((target) => target.reason === 'learned');
    assert.deepEqual(
      learned.map((target) => target.path),
      ['/mail/Alpha', '/mail/Zebra'],
    );
  });

  it('does not predict a path it is already warming', () => {
    const predictor = new NavigationPredictor();
    predictor.learn('/mail/Inbox', '/mail/Inbox/Sub', 5);

    const targets = predictor.predict('/mail/Inbox', [node('Sub', { kind: 'dir', path: '/mail/Inbox/Sub' })]);

    assert.equal(targets.filter((target) => target.path === '/mail/Inbox/Sub').length, 1);
  });

  it('restores history without inventing an edge from the previous session', () => {
    const predictor = new NavigationPredictor();
    predictor.learn('/mail/Inbox', '/mail/Archive', 4);

    // `learn` must not set a "last visited", or the first navigation of a new session
    // would fabricate an edge from wherever the previous session happened to stop.
    predictor.record('/teams/General');

    assert.deepEqual(predictor.transitions(), [{ from: '/mail/Inbox', to: '/mail/Archive', count: 4 }]);
  });

  it('ignores a restored edge with no weight', () => {
    const predictor = new NavigationPredictor();
    predictor.learn('/mail/Inbox', '/mail/Archive', 0);
    assert.deepEqual(predictor.transitions(), []);
  });

  it('reports dirty only for edges that need persisting', () => {
    const predictor = new NavigationPredictor();
    assert.equal(predictor.dirty, false);

    predictor.learn('/mail/Inbox', '/mail/Archive', 3);
    // Restored history is already in the snapshot; writing it back is pure I/O.
    assert.equal(predictor.dirty, false);

    predictor.record('/mail/Inbox');
    predictor.record('/mail/Sent');
    assert.equal(predictor.dirty, true);

    predictor.transitions();
    assert.equal(predictor.dirty, false);
  });

  it('accepts history through the constructor', () => {
    const predictor = new NavigationPredictor({
      learned: 1,
      history: [{ from: '/mail/Inbox', to: '/mail/Archive', count: 7 }],
    });

    const learned = predictor.predict('/mail/Inbox', []).filter((target) => target.reason === 'learned');
    assert.equal(learned[0]?.path, '/mail/Archive');
  });
});
