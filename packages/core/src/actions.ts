/**
 * Actions as command objects.
 *
 * `Provider.actions` and `Provider.invoke` are the wire format — a list of descriptors out,
 * a name and a bag of parameters in. Every provider that grew past two verbs implemented
 * that wire format the same way: a hand-written `actions()` that assembles descriptors
 * conditionally, and a `switch` in `invoke()` that has to stay in step with it. The two
 * drift, and they drift silently. An action offered but not handled falls through to
 * `default:` and reports "not supported" about a verb the user was just shown; an action
 * handled but no longer offered becomes dead code nobody can reach.
 *
 * So a command is one object: the descriptor that advertises it, the predicate that says
 * when it applies, and the function that performs it, declared together and impossible to
 * separate. {@link ActionRegistry} then derives both halves of the wire format from the
 * same table, which is what makes the drift unrepresentable rather than merely discouraged.
 *
 * WHY VALIDATION LIVES HERE
 *
 * A descriptor already states which parameters exist, which are required, what type each
 * is and — for a choice — which values are legal. Re-checking that inside every command is
 * both repetitive and, more to the point, inconsistent: one action says "needs --body",
 * the next throws a TypeError on `undefined`, and a third quietly posts an empty comment.
 * The registry enforces the declaration before `run` is ever called, so a command receives
 * parameters that are already the right type and already present, and the failure a user
 * sees for a missing argument is the same sentence everywhere.
 *
 * Unknown parameters are rejected rather than ignored, which is the same rule the command
 * table applies to surplus positionals and for the same reason: `--commnet "looks good"`
 * that silently approves with no comment is a wrong answer wearing the costume of a right
 * one, and it is unrecoverable — the review is already submitted.
 */

import { VfsError } from './errors.js';
import type { ActionDescriptor, ActionParam, ActionResult, MetaValue, VNode } from './provider.js';

/** Parameters after the registry has coerced and checked them against the descriptor. */
export type ActionParams = Readonly<Record<string, MetaValue>>;

/** Everything a command is given when it runs. */
export interface ActionInvocation<TContext> {
  readonly node: VNode;
  /** Already coerced to the declared types, defaults applied, required ones present. */
  readonly params: ActionParams;
  /** Whatever the provider needs to do the work: its API client, its options, itself. */
  readonly context: TContext;
}

/**
 * One verb, complete.
 *
 * `applies` is what makes actions contextual rather than merely typed. "Approve" is not a
 * property of pull requests in general, it is a property of *this* pull request, which is
 * open, is not already approved by you, and is not your own. Encoding that as a predicate
 * beside the descriptor means the list a user is offered is the list that will actually
 * work — the alternative is offering a verb and then explaining why it was refused, which
 * is a worse interface and, for someone driving by keyboard or by voice, a longer one.
 */
export interface ActionCommand<TContext> {
  readonly descriptor: ActionDescriptor;
  /** Whether this verb is offered for this node. Absent means "always". */
  applies?(node: VNode, context: TContext): boolean;
  run(invocation: ActionInvocation<TContext>): Promise<ActionResult>;
}

/**
 * The table a provider builds once and consults from both `actions()` and `invoke()`.
 *
 * Generic over the context so a provider hands its commands whatever they need without a
 * cast: the GitHub commands get a client and a repository, the mail commands get a Graph
 * API and the mount's options.
 */
export class ActionRegistry<TContext> {
  readonly #commands: ActionCommand<TContext>[] = [];
  readonly #byName = new Map<string, ActionCommand<TContext>>();

  constructor(commands: readonly ActionCommand<TContext>[] = []) {
    this.add(...commands);
  }

  add(...commands: readonly ActionCommand<TContext>[]): this {
    for (const command of commands) {
      const name = command.descriptor.name;
      if (this.#byName.has(name)) {
        throw new VfsError('EINTERNAL', `Duplicate action "${name}" registered.`);
      }
      this.#byName.set(name, command);
      this.#commands.push(command);
    }
    return this;
  }

  /** Every verb registered, applicable or not. */
  get names(): readonly string[] {
    return [...this.#byName.keys()];
  }

  /** What this node can do right now. Backs `Provider.actions`. */
  descriptors(node: VNode, context: TContext): readonly ActionDescriptor[] {
    return this.#applicable(node, context).map((command) => command.descriptor);
  }

  /** Run one verb. Backs `Provider.invoke`. */
  async invoke(
    name: string,
    node: VNode,
    params: Readonly<Record<string, MetaValue>>,
    context: TContext,
    providerId: string,
  ): Promise<ActionResult> {
    const command = this.#byName.get(name);
    if (command === undefined) throw VfsError.unsupported(`Action "${name}"`, providerId);

    // Registered but not applicable is a different failure from never having existed, and
    // conflating them sends the user to check their spelling of a verb they typed
    // correctly. Naming what *is* available turns the dead end into the next command.
    if (command.applies?.(node, context) === false) {
      const offered = this.#applicable(node, context).map((c) => c.descriptor.name);
      throw VfsError.invalid(
        `"${name}" does not apply to ${describeNode(node)}.`,
        offered.length === 0
          ? 'There is nothing you can do to that item.'
          : `Available here: ${offered.join(', ')}.`,
      );
    }

    return command.run({ node, params: resolveParams(command.descriptor, params), context });
  }

  #applicable(node: VNode, context: TContext): readonly ActionCommand<TContext>[] {
    return this.#commands.filter((command) => command.applies?.(node, context) !== false);
  }
}

