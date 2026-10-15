import path from 'node:path';
import os from 'node:os';
import { access, realpath, stat, mkdtemp, writeFile, rm, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { GEMINI_MODEL, type ConnectionReport, type LearningMode, type ProviderConnection, type ProviderId } from '../../shared/ai';
import { AppError } from '../../shared/errors';
import { runProcess } from './process';
import type { StageRequest, StageResponse } from './workflow';

export const LOCAL_WORKER_BLOCKER = '읽기 전용 실행과 기존 로그인 연결 시험이 끝나지 않아 질문 전송을 잠갔습니다.';
const providers: { provider: ProviderId; binary: string }[] = [
  { provider: 'codex', binary: 'codex' }, { provider: 'antigravity', binary: 'agy' }, { provider: 'claude-code', binary: 'claude' },
];

// Fixed installation locations, not a shell/PATH search in the selected project.
export function executableCandidates(binary: string, home = os.homedir()): string[] {
  return [path.join(home, '.local/bin', binary), path.join(home, '.npm-global/bin', binary),
    path.join('/opt/homebrew/bin', binary), path.join('/usr/local/bin', binary)];
}

/** How to start a provider: the executable plus any arguments that come before the CLI's own. */
export interface Launch { executable: string; prefix: string[] }

async function usableFile(candidate: string): Promise<string | undefined> {
  try {
    const target = await realpath(candidate);
    if (!(await stat(target)).isFile()) return undefined;
    await access(target, constants.X_OK);
    return target;
  } catch { return undefined; }
}

/**
 * npm installs Codex as a Node script (`#!/usr/bin/env node`). An app opened from Finder gets
 * PATH=/usr/bin:/bin:/usr/sbin:/sbin, where `env node` fails, so a Node script is started with a
 * node from the same fixed install locations instead. Anything else is started as it is.
 */
export async function resolveLaunch(target: string, home = os.homedir()): Promise<Launch | undefined> {
  const handle = await open(target, 'r');
  let head: string;
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(128), 0, 128, 0);
    head = buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
  if (!head.startsWith('#!') || !/\bnode\b/.test(head.split('\n')[0])) return { executable: target, prefix: [] };
  for (const candidate of executableCandidates('node', home)) {
    const node = await usableFile(candidate);
    if (node) return { executable: node, prefix: [target] };
  }
  return undefined;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('AI_RESPONSE', 'AI 응답을 읽을 수 없습니다.');
  return value as Record<string, unknown>;
}
function json(text: string): unknown {
  try { return JSON.parse(text); } catch { throw new AppError('AI_RESPONSE', 'AI 응답이 올바른 JSON이 아닙니다.'); }
}
function reportModel(value: unknown): string | null {
  return typeof value === 'string' && /^[a-zA-Z0-9._:/-]{1,120}$/.test(value) ? value : null;
}
// Parsing a successful envelope is separate from enforcing tool permissions.
// Tool failures and partial output never become a successful explanation.
export function parseStageOutput(provider: 'codex' | 'antigravity', stdout: string, exitCode: number): StageResponse {
  if (exitCode !== 0) throw new AppError('AI_UNAVAILABLE', 'AI 실행에 실패했습니다. 공식 프로그램에서 로그인·이용 한도를 확인해 주세요.');
  if (provider === 'antigravity') {
    const envelope = object(json(stdout));
    if (envelope.status !== 'SUCCESS' || envelope.error || envelope.tool_errors || envelope.errors) {
      throw new AppError('AI_RESPONSE', 'Gemini 워커가 정상적인 설명을 반환하지 않았습니다.');
    }
    const reportedModel = reportModel(envelope.model);
    if (reportedModel && reportedModel !== GEMINI_MODEL) throw new AppError('AI_RESPONSE', 'Gemini 응답 모델이 요청 모델과 다릅니다.');
    const value = envelope.structured_output ?? (typeof envelope.response === 'string' ? json(envelope.response) : undefined);
    if (!value) throw new AppError('AI_RESPONSE', 'Gemini 워커의 설명이 비어 있습니다.');
    return { value, reportedModel };
  }
  const events = stdout.split('\n').filter(line => line.trim()).map(line => object(json(line)));
  let answer: string | undefined;
  let completed = false;
  let reportedModel: string | null = null;
  for (const event of events) {
    if (event.type === 'error' || event.type === 'turn.failed' || event.error) throw new AppError('AI_RESPONSE', 'Codex 작업이 정상적으로 끝나지 않았습니다.');
    if (event.type === 'turn.completed') completed = true;
    reportedModel = reportModel(event.model) ?? reportedModel;
    if (event.type === 'item.completed' || event.type === 'item.started') {
      const item = object(event.item);
      // Codex also reports problems such as unreadable global config as `error` items; they are
      // not tool use, but the run is still not accepted as clean.
      if (item.type === 'error') throw new AppError('AI_RESPONSE', 'Codex가 실행 중 오류를 보고했습니다. 공식 프로그램의 설정을 확인해 주세요.');
      if (item.type !== 'agent_message' && item.type !== 'reasoning') throw new AppError('AI_RESPONSE', 'Codex가 허용하지 않은 도구 작업을 보고했습니다.');
      if (event.type === 'item.completed' && item.type === 'agent_message' && typeof item.text === 'string') answer = item.text;
    }
  }
  if (!completed || !answer) throw new AppError('AI_RESPONSE', 'Codex 응답이 끝나지 않았거나 설명이 비어 있습니다.');
  return { value: json(answer), reportedModel };
}

