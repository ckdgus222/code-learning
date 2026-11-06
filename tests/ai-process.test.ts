import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyFile, mkdir, mkdtemp, realpath, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { localProcessEnv, runProcess } from '../src/core/ai/process';

let root: string;
beforeEach(async () => { root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-ai-process-'))); });
afterEach(async () => {
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

async function fakeTaskkill(behavior: string): Promise<string> {
  const windowsRoot = path.join(root, 'fake Windows');
  await mkdir(path.join(windowsRoot, 'System32'), { recursive: true });
  await copyFile(process.execPath, path.join(windowsRoot, 'System32', 'taskkill.exe'));
  const marker = path.join(root, 'taskkill-called');
  // No spaces and no quotes: NODE_OPTIONS splits on spaces and treats backslashes inside quotes as escapes.
  const script = path.join(root, 'taskkill-behavior.cjs');
  await writeFile(script, `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'called\\n');\n${behavior}\n`);
  vi.stubEnv('SystemRoot', windowsRoot);
  vi.stubEnv('NODE_OPTIONS', `--require=${script}`);
  return marker;
}

/** Why the fake taskkill wrote no mark: its exit status and error output when started directly. */
function fakeTaskkillReport(): string {
  const fake = path.win32.resolve(process.env.SystemRoot ?? '', 'System32', 'taskkill.exe');
  const result = spawnSync(fake, ['/PID', '0'], { env: process.env, timeout: 3000, encoding: 'utf8', windowsHide: true });
  return JSON.stringify({ fake, status: result.status, error: result.error?.message, stderr: result.stderr?.slice(0, 1000) });
}

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
      if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch { /* already stopped */ } }
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
      if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch { /* already stopped */ } }
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
        if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* already stopped */ } }
      }
    }
  }, 10_000);

  it.skipIf(process.platform !== 'win32').each(['missing', 'nonzero', 'hanging'] as const)(
    'waits for the Windows parent to exit when taskkill is %s', async failure => {
      const controller = new AbortController();
      const pidFile = path.join(root, 'parent.pid');
      const promise = run(`require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`,
        { signal: controller.signal, timeoutMs: 10_000 });
      const result = expect(promise).rejects.toMatchObject({ code: 'CANCELLED' });
      try {
        const parentPid = await readPid(pidFile);
        let marker: string | undefined;
        if (failure === 'missing') vi.stubEnv('SystemRoot', path.join(root, 'missing Windows'));
        if (failure !== 'missing') marker = await fakeTaskkill(failure === 'nonzero'
          ? 'process.exit(7);'
          : 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);');
        const started = Date.now();
        controller.abort();
        await result;
        const elapsed = Date.now() - started;
        expect(() => process.kill(parentPid, 0)).toThrow();
        expect(elapsed).toBeLessThan(6000);
        if (failure === 'hanging') expect(elapsed).toBeGreaterThanOrEqual(1900);
        if (marker) {
          const called = await readFile(marker, 'utf8').catch(() => null);
          expect(called, called === null ? fakeTaskkillReport() : undefined).toBe('called\n');
        }
      } finally {
        controller.abort();
        await promise.catch(() => {});
        const pid = Number(await readFile(pidFile, 'utf8').catch(() => '0'));
        if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* already stopped */ } }
      }
    }, 10_000,
  );

  it.skipIf(process.platform !== 'win32')('does not taskkill an exited Windows parent whose detached child holds stdout', async () => {
    // The CLI itself keeps the real SystemRoot: Windows programs need it to start; only the app's taskkill sees the fake.
    const env = { ...localProcessEnv(), SYSTEMROOT: process.env.SystemRoot };
    const marker = await fakeTaskkill('process.exit(7);');
    const parentFile = path.join(root, 'parent.pid');
    const childFile = path.join(root, 'child.pid');
    const controller = new AbortController();
    const promise = run(`const child=require('node:child_process').spawn(process.execPath,
      ['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore',1,2]});
      const fs=require('node:fs');
      fs.writeFileSync(${JSON.stringify(parentFile)},String(process.pid));
      fs.writeFileSync(${JSON.stringify(childFile)},String(child.pid));process.exit(0);`,
    { signal: controller.signal, timeoutMs: 1500, env });
    const result = expect(promise).rejects.toMatchObject({ code: 'LIMIT' });
    try {
      const parentPid = await readPid(parentFile);
      const childPid = await readPid(childFile);
      // Confirm the parent really exited before the timeout, while its child is still alive.
      let parentAlive = true;
      for (let attempt = 0; attempt < 100; attempt++) {
        try { process.kill(parentPid, 0); } catch { parentAlive = false; break; }
        await delay(10);
      }
      expect(parentAlive).toBe(false);
      expect(() => process.kill(childPid, 0)).not.toThrow();
      await result;
      expect(() => process.kill(childPid, 0)).not.toThrow();
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      controller.abort();
      await promise.catch(() => {});
      for (const file of [childFile, parentFile]) {
        const pid = Number(await readFile(file, 'utf8').catch(() => '0'));
        if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* already stopped */ } }
      }
    }
  });

  it('handles a CLI that exits before reading a large stdin without unhandled EPIPE', async () => {
    expect((await run('process.exit(0)', { stdin: 'x'.repeat(4 * 1024 * 1024) })).exitCode).toBe(0);
  });

  it('inherits only the allowed environment keys', () => {
    expect(Object.keys(localProcessEnv()).every(key => ['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'USER', 'LOGNAME', 'SYSTEMROOT'].includes(key))).toBe(true);
    expect(localProcessEnv()).not.toHaveProperty('NODE_OPTIONS');
    expect(localProcessEnv()).not.toHaveProperty('OPENAI_API_KEY');
  });
});
