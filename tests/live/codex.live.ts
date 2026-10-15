// Live Codex connection checks C01-C03 (plan 12.4) through the app's own runtime code.
// This sends a small non-secret fixture with the user's Codex account, so it is excluded from
// `npm test` and runs only through `npm run test:codex-live`. The app's send gate stays closed:
// the checks call the runtime's stage executor directly, from this test only.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { LocalAiRuntime } from '../../src/core/ai/runtime';
import type { StageRequest, StageResponse } from '../../src/core/ai/workflow';
import { organizationSchema } from '../../src/shared/ai';

// Keep the process group of every child the runtime starts, the end of its stderr for diagnosing
// a failure on this machine, and its stdout so the kinds of Codex events can be listed. Only event
// kind names (never text) go into the results file.
const groups: number[] = [];
let stderrTail = '';
let stdoutText = '';
function eventKinds(stdout: string): string[] {
  const kinds = new Set<string>();
  for (const line of stdout.split('\n')) {
    try {
      const event = JSON.parse(line) as { type?: unknown; item?: { type?: unknown } };
      kinds.add([event.type, event.item?.type].filter(part => typeof part === 'string').join(':'));
    } catch { /* Not a JSON event line. */ }
  }
  return [...kinds];
}
/** Whether the final answer, if any, would pass the app's schema; null when there is no answer. */
function answerMatchesSchema(stdout: string): boolean | null {
  let answer: string | null = null;
  for (const line of stdout.split('\n')) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') answer = String(event.item.text);
    } catch { /* Not a JSON event line. */ }
  }
  if (answer === null) return null;
  try { return organizationSchema.safeParse(JSON.parse(answer)).success; } catch { return false; }
}
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: ((...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      if (child.pid) groups.push(child.pid);
      child.stderr?.on('data', (chunk: Buffer) => { stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000); });
      child.stdout?.on('data', (chunk: Buffer) => { stdoutText = (stdoutText + chunk.toString('utf8')).slice(-512 * 1024); });
      return child;
    }) as typeof actual.spawn,
  };
});

const runtime = new LocalAiRuntime();
const runStage = (request: StageRequest): Promise<StageResponse> =>
  (runtime as unknown as { executeVerifiedStage(request: StageRequest): Promise<StageResponse> }).executeVerifiedStage(request);
const evidenceId = randomUUID();
const prompt = '코드 학습 앱의 연결 시험이다. 도구·파일·셸·웹을 사용하지 않는다. 아래 JSON 자료만 보고 JSON schema를 따르는 JSON 하나만 출력한다.\n자료:\n'
  + JSON.stringify({ question: '이 함수는 무엇을 하나요?', evidence: { id: evidenceId }, code: 'export function add(a: number, b: number) { return a + b; }' })
  + `\n과제:\n질문을 설명하기 위한 초점을 정리하라. evidenceIds에는 ${evidenceId}만 쓰고 requestedFileIds는 빈 배열로 한다.`;
const stage = (signal: AbortSignal): StageRequest => ({
  stage: 'organizing', provider: 'codex', prompt, schema: z.toJSONSchema(organizationSchema), signal,
});
const results: Record<string, unknown> = {
  checkedAt: new Date().toISOString(), environment: 'Finder-like PATH /usr/bin:/bin:/usr/sbin:/sbin',
  scope: 'C01~C03 일부 실연결 확인. 작업 정리 단계만 시험했고 코드 대조 단계·한도 초과·인증 만료·프로젝트 전환·앱 종료 취소는 시험하지 않았다.',
};
/** The kind of failure only; the stderr text itself stays on this machine and is never recorded. */
function classify(stderr: string): 'login' | 'flag' | 'quota' | 'other' {
  if (/unexpected argument|unrecognized|unknown (?:option|flag)|invalid value/i.test(stderr)) return 'flag';
  if (/not logged in|log ?in|login|authenticat|unauthori[sz]ed|\b401\b/i.test(stderr)) return 'login';
  if (/rate.?limit|quota|usage limit|\b429\b/i.test(stderr)) return 'quota';
  return 'other';
}
const saved = { ...process.env };

