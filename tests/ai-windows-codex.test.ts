import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalAiRuntime, WINDOWS_CODEX_READY, WINDOWS_CODEX_WARNING } from '../src/core/ai/runtime';

describe.runIf(process.platform === 'win32')('Windows Codex with a fake CLI and real processes', () => {
  let root: string;
  let codexHome: string;
  let agyHome: string;
  let reportFile: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-windows-codex-')));
    const appData = path.join(root, 'App Data');
    const programFiles = path.join(root, 'Program Files');
    const codexPackage = path.join(appData, 'npm', 'node_modules', '@openai', 'codex');
    const nodeFolder = path.join(programFiles, 'nodejs');
    codexHome = path.join(root, 'app', 'codex-home');
    agyHome = path.join(root, 'app', 'agy-home');
    reportFile = path.join(root, 'fake-cli-report.json');
    await mkdir(path.join(codexPackage, 'bin'), { recursive: true });
    await mkdir(nodeFolder, { recursive: true });
    await copyFile(process.execPath, path.join(nodeFolder, 'node.exe'));
    await writeFile(path.join(codexPackage, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '9.9.9', type: 'commonjs' }));
    await writeFile(path.join(codexPackage, 'bin', 'codex.js'), `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) {
  console.log('codex-cli 9.9.9');
  process.exit(0);
}
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { stdin += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(reportFile)}, JSON.stringify({
    CODEX_HOME: process.env.CODEX_HOME, TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR,
    cwd: process.cwd(), args: process.argv.slice(2), stdin,
  }));
  console.log(JSON.stringify({ type: 'turn.started' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ summary: 'fake answer' }) } }));
  console.log(JSON.stringify({ type: 'turn.completed' }));
});
`);
    vi.stubEnv('APPDATA', appData);
    vi.stubEnv('ProgramFiles', programFiles);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    // Windows can keep a just-exited process's folder busy briefly.
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('finds and runs only the fake Codex, uses the app home and removes its working folder', async () => {
    // Use the real OS default, just like main.ts. Nothing calls an installed AI CLI.
    const runtime = new LocalAiRuntime(codexHome, agyHome);
    try {
      const connections = await runtime.checkConnections();
      expect(connections.providers).toMatchObject([{ provider: 'codex', installation: 'found', version: '9.9.9' }]);
      expect(connections.modes.find(mode => mode.mode === 'codex')).toEqual({
        mode: 'codex', ready: true, reason: WINDOWS_CODEX_READY, warning: WINDOWS_CODEX_WARNING,
      });
      const prompt = '이 코드를 설명해 주세요.\nexport const answer = 42;';
      await expect(runtime.run({ stage: 'explaining', provider: 'codex', prompt,
        schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false },
        signal: new AbortController().signal, timeoutMs: 10_000,
      })).resolves.toEqual({ value: { summary: 'fake answer' }, reportedModel: null });
      const report = JSON.parse(await readFile(reportFile, 'utf8'));
      expect(report.CODEX_HOME).toBe(codexHome);
      expect(report.TEMP).toBe(report.cwd);
      expect(report.TMP).toBe(report.cwd);
      expect(report.TMPDIR).toBe(report.cwd);
      expect(report.stdin).toBe(prompt);
      expect(report.args.join(' ')).toContain('--sandbox read-only');
      expect(report.args.join(' ')).toContain('--disable shell_tool');
      expect(report.args).not.toContain(prompt);
      await expect(stat(report.cwd)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(agyHome)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await runtime.close(); }
  }, 20_000);
});
