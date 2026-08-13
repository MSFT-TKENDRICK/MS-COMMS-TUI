/**
 * Startup warm-up.
 *
 * The measurement that motivated all of this: bringing up the Graph MCP transport takes
 * about seven seconds, and the request that follows takes about a quarter of one. Paid
 * lazily, that whole cost lands on whichever command the user happens to type first, with
 * the screen showing nothing — which is why the tool was described as locking up.
 *
 * So the two things worth testing are that it *happens* (the cost is moved off the user's
 * first command) and that it *yields* (a speculative listing must never be the reason a real
 * one is slow, or the fix is just the same delay wearing a different hat).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Vfs, type Mount } from '../vfs.js';
import { PREFETCH_PRIORITY, rankWarmCandidates } from '../prefetch.js';
import type { Capability, ListOptions, ListPage, Provider, VNode } from '../provider.js';

interface StubChild {
  readonly name: string;
  readonly unreadCount?: number;
  readonly childCount?: number;
  readonly mtime?: Date;
}

interface StubOptions {
  readonly path: string;
  readonly children?: readonly (string | StubChild)[];
  readonly warmThrows?: boolean;
  readonly warmDelayMs?: number;
  /** How long a listing takes. For testing what shutdown does with work still running. */
  readonly listDelayMs?: number;
}

class WarmStub implements Provider {
  readonly id: string;
  readonly displayName = 'stub';
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(['list', 'read']);

  warmCalls = 0;
  aborted = 0;
  readonly listed: string[] = [];

  readonly #options: StubOptions;

  constructor(options: StubOptions) {
    this.#options = options;
    this.id = `stub:${options.path}`;
  }

  async warm(): Promise<void> {
    this.warmCalls += 1;
    if (this.#options.warmDelayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, this.#options.warmDelayMs));
    }
    if (this.#options.warmThrows === true) throw new Error('the transport refused to start');
  }

  list(parent: VNode | null, options?: ListOptions): Promise<ListPage> {
    this.listed.push(parent === null ? '<root>' : parent.name);
    const delay = this.#options.listDelayMs;
    if (delay !== undefined) {
      return new Promise<ListPage>((resolve, reject) => {
        const timer = setTimeout(() => resolve(this.#page(parent)), delay);
        options?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          this.aborted += 1;
          reject(new Error('aborted'));
        });
      });
    }
    return Promise.resolve(this.#page(parent));
  }

  #page(parent: VNode | null): ListPage {
    if (parent !== null) return { entries: [] };
    const entries = (this.#options.children ?? []).map((child): VNode => {
      const spec: StubChild = typeof child === 'string' ? { name: child } : child;
      return {
        name: spec.name,
        id: spec.name,
        kind: 'dir',
        title: spec.name,
        ...(spec.unreadCount === undefined ? {} : { unreadCount: spec.unreadCount }),
        ...(spec.childCount === undefined ? {} : { childCount: spec.childCount }),
        ...(spec.mtime === undefined ? {} : { mtime: spec.mtime }),
      };
    });
    return { entries, total: entries.length };
  }

  read(node: VNode): Promise<{ title: string; headers: readonly (readonly [string, string])[]; body: string; format: 'text' }> {
    return Promise.resolve({ title: node.title, headers: [], body: '', format: 'text' as const });
  }
}

function vfsWith(
  stubs: readonly StubOptions[],
  options: { readonly prefetch?: boolean } = {},
): { readonly vfs: Vfs; readonly providers: readonly WarmStub[] } {
  const vfs = new Vfs({ prefetch: { enabled: options.prefetch ?? true, pageSize: 10 } });
  const providers = stubs.map((stub) => {
    const provider = new WarmStub(stub);
    const mount: Mount = { path: stub.path, id: stub.path.slice(1), provider };
    vfs.mount(mount);
    return provider;
  });
  return { vfs, providers };
}

describe('vfs warm-up: paying the connection cost early', () => {
  it('warms every mount, so no source is left to pay on first use', async () => {
    const { vfs, providers } = vfsWith([{ path: '/mail' }, { path: '/teams' }, { path: '/gh' }]);
    await vfs.warm();
    assert.deepEqual(
      providers.map((p) => p.warmCalls),
      [1, 1, 1],
    );
    await vfs.flush();
  });

  it('warms them at the same time rather than one after another', async () => {
    // Three mounts warming in series would be three handshakes deep, which for the real
    // transport is about twenty seconds — long enough that the user reaches the shell first
    // and the whole exercise is pointless.
    const { vfs } = vfsWith([
      { path: '/mail', warmDelayMs: 120 },
      { path: '/teams', warmDelayMs: 120 },
      { path: '/gh', warmDelayMs: 120 },
    ]);
    const started = Date.now();
    await vfs.warm();
    assert.ok(Date.now() - started < 300, 'should overlap, not queue');
    await vfs.flush();
  });

  it('survives a source that cannot connect at all', async () => {
    // Warming is an optimisation. A session that refused to start because a speculative
    // handshake failed would be a worse tool than one that is merely slower.
    const { vfs, providers } = vfsWith([{ path: '/mail', warmThrows: true }, { path: '/teams' }]);
    await vfs.warm();
    assert.equal(providers[1]?.warmCalls, 1, 'a broken mount must not stop the others');
    await vfs.flush();
  });

  it('does nothing surprising when a provider has nothing to warm', async () => {
    const vfs = new Vfs({ prefetch: { enabled: true } });
    const bare: Provider = {
      id: 'bare',
      displayName: 'bare',
      capabilities: new Set<Capability>(['list']),
      list: () => Promise.resolve({ entries: [] }),
      read: (node: VNode) =>
        Promise.resolve({ title: node.title, headers: [] as const, body: '', format: 'text' as const }),
    };
    vfs.mount({ path: '/bare', id: 'bare', provider: bare });
    await vfs.warm();
    await vfs.flush();
  });
});

