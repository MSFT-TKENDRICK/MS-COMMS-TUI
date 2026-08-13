/**
 * The unread counter on a directory row.
 *
 * The bug these tests exist for: every provider counts its *own* level, because that is all
 * any of their APIs offer — Graph's `unreadItemCount` is a folder's own messages, the memory
 * provider counts its direct file children, GitHub flags notifications and totals nothing.
 * So the rows a user chooses from first, at the top of the tree, said nothing at all, and the
 * ones that did speak disagreed with what you found by walking into them. Two mounts deep is
 * not where a counter earns its keep; the mount list is.
 *
 * What is being pinned down here is therefore not "a number appears" but what the number
 * *means*: a directory's counter is everything unread at or below it, it never costs a
 * request, and it is absent rather than zero when nobody knows.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Vfs, type Mount } from '../vfs.js';
import type { Capability, ListOptions, ListPage, Provider, VNode } from '../provider.js';

/** A folder in the fake tree: children by name, plus whatever the provider claims to know. */
interface Folder {
  readonly unreadCount?: number;
  readonly dirs?: readonly string[];
  /** Files, and whether each is unread. */
  readonly files?: Readonly<Record<string, boolean>>;
  /** Withhold a cursor-free page, so the directory never reads as fully listed. */
  readonly paged?: boolean;
  /**
   * "This is the same item as that one, reached another way." Makes the fake tree a graph,
   * which is what a people directory and a chat roster actually are: the same person is
   * under `Org`, under `Recent` and under the `Directory` they are defined in. Both routes
   * then report the same provider id and the same contents, which is the only thing that
   * lets a counter tell one item from two.
   */
  readonly same?: string;
}

class TreeStub implements Provider {
  readonly id = 'stub:tree';
  readonly displayName = 'tree';
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(['list', 'read']);

  /** Every list() this provider was asked for, to prove the roll-up adds none. */
  readonly listed: string[] = [];

  readonly #tree: Readonly<Record<string, Folder>>;

  constructor(tree: Readonly<Record<string, Folder>>) {
    this.#tree = tree;
  }

  /** Follow `same` to the key that actually owns the contents, and its identity. */
  #resolve(key: string): { key: string; folder: Folder } {
    let at = key;
    for (let hop = 0; hop < 8; hop += 1) {
      const folder = this.#tree[at] ?? {};
      if (folder.same === undefined) return { key: at, folder };
      at = folder.same;
    }
    return { key: at, folder: this.#tree[at] ?? {} };
  }

  list(parent: VNode | null, _options?: ListOptions): Promise<ListPage> {
    const key = parent === null ? '' : (parent.meta?.['key'] as string);
    this.listed.push(key === '' ? '<root>' : key);
    const { key: owner, folder } = this.#resolve(key);

    const dirs = (folder.dirs ?? []).map((name): VNode => {
      const childKey = owner === '' ? name : `${owner}/${name}`;
      const resolved = this.#resolve(childKey);
      const spec = resolved.folder;
      return {
        name,
        // The provider's identity for the thing, not for the route taken to it.
        id: resolved.key,
        kind: 'dir',
        title: name,
        ...(spec.unreadCount === undefined ? {} : { unreadCount: spec.unreadCount }),
        meta: { key: childKey },
      };
    });

    const files = Object.entries(folder.files ?? {}).map(([name, unread]): VNode => ({
      name,
      id: `${owner}/${name}`,
      kind: 'file',
      title: name,
      ...(unread ? { flags: ['unread'] } : {}),
      meta: { key: `${owner}/${name}` },
    }));

    const entries = [...dirs, ...files];
    // A cursor that is never satisfied: the page is a page, and the directory stays
    // incomplete however many times it is listed.
    return Promise.resolve(folder.paged === true ? { entries, cursor: 'more' } : { entries });
  }

  read(node: VNode): Promise<{ title: string; headers: readonly (readonly [string, string])[]; body: string; format: 'text' }> {
    return Promise.resolve({ title: node.title, headers: [], body: '', format: 'text' as const });
  }
}

