import { describe, expect, it } from 'vitest';
import { categoryOfTool, codexAttempts, verdicts, type Attempt, type Category } from './live/isolation';

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
    it('counts a finished web search as a failure, though its event has no status', () => {
      const attempts = codexAttempts(run({ id: '1', type: 'web_search', query: 'weather', action: { type: 'search' } }));
      expect(verdicts(true, none, attempts, null).web).toBe('failed');
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
