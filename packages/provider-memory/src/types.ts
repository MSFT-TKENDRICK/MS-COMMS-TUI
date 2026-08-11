/**
 * Fixture item model.
 *
 * A fixture is a plain tree. It is deliberately serializable so that a user can drop a
 * JSON file into their config and get a working mount without writing any code — which
 * makes this both the test double and the "try before you authenticate" demo mode.
 */

import type { BodyFormat, MetaValue } from '@mscomms/core';

export interface MemoryItem {
  readonly id: string;
  readonly title: string;
  /**
   * Semantic label only. Whether an item is a directory is derived from whether it has a
   * `children` array — one rule, no way for a fixture to declare itself a directory and
   * then have nothing to list, which is a genuinely confusing state to debug.
   */
  readonly subtype?: string;
  /**
   * Age in minutes at the time the provider is created. Relative rather than absolute so
   * a checked-in fixture never drifts into looking like stale 2024 mail, while a pinned
   * clock in tests still makes every timestamp exactly reproducible.
   */
  readonly agoMinutes?: number;
  readonly author?: string;
  readonly authorId?: string;
  readonly flags?: readonly string[];
  readonly summary?: string;
  readonly body?: string;
  readonly format?: BodyFormat;
  readonly meta?: Readonly<Record<string, MetaValue>>;
  readonly webUrl?: string;
  readonly threadId?: string;
  readonly attachments?: readonly MemoryAttachment[];
  readonly children?: readonly MemoryItem[];
}

export interface MemoryAttachment {
  readonly id: string;
  readonly name: string;
  readonly contentType?: string;
  readonly text: string;
}

export interface MemoryProviderOptions {
  /** Built-in fixture to use when `items` is not supplied. */
  readonly fixture?: 'mail' | 'chat' | 'issues' | 'empty';
  readonly items?: readonly MemoryItem[];
  readonly displayName?: string;
  /** Simulated per-request latency, for exercising cancellation and spinners. */
  readonly latencyMs?: number;
  readonly pageSize?: number;
  /**
   * Declare and implement server-side search. Turning this off exercises the engine's
   * client-side walk fallback instead, which is the path most real providers take.
   */
  readonly nativeSearch?: boolean;
  /** Fail every Nth request, to exercise error handling and stale-cache serving. */
  readonly failEvery?: number;
  /** Fabricate one new message per poll, so notifications are demoable offline. */
  readonly synthesizeChanges?: boolean;
  /** Injected clock. Pin it in tests. */
  readonly now?: () => number;
}
