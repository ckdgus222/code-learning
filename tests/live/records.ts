import { AppError } from '../../src/shared/errors';

/**
 * What a live check's results file may keep from a failure. Only app errors (fixed wording) and the
 * check's own assertions keep their message; any other error, such as a file error (ENOENT carries
 * the path) or a JSON parse error (quotes its input), keeps only its name and code.
 */
export function recordedFailure(error: unknown): { code?: string; errorName?: string; message?: string } {
  const { code, name, message } = (error ?? {}) as { code?: unknown; name?: unknown; message?: unknown };
  const kept = error instanceof AppError || name === 'AssertionError';
  return {
    code: typeof code === 'string' ? code : undefined,
    errorName: typeof name === 'string' ? name : undefined,
    message: kept && typeof message === 'string' ? message : undefined,
  };
}
