/**
 * Virtual path handling.
 *
 * VFS paths are ALWAYS POSIX-style, `/`-separated, regardless of host OS. This is
 * deliberate: on Windows a backslash is a legal character inside an email subject or
 * a Teams channel name, so treating it as a separator would corrupt names. Host paths
 * (token caches, exported files) are handled separately with `node:path`.
 *
 * The VFS is a chroot: `..` can never escape the root.
 */

export const SEP = '/';
export const ROOT = '/';

/** Split a path into its non-empty segments. `/a/b/` -> ['a','b'] */
export function segments(path: string): string[] {
  return path.split(SEP).filter((s) => s.length > 0);
}

/**
 * Normalize a path: collapse repeated separators, resolve `.` and `..`, and drop any
 * trailing separator. `..` at the root is a no-op (clamped) rather than an error, which
 * matches how shells behave at `/` and prevents escaping the VFS.
 */
export function normalize(path: string): string {
  const absolute = isAbsolute(path);
  const out: string[] = [];

  for (const segment of segments(path)) {
    if (segment === '.') continue;
    if (segment === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') {
        out.pop();
      } else if (!absolute) {
        out.push('..');
      }
      // Absolute path at root: clamp.
      continue;
    }
    out.push(segment);
  }

  const joined = out.join(SEP);
  if (absolute) return SEP + joined;
  return joined.length > 0 ? joined : '.';
}

export function isAbsolute(path: string): boolean {
  return path.startsWith(SEP);
}

/** Join segments into a normalized absolute-or-relative path. */
export function join(...parts: Array<string | undefined>): string {
  const usable = parts.filter((p): p is string => typeof p === 'string' && p.length > 0);
  if (usable.length === 0) return '.';
  const absolute = isAbsolute(usable[0] as string);
  const joined = usable.join(SEP);
  return normalize(absolute && !isAbsolute(joined) ? SEP + joined : joined);
}

/**
 * Resolve `input` against `cwd`. An absolute `input` wins. A `~` prefix means root,
 * mirroring shell home-directory semantics (the VFS root is "home").
 */
export function resolve(cwd: string, input: string): string {
  if (input.length === 0) return normalize(cwd);
  if (input === '~' || input.startsWith('~/')) {
    return normalize(ROOT + input.slice(1));
  }
  if (isAbsolute(input)) return normalize(input);
  return normalize(join(normalize(cwd), input));
}

export function dirname(path: string): string {
  const normalized = normalize(path);
  if (normalized === ROOT) return ROOT;
  const segs = segments(normalized);
  segs.pop();
  return isAbsolute(normalized) ? SEP + segs.join(SEP) : segs.join(SEP) || '.';
}

export function basename(path: string): string {
  const segs = segments(normalize(path));
  return segs.length > 0 ? (segs[segs.length - 1] as string) : '';
}

export function isRoot(path: string): boolean {
  return normalize(path) === ROOT;
}

/**
 * True when `child` is `parent` or lives beneath it. Segment-aware, so `/mail` is not
 * treated as a parent of `/mailbox`.
 */
export function contains(parent: string, child: string): boolean {
  const p = segments(normalize(parent));
  const c = segments(normalize(child));
  if (p.length > c.length) return false;
  return p.every((seg, i) => seg === c[i]);
}

/** The path of `child` relative to `parent`, or undefined when not contained. */
export function relative(parent: string, child: string): string | undefined {
  if (!contains(parent, child)) return undefined;
  const p = segments(normalize(parent));
  const c = segments(normalize(child));
  return c.slice(p.length).join(SEP);
}

/** Depth from root. `/` is 0, `/mail` is 1. */
export function depth(path: string): number {
  return segments(normalize(path)).length;
}
