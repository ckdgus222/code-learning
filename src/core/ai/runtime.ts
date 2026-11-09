import path from 'node:path';
import os from 'node:os';
import { access, realpath, stat, mkdtemp, readFile, writeFile, rm, open, mkdir, lstat, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
import { GEMINI_MODEL, type ConnectionReport, type LearningMode, type ProviderConnection, type ProviderId } from '../../shared/ai';
import { AppError } from '../../shared/errors';
import { localProcessEnv, runProcess } from './process';
import { fencedLaunch } from './fence';
import type { StageRequest, StageResponse } from './workflow';

// The user opened the local worker on 2026-10-19 with the C04 gaps stated as known limits
// (README ‘알려진 한계’), and the same day the Codex and Gemini single modes for faster answers.
// Claude Code stays closed: it has no stage runner and no isolation checks.
const KNOWN_LIMITS = '알려진 한계: 도구 차단은 Codex 0.163.0·Antigravity 1.4.3에서 시험한 범위만 확인했어요. '
  + '울타리는 홈 폴더 읽기와 허용 폴더 밖 쓰기를 막지만 네트워크는 막지 않아요. 자세한 내용은 README의 ‘알려진 한계’에 있어요.';
export const SINGLE_READY = `질문을 보낼 수 있어요. 한 AI가 바로 설명하고 다른 AI의 대조는 없어요. ${KNOWN_LIMITS}`;
export const SINGLE_NEEDS = {
  codex: 'Codex 단독에는 Codex가 필요해요. 먼저 로컬 AI 설치 상태를 확인해 주세요.',
  antigravity: 'Gemini 단독에는 Antigravity가 필요해요. 먼저 로컬 AI 설치 상태를 확인해 주세요.',
};
export const CLAUDE_CODE_CLOSED = 'Claude Code 단독은 아직 준비 중이에요.';
export const WINDOWS_CODEX_WARNING = 'Windows 실험 기능이에요: 실제 Windows PC에서 확인하지 못했고, macOS의 울타리 없이 실행해요. 도구 차단이 새면 Codex가 이 PC의 파일을 읽거나 바꿀 수 있어요. 자세한 내용은 README의 ‘알려진 한계’에 있어요.';
export const WINDOWS_CODEX_READY = `질문을 보낼 수 있어요. 한 AI가 바로 설명하고 다른 AI의 대조는 없어요. ${WINDOWS_CODEX_WARNING}`;
export const WINDOWS_GEMINI_CLOSED = 'Windows에서는 아직 Gemini 단독을 쓸 수 없어요. Antigravity의 도구 차단을 Windows에서 확인하지 못했어요.';
export const GEMINI_NEEDS_KEY = 'Gemini는 Google AI Studio API 키로만 연결해요. 설정에서 API 키를 넣어 주세요.';
export const GEMINI_UPDATE_AGY = 'Gemini는 Antigravity CLI 1.4.12 이상에서만 돼요. agy를 업데이트해 주세요.';
export const GEMINI_KEY_WARNING = 'Gemini는 API 키로만 연결해요. Google은 이 앱처럼 Antigravity CLI를 다른 앱에서 실행하는 방식에 개인 Google 로그인을 허용하지 않고, 어기면 Antigravity·Gemini CLI 이용이 정지될 수 있어요. 무료 등급 키로 보낸 코드와 질문은 Google이 제품 개선에 쓸 수 있어요.';
const providers: { provider: ProviderId; binary: string }[] = [
  { provider: 'codex', binary: 'codex' }, { provider: 'antigravity', binary: 'agy' }, { provider: 'claude-code', binary: 'claude' },
];

// Fixed installation locations, not a shell/PATH search in the selected project.
export function executableCandidates(binary: string, home = os.homedir(), platform: NodeJS.Platform = process.platform, env = process.env): string[] {
  if (platform === 'win32') {
    if (binary === 'codex' && env.APPDATA) return [path.win32.join(env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')];
    if (binary === 'node' && env.ProgramFiles) return [path.win32.join(env.ProgramFiles, 'nodejs', 'node.exe')];
    return [];
  }
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
export async function resolveLaunch(target: string, home = os.homedir(), platform: NodeJS.Platform = process.platform): Promise<Launch | undefined> {
  const handle = await open(target, 'r');
  let head: string;
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(128), 0, 128, 0);
    head = buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
  if (!head.startsWith('#!') || !/\bnode\b/.test(head.split('\n')[0])) return { executable: target, prefix: [] };
  for (const candidate of executableCandidates('node', home, platform)) {
    const node = await usableFile(candidate);
    if (node) return { executable: node, prefix: [target] };
  }
  return undefined;
}

/**
 * What agy may never do in an app run: the app puts the code a question needs into the prompt.
 * Without these, plan mode with --sandbox still offered file, shell, web and MCP tools (C04 step 1),
 * and agy allows file access inside its working folder by default (official headless docs).
 */
export const AGY_DENY_RULES = ['read_file(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)', 'command(*)', 'unsandboxed(*)', 'mcp(*)'];
/**
 * A PreToolUse hook that refuses every tool (official hooks docs: matcher "*", decision "deny").
 * The deny rules do not cover every tool: search_web still ran with them (C04 step 2).
 */
export const AGY_NO_TOOLS_REASON = 'Code Learning runs agy without tools';
export const AGY_NO_TOOLS_HOOK = {
  'code-learning-no-tools': { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command',
    command: `echo '${JSON.stringify({ decision: 'deny', reason: AGY_NO_TOOLS_REASON })}'`, timeout: 5 }] }] },
};
/** No MCP server, in the format of the official MCP docs (`mcpServers`). */
export const AGY_NO_MCP_SERVERS = { mcpServers: {} };
// No O_TRUNC: the file is emptied only after it is shown to be a file of its own.
const NO_FOLLOW_WRITE = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW;

