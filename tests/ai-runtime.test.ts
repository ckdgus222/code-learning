import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalAiRuntime, executableCandidates, parseStageOutput, resolveLaunch } from '../src/core/ai/runtime';
import { GEMINI_MODEL } from '../src/shared/ai';
import { runProcess } from '../src/core/ai/process';
import { access, open, realpath, rm } from 'node:fs/promises';

vi.mock('../src/core/ai/process', () => ({ runProcess: vi.fn() }));
vi.mock('node:fs/promises', () => ({
  realpath: vi.fn(async (name: string) => name), access: vi.fn(async () => undefined),
  stat: vi.fn(async () => ({ isFile: () => true })), mkdtemp: vi.fn(async () => '/private/tmp/ai-runtime-fixture'),
  rm: vi.fn(async () => undefined), writeFile: vi.fn(async () => undefined), open: vi.fn(),
}));
// The first bytes each fake file starts with; unknown files look like a native executable.
let heads: Record<string, string> = {};
beforeEach(() => {
  vi.clearAllMocks();
  heads = {};
  vi.mocked(realpath).mockImplementation(async (name: unknown) => String(name));
  vi.mocked(access).mockResolvedValue(undefined);
  vi.mocked(open).mockImplementation((async (name: string) => ({
    read: async (buffer: Buffer) => ({ buffer, bytesRead: buffer.write(heads[name] ?? '\xCF\xFA\xED\xFE', 'latin1') }),
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
    const report = await new LocalAiRuntime().checkConnections();
    expect(report.providers.find(item => item.provider === 'codex')?.installation).toBe('found');
    const codexCall = vi.mocked(runProcess).mock.calls.find(([request]) => request.args[0] === `${home}/.local/bin/codex`);
    expect(codexCall?.[0]).toMatchObject({ executable: `${home}/.local/bin/node`, args: [`${home}/.local/bin/codex`, '--version'] });
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