/** Runs a check and records it as passed only after its own assertions have passed too. */
async function record<T>(name: string, action: () => Promise<T>, summarize: (value: T) => Record<string, unknown>, verify: (value: T) => void) {
  const started = Date.now();
  let summary: Record<string, unknown> = {};
  try {
    const value = await action();
    summary = summarize(value);
    verify(value);
    results[name] = { passed: true, seconds: (Date.now() - started) / 1000, ...summary };
    return value;
  } catch (error) {
    const { code, message } = error as { code?: string; message?: string };
    // App error messages and assertion texts are written here; the provider's own output is only classified.
    results[name] = { passed: false, seconds: (Date.now() - started) / 1000, ...summary, code, message, failure: classify(stderrTail),
      events: eventKinds(stdoutText), answerSchemaValid: answerMatchesSchema(stdoutText) };
    // Codex reports some problems as `error` items in stdout; show their messages on this machine only.
    const errorItems = stdoutText.split('\n').flatMap(line => {
      try { const event = JSON.parse(line); return event.item?.type === 'error' ? [String(event.item.message ?? '')] : []; } catch { return []; }
    });
    console.error(`[${name}] stderr tail (local only):\n${stderrTail}\n[${name}] error items (local only):\n${errorItems.join('\n')}`);
    throw error;
  }
}

beforeAll(() => {
  // An app opened from Finder gets only the system PATH, and no terminal locale.
  process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  delete process.env.LANG;
  delete process.env.LC_ALL;
});
afterAll(async () => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/codex-live.json', JSON.stringify(results, null, 2));
});

describe('Codex connection through the app runtime (real account, non-secret fixture)', () => {
  it('C01: finds codex and the node it needs from a Finder-like environment', async () => {
    await record('C01_install', () => runtime.checkConnections(), report => {
      const codex = report.providers.find(item => item.provider === 'codex');
      return { installation: codex?.installation, version: codex?.version };
    }, report => expect(report.providers.find(item => item.provider === 'codex')?.installation).toBe('found'));
  });

  it("C01/C02: answers with the app's organizing schema using the existing login", async () => {
    stderrTail = '';
    stdoutText = '';
    await record('C02_normal', () => runStage(stage(new AbortController().signal)), response => ({
      schemaValid: organizationSchema.safeParse(response.value).success, reportedModel: response.reportedModel, events: eventKinds(stdoutText),
    }), response => expect(organizationSchema.safeParse(response.value).success).toBe(true));
  });

  it('C01: without a login the CLI starts, reports a login problem and gives no answer', async () => {
    stderrTail = '';
    groups.length = 0;
    const emptyHome = await mkdtemp(path.join(os.tmpdir(), 'codex-live-home-'));
    process.env.HOME = emptyHome;
    try {
      // AI_UNAVAILABLE alone also covers bad flags and start failures, so the stderr kind is
      // classified here in memory and only the kind is recorded.
      await record('C01_no_login', () => runStage(stage(new AbortController().signal)).then(
        () => ({ code: 'ANSWERED', failure: 'none' }),
        (error: { code?: string }) => ({ code: error.code, failure: classify(stderrTail) })), outcome => ({ ...outcome, started: groups.length > 0 }),
      outcome => {
        expect(groups.length).toBeGreaterThan(0);
        expect(outcome).toEqual({ code: 'AI_UNAVAILABLE', failure: 'login' });
      });
    } finally {
      process.env.HOME = saved.HOME;
      await rm(emptyHome, { recursive: true, force: true });
    }
  });

  it('C03: cancelling stops every process in the started group and returns CANCELLED', async () => {
    stderrTail = '';
    groups.length = 0;
    const controller = new AbortController();
    const pending = runStage(stage(controller.signal));
    // Cancel once the CLI has had time to start its request.
    await new Promise(resolve => setTimeout(resolve, 2000));
    controller.abort();
    const outcome = await pending.then(() => ({ code: 'ANSWERED' }), (error: { code?: string }) => ({ code: error.code }));
    await new Promise(resolve => setTimeout(resolve, 500));
    // Signal 0 only checks existence; ESRCH means no process is left in that group. A daemon
    // that moved itself to another group would not be seen here.
    const alive = groups.filter(pid => {
      try { process.kill(-pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
    });
    results.C03_cancel = { passed: outcome.code === 'CANCELLED' && groups.length > 0 && alive.length === 0,
      code: outcome.code, groupsStarted: groups.length, groupsAlive: alive.length };
    expect(outcome.code).toBe('CANCELLED');
    expect(groups.length).toBeGreaterThan(0);
    expect(alive).toEqual([]);
  });
});
