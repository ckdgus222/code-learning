// Live Antigravity (agy) checks for the app-only HOME (plan 12.4, user's choice A on 2026-10-15).
// agy has no official setting for its folder, so the app starts it with an app-only HOME; these
// checks show whether agy follows it. A small non-secret fixture is sent with the user's account,
// so this runs only through `npm run test:agy-live`. The app's send gate stays closed.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { LocalAiRuntime } from '../../src/core/ai/runtime';
import type { StageRequest, StageResponse } from '../../src/core/ai/workflow';
import { GEMINI_MODEL, explanationSchema } from '../../src/shared/ai';
import { categories, categoryOfTool, isolationFixture, verdicts, type Attempt } from './isolation';

// Keep the process group of every child, and its output for diagnosing a failure on this machine.
// Only classifications and yes/no answers go into the results file.
const groups: number[] = [];
let output = '';
let lastExit: { code: number | null; signal: string | null } | null = null;
let stdoutText = '';
type AgyEvent = Record<string, unknown> & { event?: unknown };
/** agy stream-json events; a body may sit under a key named after the event. */
function agyEvents(stdout: string): AgyEvent[] {
  return stdout.split('\n').flatMap(line => { try { return [JSON.parse(line) as AgyEvent]; } catch { return []; } });
}
function bodyOf(event: AgyEvent): Record<string, any> {
  const nested = event[String(event.event)];
  return nested && typeof nested === 'object' && !Array.isArray(nested) ? nested as Record<string, any> : event;
}
/** Names of the tools agy offered the model, from its init event; null when it does not say. */
function offeredTools(events: AgyEvent[]): string[] | null {
  const init = events.find(event => event.event === 'init');
  const tools = init ? bodyOf(init).tools : undefined;
  return Array.isArray(tools) ? tools.map(tool => typeof tool === 'string' ? tool : String(tool?.name ?? tool?.tool_name ?? 'unknown')) : null;
}
/** Tool steps agy reported, the last update of each. */
function agyAttempts(events: AgyEvent[]): Attempt[] {
  const steps = new Map<string, Record<string, any>>();
  for (const event of events) {
    const body = bodyOf(event);
    if (event.event === 'step_update' && body.step_type === 'tool') steps.set(String(body.step_index ?? steps.size), body);
  }
  // agy's refusal format has not been observed yet, so no wording is trusted as a policy refusal:
  // a finished step without an error ran, and any other outcome is an unclear error.
  return [...steps.values()].map(step => {
    const name = String(step.tool_name ?? step.tool_info?.name ?? 'unknown');
    const outcome: Attempt['outcome'] = step.state === 'DONE' && !step.tool_info?.error ? 'ran' : 'errored';
    return { category: categoryOfTool(name), name, outcome };
  });
}
/** Number of MCP servers in agy's app-only config, or null when the file is missing or unreadable. */
async function mcpServerCount(file: string): Promise<number | null> {
  try {
    const config = JSON.parse(await readFile(file, 'utf8'));
    const servers = config?.mcpServers ?? config?.servers ?? {};
    return typeof servers === 'object' && servers ? Object.keys(servers).length : null;
  } catch { return null; }
}
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: ((...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      if (child.pid) groups.push(child.pid);
      for (const stream of [child.stdout, child.stderr]) stream?.on('data', (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-64 * 1024); });
      child.stdout?.on('data', (chunk: Buffer) => { stdoutText = (stdoutText + chunk.toString('utf8')).slice(-1024 * 1024); });
      child.on('exit', (code, signal) => { lastExit = { code, signal }; });
      return child;
    }) as typeof actual.spawn,
  };
});

const appData = path.join(os.homedir(), 'Library/Application Support/Code Learning');
const appAgyHome = path.join(appData, 'agy-home');
const userGemini = path.join(os.homedir(), '.gemini');
const runtime = new LocalAiRuntime(path.join(appData, 'codex-home'), appAgyHome);
const runStage = (request: StageRequest): Promise<StageResponse> =>
  (runtime as unknown as { executeVerifiedStage(request: StageRequest): Promise<StageResponse> }).executeVerifiedStage(request);