// ---------------------------------------------------------------------------
// Parameter handling
// ---------------------------------------------------------------------------

/**
 * Check a caller's parameters against what the action declared, and coerce them.
 *
 * Exported because the shell wants to validate before it prompts — asking someone to type
 * a three-paragraph review comment and *then* telling them the action needed a different
 * flag is the sort of thing that makes people stop trusting an interface.
 */
export function resolveParams(
  descriptor: ActionDescriptor,
  raw: Readonly<Record<string, MetaValue>>,
): ActionParams {
  const declared = descriptor.params ?? [];
  const byName = new Map(declared.map((param) => [param.name, param]));

  for (const name of Object.keys(raw)) {
    if (byName.has(name)) continue;
    const near = nearest(name, [...byName.keys()]);
    throw VfsError.invalid(
      `"${descriptor.name}" has no parameter called "${name}".`,
      near === undefined
        ? declared.length === 0
          ? `"${descriptor.name}" takes no parameters.`
          : `It takes: ${declared.map((param) => param.name).join(', ')}.`
        : `Did you mean "${near}"?`,
    );
  }

  const resolved: Record<string, MetaValue> = {};
  for (const param of declared) {
    const value = raw[param.name];
    if (value === undefined || value === null || value === '') {
      if (param.required === true) {
        throw VfsError.invalid(
          `"${descriptor.name}" needs ${param.name} (${param.label}).`,
          `Pass it as --${param.name}, for example: do ${descriptor.name} <item> --${param.name} "…"`,
        );
      }
      if (param.default !== undefined) resolved[param.name] = param.default;
      continue;
    }
    resolved[param.name] = coerce(param, value, descriptor.name);
  }
  return resolved;
}

function coerce(param: ActionParam, value: MetaValue, action: string): MetaValue {
  switch (param.type) {
    case 'number': {
      const numeric = typeof value === 'number' ? value : Number(String(value).trim());
      if (!Number.isFinite(numeric)) {
        throw VfsError.invalid(`${param.name} must be a number, not "${String(value)}".`);
      }
      return numeric;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      const text = String(value).trim().toLowerCase();
      if (['true', 'yes', 'y', 'on', '1'].includes(text)) return true;
      if (['false', 'no', 'n', 'off', '0'].includes(text)) return false;
      throw VfsError.invalid(`${param.name} must be yes or no, not "${String(value)}".`);
    }
    case 'choice': {
      const choices = param.choices ?? [];
      const text = String(value).trim();
      // Matched case-insensitively but returned in the declared casing, so a command can
      // compare against its own literals without lowercasing defensively.
      const match = choices.find((choice) => choice.toLowerCase() === text.toLowerCase());
      if (match === undefined) {
        throw VfsError.invalid(
          `${param.name} must be one of ${choices.join(', ')}, not "${text}".`,
          `Run \`actions\` to see what "${action}" accepts.`,
        );
      }
      return match;
    }
    default:
      return String(value);
  }
}

/**
 * The closest declared name, when the user's is plausibly a typo of it.
 *
 * A local two-row Levenshtein rather than an import: this module is the one thing every
 * provider pulls in to declare actions, and it should not drag the mount builder with it.
 */
function nearest(value: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = editDistanceOf(value.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  // A third of the word, at least one edit: close enough to be a slip, far enough not to
  // suggest "body" for "state".
  return best !== undefined && bestDistance <= Math.max(1, Math.floor(value.length / 3)) ? best : undefined;
}

function editDistanceOf(a: string, b: string): number {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const deletion = (previous[j] as number) + 1;
      const insertion = (current[j - 1] as number) + 1;
      current.push(Math.min(substitution, deletion, insertion));
    }
    previous = current;
  }
  return previous[b.length] as number;
}

/** How to refer to a node in an error, preferring the human title. */
function describeNode(node: VNode): string {
  const label = node.title !== '' ? node.title : node.name;
  return node.subtype === undefined ? `"${label}"` : `${node.subtype} "${label}"`;
}

// ---------------------------------------------------------------------------
// Accessors for command bodies
// ---------------------------------------------------------------------------

/**
 * Read a parameter the descriptor declared required.
 *
 * The registry has already guaranteed it is present and a string, so this throws only if a
 * command asks for a parameter it never declared — a programming error, reported as one
 * rather than as a confusing message about the user's input.
 */
export function requiredText(params: ActionParams, name: string): string {
  const value = params[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new VfsError('EINTERNAL', `Action parameter "${name}" was read but never declared as required.`);
  }
  return value;
}

export function optionalText(params: ActionParams, name: string): string | undefined {
  const value = params[name];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

export function optionalFlag(params: ActionParams, name: string): boolean {
  return params[name] === true;
}

/**
 * A meta value from a node, as a string.
 *
 * Every provider that acts on a node has to dig its own identifiers back out of `meta` —
 * the owner, the repository, the number, the folder id — and the failure when one is
 * missing should name the node rather than throw `undefined is not a string` from three
 * frames down.
 */
export function metaText(node: VNode, key: string): string {
  const value = node.meta?.[key];
  if (value === undefined || value === null || value === '') {
    throw VfsError.invalid(
      `${describeNode(node)} has no "${key}", so that action cannot run on it.`,
      'Run `stat` on the item to see what the source recorded about it.',
    );
  }
  return String(value);
}

export function metaNumber(node: VNode, key: string): number {
  const value = Number(metaText(node, key));
  if (!Number.isFinite(value)) {
    throw VfsError.invalid(`${describeNode(node)} has a "${key}" that is not a number.`);
  }
  return value;
}
