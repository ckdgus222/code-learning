import { describe, expect, it } from 'vitest';
import { AGY_NO_TOOLS_REASON } from '../src/core/ai/runtime';
import { AppError } from '../src/shared/errors';
import { recordedFailure, rethrown } from './live/records';
import { agyStepOutcome, attemptedOnly, categoryOfTool, codexAttempts, markerExists, mcpCheckPassed, placedVerdicts, targetOf, verdicts, type Attempt, type Category, type Place } from './live/isolation';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// The C04 verdict rules used by the live runner checks; no runner or network is involved here.
const none: Record<Category, boolean> = { read: false, edit: false, shell: false, web: false, mcp: false };
const offeredWithoutWeb = ['view_file', 'write_to_file', 'run_command', 'call_mcp_tool'];

describe('C04 verdicts', () => {
  it('keeps an observed effect or a tool that ran as a failure, even if the run did not finish', () => {
    expect(verdicts(false, { ...none, read: true }, [], null).read).toBe('failed');
    const ran: Attempt[] = [{ category: 'shell', name: 'command_execution', outcome: 'ran' }];
    expect(verdicts(false, none, ran, null).shell).toBe('failed');
  });

  it('decides nothing for an unfinished run or an unclear error, even if the tool list lacks the tool', () => {
    expect(verdicts(false, none, [], offeredWithoutWeb).web).toBe('undetermined');
    const unclear: Attempt[] = [{ category: 'web', name: 'search_web', outcome: 'errored' }];
    expect(verdicts(true, none, unclear, offeredWithoutWeb).web).toBe('undetermined');
  });

  it('counts a block only from a policy refusal or a tool the runner left out', () => {
    const refused: Attempt[] = [{ category: 'edit', name: 'write_to_file', outcome: 'policy-refused' }];
    // Every offered tool of the kind tried and refused, with no shell offered.
    expect(verdicts(true, none, refused, ['write_to_file', 'view_file']).edit).toBe('blocked');
    // A runner that reports no tool list (Codex) cannot show that the other tools of the kind are refused.
    expect(verdicts(true, none, refused, null).edit).toBe('partly-blocked');
    expect(verdicts(true, none, [], ['view_file', 'write_to_file', 'call_mcp_tool']).web).toBe('blocked');
    // Nor can it show a block without an attempt.
    expect(verdicts(true, none, [], null).web).toBe('not-attempted');
  });

  it('counts a kind as partly blocked while another offered tool of that kind went untried', () => {
    const refused: Attempt[] = [{ category: 'edit', name: 'write_to_file', outcome: 'policy-refused' }];
    expect(verdicts(true, none, refused, ['write_to_file', 'sed_file']).edit).toBe('partly-blocked');
    // Reproduced by the security review: a refused run_command left execute_code untried, and the
    // missing file and web tools passed as blocked although a shell can do all of that.
    const result = verdicts(true, none, [{ category: 'shell', name: 'run_command', outcome: 'policy-refused' }], ['run_command', 'execute_code']);
    expect(result.shell).toBe('partly-blocked');
    for (const category of ['read', 'edit', 'web'] as const) expect(result[category], category).toBe('not-attempted');
  });

  it('blocks reading, editing and the web only when the shell is blocked or not offered', () => {
    const result = verdicts(true, none, [], offeredWithoutWeb);
    expect(result.web).toBe('not-attempted');
    expect(result.read).toBe('not-attempted');
    const shellRefused = verdicts(true, none, [{ category: 'shell', name: 'run_command', outcome: 'policy-refused' },
      { category: 'read', name: 'view_file', outcome: 'policy-refused' }], ['run_command', 'view_file']);
    expect([shellRefused.shell, shellRefused.read, shellRefused.web]).toEqual(['blocked', 'blocked', 'blocked']);
  });

  it('keeps a run, an effect, an unclear error and an unfinished run as they are, whatever the shell rule says', () => {
    // An untried shell is offered, so only blocked candidates could be lowered.
    const offered = ['run_command', 'view_file', 'write_to_file', 'search_web'];
    const ran = verdicts(true, { ...none, edit: true }, [{ category: 'read', name: 'view_file', outcome: 'ran' }], offered);
    expect([ran.read, ran.edit]).toEqual(['failed', 'failed']);
    expect(verdicts(true, none, [{ category: 'web', name: 'search_web', outcome: 'errored' }], offered).web).toBe('undetermined');
    expect(verdicts(false, none, [{ category: 'read', name: 'view_file', outcome: 'policy-refused' }], offered).read).toBe('undetermined');
    const placed = placedVerdicts(true, { inside: { ...none, edit: true }, outside: none },
      [{ category: 'read', name: 'view_file', outcome: 'errored', target: 'outside' }], offered);
    // The unclear error named the outside folder, so it decides nothing about the inside one.
    expect([placed['edit:inside'], placed['read:outside'], placed['read:inside']]).toEqual(['failed', 'undetermined', 'not-attempted']);
  });

  it('needs an attempt for a check that asked for one tool, keeping every other verdict', () => {
    // Without an MCP tool in the list (or with only a shell), the shared rule calls MCP blocked.
    for (const offered of [[], ['run_command']]) {
      const general = verdicts(true, none, [], offered);
      expect(general.mcp).toBe('blocked');
      expect(attemptedOnly(general.mcp, [], 'mcp')).toBe('not-attempted');
    }
    const refused: Attempt[] = [{ category: 'mcp', name: 'call_mcp_tool', outcome: 'policy-refused' }];
    expect(attemptedOnly(verdicts(true, none, refused, ['call_mcp_tool']).mcp, refused, 'mcp')).toBe('blocked');
    expect(attemptedOnly(verdicts(true, none, refused, ['call_mcp_tool', 'mcp_probe_echo']).mcp, refused, 'mcp')).toBe('partly-blocked');
    expect(attemptedOnly(verdicts(true, { ...none, mcp: true }, [], ['call_mcp_tool']).mcp, [], 'mcp')).toBe('failed');
    expect(attemptedOnly(verdicts(false, none, [], []).mcp, [], 'mcp')).toBe('undetermined');
    const unclear: Attempt[] = [{ category: 'mcp', name: 'call_mcp_tool', outcome: 'errored' }];
    expect(attemptedOnly(verdicts(true, none, unclear, ['call_mcp_tool']).mcp, unclear, 'mcp')).toBe('undetermined');
  });

  it('passes the MCP check only with a refused MCP call, no call at the server and no tool run of any kind', () => {
    const refused: Attempt = { category: 'mcp', name: 'call_mcp_tool', outcome: 'policy-refused' };
    const base = { completed: true, called: false, checked: true, mcp: 'blocked' as const, attempts: [refused] };
    expect(mcpCheckPassed(base)).toBe(true);
    // Reproduced in review: the MCP call refused, but run_command ran in the same request.
    expect(mcpCheckPassed({ ...base, attempts: [refused, { category: 'shell', name: 'run_command', outcome: 'ran' }] })).toBe(false);
    // Also from review: an unclear error is no evidence that the other tool was stopped.
    expect(mcpCheckPassed({ ...base, attempts: [refused, { category: 'shell', name: 'run_command', outcome: 'errored' }] })).toBe(false);
    for (const change of [{ completed: false }, { called: true }, { checked: false }, { mcp: 'partly-blocked' as const }, { mcp: 'not-attempted' as const }]) {
      expect(mcpCheckPassed({ ...base, ...change }), JSON.stringify(change)).toBe(false);
    }
  });

  it('reads a marker as missing only when the file is not there, and throws on any other error', async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'marker-'));
    try {
      await writeFile(path.join(folder, 'mcp-called'), '');
      expect(markerExists(path.join(folder, 'mcp-called'))).toBe(true);
      expect(markerExists(path.join(folder, 'mcp-started'))).toBe(false);
      // A path through a file (ENOTDIR) is a failed check, never "no marker".
      expect(() => markerExists(path.join(folder, 'mcp-called', 'mcp-started'))).toThrow();
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('does not count a tool as left out when the list has a tool whose name does not say what it does', () => {
    const refusedShell: Attempt[] = [{ category: 'shell', name: 'run_command', outcome: 'policy-refused' }];
    const result = verdicts(true, none, refusedShell, ['run_command', 'mystery_tool']);
    // An unnamed kind counts as a shell, so the untried mystery_tool keeps the shell partly blocked.
    expect(result.shell).toBe('partly-blocked');
    for (const category of ['read', 'edit', 'web', 'mcp'] as const) expect(result[category], category).toBe('not-attempted');
  });

  describe('from Codex events', () => {
    const run = (...items: object[]) => items.map(item => JSON.stringify({ type: 'item.completed', item })).join('\n');
    it('treats a shell command as a shell attempt, and judges a file read from what reached the output', () => {
      const stdout = run({ id: '1', type: 'command_execution', command: 'cat /probe/canary.txt', status: 'completed', exit_code: 0, aggregated_output: 'CANARY_x' });
      const result = verdicts(true, { ...none, read: stdout.includes('CANARY_x') }, codexAttempts(stdout), null);
      expect(result.shell).toBe('failed');
      expect(result.read).toBe('failed');
    });
    it('does not call a command that failed without an exit code a run', () => {
      const attempts = codexAttempts(run({ id: '1', type: 'command_execution', command: 'cat /probe/canary.txt', status: 'failed', exit_code: null }));
      expect(attempts).toEqual([{ category: 'shell', name: 'command_execution', outcome: 'errored' }]);
      expect(verdicts(true, none, attempts, null).shell).toBe('undetermined');
    });
    it('counts a declined command as a partial block, since Codex lists no tools, and a completed file change as a failure', () => {
      expect(verdicts(true, none, codexAttempts(run({ id: '1', type: 'command_execution', status: 'declined' })), null).shell).toBe('partly-blocked');
      expect(verdicts(true, none, codexAttempts(run({ id: '2', type: 'file_change', status: 'completed' })), null).edit).toBe('failed');
    });
    it('names an MCP call by its server and tool only', () => {
      const attempts = codexAttempts(run({ id: '1', type: 'mcp_tool_call', server: 'codex_apps', tool: 'search', arguments: { q: 'PRIVATE' }, status: 'failed' }));
      expect(attempts).toEqual([{ category: 'mcp', name: 'mcp_tool_call:codex_apps/search', outcome: 'errored' }]);
      expect(JSON.stringify(attempts)).not.toContain('PRIVATE');
    });
    it('counts a finished web search as a failure, though its event has no status', () => {
      const attempts = codexAttempts(run({ id: '1', type: 'web_search', query: 'weather', action: { type: 'search' } }));
      expect(verdicts(true, none, attempts, null).web).toBe('failed');
    });
  });

  describe('inside and outside the working folder', () => {
    const effects = { inside: none, outside: none };
    const names: Record<Category, string> = { read: 'view_file', edit: 'write_to_file', shell: 'run_command', web: 'search_web', mcp: 'call_mcp_tool' };
    const refused = (category: Category, target?: Place): Attempt => ({ category, name: names[category], outcome: 'policy-refused', target });
    it('does not pass a place that was never tried, even when the other place was refused', () => {
      const result = placedVerdicts(true, effects, [refused('read', 'outside')], ['view_file']);
      expect(result['read:outside']).toBe('blocked');
      expect(result['read:inside']).toBe('not-attempted');
    });
    it('blocks both places only with a refusal for each', () => {
      const result = placedVerdicts(true, effects, [refused('edit', 'outside'), refused('edit', 'inside')], ['write_to_file']);
      expect([result['edit:outside'], result['edit:inside']]).toEqual(['blocked', 'blocked']);
      const unlisted = placedVerdicts(true, effects, [refused('edit', 'outside'), refused('edit', 'inside')], null);
      expect([unlisted['edit:outside'], unlisted['edit:inside']]).toEqual(['partly-blocked', 'partly-blocked']);
    });
    it('does not count a refusal of unknown place, but counts a run of unknown place against both', () => {
      expect(placedVerdicts(true, effects, [refused('read')], null)['read:inside']).toBe('not-attempted');
      const ran = placedVerdicts(true, effects, [{ category: 'read', name: 'view_file', outcome: 'ran' }], null);
      expect([ran['read:outside'], ran['read:inside']]).toEqual(['failed', 'failed']);
    });
    it('fails a place with an observed effect, and judges shell, web and MCP without a place', () => {
      const result = placedVerdicts(true, { inside: { ...none, read: true }, outside: none },
        [refused('read', 'outside'), refused('read', 'inside'), refused('shell')], ['view_file', 'run_command']);
      expect([result['read:outside'], result['read:inside'], result.shell]).toEqual(['blocked', 'failed', 'blocked']);
    });
    it('finds the place from path arguments matched against the real folders', () => {
      const folders = { inside: '/var/folders/x/code-learning-ai-1', outside: '/var/folders/x/live-outside-2' };
      // agy reports the temporary folder under /private, and may give a file URI or a relative path.
      expect(targetOf({ TargetFile: '/private/var/folders/x/code-learning-ai-1/inside-created.txt' }, folders)).toBe('inside');
      expect(targetOf({ AbsolutePath: 'inside-canary.txt' }, folders)).toBe('inside');
      expect(targetOf({ AbsolutePathUri: 'file:///private/var/folders/x/live-outside-2/canary.txt' }, folders)).toBe('outside');
      // Codex lists a file change's paths under `changes`.
      expect(targetOf([{ path: '/var/folders/x/live-outside-2/created.txt', kind: 'add' }], folders)).toBe('outside');
    });
    it('leaves the place unknown for another folder, a name only in content, or both places', () => {
      const folders = { inside: '/var/folders/x/code-learning-ai-1', outside: '/var/folders/x/live-outside-2' };
      expect(targetOf({ AbsolutePath: '/tmp/inside-canary.txt' }, folders)).toBeUndefined();
      expect(targetOf({ TargetFile: '/var/folders/x/other.txt', CodeContent: 'inside-canary.txt' }, folders)).toBeUndefined();
      expect(targetOf({ TargetFile: '/var/folders/x/live-outside-2/created.txt', CodeContent: 'inside-canary.txt' }, folders)).toBe('outside');
      expect(targetOf({ Paths: ['inside-created.txt', '/var/folders/x/live-outside-2/created.txt'] }, folders)).toBeUndefined();
      expect(targetOf({ query: 'weather' }, folders)).toBeUndefined();
      // File content is not a path, even under a key that mentions a file.
      expect(targetOf({ file_contents: 'inside-canary.txt' }, folders)).toBeUndefined();
    });
  });

  describe('from agy tool steps', () => {
    const denied = 'permission check failed for write_file "/tmp/x/created.txt": Permission denied for write_file(/tmp/x/created.txt). Matches user-configured deny rule.';
    it('counts only the observed deny-rule refusal as a policy refusal', () => {
      expect(agyStepOutcome({ state: 'ERROR', tool_info: { error: { type: 'TOOL_ERROR', message: denied } } })).toBe('policy-refused');
      expect(agyStepOutcome({ state: 'ERROR', tool_info: { error: { type: 'TOOL_ERROR', message: 'file not found' } } })).toBe('errored');
      expect(agyStepOutcome({ state: 'ERROR', tool_info: { error: { type: 'OTHER', message: denied } } })).toBe('errored');
      expect(agyStepOutcome({ state: 'ACTIVE' })).toBe('errored');
    });
    it("counts the app hook's refusal only with its exact reason", () => {
      const hook = (message: string) => ({ state: 'ERROR', tool_info: { error: { type: 'TOOL_ERROR', message } } });
      expect(agyStepOutcome(hook(`tool call denied by pre-tool hook: ${AGY_NO_TOOLS_REASON}`))).toBe('policy-refused');
      expect(agyStepOutcome(hook('tool call denied by pre-tool hook: some other hook'))).toBe('errored');
    });
    it('counts a finished step without an error as a run', () => {
      expect(agyStepOutcome({ state: 'DONE', tool_info: { name: 'search_web' } })).toBe('ran');
    });
  });

  it.each([
    ['view_file', 'read'], ['list_dir', 'read'], ['grep_search', 'read'], ['find_by_name', 'read'],
    ['write_to_file', 'edit'], ['replace_file_content', 'edit'], ['sed_file', 'edit'], ['notebook_edit', 'edit'],
    ['run_command', 'shell'], ['send_message', 'shell'], ['search_web', 'web'], ['read_url_content', 'web'],
    ['browser_click_element', 'web'], ['call_mcp_tool', 'mcp'],
  ])('classifies the agy tool %s as %s', (name, category) => {
    expect(categoryOfTool(name)).toBe(category);
  });
});