/** Makes each level under `home` a private folder, refusing a link at any level. */
async function privateFolder(home: string, parts: string[]): Promise<string> {
  let folder = home;
  for (const part of parts) {
    folder = path.join(folder, part);
    // A link could lead to the user's own ~/.gemini. mkdir does not follow an existing link, so
    // nothing is made inside a link's target before this check.
    await mkdir(folder, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(folder);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('not a private folder');
    await chmod(folder, 0o700);
  }
  return folder;
}

/** Writes a file without following a link at its name, and makes an existing one private too. */
async function writePrivateFile(file: string, text: string): Promise<void> {
  // Windows has no O_NOFOLLOW; reject a link before opening its target.
  const existing = await lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  if (existing?.isSymbolicLink()) throw new Error('not a private file');
  const handle = await open(file, NO_FOLLOW_WRITE, 0o600);
  try {
    // O_NOFOLLOW opens a hard link, which shares its contents with another name such as the
    // user's own ~/.gemini file.
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) throw new Error('not a private file');
    await handle.truncate(0);
    await handle.chmod(0o600);
    await handle.writeFile(text);
  } finally { await handle.close(); }
}

/**
 * Restricts agy under the app-only HOME before every run, so the restrictions hold even if agy
 * rewrites its files. settings.json gets the deny rules (deny outranks ask and allow, official
 * permissions docs) and loses any hooks, since a hook runs commands; other keys agy wrote there
 * itself, such as trusted folders, are kept. hooks.json then holds only the app's hook, and
 * mcp_config.json no MCP server. A run's working folder, where agy also reads `.agents/`, is a new
 * empty folder the app makes, so agy must never run in a user's project.
 */