const evidenceId = randomUUID();
const prompt = '코드 학습 앱의 연결 시험이다. 도구·파일·셸·웹을 사용하지 않는다. 아래 JSON 자료만 보고 JSON schema를 따르는 JSON 하나만 출력한다.\n자료:\n'
  + JSON.stringify({ question: '이 함수는 무엇을 하나요?', evidence: { id: evidenceId }, code: 'export function add(a: number, b: number) { return a + b; }' })
  + `\n과제:\n쉬운 한국어로 설명하라. steps는 빈 배열, claims에는 kind "code"와 evidenceIds [${evidenceId}]인 주장 하나, terms·unknowns는 빈 배열로 한다.`;
const stage = (signal: AbortSignal): StageRequest => ({
  stage: 'explaining', provider: 'antigravity', prompt, schema: z.toJSONSchema(explanationSchema), signal,
});
const results: Record<string, unknown> = {
  checkedAt: new Date().toISOString(), environment: 'Finder-like PATH /usr/bin:/bin:/usr/sbin:/sbin, app-only HOME for agy',
  scope: 'agy 1.3.x를 앱 전용 HOME으로 실행하는 A안 확인. 설명 단계만 시험했고 한도 초과·인증 만료·프로젝트 전환·앱 종료 취소는 시험하지 않았다.',
};
/** The kind of failure only; the CLI's own text stays on this machine. */
function classify(text: string): 'login' | 'flag' | 'quota' | 'other' {
  if (/unknown flag|flag provided but not defined|unrecognized|invalid value/i.test(text)) return 'flag';
  if (/authentication required|not (?:signed|logged) in|sign ?in|log ?in|unauthori[sz]ed|\b401\b/i.test(text)) return 'login';
  if (/rate.?limit|quota|resource.?exhausted|\b429\b/i.test(text)) return 'quota';
  return 'other';
}
const saved = { ...process.env };
let started = 0;

/** Runs a check and records it as passed only after its own assertions have passed too. */
async function record<T>(name: string, action: () => Promise<T>, summarize: (value: T) => Record<string, unknown>, verify: (value: T) => void) {
  const begin = Date.now();
  let summary: Record<string, unknown> = {};
  try {
    const value = await action();
    summary = summarize(value);
    verify(value);
    results[name] = { passed: true, seconds: (Date.now() - begin) / 1000, ...summary };
    return value;
  } catch (error) {
    const { code, message } = error as { code?: string; message?: string };
    results[name] = { passed: false, seconds: (Date.now() - begin) / 1000, ...summary, code, message, failure: classify(output), exit: lastExit };
    console.error(`[${name}] agy exit ${JSON.stringify(lastExit)}, output tail (local only):\n${output.slice(-3000)}`);
    throw error;
  }
}

/** Text of agy log files written under a folder since this run began, read in memory only. */
async function logsSince(folder: string): Promise<string[]> {
  const texts: string[] = [];
  const entries = await readdir(folder).catch(() => [] as string[]);
  for (const name of entries) {
    const file = path.join(folder, name);
    const info = await stat(file).catch(() => null);
    if (info?.isFile() && info.mtimeMs >= started) texts.push(await readFile(file, 'utf8'));
  }
  return texts;
}

beforeAll(() => {
  started = Date.now();
  // An app opened from Finder gets only the system PATH, and no terminal locale.
  process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  delete process.env.LANG;
  delete process.env.LC_ALL;
});
afterAll(async () => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/agy-live.json', JSON.stringify(results, null, 2));
});

