import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalAiRuntime, executableCandidates, parseStageOutput, resolveLaunch } from '../src/core/ai/runtime';
import { GEMINI_MODEL } from '../src/shared/ai';
import { runProcess } from '../src/core/ai/process';
import { access, chmod, lstat, mkdir, open, realpath, rm } from 'node:fs/promises';

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
beforeEach(() => {
  vi.clearAllMocks();
  heads = {};
  written = {};
  vi.mocked(realpath).mockImplementation(async (name: unknown) => String(name));
  vi.mocked(access).mockResolvedValue(undefined);
  vi.mocked(open).mockImplementation((async (name: string) => ({
    read: async (buffer: Buffer) => ({ buffer, bytesRead: buffer.write(heads[name] ?? '\xCF\xFA\xED\xFE', 'latin1') }),
    chmod: async () => undefined,
    writeFile: async (text: string) => { written[name] = text; },
    close: async () => undefined,
  })) as unknown as typeof open);
  vi.mocked(runProcess).mockResolvedValue({ stdout: 'codex-cli 1.2.3\n', stderr: '', exitCode: 0 });
});

describe('local connection readiness', () => {
  it('uses fixed install locations, never the selected project or a shell command', () => {
    expect(executableCandidates('codex', '/Users/test')).toEqual([
      '/Users/test/.local/bin/codex', '/Users/test/.npm-global/bin/codex', '/opt/homebrew/bin/codex', '/usr/local/bin/codex',
    ]);
  });
  it('only probes versions and never claims authentication or isolation succeeded', async () => {
    const report = await new LocalAiRuntime(appCodexHome, appAgyHome).checkConnections();
    expect(report.providers).toHaveLength(3);
    expect(report.providers.every(item => item.installation === 'found' && item.authentication === 'unchecked' && item.isolation === 'unverified')).toBe(true);
    expect(report.modes.every(mode => !mode.ready)).toBe(true);
    expect(runProcess).toHaveBeenCalledTimes(3);
    for (const [request] of vi.mocked(runProcess).mock.calls) {
      expect(request.args).toEqual(['--version']);
      expect(request.stdin).toBeUndefined();
    }
    expect(rm).toHaveBeenCalled();
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
    heads[`${home}/.local/bin/codex`] = '#!/usr/bin/env node\n';
    const report = await new LocalAiRuntime(appCodexHome, appAgyHome).checkConnections();
    expect(report.providers.find(item => item.provider === 'codex')?.installation).toBe('found');
    const codexCall = vi.mocked(runProcess).mock.calls.find(([request]) => request.args[0] === `${home}/.local/bin/codex`);
    expect(codexCall?.[0]).toMatchObject({ executable: `${home}/.local/bin/node`, args: [`${home}/.local/bin/codex`, '--version'] });
  });
  it("gives codex its app-only CODEX_HOME and agy its app-only HOME, created private; claude is unchanged", async () => {
    const before = process.env.CODEX_HOME;
    process.env.CODEX_HOME = '/Users/test/.codex';
    try {
      const report = await new LocalAiRuntime(appCodexHome, appAgyHome).checkConnections();
      expect(report.providers.find(item => item.provider === 'codex')?.message).toContain(`CODEX_HOME="${appCodexHome}" codex login`);
      const calls = vi.mocked(runProcess).mock.calls.map(([request]) => request);
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
      expect(vi.mocked(runProcess).mock.calls.some(([request]) => request.executable.endsWith('/codex'))).toBe(false);
    }
  });
  it('deduplicates simultaneous inspections', async () => {
    const runtime = new LocalAiRuntime(appCodexHome, appAgyHome);
    const first = runtime.checkConnections();
    expect(runtime.checkConnections()).toBe(first);
    await first;
    expect(runProcess).toHaveBeenCalledTimes(3);
  });
  it('blocks real model invocation even after successful installation detection', async () => {
    const runtime = new LocalAiRuntime(appCodexHome, appAgyHome);
    await runtime.checkConnections();
    vi.mocked(runProcess).mockClear();
    await expect(runtime.run({ stage: 'explaining', provider: 'antigravity', prompt: 'private code', schema: {}, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
    expect(runProcess).not.toHaveBeenCalled();
    for (const mode of ['local-worker', 'codex', 'claude-code', 'antigravity'] as const) {
      expect(() => runtime.assertReady(mode)).toThrow();
    }
  });
});

describe('CLI response parsers (synthetic format fixtures, not real AI)', () => {
  // agy stream-json events in the shapes of the official headless docs.
  const agy = (...events: object[]) => events.map(event => JSON.stringify(event)).join('\n');
  const init = (model?: string) => ({ event: 'init', conversation_id: 'c', init: { cwd: '/tmp', tools: [], permission_mode: 'request-review', ...(model ? { model } : {}) } });
  const ok = { event: 'result', conversation_id: 'c', status: 'SUCCESS', structured_output: { summary: 'example' } };
  it('extracts the final agy stream-json result and the model named in init', () => {
    const value = { summary: 'example' };
    expect(parseStageOutput('antigravity', agy(init(GEMINI_MODEL), { event: 'step_update', step_type: 'agent_response', state: 'DONE' }, ok), 0))
      .toEqual({ value, reportedModel: GEMINI_MODEL });
    // A body nested under the event name and the `response` fallback are read too.
    expect(parseStageOutput('antigravity', agy(init(), { event: 'result', result: { status: 'SUCCESS', response: JSON.stringify(value) } }), 0))
      .toEqual({ value, reportedModel: null });
  });
  it.each([
    ['no init event', [ok]],
    ['a different model', [init('different-model'), ok]],
    ['a tool step', [init(GEMINI_MODEL), { event: 'step_update', step_type: 'tool', tool_name: 'run_command' }, ok]],
    ['a nested tool step', [init(GEMINI_MODEL), { event: 'step_update', step_update: { step_type: 'tool' } }, ok]],
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
    expect(request.args).toEqual(expect.arrayContaining(['--input-format', 'stream-json', '--output-format', 'stream-json', '--model', GEMINI_MODEL, '--mode', 'plan', '--sandbox']));
    expect(request.args).not.toContain('-p');
    // --json-schema makes agy force an extra internal tool call, so the schema travels in the prompt.
    expect(request.args).not.toContain('--json-schema');
    expect(request.args.join(' ')).not.toContain('PROMPT_WITH_CODE');
    const message = JSON.parse(request.stdin!);
    expect(message.event).toBe('user');
    expect(message.message.content.startsWith(prompt)).toBe(true);
    expect(message.message.content).toContain(JSON.stringify(schema));
  });
  it('starts Codex without shell, hooks, sub-agents, web search, account-linked apps or plugins', async () => {
    const runtime = new LocalAiRuntime(appCodexHome, appAgyHome);
    await runtime.checkConnections();
    vi.mocked(runProcess).mockClear();
    const events = [{ type: 'item.completed', item: { type: 'agent_message', text: '{"summary":"example"}' } }, { type: 'turn.completed' }];
    vi.mocked(runProcess).mockResolvedValue({ stdout: events.map(event => JSON.stringify(event)).join('\n'), stderr: '', exitCode: 0 });
    await (runtime as unknown as { executeVerifiedStage(request: object): Promise<unknown> })
      .executeVerifiedStage({ stage: 'organizing', provider: 'codex', prompt: 'PROMPT', schema: {}, signal: new AbortController().signal });
    const args = vi.mocked(runProcess).mock.calls[0][0].args.join(' ');
    for (const feature of ['hooks', 'shell_tool', 'multi_agent', 'apps', 'plugins']) expect(args).toContain(`--disable ${feature}`);
    expect(args).toContain('--sandbox read-only');
    expect(args).toContain('web_search="disabled"');
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
