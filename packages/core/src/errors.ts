/**
 * Error taxonomy.
 *
 * Codes deliberately mirror POSIX errno values where an equivalent exists. The whole
 * premise of the tool is that shell muscle memory transfers, and that has to include
 * failure modes: `cd` into a message should say "Not a directory", not "TypeError:
 * entries is undefined".
 *
 * Every error carries a `hint` — a plain-language next step. Blind users navigating by
 * audio cannot scan a wall of stack trace for the actionable line, so the actionable
 * line is a structured field that the shell prints on its own row.
 */

export type VfsErrorCode =
  | 'ENOENT'     // no such file or directory
  | 'ENOTDIR'    // tried to list something that is not a directory
  | 'EISDIR'     // tried to read a directory as a file
  | 'EACCES'     // permission denied by the backend
  | 'EAUTH'      // not signed in, or the token expired
  | 'ENOTSUP'    // provider does not implement this capability
  | 'ENETWORK'   // transport failure
  | 'ERATELIMIT' // backend asked us to slow down
  | 'ETIMEDOUT'
  | 'ECANCELED'
  | 'EINVAL'     // bad user input (malformed query, bad flag)
  | 'ECONFIG'    // configuration is wrong
  | 'EINTERNAL';

export class VfsError extends Error {
  readonly code: VfsErrorCode;
  readonly path: string | undefined;
  readonly hint: string | undefined;
  /** Seconds to wait before retrying; set for ERATELIMIT. */
  readonly retryAfter: number | undefined;

  constructor(
    code: VfsErrorCode,
    message: string,
    options: { path?: string; hint?: string; cause?: unknown; retryAfter?: number } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'VfsError';
    this.code = code;
    this.path = options.path;
    this.hint = options.hint;
    this.retryAfter = options.retryAfter;
  }

  static notFound(path: string, hint?: string): VfsError {
    return new VfsError('ENOENT', `No such file or directory: ${path}`, {
      path,
      ...(hint === undefined ? {} : { hint }),
    });
  }

  static notDirectory(path: string): VfsError {
    return new VfsError('ENOTDIR', `Not a directory: ${path}`, {
      path,
      hint: 'Use `cat` to read it, or `stat` to inspect it.',
    });
  }

  static isDirectory(path: string): VfsError {
    return new VfsError('EISDIR', `Is a directory: ${path}`, {
      path,
      hint: 'Use `ls` to list it, or `cd` to enter it.',
    });
  }

  static unsupported(what: string, providerId: string): VfsError {
    return new VfsError('ENOTSUP', `${what} is not supported by provider "${providerId}".`, {
      hint: 'Run `mounts` to see which capabilities each mount advertises.',
    });
  }

  static invalid(message: string, hint?: string): VfsError {
    return new VfsError('EINVAL', message, { ...(hint === undefined ? {} : { hint }) });
  }

  static config(message: string, hint?: string): VfsError {
    return new VfsError('ECONFIG', message, { ...(hint === undefined ? {} : { hint }) });
  }
}

export function isVfsError(value: unknown): value is VfsError {
  return value instanceof VfsError;
}

/** Best-effort conversion of an unknown thrown value into a VfsError. */
export function toVfsError(value: unknown, path?: string): VfsError {
  if (isVfsError(value)) return value;

  if (value instanceof Error) {
    // Node surfaces offline/DNS/connection-refused as these codes on the cause chain.
    const code = (value as NodeJS.ErrnoException).code;
    if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EAI_AGAIN') {
      return new VfsError('ENETWORK', `Network error: ${value.message}`, {
        ...(path === undefined ? {} : { path }),
        cause: value,
        hint: 'Check your connection, then retry. Cached entries remain browsable offline.',
      });
    }
    if (value.name === 'AbortError') {
      return new VfsError('ECANCELED', 'Operation canceled.', {
        ...(path === undefined ? {} : { path }),
        cause: value,
      });
    }
    if (value.name === 'TimeoutError') {
      return new VfsError('ETIMEDOUT', `Timed out: ${value.message}`, {
        ...(path === undefined ? {} : { path }),
        cause: value,
      });
    }
    return new VfsError('EINTERNAL', value.message, {
      ...(path === undefined ? {} : { path }),
      cause: value,
    });
  }

  return new VfsError('EINTERNAL', String(value), { ...(path === undefined ? {} : { path }) });
}
