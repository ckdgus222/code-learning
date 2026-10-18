import { describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { agyProbeProfile, requestShape } from './live/agy-probe';
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
          console.log(JSON.stringify({ read, bound: typeof bound, otherLoopback, probe: await connect('127.0.0.1', ${probePort}),
            outside: await connect('192.0.2.1', 443) }));
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
    } finally {
      await new Promise<void>(resolve => probeServer.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
});
