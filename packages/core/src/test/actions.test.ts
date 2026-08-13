/**
 * Tests for the action command framework.
 *
 * The framework exists to make one specific class of bug impossible, so that is what these
 * assert: that the list of verbs a user is shown and the list a provider will actually run
 * cannot disagree. Every test here is really the same question asked from a different
 * angle — if the interface offers it, does it work, and if it does not offer it, does the
 * refusal say something useful?
 *
 * The parameter tests are the other half. A mistyped flag on an action that sends mail or
 * approves a pull request is not a formatting problem; silently dropping it produces a
 * confident, wrong result that the user has no way to notice.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ActionRegistry,
  metaNumber,
  metaText,
  optionalFlag,
  optionalText,
  requiredText,
  resolveParams,
  VfsError,
} from '../index.js';
import type { ActionCommand, ActionDescriptor, VNode } from '../index.js';

interface Ctx {
  readonly open: boolean;
  readonly log: string[];
}

function node(extra: Partial<VNode> = {}): VNode {
  return { name: 'pr-14', kind: 'file', title: '#14 Cap listings', id: 'pr-14', ...extra };
}

function command(descriptor: ActionDescriptor, extra: Partial<ActionCommand<Ctx>> = {}): ActionCommand<Ctx> {
  return {
    descriptor,
    async run({ context, params }) {
      context.log.push(`${descriptor.name}:${JSON.stringify(params)}`);
      return { ok: true, message: `Ran ${descriptor.name}.` };
    },
    ...extra,
  };
}

const APPROVE: ActionDescriptor = {
  name: 'approve',
  label: 'Approve',
  group: 'review',
  params: [{ name: 'body', type: 'text', label: 'Comment', required: false }],
};

const MERGE: ActionDescriptor = { name: 'merge', label: 'Merge', destructive: true };

function registry(): ActionRegistry<Ctx> {
  return new ActionRegistry<Ctx>([
    command(APPROVE, { applies: (_node, context) => context.open }),
    command(MERGE, { applies: (_node, context) => context.open }),
    command({ name: 'url', label: 'Show the URL' }),
  ]);
}

describe('ActionRegistry', () => {
  it('offers only the verbs that apply right now', () => {
    const open = registry().descriptors(node(), { open: true, log: [] });
    const closed = registry().descriptors(node(), { open: false, log: [] });

    assert.deepEqual(
      open.map((descriptor) => descriptor.name),
      ['approve', 'merge', 'url'],
    );
    assert.deepEqual(
      closed.map((descriptor) => descriptor.name),
      ['url'],
    );
  });

  it('keeps the declared order, because that order is the menu', () => {
    const names = registry()
      .descriptors(node(), { open: true, log: [] })
      .map((descriptor) => descriptor.name);
    assert.deepEqual(names, ['approve', 'merge', 'url']);
  });

  it('runs an applicable verb and passes the resolved parameters through', async () => {
    const context: Ctx = { open: true, log: [] };
    const result = await registry().invoke('approve', node(), { body: 'Looks good' }, context, 'test');

    assert.equal(result.ok, true);
    assert.deepEqual(context.log, ['approve:{"body":"Looks good"}']);
  });

  it('reports an unknown verb as unsupported', async () => {
    await assert.rejects(
      () => registry().invoke('aprove', node(), {}, { open: true, log: [] }, 'test'),
      (error: VfsError) => error.code === 'ENOTSUP',
    );
  });

  // The distinction this pins down is the entire reason the registry exists: "that verb
  // does not exist" and "that verb does not apply here" send the user to two different
  // places, and only one of them is where the problem is.
  it('distinguishes a verb that does not apply from one that does not exist', async () => {
    await assert.rejects(
      () => registry().invoke('merge', node(), {}, { open: false, log: [] }, 'test'),
      (error: VfsError) => {
        assert.equal(error.code, 'EINVAL');
        assert.match(error.message, /does not apply/);
        // And it says what would have worked, so the dead end has an exit.
        assert.match(error.hint ?? '', /url/);
        return true;
      },
    );
  });

  it('refuses to register the same verb twice', () => {
    assert.throws(
      () => new ActionRegistry<Ctx>([command(MERGE), command(MERGE)]),
      (error: VfsError) => error.code === 'EINTERNAL',
    );
  });

  it('never runs a command whose parameters did not resolve', async () => {
    const context: Ctx = { open: true, log: [] };
    await assert.rejects(() => registry().invoke('approve', node(), { comment: 'oops' }, context, 'test'));
    assert.deepEqual(context.log, [], 'the command body must not have run');
  });
});

describe('resolveParams', () => {
  const descriptor: ActionDescriptor = {
    name: 'close',
    label: 'Close',
    params: [
      { name: 'reason', type: 'choice', label: 'Reason', choices: ['completed', 'not-planned'], default: 'completed' },
      { name: 'notify', type: 'boolean', label: 'Notify watchers' },
      { name: 'weight', type: 'number', label: 'Weight' },
      { name: 'body', type: 'text', label: 'Comment', required: true },
    ],
  };

  it('applies defaults for parameters the caller omitted', () => {
    assert.deepEqual(resolveParams(descriptor, { body: 'done' }), { reason: 'completed', body: 'done' });
  });

  it('treats an empty string as absent, so a default is not overwritten with a blank', () => {
    assert.deepEqual(resolveParams(descriptor, { body: 'done', reason: '' }), { reason: 'completed', body: 'done' });
  });

  it('requires what the descriptor says is required', () => {
    assert.throws(
      () => resolveParams(descriptor, {}),
      (error: VfsError) => error.code === 'EINVAL' && /needs body/.test(error.message),
    );
  });

  // Silently ignoring an unknown flag is the failure mode that matters: `--commnet "wait,
  // no"` on an approval would approve with no comment at all, and look like it worked.
  it('rejects an undeclared parameter and suggests the one that was meant', () => {
    assert.throws(
      () => resolveParams(descriptor, { body: 'x', resaon: 'completed' }),
      (error: VfsError) => {
        assert.match(error.message, /no parameter called "resaon"/);
        assert.match(error.hint ?? '', /Did you mean "reason"\?/);
        return true;
      },
    );
  });

  it('lists the real parameters when the mistake is not a near miss', () => {
    assert.throws(
      () => resolveParams(descriptor, { body: 'x', zzzzzzzz: '1' }),
      (error: VfsError) => /It takes: reason, notify, weight, body\./.test(error.hint ?? ''),
    );
  });

  it('says an action takes no parameters rather than listing nothing', () => {
    assert.throws(
      () => resolveParams({ name: 'url', label: 'URL' }, { body: 'x' }),
      (error: VfsError) => /"url" takes no parameters\./.test(error.hint ?? ''),
    );
  });

  it('coerces numbers and refuses ones that are not', () => {
    assert.equal(resolveParams(descriptor, { body: 'x', weight: '3' })['weight'], 3);
    assert.throws(() => resolveParams(descriptor, { body: 'x', weight: 'heavy' }));
    assert.throws(() => resolveParams(descriptor, { body: 'x', weight: 'Infinity' }));
  });

  it('accepts the words people actually type for a boolean', () => {
    for (const yes of ['yes', 'Y', 'true', 'on', '1']) {
      assert.equal(resolveParams(descriptor, { body: 'x', notify: yes })['notify'], true, yes);
    }
    for (const no of ['no', 'N', 'false', 'off', '0']) {
      assert.equal(resolveParams(descriptor, { body: 'x', notify: no })['notify'], false, no);
    }
    assert.throws(() => resolveParams(descriptor, { body: 'x', notify: 'maybe' }));
  });

  it('matches a choice case-insensitively but returns the declared casing', () => {
    assert.equal(resolveParams(descriptor, { body: 'x', reason: 'NOT-PLANNED' })['reason'], 'not-planned');
    assert.throws(
      () => resolveParams(descriptor, { body: 'x', reason: 'abandoned' }),
      (error: VfsError) => /must be one of completed, not-planned/.test(error.message),
    );
  });
});

describe('parameter accessors', () => {
  it('reads what the descriptor guaranteed', () => {
    assert.equal(requiredText({ body: 'hello' }, 'body'), 'hello');
    assert.equal(optionalText({ body: '  ' }, 'body'), undefined);
    assert.equal(optionalText({}, 'body'), undefined);
    assert.equal(optionalFlag({ notify: true }, 'notify'), true);
    assert.equal(optionalFlag({ notify: 'yes' }, 'notify'), false, 'only a real boolean counts');
  });

  // A command that reads a parameter it forgot to declare is a bug in the provider, and it
  // has to fail as one — not as a message telling the user their input was wrong.
  it('blames the provider when a required parameter was never declared', () => {
    assert.throws(
      () => requiredText({}, 'body'),
      (error: VfsError) => error.code === 'EINTERNAL',
    );
  });

  it('reads node metadata with the types commands expect', () => {
    const target = node({ meta: { number: 14, state: 'open' } });
    assert.equal(metaText(target, 'state'), 'open');
    assert.equal(metaNumber(target, 'number'), 14);
  });

  // The alternative is `undefined is not a string` from three frames inside a command,
  // which tells the user nothing about which item could not be acted on or why.
  it('names the node when the metadata an action depends on is missing', () => {
    const target = node({ subtype: 'pull', meta: { number: 14 } });
    assert.throws(
      () => metaText(target, 'owner'),
      (error: VfsError) => {
        assert.equal(error.code, 'EINVAL');
        assert.match(error.message, /pull "#14 Cap listings" has no "owner"/);
        return true;
      },
    );
    assert.throws(() => metaNumber(target, 'title'));
  });
});