export async function restrictAgy(home: string): Promise<void> {
  const settingsFile = path.join(await privateFolder(home, ['.gemini', 'antigravity-cli']), 'settings.json');
  let settings: Record<string, unknown> = {};
  try {
    if ((await lstat(settingsFile)).isSymbolicLink()) throw new Error('not a private file');
    settings = JSON.parse(await readFile(settingsFile, { encoding: 'utf8', flag: constants.O_RDONLY | constants.O_NOFOLLOW }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // Anything but the expected shapes is left as it is, and agy is not started.
  const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  if (!isObject(settings)) throw new Error('unexpected settings');
  const permissions = settings.permissions ?? {};
  if (!isObject(permissions)) throw new Error('unexpected settings');
  const deny = permissions.deny ?? [];
  if (!Array.isArray(deny) || !deny.every(rule => typeof rule === 'string')) throw new Error('unexpected settings');
  const updated: Record<string, unknown> = { ...settings, modelProvider: 'gemini', permissions: { ...permissions, deny: [...new Set([...deny, ...AGY_DENY_RULES])] } };
  delete updated.hooks;
  await writePrivateFile(settingsFile, `${JSON.stringify(updated, null, 2)}\n`);
  const configFolder = await privateFolder(home, ['.gemini', 'config']);
  await writePrivateFile(path.join(configFolder, 'hooks.json'), `${JSON.stringify(AGY_NO_TOOLS_HOOK, null, 2)}\n`);
  // A configured MCP server is a command agy starts by itself; the hook only sees tool calls.
  await writePrivateFile(path.join(configFolder, 'mcp_config.json'), `${JSON.stringify(AGY_NO_MCP_SERVERS, null, 2)}\n`);
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
/** The only agy step kinds a normal answer reports (seen in the API-key run A8 and the login run A2). */
export const AGY_ANSWER_STEP_TYPES = ['user_input', 'agent_response'];

// Parsing a successful envelope is separate from enforcing tool permissions.
// Tool failures and partial output never become a successful explanation.
export function parseStageOutput(provider: 'codex' | 'antigravity', stdout: string, exitCode: number): StageResponse {
  if (exitCode !== 0) throw new AppError('AI_UNAVAILABLE', provider === 'antigravity'
    ? 'AI 실행에 실패했습니다. 설정의 Gemini API 키와 이용 한도를 확인해 주세요.'
    : 'AI 실행에 실패했습니다. 공식 프로그램에서 로그인·이용 한도를 확인해 주세요.');
  if (provider === 'antigravity') {
    // agy stream-json: an `init` event, `step_update` events, then a final `result`. A body may sit
    // under a key named after the event (`{"event":"init","init":{…}}`), so both shapes are read.
    const events = stdout.split('\n').filter(line => line.trim()).map(line => object(json(line)));
    const body = (event: Record<string, unknown>) => {
      const nested = event[String(event.event)];
      return nested && typeof nested === 'object' && !Array.isArray(nested) ? nested as Record<string, unknown> : event;
    };
    const init = events.find(event => event.event === 'init');
    if (!init) throw new AppError('AI_RESPONSE', 'Gemini 워커의 시작 정보가 없습니다.');
    const reportedModel = reportModel(body(init).model);
    if (reportedModel && reportedModel !== GEMINI_MODEL) throw new AppError('AI_RESPONSE', 'Gemini 응답 모델이 요청 모델과 다릅니다.');
    // A normal answer carries only the user's input and the agent's response. A tool call, a
    // sub-agent or a question is reported as another kind (`tool`, `subagent`, or no kind at all in
    // the local A9 run), so anything else rejects the answer; it does not undo what already ran.
    if (events.some(event => event.event === 'step_update' && !AGY_ANSWER_STEP_TYPES.includes(String(body(event).step_type)))) {
      throw new AppError('AI_RESPONSE', 'Gemini 워커가 허용하지 않은 작업 단계를 보고했습니다.');
    }
    const result = events.filter(event => event.event === 'result').map(body).at(-1);
    if (!result || result.status !== 'SUCCESS' || result.error) throw new AppError('AI_RESPONSE', 'Gemini 워커가 정상적인 설명을 반환하지 않았습니다.');
    const value = result.structured_output ?? (typeof result.response === 'string' ? json(result.response) : undefined);
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
  private agySupportsDisableSlashCommands = false;
  private agySupported = false;
  private geminiKeySaved = false;
  /**
   * App-only folders keep the user's own AI settings out of app runs.
   * `codexHome`: even with `--ignore-user-config`, codex-cli 0.162.1 read the user's global
   * `~/.codex/agents`, so every codex run gets this folder as CODEX_HOME, with its own one-time
   * official login. `antigravityHome`: agy has no setting for its folder (its settings, GEMINI.md,
   * MCP, plugins and hooks live under `~/.gemini`), so it is started with this folder as HOME.
   * That is not an official agy feature and is checked by `npm run test:agy-live`.
   */
  constructor(private readonly codexHome: string, private readonly antigravityHome: string,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly geminiKey: { has(): Promise<boolean>; read(): Promise<string | null> } = {
      has: async () => false, read: async () => null,
    }) {}

  async refreshGeminiKey(): Promise<void> {
    this.geminiKeySaved = await this.geminiKey.has();
  }

  /**
   * How a CLI is started: inside the macOS fence, or on Windows, which has no such sandbox, Codex as
   * it is. That unfenced Codex is the unverified experimental mode the user chose on 2026-11-06; agy
   * stays closed there because its no-tools hook and app-only HOME were never checked on Windows.
   */
  private async launchFor(provider: ProviderId, launch: Launch, directory: string): Promise<Launch> {
    if (this.platform !== 'win32') {
      return fencedLaunch(launch, { appHome: provider === 'codex' ? this.codexHome : this.antigravityHome, runDirectory: directory });
    }
    if (provider !== 'codex') throw new AppError('AI_UNAVAILABLE', 'Windows에서는 Codex 단독만 실행할 수 있어요.');
    return launch;
  }

  private async environment(provider: ProviderId, running = false): Promise<NodeJS.ProcessEnv | undefined> {
    const home = provider === 'codex' ? this.codexHome : provider === 'antigravity' ? this.antigravityHome : undefined;
    if (!home) return undefined;
    try {
      await mkdir(home, { recursive: true, mode: 0o700 });
      // A link could point back at the user's own folder, so only a real folder is used,
      // and an existing one is made private too (mkdir's mode only applies to new folders).
      const info = await lstat(home);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('not a private folder');
      await chmod(home, 0o700);
      if (provider === 'antigravity') await restrictAgy(home);
    } catch {
      throw new AppError('AI_UNAVAILABLE', `앱 전용 ${provider === 'codex' ? 'Codex' : 'Antigravity'} 위치를 준비하지 못했습니다. 폴더 권한${provider === 'antigravity' ? '과 설정 파일(settings.json, hooks.json, mcp_config.json)' : ''}을 확인해 주세요.`);
    }
    if (provider === 'antigravity' && running) {
      if (this.platform === 'win32') throw new AppError('AI_UNAVAILABLE', 'Windows에서는 Codex 단독만 실행할 수 있어요.');
      const key = await this.geminiKey.read();
      if (!key) throw new AppError('AI_UNAVAILABLE', GEMINI_NEEDS_KEY);
      return { ...localProcessEnv(), HOME: home, GEMINI_API_KEY: key };
    }
    return provider === 'codex' ? { ...localProcessEnv(), CODEX_HOME: home } : { ...localProcessEnv(), HOME: home };
  }
  private inspection?: { controller: AbortController; done: Promise<ConnectionReport> };

  checkConnections(request?: { automatic: true }): Promise<ConnectionReport> {
    if (this.inspection) return this.inspection.done;
    const controller = new AbortController();
    const done = this.inspect(controller.signal, request?.automatic === true).finally(() => { if (this.inspection?.controller === controller) this.inspection = undefined; });
    this.inspection = { controller, done };
    return done;
  }
  private async inspect(signal: AbortSignal, automatic: boolean): Promise<ConnectionReport> {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'code-learning-check-'));
    const connections: ProviderConnection[] = [];
    this.launches.clear();
    this.agySupportsDisableSlashCommands = false;
    this.agySupported = false;
    try {
      await this.refreshGeminiKey();
      for (const { provider, binary } of providers) {
        if (this.platform === 'win32' && provider !== 'codex') continue;
        if (automatic && provider === 'claude-code') continue;
        if (signal.aborted) throw new AppError('CANCELLED', '연결 확인을 취소했습니다.');
        let executable: string | undefined;
        // Try the official/common installation locations in order.
        for (const candidate of executableCandidates(binary, os.homedir(), this.platform)) {
          executable = await usableFile(candidate);
          if (executable) break;
        }
        const base = { provider, version: null, authentication: 'unchecked', isolation: 'unverified' } as const;
        if (!executable) {
          connections.push({ ...base, installation: 'missing', message: '기본 설치 위치에서 찾지 못했습니다. 공식 프로그램을 설치해 주세요.' });
          continue;
        }
        const launch = await resolveLaunch(executable, os.homedir(), this.platform).catch(() => undefined);
        if (!launch) {
          connections.push({ ...base, installation: 'unusable', message: '실행에 필요한 Node를 기본 위치에서 찾지 못했습니다.' });
          continue;
        }
        let env: NodeJS.ProcessEnv | undefined;
        try { env = await this.environment(provider); } catch (error) {
          connections.push({ ...base, installation: 'unusable', message: (error as AppError).message });
          continue;
        }
        // Version checks use the same launch protection as questions (agy can update itself here).
        // Claude Code has no app-only home and is not used to send.
        let start = launch;
        if (env) {
          try { start = await this.launchFor(provider, launch, directory); } catch (error) {
            connections.push({ ...base, installation: 'unusable', message: (error as AppError).message });
            continue;
          }
        }
        try {
          const output = await runProcess({ executable: start.executable, args: [...start.prefix, '--version'], cwd: directory, signal,
            timeoutMs: 8000, maxOutputBytes: 16 * 1024, env: env && { ...env, TMPDIR: directory, TEMP: directory, TMP: directory } });
          const version = output.stdout.match(/(?:^|\s)(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)(?:\s|$)/)?.[1] ?? null;
          if (output.exitCode !== 0 || !version) throw new Error('unusable');
          this.launches.set(provider, launch);
          if (provider === 'antigravity') {
            const [major, minor, patch] = version.split('.').map(part => Number.parseInt(part, 10));
            // 1.4.12 is both the oldest agy verified in API key mode (user decision) and the first with --disable-slash-commands.
            this.agySupported = major > 1 || (major === 1 && (minor > 4 || (minor === 4 && patch >= 12)));
            this.agySupportsDisableSlashCommands = this.agySupported;
          }
          let message = provider === 'antigravity'
            ? `설치를 확인했습니다. ${this.geminiKeySaved ? '' : `${GEMINI_NEEDS_KEY} `}실제 응답·접근 제한은 아직 미검증입니다.`
            : '설치를 확인했습니다. 로그인·실제 응답·접근 제한은 아직 미검증입니다.';
          if (provider === 'codex') {
            const login = this.platform === 'win32'
              ? `PowerShell에서 로그인이 필요할 수 있어요: $env:CODEX_HOME="${this.codexHome}"; codex login`
              : `터미널에서 로그인이 필요할 수 있어요: CODEX_HOME="${this.codexHome}" codex login`;
            message += ` 앱은 개인 Codex 설정과 분리된 앱 전용 위치를 쓰므로, 처음 한 번 ${login}`;
          }
          connections.push({ ...base, installation: 'found', version, message });
        } catch (error) {
          if (signal.aborted) throw new AppError('CANCELLED', '연결 확인을 취소했습니다.');
          connections.push({ ...base, installation: 'unusable', message: '실행 파일은 있지만 버전을 확인하지 못했습니다.' });
        }
      }
      return { checkedAt: new Date().toISOString(), providers: connections,
        modes: (['codex', 'antigravity', 'claude-code'] as const).map(mode => {
          const blocker = this.blocker(mode);
          if (this.platform === 'win32' && mode === 'codex' && !blocker) {
            return { mode, ready: true, reason: WINDOWS_CODEX_READY, warning: WINDOWS_CODEX_WARNING };
          }
          return { mode, ready: !blocker, reason: blocker ?? SINGLE_READY,
            ...(mode === 'antigravity' && !blocker ? { warning: GEMINI_KEY_WARNING } : {}) };
        }) };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  /** Why a mode cannot send now, or null. Only this run's installation check counts (`launches` is cleared when one starts). */
  private blocker(mode: LearningMode): string | null {
    if (mode === 'claude-code') return CLAUDE_CODE_CLOSED;
    if (this.platform === 'win32' && mode === 'antigravity') return WINDOWS_GEMINI_CLOSED;
    if (!this.launches.has(mode)) return SINGLE_NEEDS[mode];
    if (mode === 'antigravity' && !this.agySupported) return GEMINI_UPDATE_AGY;
    if (mode === 'antigravity' && !this.geminiKeySaved) return GEMINI_NEEDS_KEY;
    return null;
  }

  assertReady(mode: LearningMode): void {
    // Deliberately no environment/UI override. Login is not checked here: a missing one fails at the
    // first stage that calls that provider.
    const blocker = this.blocker(mode);
    if (blocker) throw new AppError('AI_UNAVAILABLE', blocker);
  }

  async run(request: StageRequest): Promise<StageResponse> {
    // The stage's own CLI must have been found by this run's installation check.
    this.assertReady(request.provider);
    return this.executeVerifiedStage(request);
  }

  private async executeVerifiedStage(request: StageRequest): Promise<StageResponse> {
    const launch = this.launches.get(request.provider);
    if (!launch) throw new AppError('AI_UNAVAILABLE', '먼저 로컬 AI 설치 상태를 확인해 주세요.');
    const timeoutMs = request.timeoutMs ?? 120_000;
    const directory = await mkdtemp(path.join(os.tmpdir(), 'code-learning-ai-'));
    try {
      const schema = path.join(directory, 'response-schema.json');
      await writeFile(schema, JSON.stringify(request.schema), { mode: 0o600 });
      const args = request.provider === 'codex'
        ? ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only',
          '--disable', 'hooks', '--disable', 'shell_tool', '--disable', 'multi_agent',
          // Model metadata can select V2 agents despite the legacy multi_agent flag.
          '--disable', 'multi_agent_v2', '-c', 'agents.enabled=false', '--disable', 'view_image',
          // On by default; with an OpenAI login on a paid plan and a model that takes images, Codex
          // offers image_gen.imagegen (rust-v0.163.0 spec_plan.rs image_generation_available).
          '--disable', 'image_generation',
          // An explicit token_budget keeps a refreshed model catalog from turning it on, which would
          // add the history/notes tools, notes writing among them (core/src/session/token_budget.rs).
          // context_management (off by default) turns both back on for some models and plans.
          '--disable', 'token_budget', '--disable', 'context_management',
          // With a ChatGPT login, apps linked to the account (GitHub and others) are installed into
          // the app-only CODEX_HOME and offered as MCP tools; Codex called them in C04 step 2.
          '--disable', 'apps', '--disable', 'plugins',
          // Exclude indirect default-namespace tools (including apply_patch) in Code Mode.
          // This is not a global deny or an exec-tool disable; keep the C04 gate closed.
          '-c', 'features.code_mode.excluded_tool_namespaces=["functions"]',
          '-c', 'web_search="disabled"', '-c', 'project_doc_max_bytes=0', '-c', 'approval_policy="never"',
          '--json', '--color', 'never', '--output-schema', schema, '-']
        // `-p` takes the prompt as its own argument; code must not go on the command line, so agy
        // reads one stream-json user message from stdin and exits once stdin closes (headless docs).
        // No --json-schema: agy 1.3.5 then forces an extra internal tool call to shape the answer,
        // which the no-tools rule rejects. The schema goes into the prompt and the app checks the JSON.
        : ['--input-format', 'stream-json', '--output-format', 'stream-json', '--model', GEMINI_MODEL, '--mode', 'plan', '--sandbox',
          // Keep plan mode, but stop /plan expansion from requesting planning documents and approval.
          // Only from agy 1.4.12, where the option was seen; an agy that does not know it would refuse every run.
          ...(this.agySupportsDisableSlashCommands ? ['--disable-slash-commands'] : []),
          '--print-timeout', `${timeoutMs / 1000}s`];
      const stdin = request.provider === 'codex' ? request.prompt : `${JSON.stringify({ event: 'user', message: {
        content: `${request.prompt}\n\n응답은 아래 JSON schema를 따르는 JSON 하나만 출력한다. 코드 울타리나 다른 글을 붙이지 않는다.\n${JSON.stringify(request.schema)}`,
      } })}\n`;
      const env = await this.environment(request.provider, true);
      const start = await this.launchFor(request.provider, launch, directory);
      // TMPDIR (macOS) and TEMP/TMP (Windows) point into this run's folder: the only temporary place the
      // fence lets the CLI write, and removed after the run.
      const output = await runProcess({ executable: start.executable, args: [...start.prefix, ...args], stdin, cwd: directory,
        signal: request.signal, timeoutMs, env: { ...env, TMPDIR: directory, TEMP: directory, TMP: directory } });
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
