import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CLAUDE_CODE_CLOSED, LOCAL_WORKER_NEEDS_BOTH, LOCAL_WORKER_READY, SINGLE_NEEDS, SINGLE_READY, LocalAiRuntime, executableCandidates, parseStageOutput,
  resolveLaunch } from '../src/core/ai/runtime';
import { GEMINI_MODEL } from '../src/shared/ai';
import { runProcess, type ProcessRequest } from '../src/core/ai/process';
import { access, chmod, lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
import os from 'node:os';

// The CLI and its own arguments inside `sandbox-exec -p <profile> <CLI> …`, or the request as it is.
const inner = (request: ProcessRequest) => request.executable === '/usr/bin/sandbox-exec'
  ? { ...request, executable: request.args[2], args: request.args.slice(3) } : request;

vi.mock('../src/core/ai/process', async original => ({ ...(await original<typeof import('../src/core/ai/process')>()), runProcess: vi.fn() }));
vi.mock('node:fs/promises', () => ({
  realpath: vi.fn(async (name: string) => name), access: vi.fn(async () => undefined),
  stat: vi.fn(async () => ({ isFile: () => true })), mkdtemp: vi.fn(async () => '/private/tmp/ai-runtime-fixture'),
  rm: vi.fn(async () => undefined), writeFile: vi.fn(async () => undefined), open: vi.fn(), mkdir: vi.fn(async () => undefined),
  readFile: vi.fn(async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }),
  lstat: vi.fn(async () => ({ isDirectory: () => true, isSymbolicLink: () => false })), chmod: vi.fn(async () => undefined),
}));
const appCodexHome = '/private/tmp/app-data/codex-home';
const appAgyHome = '/private/tmp/app-data/agy-home';
// The first bytes each fake file starts with; unknown files look like a native executable.
let heads: Record<string, string> = {};
// What the runtime wrote through a file handle, by file name.
let written: Record<string, string> = {};
const stage = (runtime: LocalAiRuntime, provider: 'codex' | 'antigravity') => (runtime as unknown as { executeVerifiedStage(request: object): Promise<unknown> })
  .executeVerifiedStage({ stage: provider === 'codex' ? 'organizing' : 'explaining', provider, prompt: 'PROMPT', schema: {}, signal: new AbortController().signal });
beforeEach(() => {
  vi.clearAllMocks();
  heads = {};
  written = {};
  vi.mocked(realpath).mockImplementation(async (name: unknown) => String(name));
  vi.mocked(access).mockResolvedValue(undefined);
  vi.mocked(open).mockImplementation((async (name: string) => ({
    read: async (buffer: Buffer) => ({ buffer, bytesRead: buffer.write(heads[name] ?? '\xCF\xFA\xED\xFE', 'latin1') }),
    stat: async () => ({ isFile: () => true, nlink: 1 }),
    truncate: async () => undefined,
    chmod: async () => undefined,
    writeFile: async (text: string) => { written[name] = text; },
    close: async () => undefined,
  })) as unknown as typeof open);
  vi.mocked(runProcess).mockResolvedValue({ stdout: 'codex-cli 1.2.3\n', stderr: '', exitCode: 0 });
});