function mount(tree: Readonly<Record<string, Folder>>, at = '/src'): { vfs: Vfs; provider: TreeStub } {
  const vfs = new Vfs({ prefetch: { enabled: false } });
  const provider = new TreeStub(tree);
  const m: Mount = { path: at, id: at.slice(1), provider };
  vfs.mount(m);
  return { vfs, provider };
}

/** The counter shown against `name` when `dir` is listed. */
async function counterOn(vfs: Vfs, dir: string, name: string): Promise<number | undefined> {
  const page = await vfs.list(dir);
  const row = page.entries.find((entry) => entry.name === name);
  assert.ok(row !== undefined, `no row called ${name} in ${dir}`);
  return row.unreadCount;
}

describe('unread counters: what the number on a folder means', () => {
  it('counts what is inside a folder, not just what is loose in it', async () => {
    // The shape that started this: a folder whose own children are all folders. Counting
    // only its own level makes it report nothing while three unread sit one step below.
    const { vfs } = mount({
      Chats: { dirs: ['Alice', 'Bob'] },
      'Chats/Alice': { files: { 'a.md': true, 'b.md': true } },
      'Chats/Bob': { files: { 'c.md': true, 'd.md': false } },
      '': { dirs: ['Chats'] },
    });

    await vfs.list('/src/Chats/Alice');
    await vfs.list('/src/Chats/Bob');
    await vfs.list('/src/Chats');

    assert.equal(await counterOn(vfs, '/src', 'Chats'), 3);
  });

  it('does not drift upward as browsing fills the cache', async () => {
    // The property that makes a number worth reading: it says the same thing at 9am as it
    // does after an hour of navigating. An engine that added cached children to a count the
    // provider had already given would make every mail folder grow as you explored it, and a
    // number that moves on its own is one people stop believing.
    const { vfs } = mount({
      '': { dirs: ['Inbox'] },
      Inbox: { unreadCount: 9, dirs: ['Projects'], files: {} },
      'Inbox/Projects': { unreadCount: 4, dirs: ['Old'] },
      'Inbox/Projects/Old': { unreadCount: 1 },
    });

    assert.equal(await counterOn(vfs, '/src', 'Inbox'), 9, 'what the provider said');

    await vfs.list('/src/Inbox/Projects/Old');
    await vfs.list('/src/Inbox/Projects');
    await vfs.list('/src/Inbox');

    assert.equal(await counterOn(vfs, '/src', 'Inbox'), 9, 'and still what the provider said');
  });

  it('leaves a provider that counted and found nothing alone', async () => {
    // `0` from a source that genuinely counts is a real answer — an empty Drafts folder, a
    // mailbox you are on top of — and the engine is in no position to overrule it from a
    // partial cache. Where a `0` is actually wrong, as it was for a folder of folders, the
    // fix belongs in the provider that miscounted rather than in a correction applied to
    // everybody.
    const { vfs } = mount({
      '': { dirs: ['Drafts'] },
      Drafts: { unreadCount: 0, files: { 'a.md': false } },
    });

    await vfs.list('/src/Drafts');

    assert.equal(await counterOn(vfs, '/src', 'Drafts'), 0);
  });

  it('gives a number to a source that only flags items', async () => {
    // GitHub marks a notification unread and totals nothing, which is the common shape for
    // a plugin. The engine composing the total is what saves every such source from having
    // to spend a request on arithmetic.
    const { vfs } = mount({
      '': { dirs: ['notifications'] },
      notifications: { files: { 'one.md': true, 'two.md': false, 'three.md': true } },
    });

    await vfs.list('/src/notifications');

    assert.equal(await counterOn(vfs, '/src', 'notifications'), 2);
  });

  it('says nothing when nobody has an answer, rather than saying zero', async () => {
    // Issues and pull requests have no read state anywhere in GitHub's API. A `0` there
    // would be a claim that someone counted, and it is the claim the user reported as
    // obviously wrong.
    const { vfs } = mount({
      '': { dirs: ['issues'] },
      issues: { files: { '1.md': false, '2.md': false } },
    });

    await vfs.list('/src/issues');

    assert.equal(await counterOn(vfs, '/src', 'issues'), undefined);
  });

  it('leaves an unopened folder exactly as its provider described it', async () => {
    const { vfs } = mount({
      '': { dirs: ['Archive', 'Unknown'] },
      Archive: { unreadCount: 2, files: { 'a.md': true, 'b.md': true } },
      Unknown: { files: { 'c.md': true } },
    });

    assert.equal(await counterOn(vfs, '/src', 'Archive'), 2, 'the provider spoke; nothing to add');
    assert.equal(await counterOn(vfs, '/src', 'Unknown'), undefined, 'never listed, so unknown');
  });

  it('costs no requests, because it runs while someone is waiting', async () => {
    // `ls /` over eight mounts must stay one listing. A roll-up that fetched would make the
    // root of the tree the slowest thing in the tool, and would fail outright offline — for
    // a decoration on a row.
    const { vfs, provider } = mount({
      '': { dirs: ['a', 'b', 'c'] },
      a: { files: { 'x.md': true } },
      b: { files: { 'y.md': true } },
      c: { files: { 'z.md': true } },
    });

    await vfs.list('/src/a');
    await vfs.list('/src/b');
    await vfs.list('/src/c');
    provider.listed.length = 0;

    await vfs.list('/src');

    assert.deepEqual(provider.listed, [], 'served from cache, and the roll-up asked for nothing');
  });

  it('refuses to total a folder it has only seen part of', async () => {
    // A half-paged directory can only yield a floor, and a number that silently means "at
    // least" is worse than no number: it is indistinguishable from an exact one.
    const { vfs } = mount({
      '': { dirs: ['Huge'] },
      Huge: { unreadCount: 3, paged: true, dirs: ['Sub'] },
      'Huge/Sub': { unreadCount: 40 },
    });

    await vfs.list('/src/Huge');

    assert.equal(await counterOn(vfs, '/src', 'Huge'), 3, "the provider's own count, unembellished");
  });

  it('walks a cyclic graph without hanging', async () => {
    // The people tree really is cyclic — your manager's reports contain you — and this runs
    // on the render path of the first command someone types.
    const { vfs } = mount({
      '': { dirs: ['Ada'] },
      Ada: { dirs: ['manager'], files: { 'note.md': true } },
      'Ada/manager': { dirs: ['reports'] },
      'Ada/manager/reports': { dirs: ['Ada'] },
      'Ada/manager/reports/Ada': { dirs: ['manager'], files: { 'note.md': true } },
    });

    await vfs.list('/src/Ada');
    await vfs.list('/src/Ada/manager');
    await vfs.list('/src/Ada/manager/reports');
    await vfs.list('/src/Ada/manager/reports/Ada');

    const counter = await counterOn(vfs, '/src', 'Ada');
    assert.ok(counter !== undefined && counter >= 1, 'terminates, and still finds the unread note');
  });
});

