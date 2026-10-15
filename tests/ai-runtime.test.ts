import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalAiRuntime, executableCandidates, parseStageOutput } from '../src/core/ai/runtime';
import { GEMINI_MODEL } from '../src/shared/ai';
import { runProcess } from '../src/core/ai/process';
import { realpath, rm } from 'node:fs/promises';

vi.mock('../src/core/ai/process', () => ({ runProcess: vi.fn() }));
vi.mock('node:fs/promises', () => ({
  realpath: vi.fn(async (name: string) => name), access: vi.fn(async () => undefined),
  stat: vi.fn(async () => ({ isFile: () => true })), mkdtemp: vi.fn(async () => '/private/tmp/ai-runtime-fixture'),
  rm: vi.fn(async () => undefined), writeFile: vi.fn(async () => undefined),
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(realpath).mockImplementation(async (name: unknown) => String(name));
  vi.mocked(runProcess).mockResolvedValue({ stdout: 'codex-cli 1.2.3\n', stderr: '', exitCode: 0 });
});

describe('local connection readiness', () => {
  it('uses fixed install locations, never the selected project or a shell command', () => {
    expect(executableCandidates('codex', '/Users/test')).toEqual([
      '/Users/test/.local/bin/codex', '/Users/test/.npm-global/bin/codex', '/opt/homebrew/bin/codex', '/usr/local/bin/codex',
    ]);
  });
  it('only probes versions and never claims authentication or isolation succeeded', async () => {
    const report = await new LocalAiRuntime().checkConnections();
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
    let report = await new LocalAiRuntime().checkConnections();
    expect(report.providers.every(item => item.installation === 'missing')).toBe(true);
    expect(runProcess).not.toHaveBeenCalled();
    vi.mocked(realpath).mockImplementation(async (name: unknown) => String(name));
    vi.mocked(runProcess).mockResolvedValue({ stdout: 'PRIVATE_OUTPUT', stderr: 'PRIVATE_PATH', exitCode: 1 });
    report = await new LocalAiRuntime().checkConnections();
    expect(report.providers.every(item => item.installation === 'unusable')).toBe(true);
    expect(JSON.stringify(report)).not.toContain('PRIVATE_');
  });
  it('deduplicates simultaneous inspections', async () => {
    const runtime = new LocalAiRuntime();
    const first = runtime.checkConnections();
    expect(runtime.checkConnections()).toBe(first);
    await first;
    expect(runProcess).toHaveBeenCalledTimes(3);
  });
  it('blocks real model invocation even after successful installation detection', async () => {
    const runtime = new LocalAiRuntime();
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
  it('extracts agy structured JSON and preserves absent model metadata', () => {
    const value = { summary: 'example' };
    expect(parseStageOutput('antigravity', JSON.stringify({ status: 'SUCCESS', structured_output: value }), 0)).toEqual({ value, reportedModel: null });
    expect(parseStageOutput('antigravity', JSON.stringify({ status: 'SUCCESS', response: JSON.stringify(value), model: GEMINI_MODEL }), 0)).toEqual({ value, reportedModel: GEMINI_MODEL });
  });
  it.each([
    { status: 'ERROR', response: '{}' }, { status: 'CANCELLED', response: '{}' },
    { status: 'SUCCESS', response: '{}' , error: 'tool denied' },
    { status: 'SUCCESS', response: 'not json' }, { status: 'SUCCESS' },
    { status: 'SUCCESS', response: '{}', model: 'different-model' },
  ])('rejects unsuccessful, incomplete and unexpected Gemini results: %j', envelope => {
    expect(() => parseStageOutput('antigravity', JSON.stringify(envelope), 0)).toThrow();
  });
  it('requires completed Codex turns and extracts the final structured message', () => {
    const events = [{ type: 'thread.started', thread_id: 'example' },
      { type: 'item.completed', item: { type: 'agent_message', text: '{"summary":"example"}' } }, { type: 'turn.completed' }];
    expect(parseStageOutput('codex', events.map(event => JSON.stringify(event)).join('\n'), 0)).toEqual({ value: { summary: 'example' }, reportedModel: null });
    expect(() => parseStageOutput('codex', events.slice(0, -1).map(event => JSON.stringify(event)).join('\n'), 0)).toThrow();
  });
  it.each(['command_execution', 'mcp_tool_call', 'file_change'])('rejects unexpected Codex tool reports: %s', type => {
    expect(() => parseStageOutput('codex', JSON.stringify({ type: 'item.started', item: { type } }), 0)).toThrow();
  });
  it('rejects malformed and failed processes without exposing provider output', () => {
    for (const provider of ['codex', 'antigravity'] as const) {
      expect(() => parseStageOutput(provider, '{broken', 0)).toThrow();
      expect(() => parseStageOutput(provider, 'SECRET_PROVIDER_ERROR', 1)).toThrow(/AI 실행에 실패/);
    }
    expect(() => parseStageOutput('codex', '{"type":"turn.failed","error":{"message":"SECRET"}}', 0)).toThrow(/정상적으로 끝나지/);
  });
});