export class LocalAiRuntime {
  private launches = new Map<ProviderId, Launch>();
  private inspection?: { controller: AbortController; done: Promise<ConnectionReport> };

  checkConnections(): Promise<ConnectionReport> {
    if (this.inspection) return this.inspection.done;
    const controller = new AbortController();
    const done = this.inspect(controller.signal).finally(() => { if (this.inspection?.controller === controller) this.inspection = undefined; });
    this.inspection = { controller, done };
    return done;
  }
  private async inspect(signal: AbortSignal): Promise<ConnectionReport> {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'code-learning-check-'));
    const connections: ProviderConnection[] = [];
    this.launches.clear();
    try {
      for (const { provider, binary } of providers) {
        if (signal.aborted) throw new AppError('CANCELLED', '연결 확인을 취소했습니다.');
        let executable: string | undefined;
        // Try the official/common installation locations in order.
        for (const candidate of executableCandidates(binary)) {
          executable = await usableFile(candidate);
          if (executable) break;
        }
        const base = { provider, version: null, authentication: 'unchecked', isolation: 'unverified' } as const;
        if (!executable) {
          connections.push({ ...base, installation: 'missing', message: '기본 설치 위치에서 찾지 못했습니다. 공식 프로그램을 설치해 주세요.' });
          continue;
        }
        const launch = await resolveLaunch(executable).catch(() => undefined);
        if (!launch) {
          connections.push({ ...base, installation: 'unusable', message: '실행에 필요한 Node를 기본 위치에서 찾지 못했습니다.' });
          continue;
        }
        try {
          const output = await runProcess({ executable: launch.executable, args: [...launch.prefix, '--version'], cwd: directory, signal, timeoutMs: 8000, maxOutputBytes: 16 * 1024 });
          const version = output.stdout.match(/(?:^|\s)(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)(?:\s|$)/)?.[1] ?? null;
          if (output.exitCode !== 0 || !version) throw new Error('unusable');
          this.launches.set(provider, launch);
          connections.push({ ...base, installation: 'found', version, message: '설치를 확인했습니다. 로그인·실제 응답·접근 제한은 아직 미검증입니다.' });
        } catch (error) {
          if (signal.aborted) throw new AppError('CANCELLED', '연결 확인을 취소했습니다.');
          connections.push({ ...base, installation: 'unusable', message: '실행 파일은 있지만 버전을 확인하지 못했습니다.' });
        }
      }
      return { checkedAt: new Date().toISOString(), providers: connections,
        modes: [
          { mode: 'local-worker', ready: false, reason: LOCAL_WORKER_BLOCKER },
          ...providers.map(({ provider }) => ({ mode: provider, ready: false, reason: 'AI 단독 실행은 후속 연결 단계입니다.' })),
        ] };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  assertReady(mode: LearningMode): never {
    if (mode !== 'local-worker') throw new AppError('AI_UNAVAILABLE', 'AI 단독 실행은 아직 준비 중입니다.');
    // Deliberately no environment/UI override. Enable only after C04/C05 and
    // the exact provider invocation have passed real isolated-fixture checks.
    throw new AppError('AI_UNAVAILABLE', LOCAL_WORKER_BLOCKER);
  }

  async run(request: StageRequest): Promise<StageResponse> {
    this.assertReady('local-worker');
    return this.executeVerifiedStage(request);
  }

  private async executeVerifiedStage(request: StageRequest): Promise<StageResponse> {
    const launch = this.launches.get(request.provider);
    if (!launch) throw new AppError('AI_UNAVAILABLE', '먼저 로컬 AI 설치 상태를 확인해 주세요.');
    const directory = await mkdtemp(path.join(os.tmpdir(), 'code-learning-ai-'));
    try {
      const schema = path.join(directory, 'response-schema.json');
      await writeFile(schema, JSON.stringify(request.schema), { mode: 0o600 });
      const args = request.provider === 'codex'
        ? ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only',
          '--disable', 'hooks', '--disable', 'shell_tool', '--disable', 'multi_agent',
          '-c', 'web_search="disabled"', '-c', 'project_doc_max_bytes=0', '-c', 'approval_policy="never"',
          '--json', '--color', 'never', '--output-schema', schema, '-']
        : ['-p', '--model', GEMINI_MODEL, '--mode', 'plan', '--sandbox', '--output-format', 'json', '--json-schema', schema, '--print-timeout', '2m'];
      const output = await runProcess({ executable: launch.executable, args: [...launch.prefix, ...args], stdin: request.prompt, cwd: directory, signal: request.signal });
      // Stderr can contain provider/native paths; never return it to the renderer.
      if (/denied|permission|not allowed|unauthorized|authentication required|rate.limit|quota/i.test(output.stderr)) {
        throw new AppError('AI_UNAVAILABLE', 'AI 실행 중 인증·권한·이용 한도 오류가 발생했습니다.');
      }
      return parseStageOutput(request.provider, output.stdout, output.exitCode);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  async close(): Promise<void> {
    this.inspection?.controller.abort();
    await this.inspection?.done.catch(() => undefined);
  }
}