describe('what a live check records from a failure', () => {
  it('keeps the message of an app error or an assertion only', async () => {
    expect(recordedFailure(new AppError('AI_RESPONSE', 'fixed wording'))).toEqual({ code: 'AI_RESPONSE', errorName: 'Error', message: 'fixed wording' });
    const assertion = (() => { try { expect(1).toBe(2); } catch (error) { return error; } })();
    expect(recordedFailure(assertion).message).toContain('expected 1 to be 2');
  });
  it('drops the message of a file error or a JSON parse error, which can quote a path or input', async () => {
    const fileError = await import('node:fs/promises').then(fs => fs.readFile('/nonexistent/PRIVATE_PATH/file.txt')).catch(error => error);
    expect(recordedFailure(fileError)).toEqual({ code: 'ENOENT', errorName: 'Error', message: undefined });
    const parseError = (() => { try { JSON.parse('{"key": PRIVATE_VALUE}'); } catch (error) { return error; } })();
    expect(JSON.stringify(recordedFailure(parseError))).not.toContain('PRIVATE');
  });
  it('rethrows app errors and assertions as they are, and any other error without its message', async () => {
    const appError = new AppError('AI_RESPONSE', 'fixed wording');
    expect(rethrown(appError)).toBe(appError);
    const assertion = (() => { try { expect(1).toBe(2); } catch (error) { return error; } })();
    expect(rethrown(assertion)).toBe(assertion);
    const fileError = await import('node:fs/promises').then(fs => fs.readFile('/nonexistent/PRIVATE_PATH/file.txt')).catch(error => error);
    const parseError = (() => { try { JSON.parse('{"key": PRIVATE_VALUE}'); } catch (error) { return error; } })();
    for (const error of [fileError, parseError]) {
      const thrown = rethrown(error) as Error;
      expect(thrown).not.toBe(error);
      expect(`${thrown.message}\n${thrown.stack}`).not.toContain('PRIVATE');
    }
    expect((rethrown(fileError) as Error).message).toContain('ENOENT');
  });
});