describe('vfs warm-up: preloading what the user will open', () => {
  it('lists each mount root, so the first `ls` is already answered', async () => {
    const { vfs, providers } = vfsWith([{ path: '/mail', children: ['Inbox'] }, { path: '/gh', children: [] }]);
    await vfs.warm();
    await vfs.flush();
    assert.ok(providers[0]?.listed.includes('<root>'), '/mail root should have been listed');
    assert.ok(providers[1]?.listed.includes('<root>'), '/gh root should have been listed');
  });

  it('follows one level in, because a mount root is a menu and not a destination', async () => {
    // Nobody reads `/mail`; they are on their way to Inbox. Stopping at the root would warm
    // the one listing the user spends no time on.
    const { vfs, providers } = vfsWith([{ path: '/mail', children: ['Inbox', 'Sent Items'] }]);
    await vfs.warm();
    await vfs.flush();
    assert.ok(providers[0]?.listed.includes('Inbox'));
  });

  it('stops after a handful, so a mailbox with sixty folders does not warm all of them', async () => {
    const many = Array.from({ length: 60 }, (_, i) => `Folder${String(i)}`);
    const { vfs, providers } = vfsWith([{ path: '/mail', children: many }]);
    await vfs.warm();
    await vfs.flush();
    const children = providers[0]?.listed.filter((name) => name !== '<root>') ?? [];
    assert.ok(children.length > 0, 'should warm something');
    assert.ok(children.length <= 8, `warmed ${String(children.length)} children; that is a spending spree`);
  });

  it('ranks warming below every other kind of speculation', () => {
    // It is the only guess made with no evidence at all — there is no current directory to
    // reason from — so it must be the first thing dropped when real work arrives.
    const others = [
      PREFETCH_PRIORITY.nextPage,
      PREFETCH_PRIORITY.document,
      PREFETCH_PRIORITY.child,
      PREFETCH_PRIORITY.learned,
      PREFETCH_PRIORITY.sibling,
    ];
    for (const priority of others) assert.ok(PREFETCH_PRIORITY.warm > priority);
  });

  it('preloads nothing when prefetching is switched off, but still connects', async () => {
    // The connection is the expensive part and costs no bandwidth; the listings are the part
    // a user who turned prefetching off is asking not to have.
    const { vfs, providers } = vfsWith([{ path: '/mail', children: ['Inbox'] }], { prefetch: false });
    await vfs.warm();
    await vfs.flush();
    assert.equal(providers[0]?.warmCalls, 1);
    assert.deepEqual(providers[0]?.listed, []);
  });

  it('gives up when the session is already shutting down', async () => {
    const controller = new AbortController();
    controller.abort();
    const { vfs, providers } = vfsWith([{ path: '/mail', children: ['Inbox'] }]);
    await vfs.warm({ signal: controller.signal });
    await vfs.flush();
    assert.deepEqual(providers[0]?.listed, [], 'no speculative listing after an abort');
  });
});

/**
 * The shape of a real mailbox, taken from the account this was measured against.
 *
 * Folders come back alphabetically and the interesting one is sixth. Three of the five
 * that sort ahead of it are completely empty. This is the case that showed "warm the
 * first few in listing order" to be worthless.
 */
const REAL_MAILBOX: readonly StubChild[] = [
  { name: 'Archive', unreadCount: 0, childCount: 0 },
  { name: 'Conversation History', unreadCount: 0, childCount: 0 },
  { name: 'Deleted Items', unreadCount: 420, childCount: 545 },
  { name: 'Drafts', unreadCount: 0, childCount: 5 },
  { name: 'External', unreadCount: 404, childCount: 469 },
  { name: 'Inbox', unreadCount: 3629, childCount: 3771 },
  { name: 'Junk Email', unreadCount: 1, childCount: 1 },
  { name: 'Outbox', unreadCount: 0, childCount: 0 },
  { name: 'Sent Items', unreadCount: 0, childCount: 423 },
];

