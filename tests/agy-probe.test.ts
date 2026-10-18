import { describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { agyProbeProfile, collectResponses, forcedCallAllowed, forcedCallResults, forcedCallsPassed, matchResponses, requestShape } from './live/agy-probe';
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
    expect(forcedCallAllowed('send_message', ['send_message'])).toBe(false);
    expect(forcedCallAllowed('view_file', null)).toBe(false);
  });
  it('fails the web kind when the probe address was requested, even with a refused step', () => {
    const none = { read: false, edit: false, shell: false, web: false, mcp: false };
    const refusedWeb: Attempt = { category: 'web', name: 'read_url_content', outcome: 'policy-refused', refusedBy: 'app-hook' };
    expect(placedVerdicts(true, { outside: { ...none, web: true }, inside: none }, [refusedWeb], ['read_url_content']).web).toBe('failed');
  });
});

describe.skipIf(process.platform !== 'darwin')('agy test sandbox profile', () => {
  it('lets agy open a loopback port but connect only to the probe server, and blocks synthetic private files', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'agy-probe-profile-')));
    // The probe server stands outside the sandbox, as in A8.
    const probeServer = createServer(socket => socket.destroy());
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
          console.log(JSON.stringify({ read, bound: typeof bound, otherLoopback, probe: await connect('127.0.0.1', ${probePort}),
            outside: await connect('192.0.2.1', 443), shellOutside, shellInside, childConnect }));
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
    } finally {
      await new Promise<void>(resolve => probeServer.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
});
