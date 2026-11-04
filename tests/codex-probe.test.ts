import { describe, expect, it } from 'vitest';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { classifyForced, createCodexProbe, forcedKindVerdict, isEmptyList, observedToolNames, probeProfile, requestInventory } from './live/codex-probe';
import { runProcess } from '../src/core/ai/process';
import modelFixture from './fixtures/codex-model-0.163.0.json';

describe('local Codex request inventory', () => {
  it('distinguishes an observed empty array from missing or malformed definitions', () => {
    expect(requestInventory({ model: 'fixture-model', tools: [] })).toMatchObject({ tools: [], topLevelCount: 0 });
    for (const value of [{ model: 'fixture-model' }, { model: 'fixture-model', tools: null }, { tools: [] }, null,
      { model: 'fixture-model', tools: [{ type: 'unknown-new-tool' }] }, { model: 'fixture-model', tools: [{ type: 'function' }] }]) {
      expect(() => requestInventory(value)).toThrow();
    }
  });

  it('retains namespaces and built-ins without saving prompts, descriptions or schemas', () => {
    const inventory = requestInventory({ model: 'fixture-model', input: 'PRIVATE_PROMPT', tools: [
      { type: 'namespace', name: 'functions', description: 'PRIVATE_DESCRIPTION', tools: [
        { type: 'function', name: 'view_image', parameters: { description: 'PRIVATE_SCHEMA' } },
        { type: 'custom', name: 'apply_patch' },
      ] }, { type: 'image_generation' },
    ] });
    expect(inventory.tools).toEqual([
      { type: 'namespace', name: 'functions' }, { type: 'function', name: 'functions.view_image' },
      { type: 'custom', name: 'functions.apply_patch' }, { type: 'image_generation', name: 'image_generation' },
    ]);
    expect(inventory.definitionsHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(inventory)).not.toContain('PRIVATE');
  });

  it('rejects malformed nested definitions instead of silently omitting tools', () => {
    for (const tool of [{ type: 'namespace', name: 'functions' },
      { type: 'namespace', name: 'functions', tools: [null] }, { type: 'function', name: 'unexpected\nvalue' }]) {
      expect(() => requestInventory({ model: 'fixture-model', tools: [tool] })).toThrow();
    }
  });

  it('observes Responses Lite additional_tools and never mistakes missing definitions for no tools', () => {
    const item = { type: 'additional_tools', role: 'developer', tools: [
      { type: 'namespace', name: 'functions', tools: [{ type: 'function', name: 'view_image' }] },
    ] };
    expect(requestInventory({ model: 'fixture-model', input: [item] })).toMatchObject({
      locations: ['input.additional_tools'], tools: [{ name: 'functions' }, { name: 'functions.view_image' }],
    });
    expect(() => requestInventory({ model: 'fixture-model', input: [{ ...item, tools: null }] })).toThrow();
    expect(() => requestInventory({ model: 'fixture-model', input: [{ type: 'message', content: 'no tools' }] })).toThrow();
    expect(() => requestInventory({ model: 'fixture-model', tools: null, input: [item] })).toThrow();
  });

  it('extracts declared Code Mode tools but excludes examples and reports incomplete visibility', () => {
    const declaration = (heading: string, name: string) => `### \`${heading}\`\nDescription\n\nexec tool declaration:\n\`\`\`ts\ndeclare const tools: { ${name}(args: {}): Promise<unknown>; };\n\`\`\``;
    const inventory = (description: string) => requestInventory({ model: 'fixture-model', tools: [
      { type: 'custom', name: 'exec', description },
    ] }).codeModeTools[0];
    expect(inventory('Example: tools.exec_command(...)')).toMatchObject({ names: [], status: 'unavailable', exhaustive: false });
    expect(inventory(`Example: tools.fake_tool(...)\n${declaration('view_image', 'view_image')}`))
      .toEqual({ source: 'exec-description', names: ['view_image'], declarationBlocks: 1, status: 'parsed', exhaustive: false });
    expect(inventory(declaration('view_image', 'different'))).toMatchObject({ names: [], status: 'unrecognized', exhaustive: false });
  });

  it.runIf(process.platform === 'darwin')('restricts network access to the listener and denies personal configuration and credential paths', () => {
    const profile = probeProfile('/private/tmp/probe', '/private/tmp/cwd', '/Users/fixture', 12345);
    expect(profile).toContain('(deny network*)');
    expect(profile).toContain('(remote ip "localhost:12345")');
    for (const part of ['.codex', '.gemini', 'Library/Keychains', 'Library/Application Support/Code Learning']) {
      expect(profile).toContain(`(subpath "/Users/fixture/${part}")`);
    }
    expect(profile).toContain('(deny file-write*)');
    expect(() => probeProfile('/tmp/x', '/tmp/y', '/Users/fixture', 0)).toThrow();
  });

  it('never treats missing or unreadable Code Mode declarations as evidence that a tool is absent', () => {
    const inventory = (description?: string) => requestInventory({ model: 'fixture-model', tools: [
      { type: 'namespace', name: 'functions', tools: [{ type: 'custom', name: 'exec', description }] },
    ] });
    for (const description of [undefined, 'New description format without declarations', 'exec tool declaration:\nunknown format']) {
      expect(() => observedToolNames(inventory(description))).toThrow('unparsed-code-mode-tools');
    }
    const parsed = inventory('### `apply_patch`\nexec tool declaration:\n```ts\ndeclare const tools: { apply_patch(input: string): Promise<unknown>; };\n```');
    expect(observedToolNames(parsed)).toEqual(['functions.exec', 'apply_patch']);
    expect(() => observedToolNames({ ...parsed, codeModeTools: [] })).toThrow('unparsed-code-mode-tools');
    expect(observedToolNames(requestInventory({ model: 'fixture-model', tools: [] }))).toEqual([]);
  });
});

