import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, readFile, rm } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { type ChildProcess, type execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { killWindowsTree, localProcessEnv, runProcess } from '../src/core/ai/process';

let root: string;
beforeEach(async () => { root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-ai-process-'))); });
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function run(source: string, options: Partial<Parameters<typeof runProcess>[0]> = {}) {
  return runProcess({ executable: process.execPath, args: ['-e', source], cwd: root,
    signal: new AbortController().signal, timeoutMs: 3000, ...options });
}

async function readPid(file: string): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const text = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    const pid = Number(text);
    if (Number.isSafeInteger(pid) && pid > 0) return pid;
    await delay(10);
  }
  throw new Error('CLI did not write its PID');
}

async function stopProcess(pid: number): Promise<void> {
  if (!pid) return;
  try { process.kill(pid, 'SIGKILL'); } catch { return; }
  if (process.platform !== 'win32') return;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await delay(10);
  }
  throw new Error(`Process ${pid} did not exit within 5 seconds`);
}

describe('Windows process tree termination', () => {
  let child: EventEmitter & Pick<ChildProcess, 'once' | 'removeListener'> & {
    pid: number | undefined;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: ReturnType<typeof vi.fn<ChildProcess['kill']>>;
  };
  let runTaskkill: ReturnType<typeof vi.fn<typeof execFile>> & typeof execFile;

  beforeEach(() => {
    vi.useFakeTimers();
    child = Object.assign(new EventEmitter(), {
      pid: 123, exitCode: null, signalCode: null, kill: vi.fn<ChildProcess['kill']>(() => true),
    }) as unknown as typeof child;
    runTaskkill = vi.fn<typeof execFile>() as typeof runTaskkill;
  });

  it.each([
    { pid: undefined, exitCode: null, signalCode: null },
    { pid: 123, exitCode: 0, signalCode: null },
    { pid: 123, exitCode: null, signalCode: 'SIGTERM' as const },
  ])('does not taskkill a missing or exited parent: %j', async state => {
    Object.assign(child, state);
    await killWindowsTree(child, runTaskkill);
    expect(runTaskkill).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['', 'D:\\Windows folder'])('uses the absolute taskkill path and waits for exit on success: %s', async systemRoot => {
    const finished = vi.fn();
    const promise = killWindowsTree(child, runTaskkill, systemRoot).then(finished);
    expect(runTaskkill).toHaveBeenCalledExactlyOnceWith(
      `${systemRoot || 'C:\\Windows'}\\System32\\taskkill.exe`, ['/PID', '123', '/T', '/F'],
      { windowsHide: true, timeout: 2000 }, expect.any(Function),
    );
    runTaskkill.mock.calls[0][3]!(null, '', '');
    await vi.advanceTimersByTimeAsync(0);
    expect(child.kill).not.toHaveBeenCalled();
    expect(finished).not.toHaveBeenCalled();
    child.exitCode = 0;
    child.emit('exit', 0, null);
    await promise;
    expect(finished).toHaveBeenCalledOnce();
    expect(child.listenerCount('exit')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    Object.assign(new Error('missing taskkill'), { cmd: 'taskkill.exe', code: 'ENOENT' }),
    Object.assign(new Error('nonzero exit'), { cmd: 'taskkill.exe', code: 7 }),
    Object.assign(new Error('taskkill timeout'), { cmd: 'taskkill.exe', killed: true, signal: 'SIGTERM' as const }),
  ])('kills a live parent after taskkill fails and waits for exit: %s', async error => {
    const finished = vi.fn();
    const promise = killWindowsTree(child, runTaskkill).then(finished);
    runTaskkill.mock.calls[0][3]!(error, '', '');
    await vi.advanceTimersByTimeAsync(0);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith();
    expect(finished).not.toHaveBeenCalled();
    child.signalCode = 'SIGTERM';
    child.emit('exit', null, 'SIGTERM');
    await promise;
    expect(finished).toHaveBeenCalledOnce();
    expect(child.listenerCount('exit')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['exitCode', 'signalCode'] as const)('does not fall back to kill if the parent exits during taskkill: %s', async exitState => {
    const promise = killWindowsTree(child, runTaskkill);
    if (exitState === 'exitCode') child.exitCode = 0;
    if (exitState === 'signalCode') child.signalCode = 'SIGTERM';
    runTaskkill.mock.calls[0][3]!(Object.assign(new Error('parent already exited'), { cmd: 'taskkill.exe' }), '', '');
    await promise;
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.listenerCount('exit')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([null, Object.assign(new Error('taskkill failed'), { cmd: 'taskkill.exe' })])('stops waiting after 2 seconds if exit never arrives: %s', async error => {
    const finished = vi.fn();
    const promise = killWindowsTree(child, runTaskkill).then(finished);
    runTaskkill.mock.calls[0][3]!(error, '', '');
    await vi.advanceTimersByTimeAsync(1999);
    expect(finished).not.toHaveBeenCalled();
    expect(child.listenerCount('exit')).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(finished).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledTimes(error ? 1 : 0);
    expect(child.listenerCount('exit')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('local AI process boundary', () => {
  it('passes shell syntax literally and closes stdin after the request', async () => {
    const literal = '$(touch injected) ; echo unsafe && `pwd`';
    const result = await run('', {
      args: ['-e', 'let input="";process.stdin.on("data",d=>input+=d);process.stdin.on("end",()=>console.log(JSON.stringify([process.argv[1],input])))', literal],
      stdin: '안녕\nsecond line',
    });
    expect(JSON.parse(result.stdout)).toEqual([literal, '안녕\nsecond line']);
    expect(result.exitCode).toBe(0);
    await expect(readFile(path.join(root, 'injected'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns nonzero status and separate stdout and stderr for caller parsing', async () => {
    expect(await run('process.stdout.write("out");process.stderr.write("err");process.exitCode=7')).toEqual({ stdout: 'out', stderr: 'err', exitCode: 7 });
  });

  it('limits stdout and stderr by their combined byte count', async () => {
    await expect(run('process.stdout.write("a".repeat(600));process.stderr.write("b".repeat(600))', { maxOutputBytes: 1000 })).rejects.toMatchObject({ code: 'LIMIT' });
    expect((await run('process.stdout.write("한글")', { maxOutputBytes: 6 })).stdout).toBe('한글');
    await expect(run('process.stdout.write("한글")', { maxOutputBytes: 5 })).rejects.toMatchObject({ code: 'LIMIT' });
  });

  it('does not expose native paths or errors when executable or cwd is missing', async () => {
    for (const options of [{ executable: path.join(root, 'missing-secret') }, { cwd: path.join(root, 'missing-secret') }, { executable: 'node' }]) {
      await expect(run('', options)).rejects.toMatchObject({ code: 'AI_UNAVAILABLE', message: 'AI 프로그램을 실행하지 못했습니다. 설치와 연결 상태를 확인해 주세요.' });
    }
  });

  it('does not start an already aborted request', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(run('require("node:fs").writeFileSync("started", "yes")', { signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(readFile(path.join(root, 'started'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cancels in-flight work and kills descendants that keep pipes open and ignore TERM', async () => {
    const controller = new AbortController();
    const pidFile = path.join(root, 'child.pid');
    const childSource = 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000);';
    const promise = run(`const {spawn}=require('node:child_process'); const fs=require('node:fs');
      const child=spawn(process.execPath,['-e',${JSON.stringify(childSource)}],{stdio:['ignore',1,2]});
      fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},1000);`, { signal: controller.signal });
    let childPid = 0;
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        try { childPid = Number(await readFile(pidFile, 'utf8')); break; } catch { await delay(10); }
      }
      expect(childPid).toBeGreaterThan(0);
      await delay(80);
      controller.abort();
      await expect(promise).rejects.toMatchObject({ code: 'CANCELLED' });
      let alive = true;
      for (let attempt = 0; attempt < 100; attempt++) {
        try { process.kill(childPid, 0); await delay(10); } catch { alive = false; break; }
      }
      expect(alive).toBe(false);
    } finally {
      controller.abort();
      await stopProcess(childPid);
    }
  });

  it('times out even when the parent exited and a descendant holds stdout open', async () => {
    const pidFile = path.join(root, 'child.pid');
    try {
      await expect(run(`const child=require('node:child_process').spawn(process.execPath,
        ['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],
        {detached:process.platform==='win32',stdio:['ignore',1,2]});
        require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(child.pid));process.exit(0);`,
      { timeoutMs: 200 })).rejects.toMatchObject({ code: 'LIMIT' });
    } finally {
      const childPid = Number(await readFile(pidFile, 'utf8').catch(() => '0'));
      await stopProcess(childPid);
    }
  });

  it.skipIf(process.platform !== 'win32')('cancels the whole Windows tree including a detached child before returning', async () => {
    const controller = new AbortController();
    const parentFile = path.join(root, 'parent.pid');
    const childFile = path.join(root, 'child.pid');
    const promise = run(`const child=require('node:child_process').spawn(process.execPath,
      ['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore',1,2]});
      const fs=require('node:fs');
      fs.writeFileSync(${JSON.stringify(parentFile)},String(process.pid));
      fs.writeFileSync(${JSON.stringify(childFile)},String(child.pid));setInterval(()=>{},1000);`,
    { signal: controller.signal, timeoutMs: 10_000 });
    const result = expect(promise).rejects.toMatchObject({ code: 'CANCELLED' });
    try {
      const parentPid = await readPid(parentFile);
      const childPid = await readPid(childFile);
      controller.abort();
      await result;
      expect(() => process.kill(parentPid, 0)).toThrow();
      expect(() => process.kill(childPid, 0)).toThrow();
    } finally {
      controller.abort();
      await promise.catch(() => {});
      for (const file of [childFile, parentFile]) {
        const pid = Number(await readFile(file, 'utf8').catch(() => '0'));
        await stopProcess(pid);
      }
    }
  }, 10_000);

  it.skipIf(process.platform !== 'win32')('waits for the Windows parent to exit when taskkill cannot start', async () => {
    const controller = new AbortController();
    const pidFile = path.join(root, 'parent.pid');
    const promise = run(`require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`,
      { signal: controller.signal, timeoutMs: 10_000 });
    const result = expect(promise).rejects.toMatchObject({ code: 'CANCELLED' });
    try {
      const parentPid = await readPid(pidFile);
      vi.stubEnv('SystemRoot', path.join(root, 'missing Windows'));
      const started = Date.now();
      controller.abort();
      await result;
      expect(() => process.kill(parentPid, 0)).toThrow();
      expect(Date.now() - started).toBeLessThan(6000);
    } finally {
      controller.abort();
      await promise.catch(() => {});
      const pid = Number(await readFile(pidFile, 'utf8').catch(() => '0'));
      await stopProcess(pid);
    }
  }, 10_000);

  it('handles a CLI that exits before reading a large stdin without unhandled EPIPE', async () => {
    expect((await run('process.exit(0)', { stdin: 'x'.repeat(4 * 1024 * 1024) })).exitCode).toBe(0);
  });

  it('inherits only the allowed environment keys', () => {
    expect(Object.keys(localProcessEnv()).every(key => ['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'USER', 'LOGNAME', 'SYSTEMROOT'].includes(key))).toBe(true);
    expect(localProcessEnv()).not.toHaveProperty('NODE_OPTIONS');
    expect(localProcessEnv()).not.toHaveProperty('OPENAI_API_KEY');
  });
});