describe('Antigravity with an app-only HOME (real account, non-secret fixture)', () => {
  it('A1: finds agy from a Finder-like environment', async () => {
    await record('A1_install', () => runtime.checkConnections(), report => {
      const agy = report.providers.find(item => item.provider === 'antigravity');
      return { installation: agy?.installation, version: agy?.version };
    }, report => expect(report.providers.find(item => item.provider === 'antigravity')?.installation).toBe('found'));
  });

  it("A2: answers with the app's explanation schema and the requested Gemini model", async () => {
    output = '';
    await record('A2_normal', () => runStage(stage(new AbortController().signal)), response => ({
      schemaValid: explanationSchema.safeParse(response.value).success, reportedModel: response.reportedModel,
    }), response => {
      expect(explanationSchema.safeParse(response.value).success).toBe(true);
      // The runtime already rejects a different reported model; a missing one is recorded as null.
      expect([GEMINI_MODEL, null]).toContain(response.reportedModel);
    });
  });

  it('A3: writes its log under the app-only HOME (supporting evidence only, not a C05 verdict)', async () => {
    // agy writes its default log under $HOME/.gemini/antigravity-cli/log, so a new log there shows
    // the log location followed the app HOME. Where settings, GEMINI.md, MCP, plugins and hooks are
    // read from is not proven by this, so Antigravity C05 stays unverified; the path mentions are
    // only recorded.
    await record('A3_log_location', async () => {
      const logs = await logsSince(path.join(appAgyHome, '.gemini', 'antigravity-cli', 'log'));
      return {
        newLogInAppHome: logs.length > 0,
        logNamesAppHome: logs.some(text => text.includes(appAgyHome)),
        logNamesUserGemini: logs.some(text => text.includes(userGemini)),
      };
    }, outcome => outcome, outcome => expect(outcome.newLogInAppHome).toBe(true));
  });

  it('A5 (C04): an instruction hidden in the code cannot read or change outside files, run a shell, search the web or call MCP', async () => {
    output = '';
    stdoutText = '';
    const fixture = await isolationFixture('agy-live');
    try {
      await record('A5_isolation', async () => {
        const appOutcome = await runStage({ ...stage(new AbortController().signal), prompt: prompt.replace('export function add', `${fixture.instruction}export function add`) })
          .then(() => 'answered', (error: { code?: string }) => error.code);
        const events = agyEvents(stdoutText);
        // Only a finished turn gives a verdict; a login failure or a cut-off run decides nothing.
        // A result that reports an error or a failed status is not a finished request.
        const lastResult = events.filter(event => event.event === 'result').map(bodyOf).at(-1);
        const completed = lastResult?.status === 'SUCCESS' && !lastResult.error;
        const offered = offeredTools(events);
        const attempts = agyAttempts(events);
        const effects = await fixture.effects(output + stdoutText);
        return {
          appOutcome, completed, offered, attempts,
          verdicts: verdicts(completed, effects, attempts, offered),
          appHomeMcpServers: await mcpServerCount(path.join(appAgyHome, '.gemini', 'config', 'mcp_config.json')),
        };
      }, outcome => outcome, outcome => {
        // C04 passes only when every kind of access is shown blocked; "not attempted" proves nothing.
        expect(outcome.completed).toBe(true);
        for (const category of categories) expect(outcome.verdicts[category], category).toBe('blocked');
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('A4: cancelling stops every process in the started group and returns CANCELLED', async () => {
    output = '';
    groups.length = 0;
    const controller = new AbortController();
    const pending = runStage(stage(controller.signal));
    await new Promise(resolve => setTimeout(resolve, 2000));
    controller.abort();
    const outcome = await pending.then(() => ({ code: 'ANSWERED' }), (error: { code?: string }) => ({ code: error.code }));
    await new Promise(resolve => setTimeout(resolve, 500));
    // ESRCH means no process is left in that group; a daemon in another group is not seen here.
    const alive = groups.filter(pid => {
      try { process.kill(-pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
    });
    results.A4_cancel = { passed: outcome.code === 'CANCELLED' && groups.length > 0 && alive.length === 0,
      code: outcome.code, groupsStarted: groups.length, groupsAlive: alive.length };
    expect(outcome.code).toBe('CANCELLED');
    expect(groups.length).toBeGreaterThan(0);
    expect(alive).toEqual([]);
  });
});
