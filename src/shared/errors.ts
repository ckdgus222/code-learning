import type { AppErrorCode, Result } from './contracts';

export class AppError extends Error {
  constructor(public code: AppErrorCode, message: string) { super(message); }
}

export function failure(error: unknown): Result<never> {
  if (error instanceof AppError) return { ok: false, code: error.code, message: error.message };
  // Never return filesystem paths, source contents or arbitrary native error text to the UI.
  return { ok: false, code: 'INTERNAL', message: '작업을 완료하지 못했습니다. 폴더 권한을 확인하고 다시 열어 주세요.' };
}
