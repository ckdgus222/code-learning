import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { localProcessEnv, runProcess } from '../src/core/ai/process';

let root: string;
beforeEach(async () => { root = await mkdtemp('/private/tmp/learning-ai-process-'); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function run(source: string, options: Partial<Parameters<typeof runProcess>[0]> = {}) {
  return runProcess({ executable: process.execPath, args: ['-e', source], cwd: root,
    signal: new AbortController().signal, timeoutMs: 3000, ...options });
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
    await expect(run(`require('node:child_process').spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:['ignore',1,2]});process.exit(0);`, { timeoutMs: 200 })).rejects.toMatchObject({ code: 'LIMIT' });
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