describe('local connection readiness', () => {
  it('automatically probes only Codex and Antigravity without looking for Claude Code', async () => {
    const runtime = new LocalAiRuntime(appCodexHome, appAgyHome);
    const report = await runtime.checkConnections({ automatic: true });
    expect(report.providers.map(item => item.provider)).toEqual(['codex', 'antigravity']);
    expect(vi.mocked(realpath).mock.calls.some(([name]) => String(name).endsWith('/claude'))).toBe(false);
    expect(vi.mocked(access).mock.calls.some(([name]) => String(name).endsWith('/claude'))).toBe(false);
    expect(runProcess).toHaveBeenCalledTimes(2);
    for (const [request] of vi.mocked(runProcess).mock.calls) {
      expect(request.executable).toBe('/usr/bin/sandbox-exec');
      expect(inner(request).args).toEqual(['--version']);
      expect(inner(request).executable).not.toMatch(/\/claude$/);
    }
    expect(report.modes.find(item => item.mode === 'claude-code')).toMatchObject({ ready: false, reason: CLAUDE_CODE_CLOSED });
    expect((await runtime.checkConnections()).providers.map(item => item.provider)).toEqual(['codex', 'antigravity', 'claude-code']);
  });
  it('uses fixed install locations, never the selected project or a shell command', () => {
    expect(executableCandidates('codex', '/Users/test')).toEqual([
      '/Users/test/.local/bin/codex', '/Users/test/.npm-global/bin/codex', '/opt/homebrew/bin/codex', '/usr/local/bin/codex',
    ]);
  });
  it('only probes versions and never claims authentication or isolation succeeded', async () => {
    const report = await new LocalAiRuntime(appCodexHome, appAgyHome).checkConnections();
    expect(report.providers).toHaveLength(3);
    expect(report.providers.every(item => item.installation === 'found' && item.authentication === 'unchecked' && item.isolation === 'unverified')).toBe(true);
    // Finding both workers opens the local worker and the Codex and Gemini single modes; Claude Code stays closed.
    expect(report.modes.map(mode => [mode.mode, mode.ready, mode.reason])).toEqual([['local-worker', true, LOCAL_WORKER_READY],
      ['codex', true, SINGLE_READY], ['antigravity', true, SINGLE_READY], ['claude-code', false, CLAUDE_CODE_CLOSED]]);
    expect(runProcess).toHaveBeenCalledTimes(3);
    for (const [request] of vi.mocked(runProcess).mock.calls) {
      expect(inner(request).args).toEqual(['--version']);
      expect(request.stdin).toBeUndefined();
    }
    expect(rm).toHaveBeenCalled();
  });
  it('checks the codex and agy versions inside the fence with their own app home; Claude Code, without one, as it is', async () => {
    await new LocalAiRuntime(appCodexHome, appAgyHome).checkConnections();
    const calls = vi.mocked(runProcess).mock.calls.map(([request]) => request);
    const of = (binary: string) => calls.find(request => inner(request).executable.endsWith(`/${binary}`))!;
    for (const [binary, own, other] of [['codex', appCodexHome, appAgyHome], ['agy', appAgyHome, appCodexHome]]) {
      expect(of(binary).executable, binary).toBe('/usr/bin/sandbox-exec');
      expect(of(binary).args[1]).toContain(`(allow file-write* (subpath "${own}") (subpath "/private/tmp/ai-runtime-fixture")`);
      expect(of(binary).args[1]).not.toContain(other);
      expect(of(binary).env?.TMPDIR).toBe('/private/tmp/ai-runtime-fixture');
    }
    expect(of('claude').executable).toBe(`${os.homedir()}/.local/bin/claude`);
  });
  it('distinguishes missing and unusable installations without leaking output', async () => {
    vi.mocked(realpath).mockRejectedValue(new Error('private path'));
    let report = await new LocalAiRuntime(appCodexHome, appAgyHome).checkConnections();
    expect(report.providers.every(item => item.installation === 'missing')).toBe(true);
    expect(runProcess).not.toHaveBeenCalled();
    vi.mocked(realpath).mockImplementation(async (name: unknown) => String(name));
    vi.mocked(runProcess).mockResolvedValue({ stdout: 'PRIVATE_OUTPUT', stderr: 'PRIVATE_PATH', exitCode: 1 });
    report = await new LocalAiRuntime(appCodexHome, appAgyHome).checkConnections();
    expect(report.providers.every(item => item.installation === 'unusable')).toBe(true);
    expect(JSON.stringify(report)).not.toContain('PRIVATE_');
  });
  it('starts a Node script with a node from the fixed locations, never from PATH', async () => {
    heads['/Users/test/.npm-global/bin/codex'] = '#!/usr/bin/env node\n// launcher';
    // Only Homebrew's node exists among the fixed node locations.
    vi.mocked(access).mockImplementation(async name => {
      if (String(name).endsWith('/node') && String(name) !== '/opt/homebrew/bin/node') throw new Error('missing');
    });
    expect(await resolveLaunch('/Users/test/.npm-global/bin/codex', '/Users/test'))
      .toEqual({ executable: '/opt/homebrew/bin/node', prefix: ['/Users/test/.npm-global/bin/codex'] });
    expect(await resolveLaunch('/Users/test/.local/bin/agy', '/Users/test')).toEqual({ executable: '/Users/test/.local/bin/agy', prefix: [] });
  });
  it('reports a Node script without a usable node as unusable, and starts other scripts as they are', async () => {
    heads['/Users/test/.local/bin/codex'] = '#!/usr/bin/env node\n';
    heads['/Users/test/.local/bin/tool'] = '#!/bin/sh\necho';
    vi.mocked(access).mockImplementation(async name => { if (String(name).endsWith('/node')) throw new Error('missing'); });
    expect(await resolveLaunch('/Users/test/.local/bin/codex', '/Users/test')).toBeUndefined();
    expect(await resolveLaunch('/Users/test/.local/bin/tool', '/Users/test')).toEqual({ executable: '/Users/test/.local/bin/tool', prefix: [] });
  });
  it('uses the resolved launch for the version probe of a Node-script install', async () => {
    const home = (await import('node:os')).homedir();
    // As npm installs it: the command is a link to a script inside the package, which the fence reopens.
    const script = `${home}/.npm-global/lib/node_modules/@openai/codex/bin/codex.js`;
    vi.mocked(realpath).mockImplementation(async (name: unknown) => name === `${home}/.local/bin/codex` ? script : String(name));
    heads[script] = '#!/usr/bin/env node\n';
    const report = await new LocalAiRuntime(appCodexHome, appAgyHome).checkConnections();
    expect(report.providers.find(item => item.provider === 'codex')?.installation).toBe('found');
    const codexCall = vi.mocked(runProcess).mock.calls.map(([request]) => inner(request)).find(request => request.args[0] === script);
    expect(codexCall).toMatchObject({ executable: `${home}/.local/bin/node`, args: [script, '--version'] });
  });
  it("gives codex its app-only CODEX_HOME and agy its app-only HOME, created private; claude is unchanged", async () => {
    const before = process.env.CODEX_HOME;
    process.env.CODEX_HOME = '/Users/test/.codex';
    try {
      const report = await new LocalAiRuntime(appCodexHome, appAgyHome).checkConnections();
      expect(report.providers.find(item => item.provider === 'codex')?.message).toContain(`CODEX_HOME="${appCodexHome}" codex login`);
      const calls = vi.mocked(runProcess).mock.calls.map(([request]) => inner(request));
      const codex = calls.find(request => request.executable.endsWith('/codex'))!;
      expect(codex.env?.CODEX_HOME).toBe(appCodexHome);
      expect(Object.keys(codex.env!).every(key => ['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'USER', 'LOGNAME', 'SYSTEMROOT', 'CODEX_HOME'].includes(key))).toBe(true);
      // agy has no folder setting, so its HOME is the app folder and it never gets CODEX_HOME.
      const agy = calls.find(request => request.executable.endsWith('/agy'))!;
      expect(agy.env?.HOME).toBe(appAgyHome);
      expect(agy.env?.CODEX_HOME).toBeUndefined();
      expect(codex.env?.HOME).toBe(process.env.HOME);
      expect(calls.find(request => request.executable.endsWith('/claude'))!.env).toBeUndefined();
      for (const home of [appCodexHome, appAgyHome]) {
        expect(mkdir).toHaveBeenCalledWith(home, { recursive: true, mode: 0o700 });
        // An existing folder is made private as well.
        expect(chmod).toHaveBeenCalledWith(home, 0o700);
      }
      // agy's app-only settings get the deny rules before agy starts.
      expect(written[`${appAgyHome}/.gemini/antigravity-cli/settings.json`]).toContain('"command(*)"');
      expect(written[`${appAgyHome}/.gemini/config/hooks.json`]).toContain('"decision\\":\\"deny');
      expect(JSON.parse(written[`${appAgyHome}/.gemini/config/mcp_config.json`])).toEqual({ mcpServers: {} });
    } finally {
      if (before === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = before;
    }
  });
  it('does not start codex when the app Codex home cannot be prepared or is a link', async () => {
    for (const setup of [
      () => vi.mocked(mkdir).mockRejectedValueOnce(new Error('denied')),
      // A link could point at the user's global ~/.codex.
      () => vi.mocked(lstat).mockResolvedValueOnce({ isDirectory: () => false, isSymbolicLink: () => true } as never),
    ]) {
      vi.mocked(runProcess).mockClear();
      setup();
      const report = await new LocalAiRuntime(appCodexHome, appAgyHome).checkConnections();
      expect(report.providers.find(item => item.provider === 'codex')).toMatchObject({ installation: 'unusable', message: expect.stringContaining('앱 전용 Codex 위치') });
      expect(vi.mocked(runProcess).mock.calls.some(([request]) => inner(request).executable.endsWith('/codex'))).toBe(false);
    }
  });
  it('deduplicates simultaneous inspections', async () => {
    const runtime = new LocalAiRuntime(appCodexHome, appAgyHome);
    const first = runtime.checkConnections();
    expect(runtime.checkConnections()).toBe(first);
    await first;
    expect(runProcess).toHaveBeenCalledTimes(3);
  });
  const privateStage = () => ({ stage: 'explaining' as const, provider: 'antigravity' as const, prompt: 'private code', schema: {}, signal: new AbortController().signal });
  it('opens a mode only after this run found its CLIs, and never Claude Code', async () => {
    const runtime = new LocalAiRuntime(appCodexHome, appAgyHome);
    // Before an installation check nothing is started.
    await expect(runtime.run(privateStage())).rejects.toMatchObject({ code: 'AI_UNAVAILABLE', message: SINGLE_NEEDS.antigravity });
    expect(runProcess).not.toHaveBeenCalled();
    await runtime.checkConnections();
    for (const mode of ['local-worker', 'codex', 'antigravity'] as const) expect(() => runtime.assertReady(mode)).not.toThrow();
    expect(() => runtime.assertReady('claude-code')).toThrow(CLAUDE_CODE_CLOSED);
  });
  it('keeps the local worker and Gemini single closed when Antigravity is missing; Codex single still opens', async () => {
    vi.mocked(realpath).mockImplementation(async (name: unknown) => {
      if (String(name).endsWith('/agy')) throw new Error('missing');
      return String(name);
    });
    const runtime = new LocalAiRuntime(appCodexHome, appAgyHome);
    const report = await runtime.checkConnections();
    expect(report.providers.find(item => item.provider === 'antigravity')?.installation).toBe('missing');
    expect(report.modes.map(mode => [mode.mode, mode.ready, mode.reason]).slice(0, 3)).toEqual([['local-worker', false, LOCAL_WORKER_NEEDS_BOTH],
      ['codex', true, SINGLE_READY], ['antigravity', false, SINGLE_NEEDS.antigravity]]);
    vi.mocked(runProcess).mockClear();
    await expect(runtime.run(privateStage())).rejects.toMatchObject({ code: 'AI_UNAVAILABLE', message: SINGLE_NEEDS.antigravity });
    expect(runProcess).not.toHaveBeenCalled();
  });
  it('opens Gemini single without Codex, and runs its stage; the local worker and Codex single stay closed', async () => {
    vi.mocked(realpath).mockImplementation(async (name: unknown) => {
      if (String(name).endsWith('/codex')) throw new Error('missing');
      return String(name);
    });
    const runtime = new LocalAiRuntime(appCodexHome, appAgyHome);
    const report = await runtime.checkConnections();
    expect(report.modes.map(mode => [mode.mode, mode.ready, mode.reason]).slice(0, 3)).toEqual([['local-worker', false, LOCAL_WORKER_NEEDS_BOTH],
      ['codex', false, SINGLE_NEEDS.codex], ['antigravity', true, SINGLE_READY]]);
    expect(() => runtime.assertReady('local-worker')).toThrow(LOCAL_WORKER_NEEDS_BOTH);
    expect(() => runtime.assertReady('codex')).toThrow(SINGLE_NEEDS.codex);
    vi.mocked(runProcess).mockClear();
    await expect(runtime.run({ ...privateStage(), provider: 'codex' })).rejects.toMatchObject({ code: 'AI_UNAVAILABLE', message: SINGLE_NEEDS.codex });
    expect(runProcess).not.toHaveBeenCalled();
    // The fake output is not an agy answer; what matters is that agy itself was started.
    await runtime.run(privateStage()).catch(() => undefined);
    expect(runProcess).toHaveBeenCalledTimes(1);
    expect(inner(vi.mocked(runProcess).mock.calls[0][0]).executable).toMatch(/\/agy$/);
  });
});

describe('CLI response parsers (synthetic format fixtures, not real AI)', () => {
  // agy stream-json events in the shapes of the official headless docs.
  const agy = (...events: object[]) => events.map(event => JSON.stringify(event)).join('\n');
  const init = (model?: string) => ({ event: 'init', conversation_id: 'c', init: { cwd: '/tmp', tools: [], permission_mode: 'request-review', ...(model ? { model } : {}) } });
  const ok = { event: 'result', conversation_id: 'c', status: 'SUCCESS', structured_output: { summary: 'example' } };
  it.each([
    { provider: 'antigravity' as const, timeoutMs: undefined, expected: 120_000 },
    { provider: 'antigravity' as const, timeoutMs: 240_000, expected: 240_000 },
    { provider: 'codex' as const, timeoutMs: undefined, expected: 120_000 },
    { provider: 'codex' as const, timeoutMs: 240_000, expected: 240_000 },
  ])('passes the same timeout to the process and CLI for $provider with $timeoutMs', async ({ provider, timeoutMs, expected }) => {
    const runtime = new LocalAiRuntime(appCodexHome, appAgyHome);
    await runtime.checkConnections();
    vi.mocked(runProcess).mockClear();
    const stdout = provider === 'antigravity' ? agy(init(GEMINI_MODEL), ok)
      : [{ type: 'item.completed', item: { type: 'agent_message', text: '{"summary":"example"}' } }, { type: 'turn.completed' }]
        .map(event => JSON.stringify(event)).join('\n');
    vi.mocked(runProcess).mockResolvedValue({ stdout, stderr: '', exitCode: 0 });
    const signal = new AbortController().signal;
    await expect(runtime.run({ stage: 'explaining', provider, prompt: 'PROMPT', schema: {}, signal,
      ...(timeoutMs === undefined ? {} : { timeoutMs }) })).resolves.toMatchObject({ value: { summary: 'example' } });
    expect(runProcess).toHaveBeenCalledTimes(1);
    const request = inner(vi.mocked(runProcess).mock.calls[0][0]);
    expect(request.timeoutMs).toBe(expected);
    expect(request.signal).toBe(signal);
    if (provider === 'codex') {
      expect(request.args).not.toContain('--print-timeout');
      return;
    }
    const index = request.args.indexOf('--print-timeout');
    expect(index).toBeGreaterThanOrEqual(0);
    expect(request.args[index + 1]).toBe(`${expected / 1000}s`);
  });

  it('extracts the final agy stream-json result and the model named in init', () => {
    const value = { summary: 'example' };
    expect(parseStageOutput('antigravity', agy(init(GEMINI_MODEL), { event: 'step_update', step_type: 'user_input', state: 'DONE' },
      { event: 'step_update', step_type: 'agent_response', state: 'DONE' }, ok), 0)).toEqual({ value, reportedModel: GEMINI_MODEL });
    // A body nested under the event name and the `response` fallback are read too.
    expect(parseStageOutput('antigravity', agy(init(), { event: 'result', result: { status: 'SUCCESS', response: JSON.stringify(value) } }), 0))
      .toEqual({ value, reportedModel: null });
  });
  it.each([
    ['no init event', [ok]],
    ['a different model', [init('different-model'), ok]],
    ['a tool step', [init(GEMINI_MODEL), { event: 'step_update', step_type: 'tool', tool_name: 'run_command' }, ok]],
    ['a nested tool step', [init(GEMINI_MODEL), { event: 'step_update', step_update: { step_type: 'tool' } }, ok]],
    // A sub-agent call and a question were reported as these kinds in the local A9 run, not as tool steps.
    ['a subagent step', [init(GEMINI_MODEL), { event: 'step_update', step_type: 'subagent', state: 'DONE' }, ok]],
    ['a step without a kind', [init(GEMINI_MODEL), { event: 'step_update', step_index: 2, state: 'ERROR' }, ok]],
    ['no result', [init(GEMINI_MODEL)]],
    ['an error status', [init(GEMINI_MODEL), { event: 'result', status: 'ERROR', error: 'failed' }]],
    ['success with an error', [init(GEMINI_MODEL), { ...ok, error: 'tool denied' }]],
    ['an empty answer', [init(GEMINI_MODEL), { event: 'result', status: 'SUCCESS' }]],
    ['a non-JSON answer', [init(GEMINI_MODEL), { event: 'result', status: 'SUCCESS', response: 'not json' }]],
  ])('rejects agy output with %s', (_name, events) => {
    expect(() => parseStageOutput('antigravity', agy(...events), 0)).toThrow();
  });
  it('sends the agy prompt on stdin as one stream-json user message, never as an argument', async () => {
    const runtime = new LocalAiRuntime(appCodexHome, appAgyHome);
    await runtime.checkConnections();
    vi.mocked(runProcess).mockClear();
    vi.mocked(runProcess).mockResolvedValue({ stdout: agy(init(GEMINI_MODEL), ok), stderr: '', exitCode: 0 });
    const prompt = 'PROMPT_WITH_CODE export const x = 1;';
    const schema = { type: 'object', properties: { summary: { type: 'string' } } };
    await (runtime as unknown as { executeVerifiedStage(request: object): Promise<unknown> })
      .executeVerifiedStage({ stage: 'explaining', provider: 'antigravity', prompt, schema, signal: new AbortController().signal });
    const [request] = vi.mocked(runProcess).mock.calls[0];
    // sandbox-exec -p <profile> <agy> <agy arguments…>
    expect(request.executable).toBe('/usr/bin/sandbox-exec');
    const agyArgs = request.args.slice(3);
    expect(agyArgs).toEqual(expect.arrayContaining(['--input-format', 'stream-json', '--output-format', 'stream-json', '--model', GEMINI_MODEL, '--mode', 'plan', '--sandbox']));
    expect(agyArgs).not.toContain('--disable-slash-commands');
    expect(agyArgs).not.toContain('-p');
    // --json-schema makes agy force an extra internal tool call, so the schema travels in the prompt.
    expect(agyArgs).not.toContain('--json-schema');
    expect(request.args.join(' ')).not.toContain('PROMPT_WITH_CODE');
    const message = JSON.parse(request.stdin!);
    expect(message.event).toBe('user');
    expect(message.message.content.startsWith(prompt)).toBe(true);
    expect(message.message.content).toContain(JSON.stringify(schema));
  });
  it.each([
    ['1.4.12', true], ['1.4.13', true], ['1.5.0', true], ['1.10.0', true], ['2.0.0', true],
    ['1.4.12-beta', true], ['1.4.12+build.1', true],
    ['1.4.11', false], ['1.3.5', false], ['0.10.20', false],
  ])('uses the agy version %s to decide whether to disable slash expansion (%s)', async (version, supported) => {
    vi.mocked(runProcess).mockResolvedValue({ stdout: `agy ${version}\n`, stderr: '', exitCode: 0 });
    const runtime = new LocalAiRuntime(appCodexHome, appAgyHome);
    await runtime.checkConnections();
    expect(runProcess).toHaveBeenCalledTimes(3);
    for (const [request] of vi.mocked(runProcess).mock.calls) expect(inner(request).args).toEqual(['--version']);
    vi.mocked(runProcess).mockClear();
    vi.mocked(runProcess).mockResolvedValue({ stdout: agy(init(GEMINI_MODEL), ok), stderr: '', exitCode: 0 });
    await runtime.run({ stage: 'explaining', provider: 'antigravity', prompt: 'PROMPT', schema: {}, signal: new AbortController().signal });
    expect(runProcess).toHaveBeenCalledTimes(1);
    const args = inner(vi.mocked(runProcess).mock.calls[0][0]).args;
    expect(args).toEqual(['--input-format', 'stream-json', '--output-format', 'stream-json', '--model', GEMINI_MODEL,
      '--mode', 'plan', '--sandbox', ...(supported ? ['--disable-slash-commands'] : []), '--print-timeout', '120s']);
  });
  it('drops the slash expansion option when the same runtime rechecks agy 1.4.12 as 1.4.11', async () => {
    const runtime = new LocalAiRuntime(appCodexHome, appAgyHome);
    for (const version of ['1.4.12', '1.4.11']) {
      vi.mocked(runProcess).mockResolvedValue({ stdout: `agy ${version}\n`, stderr: '', exitCode: 0 });
      await runtime.checkConnections();
      vi.mocked(runProcess).mockClear();
      vi.mocked(runProcess).mockResolvedValue({ stdout: agy(init(GEMINI_MODEL), ok), stderr: '', exitCode: 0 });
      await runtime.run({ stage: 'explaining', provider: 'antigravity', prompt: 'PROMPT', schema: {}, signal: new AbortController().signal });
      expect(runProcess).toHaveBeenCalledTimes(1);
      expect(inner(vi.mocked(runProcess).mock.calls[0][0]).args.includes('--disable-slash-commands')).toBe(version === '1.4.12');
    }
  });
  it.each(['missing', 'nonzero exit', 'unreadable version', 'process failure'])('refuses agy after a successful check followed by %s', async failure => {
    const runtime = new LocalAiRuntime(appCodexHome, appAgyHome);
    vi.mocked(runProcess).mockResolvedValue({ stdout: 'agy 1.4.12\n', stderr: '', exitCode: 0 });
    await runtime.checkConnections();
    expect(() => runtime.assertReady('antigravity')).not.toThrow();
    vi.mocked(realpath).mockImplementation(async name => {
      if (failure === 'missing' && String(name).endsWith('/agy')) throw new Error('missing');
      return String(name);
    });
    vi.mocked(runProcess).mockImplementation(async request => {
      if (!inner(request).executable.endsWith('/agy')) return { stdout: 'cli 1.2.3\n', stderr: '', exitCode: 0 };
      if (failure === 'process failure') throw new Error('version check failed');
      return { stdout: failure === 'unreadable version' ? 'agy unknown\n' : 'agy 1.4.12\n', stderr: '', exitCode: failure === 'nonzero exit' ? 1 : 0 };
    });
    const report = await runtime.checkConnections();
    expect(report.providers.find(item => item.provider === 'antigravity')).toMatchObject({ installation: failure === 'missing' ? 'missing' : 'unusable', version: null });
    expect(report.modes.find(item => item.mode === 'antigravity')).toMatchObject({ ready: false });
    vi.mocked(runProcess).mockClear();
    await expect(runtime.run({ stage: 'explaining', provider: 'antigravity', prompt: 'PROMPT', schema: {}, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'AI_UNAVAILABLE', message: SINGLE_NEEDS.antigravity });
    expect(runProcess).not.toHaveBeenCalled();
  });
  it('passes explicit Codex restrictions for shell, hooks, agents, images, image generation, history notes, web, apps and plugins', async () => {
    const runtime = new LocalAiRuntime(appCodexHome, appAgyHome);
    vi.mocked(runProcess).mockResolvedValue({ stdout: 'cli 1.4.12\n', stderr: '', exitCode: 0 });
    await runtime.checkConnections();
    vi.mocked(runProcess).mockClear();
    const events = [{ type: 'item.completed', item: { type: 'agent_message', text: '{"summary":"example"}' } }, { type: 'turn.completed' }];
    vi.mocked(runProcess).mockResolvedValue({ stdout: events.map(event => JSON.stringify(event)).join('\n'), stderr: '', exitCode: 0 });
    await (runtime as unknown as { executeVerifiedStage(request: object): Promise<unknown> })
      .executeVerifiedStage({ stage: 'organizing', provider: 'codex', prompt: 'PROMPT', schema: {}, signal: new AbortController().signal });
    const args = vi.mocked(runProcess).mock.calls[0][0].args.join(' ');
    expect(args).not.toContain('--disable-slash-commands');
    for (const feature of ['hooks', 'shell_tool', 'multi_agent', 'multi_agent_v2', 'view_image', 'image_generation', 'token_budget', 'context_management', 'apps', 'plugins']) {
      expect(args).toContain(`--disable ${feature}`);
    }
    expect(args).toContain('agents.enabled=false');
    expect(args).toContain('features.code_mode.excluded_tool_namespaces=["functions"]');
    expect(args).toContain('--sandbox read-only');
    expect(args).toContain('web_search="disabled"');
  });
  it('starts every stage inside the macOS fence, with its own app home, the run folder as TMPDIR and the CLI after the profile', async () => {
    const runtime = new LocalAiRuntime(appCodexHome, appAgyHome);
    await runtime.checkConnections();
    vi.mocked(runProcess).mockClear();
    const events = [{ type: 'item.completed', item: { type: 'agent_message', text: '{"summary":"example"}' } }, { type: 'turn.completed' }];
    vi.mocked(runProcess).mockResolvedValue({ stdout: events.map(event => JSON.stringify(event)).join('\n'), stderr: '', exitCode: 0 });
    await stage(runtime, 'codex');
    const [request] = vi.mocked(runProcess).mock.calls[0];
    expect(request.executable).toBe('/usr/bin/sandbox-exec');
    expect(request.args[0]).toBe('-p');
    expect(request.args[2]).toBe(`${os.homedir()}/.local/bin/codex`);
    expect(request.args[3]).toBe('exec');
    expect(request.args[1]).toContain(`(allow file-write* (subpath "${appCodexHome}") (subpath "/private/tmp/ai-runtime-fixture")`);
    expect(request.args[1]).not.toContain(appAgyHome);
    expect(request.env).toMatchObject({ CODEX_HOME: appCodexHome, TMPDIR: '/private/tmp/ai-runtime-fixture' });
  });
  const fenceFailures: [string, () => void][] = [
    ['sandbox-exec is missing', () => vi.mocked(access).mockImplementation(async name => { if (name === '/usr/bin/sandbox-exec') throw new Error('missing'); })],
    ['the Node package of the CLI cannot be found', () => {
      heads[`${os.homedir()}/.local/bin/codex`] = '#!/usr/bin/env node\n';
      // Only the home folder holds a package.json, which must never reopen the whole home.
      vi.mocked(access).mockImplementation(async name => { if (String(name).endsWith('package.json') && name !== `${os.homedir()}/package.json`) throw new Error('missing'); });
    }],
  ];
  it.each(fenceFailures)('does not check the version at all when %s, and reports the fence', async (_case, arrange) => {
    arrange();
    const report = await new LocalAiRuntime(appCodexHome, appAgyHome).checkConnections();
    // The fence's own refusal, not a missing installation.
    expect(report.providers.find(item => item.provider === 'codex')).toMatchObject({ installation: 'unusable', message: expect.stringContaining('울타리') });
    expect(vi.mocked(runProcess).mock.calls.some(([request]) => inner(request).executable.endsWith('/codex')
      || inner(request).args[0]?.endsWith('/codex'))).toBe(false);
  });
  it('does not start a stage at all when sandbox-exec is gone after the version check', async () => {
    const runtime = new LocalAiRuntime(appCodexHome, appAgyHome);
    await runtime.checkConnections();
    fenceFailures[0][1]();
    vi.mocked(runProcess).mockClear();
    await expect(stage(runtime, 'codex')).rejects.toMatchObject({ code: 'AI_UNAVAILABLE', message: expect.stringContaining('울타리') });
    expect(runProcess).not.toHaveBeenCalled();
  });
  it('does not retry without the fence when sandbox-exec cannot apply the profile, for a version check or a stage', async () => {
    vi.mocked(runProcess).mockImplementation(async request => request.executable === '/usr/bin/sandbox-exec'
      ? { stdout: '', stderr: 'sandbox-exec: invalid profile', exitCode: 65 } : { stdout: 'claude 1.2.3\n', stderr: '', exitCode: 0 });
    const report = await new LocalAiRuntime(appCodexHome, appAgyHome).checkConnections();
    expect(report.providers.filter(item => item.installation === 'unusable').map(item => item.provider)).toEqual(['codex', 'antigravity']);
    // One fenced call each, and no codex or agy start outside the fence.
    expect(vi.mocked(runProcess).mock.calls.map(([request]) => request.executable)).toEqual(['/usr/bin/sandbox-exec', '/usr/bin/sandbox-exec', `${os.homedir()}/.local/bin/claude`]);
    const runtime = new LocalAiRuntime(appCodexHome, appAgyHome);
    vi.mocked(runProcess).mockResolvedValue({ stdout: 'codex-cli 1.2.3\n', stderr: '', exitCode: 0 });
    await runtime.checkConnections();
    vi.mocked(runProcess).mockClear();
    vi.mocked(runProcess).mockResolvedValue({ stdout: '', stderr: 'sandbox-exec: invalid profile', exitCode: 65 });
    await expect(stage(runtime, 'codex')).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
    expect(vi.mocked(runProcess).mock.calls.map(([request]) => request.executable)).toEqual(['/usr/bin/sandbox-exec']);
  });
  it('requires completed Codex turns and extracts the final structured message', () => {
    const events = [{ type: 'thread.started', thread_id: 'example' },
      { type: 'item.completed', item: { type: 'agent_message', text: '{"summary":"example"}' } }, { type: 'turn.completed' }];
    expect(parseStageOutput('codex', events.map(event => JSON.stringify(event)).join('\n'), 0)).toEqual({ value: { summary: 'example' }, reportedModel: null });
    expect(() => parseStageOutput('codex', events.slice(0, -1).map(event => JSON.stringify(event)).join('\n'), 0)).toThrow();
  });
  it.each(['command_execution', 'mcp_tool_call', 'file_change'])('rejects unexpected Codex tool reports: %s', type => {
    expect(() => parseStageOutput('codex', JSON.stringify({ type: 'item.started', item: { type } }), 0)).toThrow(/허용하지 않은 도구/);
  });
  it('rejects a Codex run that reported an error item, and says it was an error rather than tool use', () => {
    // Shape seen from codex-cli 0.162.1 when global agent role files are malformed.
    const events = [{ type: 'thread.started' }, { type: 'item.completed', item: { type: 'error', message: 'Ignoring malformed agent role definition' } },
      { type: 'turn.started' }, { type: 'item.completed', item: { type: 'agent_message', text: '{"summary":"x"}' } }, { type: 'turn.completed' }];
    expect(() => parseStageOutput('codex', events.map(event => JSON.stringify(event)).join('\n'), 0)).toThrow(/실행 중 오류를 보고/);
  });
  it('rejects malformed and failed processes without exposing provider output', () => {
    for (const provider of ['codex', 'antigravity'] as const) {
      expect(() => parseStageOutput(provider, '{broken', 0)).toThrow();
      expect(() => parseStageOutput(provider, 'SECRET_PROVIDER_ERROR', 1)).toThrow(/AI 실행에 실패/);
    }
    expect(() => parseStageOutput('codex', '{"type":"turn.failed","error":{"message":"SECRET"}}', 0)).toThrow(/정상적으로 끝나지/);
  });
});