describe('unread counters: the mount list', () => {
  it('puts a counter on a mount root, which no provider owns', async () => {
    // The synthetic root is assembled by the engine from the mount table, so there is no
    // provider anywhere in the picture to ask. This row is the first thing anyone sees.
    const vfs = new Vfs({ prefetch: { enabled: false } });
    vfs.mount({
      path: '/mail',
      id: 'mail',
      provider: new TreeStub({
        '': { dirs: ['Inbox'] },
        Inbox: { unreadCount: 6 },
      }),
    });
    vfs.mount({
      path: '/teams',
      id: 'teams',
      provider: new TreeStub({
        '': { dirs: ['Chats'] },
        Chats: { files: { 'm.md': true } },
      }),
    });

    await vfs.list('/mail');
    await vfs.list('/teams');
    await vfs.list('/teams/Chats');

    const root = await vfs.list('/');
    const rows = new Map(root.entries.map((entry) => [entry.name, entry.unreadCount]));
    assert.equal(rows.get('mail'), 6);
    assert.equal(rows.get('teams'), 1);
  });
});

/**
 * The counter has to arrive on its own.
 *
 * Reported as: "I'm not at all seeing what you're seeing until I start navigating ... you
 * aren't updating counts in realtime or on cli init." Both halves of that are one bug. A
 * folder's counter is derived from what the cache can see beneath it, and at startup the
 * cache is empty, so the first listing of the root is necessarily uncounted. The numbers
 * arrive moments later as warming fills in the mounts — and nothing told anyone, so they
 * appeared only if the user happened to navigate, which is exactly when a counter has
 * stopped being useful because they have already committed to going somewhere.
 *
 * The engine already had the seam for this: `onListingChanged`, built so a stale listing
 * corrected against the source reaches the screen. It just never fired for a *parent* whose
 * derived number moved.
 */
