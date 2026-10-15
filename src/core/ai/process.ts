import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { AppError } from '../../shared/errors';

export interface ProcessRequest {
  executable: string;
  args: string[];
  cwd: string;
  stdin?: string;
  signal: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
}

// Do not inherit API keys, NODE_OPTIONS, provider configuration or shell startup hooks.
export function localProcessEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'USER', 'LOGNAME', 'SYSTEMROOT']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

const unavailable = () => new AppError('AI_UNAVAILABLE', 'AI 프로그램을 실행하지 못했습니다. 설치와 연결 상태를 확인해 주세요.');
const cancelled = () => new AppError('CANCELLED', '작업을 취소했습니다.');

export async function runProcess(request: ProcessRequest): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (request.signal.aborted) throw cancelled();
  const timeoutMs = request.timeoutMs ?? 120_000;
  const maxOutputBytes = request.maxOutputBytes ?? 512 * 1024;
  if (!path.isAbsolute(request.executable)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647
    || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) throw unavailable();

  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(request.executable, request.args, {
        cwd: request.cwd, env: request.env ?? localProcessEnv(),
        shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      reject(unavailable());
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    let failure: AppError | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => stop(new AppError('LIMIT', 'AI 응답 대기 시간이 초과되었습니다. 다시 시도해 주세요.')), timeoutMs);

    function cleanup() {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      request.signal.removeEventListener('abort', onAbort);
      child.stdout.removeListener('data', onStdout);
      child.stderr.removeListener('data', onStderr);
      child.removeListener('close', onClose);
      // Destroy pipes ourselves: a descendant can keep them open after the parent exits.
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
    function finish(error?: AppError, exitCode?: number) {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exitCode: exitCode! });
    }
    function kill(signal: NodeJS.Signals) {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch { /* Already exited, or spawn failed. Never expose native error text. */ }
    }
    function stop(error: AppError) {
      if (settled || failure) return;
      failure = error;
      clearTimeout(timeout);
      if (!child.pid) { finish(error); return; }
      kill('SIGTERM');
      // Keep this deadline even if close arrives: descendants may ignore SIGTERM.
      killTimer = setTimeout(() => {
        kill('SIGKILL');
        finish(error);
      }, 200);
    }
    function collect(chunk: Buffer, target: Buffer[]) {
      if (settled || failure) return;
      bytes += chunk.length;
      if (bytes > maxOutputBytes) {
        stop(new AppError('LIMIT', 'AI 응답 크기가 제한을 초과했습니다. 질문 범위를 줄여 주세요.'));
        return;
      }
      target.push(chunk);
    }
    function onStdout(chunk: Buffer) { collect(chunk, stdout); }
    function onStderr(chunk: Buffer) { collect(chunk, stderr); }
    function onAbort() { stop(cancelled()); }
    function onClose(code: number | null) {
      if (!failure) finish(code === null ? unavailable() : undefined, code ?? undefined);
    }
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.on('close', onClose);
    child.on('error', () => stop(unavailable()));
    // Some CLIs exit without consuming stdin. EPIPE must never escape as an unhandled error.
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') stop(unavailable());
    });
    child.stdout.on('error', () => stop(unavailable()));
    child.stderr.on('error', () => stop(unavailable()));
    request.signal.addEventListener('abort', onAbort, { once: true });
    if (request.signal.aborted) onAbort();
    if (!failure) child.stdin.end(request.stdin ?? '');
  });
}
