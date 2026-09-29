import { type AppError } from '@assistant/schemas';
import { err, errAsync, ok, okAsync, type Result, ResultAsync } from 'neverthrow';
import { type z } from 'zod';

export type AppResult<T> = Result<T, AppError>;
export type AppResultAsync<T> = ResultAsync<T, AppError>;

export function appError(
  code: string,
  message: string,
  opts: { retryable?: boolean; cause?: unknown } = {},
): AppError {
  return {
    code,
    message,
    retryable: opts.retryable ?? false,
    ...(opts.cause === undefined ? {} : { cause: stringifyCause(opts.cause) }),
  };
}

function stringifyCause(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  if (typeof cause === 'string') return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

/**
 * Parses with Zod and returns a Result rather than throwing.
 *
 * Every boundary in this app — model output, HTTP response, IPC message —
 * goes through here, so a shape mismatch becomes a value the caller must
 * handle rather than an exception that unwinds an audio pipeline.
 */
export function parseWith<S extends z.ZodType>(
  schema: S,
  value: unknown,
  code = 'validation_failed',
): AppResult<z.output<S>> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return ok(parsed.data);

  const detail = parsed.error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  return err(appError(code, detail, { retryable: false }));
}

/** Wraps a promise, converting rejection into a typed AppError. */
export function fromPromise<T>(
  promise: Promise<T>,
  code: string,
  opts: { retryable?: boolean } = {},
): AppResultAsync<T> {
  return ResultAsync.fromPromise(promise, (cause) =>
    appError(code, cause instanceof Error ? cause.message : 'Unknown error', {
      ...(opts.retryable === undefined ? {} : { retryable: opts.retryable }),
      cause,
    }),
  );
}

export { err, errAsync, ok, okAsync, ResultAsync };
export type { Result };