describe('unread counters: telling the screen when the number arrives', () => {
  it('announces the parent when a listing lands underneath it', async () => {
    const { vfs } = mount({
      '': { dirs: ['Chats'] },
      Chats: { dirs: ['Alice'] },
      'Chats/Alice': { files: { 'a.md': true, 'b.md': true } },
    });

    const seen: { path: string; counters: string }[] = [];
    vfs.onListingChanged((event) => {
      seen.push({
        path: event.path,
        counters: event.entries.map((e) => `${e.name}=${String(e.unreadCount)}`).join(','),
      });
    });

    // What the user sees at startup: the root, listed before anything beneath it is known.
    assert.equal(await counterOn(vfs, '/src', 'Chats'), undefined, 'nothing to count yet');
    assert.equal(seen.length, 0, 'a listing the caller just asked for is not news');

    // Warming, arriving behind them.
    await vfs.list('/src/Chats');
    await vfs.list('/src/Chats/Alice');

    const announced = seen.filter((event) => event.path === '/src');
    assert.ok(announced.length > 0, 'the row the user is looking at was never corrected');
    assert.equal(announced.at(-1)?.counters, 'Chats=2');
  });

  it('announces the synthetic root, which is the one listing nobody can navigate above', async () => {
    // The root is computed rather than fetched, so it is the one directory with no cache
    // entry of its own to notice a change. It is also the first thing anyone sees.
    const { vfs } = mount({
      '': { dirs: ['Inbox'] },
      Inbox: { files: { 'a.md': true } },
    });

    const roots: string[] = [];
    vfs.onListingChanged((event) => {
      if (event.path === '/') roots.push(event.entries.map((e) => String(e.unreadCount)).join(','));
    });

    await vfs.list('/');
    await vfs.list('/src');
    await vfs.list('/src/Inbox');

    assert.equal(roots.at(-1), '1', 'the mount row never learned its count');
  });

  it('says nothing when the number has not moved', async () => {
    // Every announcement costs a repaint, and a list that flickers while being read is worse
    // than one that updates a moment late. A folder is re-derived once per page landing
    // anywhere beneath it, so the gate is doing most of the work here.
    const { vfs } = mount({
      '': { dirs: ['Inbox'] },
      Inbox: { unreadCount: 9, dirs: ['Old'] },
      'Inbox/Old': { unreadCount: 2 },
    });

    await vfs.list('/src');
    let announcements = 0;
    vfs.onListingChanged((event) => {
      if (event.path === '/src') announcements += 1;
    });

    // The provider already gave `Inbox` its number, so nothing underneath can change it.
    await vfs.list('/src/Inbox');
    await vfs.list('/src/Inbox/Old');
    assert.equal(announcements, 0);
  });

  it('does not announce a directory nobody has listed', async () => {
    // An announcement is a correction to something on screen. A directory the user has never
    // opened has nothing to correct, and firing for it would wake a subscriber up about a
    // listing it has never held.
    const { vfs } = mount({
      '': { dirs: ['Chats'] },
      Chats: { dirs: ['Alice'] },
      'Chats/Alice': { files: { 'a.md': true } },
    });

    const paths: string[] = [];
    vfs.onListingChanged((event) => paths.push(event.path));

    await vfs.list('/src/Chats/Alice');
    assert.equal(paths.length, 0, `nothing above has ever been shown, yet: ${paths.join(', ')}`);
  });
});

/**
 * Sources that are graphs rather than trees.
 *
 * A people directory reaches the same person from `Org`, from `Recent`, from `Colleagues`
 * and from the `Directory` they are defined in; the real Graph hierarchy is a cycle, because
 * your manager's reports contain you. Adding up what is under each route counted the demo
 * org chart's six unread messages as thirty-three — a number bearing no relation to anything
 * the user could go and read, on the one row whose whole job is to tell them where to go.
 *
 * Two defences, and they are needed at different levels. Inside a subtree the engine can see
 * the items and count each one once. Between top-level folders it cannot: each has handed
 * over an opaque total, and nothing in it says which of them overlap. Only the source knows,
 * so the source is asked.
 */