describe('choosing what to warm', () => {
  const dir = (name: string, extra: Partial<VNode> = {}): VNode => ({
    name,
    id: name,
    kind: 'dir',
    title: name,
    ...extra,
  });

  it('warms the Inbox of a real mailbox, which listing order never reaches', () => {
    // The regression this function exists for. Alphabetically the Inbox is sixth, so the
    // previous "first four" rule warmed Archive, Conversation History, Deleted Items and
    // Drafts — three of them empty — and left the one folder the user actually opens cold.
    const picked = rankWarmCandidates(
      REAL_MAILBOX.map((f) => dir(f.name, { unreadCount: f.unreadCount ?? 0, childCount: f.childCount ?? 0 })),
      4,
    );
    assert.equal(picked[0]?.name, 'Inbox', 'the busiest folder must be warmed first, not sixth');
    assert.ok(
      !picked.some((n) => n.name === 'Archive' || n.name === 'Outbox'),
      'empty folders are not worth a request',
    );
  });

  it('prefers unread over everything else, because that is why you are opening it', () => {
    const picked = rankWarmCandidates(
      [dir('huge', { childCount: 99999 }), dir('unread', { unreadCount: 1 })],
      1,
    );
    assert.equal(picked[0]?.name, 'unread');
  });

  it('falls back to recent activity, which is the signal chats have and folders do not', () => {
    const picked = rankWarmCandidates(
      [dir('old', { mtime: new Date(1000) }), dir('recent', { mtime: new Date(9000) })],
      1,
    );
    assert.equal(picked[0]?.name, 'recent');
  });

  it('falls back to size when nothing else distinguishes two directories', () => {
    const picked = rankWarmCandidates([dir('small', { childCount: 1 }), dir('big', { childCount: 50 })], 1);
    assert.equal(picked[0]?.name, 'big');
  });

  it('keeps the provider\u2019s own order when it has told us nothing else', () => {
    // A provider that *has* sorted meaningfully should still get its way, and the result
    // must be stable rather than depending on sort implementation.
    const picked = rankWarmCandidates([dir('a'), dir('b'), dir('c')], 3);
    assert.deepEqual(
      picked.map((n) => n.name),
      ['a', 'b', 'c'],
    );
  });

  it('never warms a file, because there is no listing to warm', () => {
    const picked = rankWarmCandidates(
      [{ name: 'note.eml', id: '1', kind: 'file', title: 'note', unreadCount: 500 }, dir('Inbox')],
      2,
    );
    assert.deepEqual(
      picked.map((n) => n.name),
      ['Inbox'],
    );
  });

  it('respects the budget it is given', () => {
    assert.equal(rankWarmCandidates([dir('a'), dir('b'), dir('c')], 2).length, 2);
    assert.deepEqual(rankWarmCandidates([dir('a')], 0), []);
    assert.deepEqual(rankWarmCandidates([], 4), []);
  });
});

describe('warm-up against a mailbox shaped like a real one', () => {
  it('preloads the Inbox rather than three empty folders', async () => {
    const { vfs, providers } = vfsWith([{ path: '/mail', children: REAL_MAILBOX }]);
    await vfs.warm();
    await vfs.flush();
    const warmed = providers[0]?.listed.filter((name) => name !== '<root>') ?? [];
    assert.ok(warmed.includes('Inbox'), `warmed ${JSON.stringify(warmed)}, which does not include the Inbox`);
    assert.ok(!warmed.includes('Archive'), 'an empty folder is not worth a request');
  });
});

describe('warm-up: letting go on the way out', () => {
  it('does not make quitting wait for guesses nobody will collect', async () => {
    // Prefetching bets that the user is about to want something. On the way out they
    // demonstrably are not. `flush()` waits for the prefetch queue to go *idle*, so without
    // an explicit cancellation shutdown blocks on every speculative listing still running —
    // each able to sit on a provider request until it times out, which for the Graph
    // transport is two minutes. That is the "quitting hangs" symptom all over again, and
    // because every invocation warms up it lands on one-shot commands too.
    const { vfs, providers } = vfsWith([
      { path: '/mail', children: ['Inbox', 'Archive', 'Sent', 'Drafts'], listDelayMs: 30_000 },
    ]);
    await vfs.warm();
    // Let the queue actually start something, so there is real work to abandon.
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok((providers[0]?.listed.length ?? 0) > 0, 'expected a speculative listing to be running');

    vfs.cancelSpeculative();
    const startedAt = Date.now();
    await vfs.flush();
    const waited = Date.now() - startedAt;

    assert.ok(waited < 1_000, `shutdown waited ${String(waited)}ms for speculative work it had cancelled`);
  });

  it('still settles snapshot writes, which are not guesses', async () => {
    // The distinction that makes the cancellation safe: speculative *fetches* are abandoned,
    // but anything already being written down is finished. Dropping those would lose the
    // last thing the user did, which is the bug arriving from the other side.
    const { vfs } = vfsWith([{ path: '/mail', children: ['Inbox'] }]);
    await vfs.warm();
    vfs.cancelSpeculative();
    await vfs.flush();
    const page = await vfs.list('/mail');
    assert.ok(page.entries.length > 0, 'the vfs should still be usable afterwards');
  });
});

