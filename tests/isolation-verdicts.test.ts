import { describe, expect, it } from 'vitest';
import { AGY_NO_TOOLS_REASON } from '../src/core/ai/runtime';
import { agyStepOutcome, categoryOfTool, codexAttempts, placedVerdicts, targetOf, verdicts, type Attempt, type Category, type Place } from './live/isolation';

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
    const refused: Attempt[] = [{ category: 'edit', name: 'file_change', outcome: 'policy-refused' }];
    expect(verdicts(true, none, refused, null).edit).toBe('blocked');
    const result = verdicts(true, none, [], offeredWithoutWeb);
    expect(result.web).toBe('blocked');
    expect(result.read).toBe('not-attempted');
    // A runner that reports no tool list (Codex) cannot show a block without an attempt.
    expect(verdicts(true, none, [], null).web).toBe('not-attempted');
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
    it('counts a declined command as a policy block and a completed file change as a failure', () => {
      expect(verdicts(true, none, codexAttempts(run({ id: '1', type: 'command_execution', status: 'declined' })), null).shell).toBe('blocked');
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
    const refused = (category: Category, target?: Place): Attempt => ({ category, name: 'tool', outcome: 'policy-refused', target });
    it('does not pass a place that was never tried, even when the other place was refused', () => {
      const result = placedVerdicts(true, effects, [refused('read', 'outside')], null);
      expect(result['read:outside']).toBe('blocked');
      expect(result['read:inside']).toBe('not-attempted');
    });
    it('blocks both places only with a refusal for each', () => {
      const result = placedVerdicts(true, effects, [refused('edit', 'outside'), refused('edit', 'inside')], null);
      expect([result['edit:outside'], result['edit:inside']]).toEqual(['blocked', 'blocked']);
    });
    it('does not count a refusal of unknown place, but counts a run of unknown place against both', () => {
      expect(placedVerdicts(true, effects, [refused('read')], null)['read:inside']).toBe('not-attempted');
      const ran = placedVerdicts(true, effects, [{ category: 'read', name: 'view_file', outcome: 'ran' }], null);
      expect([ran['read:outside'], ran['read:inside']]).toEqual(['failed', 'failed']);
    });
    it('fails a place with an observed effect, and judges shell, web and MCP without a place', () => {
      const result = placedVerdicts(true, { inside: { ...none, read: true }, outside: none },
        [refused('read', 'outside'), refused('read', 'inside'), refused('shell')], null);
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