describe('unread counters: when the same item is in two places', () => {
  it('counts a person once however many folders point at them', async () => {
    const { vfs } = mount({
      '': { dirs: ['Org', 'Directory'] },
      Org: { dirs: ['Dana'] },
      // The same human being, filed under their manager as well as in the directory.
      'Org/Dana': { same: 'Directory/Dana' },
      Directory: { dirs: ['Dana'] },
      'Directory/Dana': { files: { 'a.eml': true, 'b.eml': true } },
    });

    await vfs.list('/src/Directory/Dana');
    await vfs.list('/src/Directory');
    await vfs.list('/src/Org/Dana');
    await vfs.list('/src/Org');

    assert.equal(await counterOn(vfs, '/', 'src'), 2, 'two messages, not four');
  });

  it('still reports nothing when the duplicate had nothing to report', async () => {
    // Silence has to survive de-duplication. A source with no notion of read state, seen
    // twice, is still a source with no notion of read state — not one that counted twice
    // and found nothing.
    const { vfs } = mount({
      '': { dirs: ['Org', 'Directory'] },
      Org: { dirs: ['Dana'] },
      'Org/Dana': { same: 'Directory/Dana' },
      Directory: { dirs: ['Dana'] },
      'Directory/Dana': { files: {} },
    });

    await vfs.list('/src/Directory/Dana');
    await vfs.list('/src/Directory');
    await vfs.list('/src/Org/Dana');
    await vfs.list('/src/Org');

    assert.equal(await counterOn(vfs, '/', 'src'), undefined);
  });

  it('takes the source at its word for the whole mount over its own arithmetic', async () => {
    // The case the engine cannot reason its way out of. Both sections carry a count the
    // provider gave, so both are final and neither can be looked inside; adding them is the
    // only thing left, and it is wrong precisely when the sections overlap. A provider that
    // says what its own total is settles it.
    const { vfs, provider } = mount({
      '': { dirs: ['Org', 'Directory'] },
      Org: { unreadCount: 5 },
      Directory: { unreadCount: 6 },
    });
    (provider as { unreadTotal?: () => number | undefined }).unreadTotal = () => 6;

    assert.equal(await counterOn(vfs, '/', 'src'), 6, 'not eleven');
    assert.equal(await counterOn(vfs, '/src', 'Org'), 5, 'and the breakdown is left alone');
  });

  it('falls back to its own arithmetic when the source declines to answer', async () => {
    // Every provider that has no opinion — which is all of them until one implements this —
    // has to keep the number it had before.
    const { vfs, provider } = mount({
      '': { dirs: ['Org', 'Directory'] },
      Org: { unreadCount: 5 },
      Directory: { unreadCount: 6 },
    });
    (provider as { unreadTotal?: () => number | undefined }).unreadTotal = () => undefined;

    await vfs.list('/src');
    assert.equal(await counterOn(vfs, '/', 'src'), 11);
  });

  it('ignores a total that cannot be true rather than printing it', async () => {
    // A row is a decoration. A provider that throws, or answers with nonsense, costs the row
    // its badge and must not cost the user the listing that tells them where everything is.
    const { vfs, provider } = mount({
      '': { dirs: ['Org'] },
      Org: { unreadCount: 5 },
    });
    (provider as { unreadTotal?: () => number | undefined }).unreadTotal = () => -3;
    await vfs.list('/src');
    assert.equal(await counterOn(vfs, '/', 'src'), 5, 'the derived number, not the impossible one');

    const { vfs: other, provider: thrower } = mount({
      '': { dirs: ['Org'] },
      Org: { unreadCount: 5 },
    });
    (thrower as { unreadTotal?: () => number | undefined }).unreadTotal = () => {
      throw new Error('the source fell over');
    };
    await other.list('/src');
    assert.equal(await counterOn(other, '/', 'src'), 5);
  });
});
