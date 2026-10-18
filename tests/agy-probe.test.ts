import { describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { agyProbeProfile, collectResponses, descendantsOf, forcedCallAllowed, forcedCallResults, forcedCallsPassed, forcedKindSummary, isMainRequest, kindAttempts,
  matchResponses, requestShape, responseShape, type ForcedCallResult } from './live/agy-probe';
import { placedVerdicts } from './live/isolation';
import type { Attempt } from './live/isolation';
import { runProcess } from '../src/core/ai/process';

describe('local agy request shape', () => {
  it('keeps names only: no prompt, instruction, tool description, header value or odd path part', () => {
    const shape = requestShape('POST', '/v1beta/models/gemini-x:streamGenerateContent?alt=sse&PRIVATE%20QUERY=1', {
      'x-goog-api-key': 'PRIVATE_KEY', 'content-type': 'application/json' }, {
      contents: [{ role: 'user', parts: [{ text: 'PRIVATE_PROMPT' }] }],
      systemInstruction: { parts: [{ text: 'PRIVATE_INSTRUCTION' }] },
      tools: [{ functionDeclarations: [{ name: 'view_file', description: 'PRIVATE_DESCRIPTION', parameters: { type: 'object' } },
        { name: 'bad name\nPRIVATE' }] }],
    });
    expect(shape).toEqual({ method: 'POST', path: '/v1beta/models/gemini-x:streamGenerateContent', queryNames: ['alt', '<name>'],
      headerNames: ['content-type', 'x-goog-api-key'], bodyKeys: ['contents', 'systemInstruction', 'tools'], toolNames: ['view_file', '<unnamed>'] });
    expect(JSON.stringify(shape)).not.toContain('PRIVATE');
    // Any path but the official model call, even one of plain letters and digits, is replaced.
    for (const url of ['/v1beta/PRIVATE PATH', '/v1beta/files/PRIVATEsk123abc', '/v1beta/models/PRIVATE:streamGenerateContent']) {
      expect(requestShape('GET', url, {}, null), url).toMatchObject({ path: '<unrecognized-path>', bodyKeys: [], toolNames: null });
    }
  });
});

describe('forced call tracking', () => {
  const calls = [{ label: 'read_out', name: 'view_file' }, { label: 'read_in', name: 'view_file' }, { label: 'shell', name: 'run_command' }];
  const refused = (name: string, refusedBy: Attempt['refusedBy'] = 'app-hook'): Attempt => ({ category: 'read', name, outcome: 'policy-refused', refusedBy });
  const all = calls.map(call => call.label);

  it('pairs steps with calls of the same name in the order they were sent', () => {
    const results = forcedCallResults(calls, all, [refused('view_file'), refused('run_command', 'deny-rule'), refused('view_file')], ['read_out', 'shell']);
    expect(results.map(result => [result.label, result.outcome, result.refusedBy, result.responded])).toEqual([
      ['read_out', 'policy-refused', 'app-hook', true], ['read_in', 'policy-refused', 'app-hook', false], ['shell', 'policy-refused', 'deny-rule', true]]);
    expect(forcedCallsPassed(results, [refused('view_file'), refused('run_command', 'deny-rule'), refused('view_file')], true, false)).toBe(true);
  });

  it("takes the hook's refusal from agy's answer only when the call has no tool step", () => {
    const steps = [refused('view_file'), refused('view_file')];
    // run_command has no tool step here (as agy reports sub-agents and questions under other step types).
    const fromAnswer = forcedCallResults(calls, all, steps, all, { shell: 'app-hook' });
    expect(fromAnswer.at(-1)).toMatchObject({ outcome: 'policy-refused', refusedBy: 'app-hook', evidence: 'response' });
    expect(forcedCallsPassed(fromAnswer, steps, true, false)).toBe(true);
    // Without the exact refusal in the answer, the call stays without a step and fails.
    expect(forcedCallResults(calls, all, steps, all, { shell: null }).at(-1)?.outcome).toBe('no-step');
    // A tool step always wins over the answer, so a run cannot be hidden by a refusal sentence.
    const ran = [...steps, { category: 'shell', name: 'run_command', outcome: 'ran' } as Attempt];
    expect(forcedCallResults(calls, all, ran, all, { shell: 'app-hook' }).at(-1)).toMatchObject({ outcome: 'ran', evidence: 'step' });
    // An unsent call is never refused by an answer.
    expect(forcedCallResults(calls, ['read_out', 'read_in'], steps, all, { shell: 'app-hook' }).at(-1)?.outcome).toBe('no-step');
  });

  it('fails on an unsent call, a call without a step, a run, an unclear step, an unfinished run or execution evidence', () => {
    const steps = [refused('view_file'), refused('view_file'), refused('run_command')];
    expect(forcedCallsPassed(forcedCallResults(calls, ['read_out', 'read_in'], steps, []), steps, true, false)).toBe(false);
    const missing = steps.slice(0, 2);
    expect(forcedCallResults(calls, all, missing, []).at(-1)?.outcome).toBe('no-step');
    expect(forcedCallsPassed(forcedCallResults(calls, all, missing, []), missing, true, false)).toBe(false);
    // A refused call next to a tool that ran is still a failure.
    const mixed = [...steps, { category: 'shell', name: 'run_command', outcome: 'ran' } as Attempt];
    expect(forcedCallsPassed(forcedCallResults(calls, all, mixed, []), mixed, true, false)).toBe(false);
    const unclear = [refused('view_file'), refused('view_file'), { category: 'shell', name: 'run_command', outcome: 'errored' } as Attempt];
    expect(forcedCallsPassed(forcedCallResults(calls, all, unclear, []), unclear, true, false)).toBe(false);
    const results = forcedCallResults(calls, all, steps, []);
    expect(forcedCallsPassed(results, steps, false, false)).toBe(false);
    expect(forcedCallsPassed(results, steps, true, true)).toBe(false);
    // A refusal of no known policy does not count.
    const unknownSource = [refused('view_file'), refused('view_file'), { category: 'shell', name: 'run_command', outcome: 'policy-refused' } as Attempt];
    expect(forcedCallsPassed(forcedCallResults(calls, all, unknownSource, []), unknownSource, true, false)).toBe(false);
  });
});

describe('forced call responses and sending', () => {
  const sent = [{ id: 'call_a', label: 'a', name: 'view_file' }, { id: 'call_b', label: 'b', name: 'view_file' }, { id: 'call_c', label: 'c', name: 'run_command' }];
  it('matches an id exactly, and without an id the k-th response of a name to the k-th call of that name', () => {
    const { matched, unmatched } = matchResponses([{ id: 'call_c', name: 'run_command', response: 'C' }, { id: 'call_zzz', name: 'view_file', response: 'UNKNOWN_ID' }], sent);
    expect([...matched]).toEqual([['c', 'C']]);
    expect(unmatched).toEqual(['UNKNOWN_ID']);
    // Reproduced in review: a lone id-less run_command response must not go to the first read call.
    expect([...matchResponses([{ id: null, name: 'run_command', response: 'R' }], sent).matched]).toEqual([['c', 'R']]);
    // The whole history resent: each view_file response keeps its own call.
    const history = [{ id: null, name: 'view_file', response: 'A' }, { id: null, name: 'view_file', response: 'B' }, { id: null, name: 'run_command', response: 'C' }];
    expect([...matchResponses(history, sent).matched]).toEqual([['a', 'A'], ['b', 'B'], ['c', 'C']]);
    // A response that matches no call, or has no name, is still returned for the leak check.
    expect(matchResponses([{ id: null, name: 'write_to_file', response: 'W' }, { id: null, name: null, response: 'N' }], sent).unmatched).toEqual(['W', 'N']);
  });
  it('keeps every response for the leak check, a repeated id and a later changed answer included', () => {
    const store = { byCall: new Map<string, unknown>(), all: [] as unknown[] };
    const part = (id: string, response: unknown) => ({ functionResponse: { id, name: 'view_file', response } });
    // Reproduced in review: a second response with the same id, then a changed one in the next request.
    collectResponses({ contents: [{ parts: [part('call_a', 'first'), part('call_a', 'CANARY_repeat')] }] }, sent, store);
    collectResponses({ contents: [{ parts: [part('call_a', 'CANARY_changed')] }] }, sent, store);
    expect([...store.byCall]).toEqual([['a', 'first']]);
    expect(JSON.stringify(store.all)).toContain('CANARY_repeat');
    expect(JSON.stringify(store.all)).toContain('CANARY_changed');
  });
  it('sends a forced call only for a fixed-list tool this request declares', () => {
    expect(forcedCallAllowed('view_file', ['view_file', 'run_command'])).toBe(true);
    // Reproduced in review: a request that declares only search_web must not receive view_file.
    expect(forcedCallAllowed('view_file', ['search_web'])).toBe(false);
    expect(forcedCallAllowed('execute_browser_javascript', ['execute_browser_javascript'])).toBe(false);
    expect(forcedCallAllowed('view_file', null)).toBe(false);
  });
  it('fails the web kind when the probe address was requested, even with a refused step', () => {
    const none = { read: false, edit: false, shell: false, web: false, mcp: false };
    const refusedWeb: Attempt = { category: 'web', name: 'read_url_content', outcome: 'policy-refused', refusedBy: 'app-hook' };
    expect(placedVerdicts(true, { outside: { ...none, web: true }, inside: none }, [refusedWeb], ['read_url_content']).web).toBe('failed');
  });
});

describe('forced conversation, processes and kind summary', () => {
  const sent = [{ id: 'call_a', label: 'a', name: 'view_file' }, { id: 'call_b', label: 'b', name: 'run_command' }];
  const history = (...parts: object[]) => ({ contents: [{ role: 'user', parts: [{ text: 'x' }] }, { role: 'model', parts }] });
  const call = (id: string, name: string) => ({ functionCall: { id, name, args: {} } });
  const answer = (id: string, name: string) => ({ functionResponse: { id, name, response: { error: 'refused' } } });

  it('gives the next call only to the forced conversation', () => {
    expect(isMainRequest(history(), true, [], false)).toBe(true);
    expect(isMainRequest(history(), true, [], true)).toBe(false);
    expect(isMainRequest(history(call('call_a', 'view_file'), answer('call_a', 'view_file'), call('call_b', 'run_command'), answer('call_b', 'run_command')), true, sent, true)).toBe(true);
    // Without ids, the last call's name and the number of calls in the history still match.
    expect(isMainRequest(history({ functionCall: { name: 'view_file' } }, { functionResponse: { name: 'view_file' } },
      { functionCall: { name: 'run_command' } }, { functionResponse: { name: 'run_command' } }), true, sent, true)).toBe(true);
  });

  it('needs the whole history in order and the answer to the very last call', () => {
    const twice = [{ id: 'call_a', label: 'a', name: 'view_file' }, { id: 'call_b', label: 'b', name: 'view_file' }];
    // Reproduced in review: two id-less view_file calls with only the first one answered.
    expect(isMainRequest(history({ functionCall: { name: 'view_file' } }, { functionResponse: { name: 'view_file' } }, { functionCall: { name: 'view_file' } }),
      true, twice, true)).toBe(false);
    // An earlier call that is not the one sent, though the count and the last call match.
    expect(isMainRequest(history(call('call_x', 'write_to_file'), answer('call_x', 'write_to_file'), call('call_b', 'run_command'), answer('call_b', 'run_command')),
      true, sent, true)).toBe(false);
  });

  it('treats a later request without tools, a retry and a sub-agent request as not the forced conversation', () => {
    const full = history(call('call_a', 'view_file'), answer('call_a', 'view_file'), call('call_b', 'run_command'), answer('call_b', 'run_command'));
    expect(isMainRequest(full, false, sent, true)).toBe(false);
    // A retry of the previous request: its history ends one call earlier.
    expect(isMainRequest(history(call('call_a', 'view_file'), answer('call_a', 'view_file')), true, sent, true)).toBe(false);
    // A sub-agent starts with a clean history.
    expect(isMainRequest(history(), true, sent, true)).toBe(false);
    // The last call without agy's answer to it.
    expect(isMainRequest(history(call('call_a', 'view_file'), answer('call_a', 'view_file'), call('call_b', 'run_command')), true, sent, true)).toBe(false);
  });

  it('follows children, grandchildren and group members of the probe, and nothing else', () => {
    const table = [
      { pid: 10, ppid: 1, pgid: 10, started: 't10' }, { pid: 11, ppid: 10, pgid: 10, started: 't11' },
      { pid: 12, ppid: 11, pgid: 12, started: 't12' }, { pid: 13, ppid: 1, pgid: 10, started: 't13' },
      { pid: 14, ppid: 12, pgid: 14, started: 't14' }, { pid: 99, ppid: 1, pgid: 99, started: 't99' },
    ];
    const root = [{ pid: 10, started: 't10' }];
    expect([...descendantsOf(table, root).keys()].sort()).toEqual([10, 11, 12, 13, 14]);
    expect(descendantsOf(table, root).get(14)).toBe('t14');
    // The root gone: its group members are still found, and known processes keep their children.
    const gone = table.filter(row => row.pid !== 10 && row.pid !== 11);
    expect([...descendantsOf(gone, root, new Map([[12, 't12']])).keys()].sort()).toEqual([12, 13, 14]);
  });

  it('never takes a reused number or its children', () => {
    // Reproduced in review: the root's number now belongs to another program with a child of its own.
    const reused = [{ pid: 10, ppid: 1, pgid: 10, started: 'other' }, { pid: 20, ppid: 10, pgid: 10, started: 't20' }];
    expect([...descendantsOf(reused, [{ pid: 10, started: 't10' }]).keys()]).toEqual([]);
    // A known process whose number was reused, and that program's child.
    const reusedChild = [{ pid: 12, ppid: 1, pgid: 12, started: 'other' }, { pid: 30, ppid: 12, pgid: 12, started: 't30' }];
    expect([...descendantsOf(reusedChild, [{ pid: 10, started: 't10' }], new Map([[12, 't12']])).keys()]).toEqual([]);
  });

  it("counts an answer as the hook's refusal only in agy's exact refusal shape", () => {
    const sentence = 'tool call denied by pre-tool hook: Fixture reason';
    const refusal = `Created At: 2026-10-18T21:37:34+09:00\nCompleted At: 2026-10-18T21:37:34+09:00\nEncountered error in tool execution: ${sentence}`;
    expect(responseShape({ output: refusal }, 'Fixture reason').source).toBe('app-hook');
    // Reproduced in review: the sentence quoted inside a successful result is no refusal.
    for (const answer of [{ output: `File contents: ${sentence}` }, { output: refusal, result: 'ok' }, { output: `${refusal} and more` },
      { output: { text: refusal } }, { error: refusal }, [refusal], refusal, { output: refusal.replace('Fixture reason', 'Other reason') }]) {
      expect(responseShape(answer, 'Fixture reason').source, JSON.stringify(answer)).toBeNull();
    }
    expect(JSON.stringify(responseShape({ output: refusal }, 'Fixture reason'))).not.toContain('Created At');
  });

  it('fails the check on a step of another kind that no refused call explains', () => {
    const result = (label: string, name: string, evidence: 'step' | 'response'): ForcedCallResult =>
      ({ label, name, sent: true, responded: true, outcome: 'policy-refused', refusedBy: 'app-hook', evidence });
    const results = [result('shell', 'run_command', 'step'), result('question', 'ask_question', 'response')];
    const toolStep: Attempt = { category: 'shell', name: 'run_command', outcome: 'policy-refused', refusedBy: 'app-hook' };
    const unnamed: Attempt = { category: 'shell', name: 'step:unknown', outcome: 'errored', stepType: 'unknown', stepState: 'ERROR' };
    expect(forcedCallsPassed(results, kindAttempts([toolStep, unnamed], results), true, false)).toBe(true);
    // Reproduced in review: one more errored step with nothing to stand for.
    expect(forcedCallsPassed(results, kindAttempts([toolStep, unnamed, unnamed], results), true, false)).toBe(false);
  });

  it('keeps a finished step of another kind in the kind summary, and excuses only an errored one its refused call stands for', () => {
    const none = { read: false, edit: false, shell: false, web: false, mcp: false };
    const result = (label: string, name: string, evidence: 'step' | 'response'): ForcedCallResult =>
      ({ label, name, sent: true, responded: true, outcome: 'policy-refused', refusedBy: 'app-hook', evidence });
    const results = [result('shell', 'run_command', 'step'), result('agent', 'invoke_subagent', 'response'), result('question', 'ask_question', 'response')];
    const toolStep: Attempt = { category: 'shell', name: 'run_command', outcome: 'policy-refused', refusedBy: 'app-hook' };
    const step = (name: string, outcome: Attempt['outcome'], stepType: string, stepState = outcome === 'ran' ? 'DONE' : 'ERROR'): Attempt =>
      ({ category: 'shell', name, outcome, stepType, stepState });
    const offered = ['run_command', 'invoke_subagent', 'ask_question'];
    const refusedSteps = [toolStep, step('invoke_subagent', 'errored', 'subagent'), step('step:unknown', 'errored', 'unknown')];
    expect(forcedKindSummary(true, { outside: none, inside: none }, kindAttempts(refusedSteps, results), offered, 0).shell).toBe('blocked');
    // Reproduced in review: a sub-agent step that finished must fail the kind, whatever the answer said.
    const ranStep = [toolStep, step('invoke_subagent', 'ran', 'subagent'), step('step:unknown', 'errored', 'unknown')];
    expect(forcedKindSummary(true, { outside: none, inside: none }, kindAttempts(ranStep, results), offered, 0).shell).toBe('failed');
    // An errored step of another kind with no refused call to stand for decides nothing.
    const extra = [...refusedSteps, step('step:unknown', 'errored', 'unknown')];
    expect(forcedKindSummary(true, { outside: none, inside: none }, kindAttempts(extra, results), offered, 0).shell).toBe('undetermined');
    // Reproduced in review: a sub-agent step still running is not excused by its refused answer.
    const running = [toolStep, step('invoke_subagent', 'errored', 'subagent', 'RUNNING'), step('step:unknown', 'errored', 'unknown')];
    expect(forcedKindSummary(true, { outside: none, inside: none }, kindAttempts(running, results), offered, 0).shell).toBe('undetermined');
  });

  it('calls no kind blocked when a model request came from an unknown origin', () => {
    const none = { read: false, edit: false, shell: false, web: false, mcp: false };
    const refused = (name: string, category: Attempt['category'], target?: 'inside' | 'outside'): Attempt => ({ category, name, outcome: 'policy-refused', refusedBy: 'app-hook', target });
    const attempts = [refused('view_file', 'read', 'outside'), refused('view_file', 'read', 'inside'), refused('run_command', 'shell')];
    const clean = forcedKindSummary(true, { outside: none, inside: none }, attempts, ['view_file', 'run_command'], 0);
    expect(clean['read:outside']).toBe('blocked');
    const unknown = forcedKindSummary(true, { outside: none, inside: none }, attempts, ['view_file', 'run_command'], 1);
    expect(Object.entries(unknown).filter(([key]) => key !== 'condition').every(([, verdict]) => verdict === 'undetermined')).toBe(true);
    // A process left running counts as a shell effect, which fails the shell kind.
    expect(forcedKindSummary(true, { outside: { ...none, shell: true }, inside: none }, attempts, ['view_file', 'run_command'], 0).shell).toBe('failed');
    // Reproduced in review: a confirmed failure next to an unknown-origin request stays a failure.
    const both = forcedKindSummary(true, { outside: { ...none, web: true }, inside: none }, attempts, ['view_file', 'run_command'], 1);
    expect([both.web, both['read:outside']]).toEqual(['failed', 'undetermined']);
  });
});

describe.skipIf(process.platform !== 'darwin')('agy test sandbox profile', () => {
  it('lets agy open a loopback port but connect only to the probe server, and blocks synthetic private files', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'agy-probe-profile-')));
    // The probe server stands outside the sandbox, as in A8.
    const probeServer = createServer(socket => socket.destroy());
    // A harmless process outside the sandbox, which no sandboxed process may signal.
    const outsider = spawn('/bin/sleep', ['30']);
    const probePort = await new Promise<number>((resolve, reject) => {
      probeServer.once('error', reject);
      probeServer.listen(0, '127.0.0.1', () => { const address = probeServer.address(); if (address && typeof address === 'object') resolve(address.port); });
    });
    try {
      const syntheticPersonalHome = path.join(root, 'synthetic-personal-home');
      const privateFile = path.join(syntheticPersonalHome, '.gemini', 'fixture.txt');
      await mkdir(path.dirname(privateFile), { recursive: true });
      await writeFile(privateFile, 'NOT_A_SECRET');
      // 192.0.2.1 is a documentation address: a refused connect never leaves this computer.
      const script = `
        const net = require('node:net');
        const fs = require('node:fs');
        const connect = (host, port) => new Promise(resolve => {
          const socket = net.connect({ host, port });
          socket.setTimeout(1000);
          socket.once('connect', () => { socket.destroy(); resolve('connected'); });
          socket.once('error', error => { socket.destroy(); resolve(error.code); });
          socket.once('timeout', () => { socket.destroy(); resolve('timeout'); });
        });
        (async () => {
          let read = 'permitted';
          try { fs.readFileSync(${JSON.stringify(privateFile)}); } catch (error) { read = error.code; }
          const server = net.createServer(socket => socket.destroy());
          const bound = await new Promise(resolve => { server.once('error', error => resolve(error.code)); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
          // Another loopback port, such as another local service, stays closed to outgoing connections.
          const otherLoopback = typeof bound === 'number' ? await connect('127.0.0.1', bound) : 'not-bound';
          server.close();
          // A child shell, as run_command would start, stays inside the same profile.
          const { spawnSync } = require('node:child_process');
          const shellOutside = spawnSync('/bin/sh', ['-c', 'echo x > ' + ${JSON.stringify(path.join(os.tmpdir(), 'agy-probe-outside-'))} + process.pid]).status;
          const shellInside = spawnSync('/bin/sh', ['-c', 'echo x > ' + ${JSON.stringify(root)} + '/inside.txt']).status;
          const childConnect = spawnSync(process.execPath, ['-e', "require('node:net').connect({ host: '192.0.2.1', port: 443 }).on('error', e => { console.log(e.code); process.exit(0); })"], { encoding: 'utf8' }).stdout.trim();
          // Signals: none to a process outside the sandbox, but its own child can still be stopped.
          const tryKill = (pid, signal) => { try { process.kill(pid, signal); return 'allowed'; } catch (error) { return error.code; } };
          const ownChild = require('node:child_process').spawn('/bin/sleep', ['5']);
          const signals = { outside: tryKill(${outsider.pid}, 'SIGCONT'), ownChild: tryKill(ownChild.pid, 'SIGTERM') };
          const schedulers = ['/bin/launchctl', '/usr/bin/crontab', '/usr/bin/at'].map(file => { const run = spawnSync(file, ['-l']); return run.error?.code ?? 'started'; });
          // System services are reached by Mach lookups; notifyutil reports a failure when its lookup is refused.
          const notify = spawnSync('/usr/bin/notifyutil', ['-p', 'code-learning-probe'], { encoding: 'utf8' });
          const machLookup = /Failed/.test(notify.stdout + notify.stderr) ? 'refused' : 'reached';
          console.log(JSON.stringify({ read, bound: typeof bound, otherLoopback, probe: await connect('127.0.0.1', ${probePort}),
            outside: await connect('192.0.2.1', 443), shellOutside, shellInside, childConnect, signals, schedulers, machLookup }));
        })();
      `;
      const output = await runProcess({ executable: '/usr/bin/sandbox-exec',
        args: ['-p', agyProbeProfile(root, root, syntheticPersonalHome, probePort), process.execPath, '-e', script],
        cwd: root, env: { HOME: root, PATH: '/usr/bin:/bin' }, signal: new AbortController().signal, timeoutMs: 5000 });
      expect(output.exitCode, output.stderr).toBe(0);
      const result = JSON.parse(output.stdout);
      expect(result.bound).toBe('number');
      expect(result.probe).toBe('connected');
      expect(['EPERM', 'EACCES']).toContain(result.otherLoopback);
      expect(['EPERM', 'EACCES']).toContain(result.outside);
      expect(['EPERM', 'EACCES']).toContain(result.read);
      expect(result.shellOutside).not.toBe(0);
      expect(result.shellInside).toBe(0);
      expect(['EPERM', 'EACCES']).toContain(result.childConnect);
      expect(result.signals).toEqual({ outside: 'EPERM', ownChild: 'allowed' });
      expect(result.schedulers).toEqual(['EPERM', 'EPERM', 'EPERM']);
      expect(result.machLookup).toBe('refused');
    } finally {
      outsider.kill();
      await new Promise<void>(resolve => probeServer.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
});