describe.skipIf(process.platform !== 'darwin')('local Codex probe transport (no CLI)', () => {
  it('changes only the two intended fields in the official model fixture and leaves the app arguments intact', async () => {
    const probe = await createCodexProbe('direct-no-patch-catalog');
    try {
      const catalog = JSON.parse(await readFile(path.join(probe.root, 'model-catalog.json'), 'utf8'));
      expect(catalog.models).toHaveLength(1);
      expect(catalog.models[0]).toEqual({ ...modelFixture.model, tool_mode: 'direct', apply_patch_tool_type: null });
      expect(Object.keys(catalog.models[0]).filter(key => JSON.stringify(catalog.models[0][key]) !== JSON.stringify((modelFixture.model as Record<string, unknown>)[key])))
        .toEqual(['apply_patch_tool_type', 'tool_mode']);
      const args = ['exec', '--ignore-user-config', '--disable', 'apps', '-'];
      const wrapped = probe.wrap({ executable: '/opt/codex', args, cwd: probe.root, env: { CODEX_HOME: probe.codexHome }, signal: new AbortController().signal });
      expect(wrapped.args.slice(wrapped.args.indexOf('--ignore-user-config'))).toEqual(args.slice(1));
      expect(wrapped.args).toContain(`model_catalog_json=${JSON.stringify(path.join(probe.root, 'model-catalog.json'))}`);
      expect(probe.summary().catalogOverride?.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    } finally { await probe.close(); }
  });

  it('enforces the sandbox rules on synthetic private files and a second loopback port', async () => {
    const probe = await createCodexProbe();
    const allowed = createServer(socket => socket.destroy());
    let forbiddenConnections = 0;
    const forbidden = createServer(socket => { forbiddenConnections++; socket.destroy(); });
    const listen = (server: ReturnType<typeof createServer>) => new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') reject(new Error('listener unavailable'));
        else resolve(address.port);
      });
    });
    try {
      const allowedPort = await listen(allowed);
      const forbiddenPort = await listen(forbidden);
      const syntheticPersonalHome = path.join(probe.root, 'synthetic-personal-home');
      const privateFile = path.join(syntheticPersonalHome, '.codex', 'fixture.txt');
      await mkdir(path.dirname(privateFile), { recursive: true });
      await writeFile(privateFile, 'NOT_A_SECRET');
      const script = `
        const net = require('node:net');
        const fs = require('node:fs');
        const connect = port => new Promise(resolve => {
          const socket = net.connect({ host: '127.0.0.1', port });
          socket.setTimeout(1000);
          socket.once('connect', () => { socket.destroy(); resolve('connected'); });
          socket.once('error', error => { socket.destroy(); resolve(error.code); });
          socket.once('timeout', () => { socket.destroy(); resolve('timeout'); });
        });
        (async () => {
          let read = 'permitted';
          try { fs.readFileSync(${JSON.stringify(privateFile)}); } catch (error) { read = error.code; }
          console.log(JSON.stringify({ read, allowed: await connect(${allowedPort}), forbidden: await connect(${forbiddenPort}) }));
        })();
      `;
      const output = await runProcess({ executable: '/usr/bin/sandbox-exec',
        args: ['-p', probeProfile(probe.root, probe.root, syntheticPersonalHome, allowedPort), process.execPath, '-e', script],
        cwd: probe.root, env: { HOME: probe.home, PATH: '/usr/bin:/bin' }, signal: new AbortController().signal, timeoutMs: 5000 });
      expect(output.exitCode, output.stderr).toBe(0);
      const result = JSON.parse(output.stdout);
      expect(result.allowed).toBe('connected');
      expect(['EPERM', 'EACCES']).toContain(result.forbidden);
      expect(['EPERM', 'EACCES']).toContain(result.read);
      expect(forbiddenConnections).toBe(0);
    } finally {
      await Promise.all([allowed, forbidden].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
      await probe.close();
    }
  });

  it('preserves the app arguments and stdin, uses only a temporary home, and cleans up', async () => {
    const probe = await createCodexProbe();
    try {
      const args = ['/opt/codex.js', 'exec', '--ignore-user-config', '--disable', 'apps', '--output-schema', '/tmp/schema', '-'];
      const wrapped = probe.wrap({ executable: '/opt/node', args, cwd: probe.root, stdin: 'PRIVATE_PROMPT',
        env: { CODEX_HOME: probe.codexHome, HOME: '/Users/fixture', OPENAI_API_KEY: 'PRIVATE_TOKEN' }, signal: new AbortController().signal });
      const providerEnd = wrapped.args.indexOf('--ignore-user-config');
      expect(wrapped.args.slice(providerEnd)).toEqual(args.slice(2));
      expect(wrapped.args.slice(3, 5)).toEqual(['/opt/codex.js', 'exec']);
      expect(wrapped.executable).toBe('/usr/bin/sandbox-exec');
      expect(wrapped.stdin).toBe('PRIVATE_PROMPT');
      expect(wrapped.env).toEqual({ CODEX_HOME: probe.codexHome, HOME: probe.home, TMPDIR: probe.root, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' });
      // A stage the app already fenced runs the same inner command under the probe's own profile.
      const fenced = probe.wrap({ executable: '/usr/bin/sandbox-exec', args: ['-p', '(version 1)\n(allow default)\n', '/opt/node', ...args], cwd: probe.root,
        stdin: 'PRIVATE_PROMPT', env: { CODEX_HOME: probe.codexHome }, signal: new AbortController().signal });
      expect(fenced.args).toEqual(wrapped.args);
      expect(() => probe.wrap({ ...wrapped, env: { CODEX_HOME: '/Users/fixture/.codex' } })).toThrow();
      expect(() => probe.wrap({ ...wrapped, env: { CODEX_HOME: `${probe.root}/../outside` } })).toThrow();
      expect(JSON.stringify(probe.summary())).not.toContain('PRIVATE');
    } finally { await probe.close(); }
    await expect(stat(probe.root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns only a static assistant message and refuses authenticated or malformed requests', async () => {
    const probe = await createCodexProbe();
    try {
      const wrapped = probe.wrap({ executable: '/opt/codex', args: ['exec', '-'], cwd: probe.root,
        env: { CODEX_HOME: probe.codexHome }, signal: new AbortController().signal });
      const setting = wrapped.args.find(arg => arg.startsWith('model_providers.code_learning_probe.base_url='))!;
      const url = `${JSON.parse(setting.slice(setting.indexOf('=') + 1))}/responses`;
      const body = JSON.stringify({ model: 'fixture-model', tools: [], input: 'PRIVATE_PROMPT' });
      const valid = await fetch(url, { method: 'POST', body });
      expect(valid.status).toBe(200);
      const response = await valid.text();
      expect(response).toContain('response.completed');
      expect(response).not.toContain('function_call');
      expect(probe.inventories).toHaveLength(1);
      const authenticated = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer PRIVATE_TOKEN' }, body });
      expect(authenticated.status).toBe(400);
      await authenticated.text();
      const malformed = await fetch(url, { method: 'POST', body: '{PRIVATE_INVALID' });
      expect(malformed.status).toBe(400);
      await malformed.text();
      expect(probe.failures).toEqual(['unexpected-authentication', 'invalid-request-inventory']);
      expect(probe.inventories).toHaveLength(1);
      expect(JSON.stringify(probe.summary())).not.toContain('PRIVATE');
    } finally { await probe.close(); }
    await expect(stat(path.join(probe.root, 'home'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('forced call outcomes', () => {
  const canary = 'CANARY_fixture';
  it("counts only Codex's own no-such-tool reply and its exact patch refusals as blocks", () => {
    expect(classifyForced('unsupported call: exec_command', canary).outcome).toBe('unavailable');
    expect(classifyForced('unsupported custom tool call: apply_patch', canary).outcome).toBe('unavailable');
    expect(classifyForced([{ type: 'input_text', text: 'unsupported call: web.run' }], canary).outcome).toBe('unavailable');
    expect(classifyForced('patch rejected: writing is blocked by read-only sandbox; rejected by user approval settings', canary).outcome).toBe('refused');
    expect(classifyForced('patch rejected: writing outside of the project; rejected by user approval settings', canary).outcome).toBe('refused');
    // An OS or sandbox error, a similar phrase or a longer text decides nothing.
    for (const text of ['sandbox-exec: sandbox_apply: Operation not permitted', 'patch rejected: something else',
      'unsupported call: exec_command\nthen it ran anyway', 'Permission denied']) {
      expect(classifyForced(text, canary).outcome, text).toBe('unclear');
    }
    expect(classifyForced(undefined, canary).outcome).toBe('no-output');
  });

  it('treats the canary in any output as a call that ran, before any refusal text', () => {
    expect(classifyForced(`unsupported call: x ${canary}`, canary).outcome).toBe('ran');
    expect(classifyForced([{ type: 'input_text', text: 'Output:' }, { type: 'input_text', text: canary }], canary).outcome).toBe('ran');
  });

  it('records fixed marker words and the length, never the text', () => {
    const result = classifyForced('PRIVATE /tmp/path: permission denied by sandbox', canary);
    expect(result).toEqual({ outcome: 'unclear', markers: ['sandbox', 'denied', 'permission'], length: 47 });
  });

  it('sees an MCP list as empty only when every list it returns is empty', () => {
    expect(isEmptyList('{"resources":[]}')).toBe(true);
    expect(isEmptyList('{"resourceTemplates":[]}')).toBe(true);
    for (const text of ['{"resources":[{"uri":"file:///x"}]}', '{}', '[]', 'not json', '{"resources":[],"nextCursor":"x"}']) {
      expect(isEmptyList(text), text).toBe(false);
    }
  });
});

describe('forced call verdict per kind', () => {
  it('fails a kind on an observed effect or a reported run before looking at refusals', () => {
    // Reproduced in review: a file change seen on disk although Codex replied with a refusal,
    // and a shell run Codex reported although its reply was not understood.
    expect(forcedKindVerdict(['refused'], 1, true)).toBe('failed');
    expect(forcedKindVerdict(['unclear'], 1, true)).toBe('failed');
    expect(forcedKindVerdict(['unavailable', 'ran'], 2, false)).toBe('failed');
  });
  it("blocks a kind only when Codex itself refused every one of its calls", () => {
    expect(forcedKindVerdict(['unavailable', 'refused'], 2, false)).toBe('blocked');
    expect(forcedKindVerdict(['unavailable'], 2, false)).toBe('undetermined');
    expect(forcedKindVerdict(['unavailable', 'unclear'], 2, false)).toBe('undetermined');
    expect(forcedKindVerdict(['no-output'], 1, false)).toBe('undetermined');
  });
});
