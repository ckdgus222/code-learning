import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AGY_DENY_RULES, AGY_NO_MCP_SERVERS, AGY_NO_TOOLS_HOOK, restrictAgy } from '../src/core/ai/runtime';

// Real files in a temporary folder that stands in for the app-only agy HOME.
let home: string;
const settingsFile = () => path.join(home, '.gemini', 'antigravity-cli', 'settings.json');
const hooksFile = () => path.join(home, '.gemini', 'config', 'hooks.json');
const mcpFile = () => path.join(home, '.gemini', 'config', 'mcp_config.json');
const json = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
beforeEach(async () => { home = await mkdtemp(path.join(os.tmpdir(), 'agy-settings-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

describe('agy restrictions in the app-only HOME', () => {
  it('creates private settings with every deny rule and a hook that refuses every tool', async () => {
    await restrictAgy(home);
    expect(await json(settingsFile())).toEqual({ modelProvider: 'gemini', permissions: { deny: AGY_DENY_RULES } });
    expect(await json(hooksFile())).toEqual(AGY_NO_TOOLS_HOOK);
    expect(AGY_NO_TOOLS_HOOK['code-learning-no-tools'].PreToolUse[0].matcher).toBe('*');
    expect(await json(mcpFile())).toEqual({ mcpServers: {} });
  });

  it.skipIf(process.platform === 'win32')('creates the settings files 0o600 and their folders 0o700', async () => {
    await restrictAgy(home);
    for (const file of [settingsFile(), hooksFile(), mcpFile()]) expect((await stat(file)).mode & 0o777).toBe(0o600);
    for (const folder of [path.dirname(settingsFile()), path.dirname(hooksFile())]) expect((await stat(folder)).mode & 0o777).toBe(0o700);
  });

  it.skipIf(process.platform === 'win32')('makes existing folders and files private too', async () => {
    await mkdir(path.dirname(settingsFile()), { recursive: true, mode: 0o755 });
    await mkdir(path.dirname(hooksFile()), { recursive: true, mode: 0o755 });
    await writeFile(settingsFile(), '{}', { mode: 0o644 });
    await writeFile(hooksFile(), '{}', { mode: 0o644 });
    await chmod(path.join(home, '.gemini'), 0o755);
    await restrictAgy(home);
    for (const folder of [path.join(home, '.gemini'), path.dirname(settingsFile()), path.dirname(hooksFile())]) {
      expect((await stat(folder)).mode & 0o777, folder).toBe(0o700);
    }
    for (const file of [settingsFile(), hooksFile()]) expect((await stat(file)).mode & 0o777, file).toBe(0o600);
  });

  it("keeps agy's own keys and existing rules without duplicates, drops other hooks, and repeats safely", async () => {
    await mkdir(path.dirname(settingsFile()), { recursive: true });
    await mkdir(path.dirname(hooksFile()), { recursive: true });
    await writeFile(settingsFile(), JSON.stringify({
      modelProvider: 'google', trustedWorkspaces: ['/fixture'], permissions: { allow: ['command(git)'], deny: ['command(rm)', 'mcp(*)'] },
      hooks: { start: { SessionStart: [{ type: 'command', command: 'echo started' }] } },
    }));
    await writeFile(hooksFile(), JSON.stringify({ other: { PreToolUse: [{ matcher: '*', hooks: [{ command: 'echo other' }] }] } }));
    // A configured MCP server is a command agy would start by itself.
    await writeFile(mcpFile(), JSON.stringify({ mcpServers: { other: { command: 'node', args: ['/tmp/server.js'] } } }));
    await restrictAgy(home);
    await restrictAgy(home);
    const settings = await json(settingsFile());
    expect(settings.modelProvider).toBe('gemini');
    expect(settings.trustedWorkspaces).toEqual(['/fixture']);
    expect(settings.permissions.allow).toEqual(['command(git)']);
    expect(settings.permissions.deny).toEqual(['command(rm)', 'mcp(*)', ...AGY_DENY_RULES.filter(rule => rule !== 'mcp(*)')]);
    expect(settings.hooks).toBeUndefined();
    expect(await json(hooksFile())).toEqual(AGY_NO_TOOLS_HOOK);
    expect(await json(mcpFile())).toEqual(AGY_NO_MCP_SERVERS);
  });

  it('refuses a settings file, hooks file, MCP file or folder that is a link, leaving its target untouched', async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'agy-settings-target-'));
    try {
      await writeFile(path.join(outside, 'target.json'), '{}');
      for (const file of [settingsFile(), hooksFile(), mcpFile()]) {
        await rm(path.join(home, '.gemini'), { recursive: true, force: true });
        await mkdir(path.dirname(file), { recursive: true });
        await symlink(path.join(outside, 'target.json'), file);
        await expect(restrictAgy(home)).rejects.toThrow();
      }
      await rm(path.join(home, '.gemini'), { recursive: true });
      // A linked .gemini could be the user's own ~/.gemini.
      await symlink(outside, path.join(home, '.gemini'));
      await expect(restrictAgy(home)).rejects.toThrow();
      expect(await readFile(path.join(outside, 'target.json'), 'utf8')).toBe('{}');
      // Nothing was made inside the link's target either.
      await expect(stat(path.join(outside, 'antigravity-cli'))).rejects.toThrow();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses a settings, hooks or MCP file that is a hard link, leaving the other name untouched', async () => {
    // A hard link is not a symbolic link: O_NOFOLLOW opens it, and it shares the user's ~/.gemini file.
    const outside = await mkdtemp(path.join(os.tmpdir(), 'agy-settings-target-'));
    try {
      const target = path.join(outside, 'target.json');
      for (const file of [settingsFile(), hooksFile(), mcpFile()]) {
        await rm(path.join(home, '.gemini'), { recursive: true, force: true });
        await writeFile(target, '{}', { mode: 0o644 });
        await mkdir(path.dirname(file), { recursive: true });
        await link(target, file);
        await expect(restrictAgy(home)).rejects.toThrow();
        expect(await readFile(target, 'utf8'), file).toBe('{}');
        // Windows has no POSIX permission bits.
        if (process.platform !== 'win32') expect((await stat(target)).mode & 0o777, file).toBe(0o644);
      }
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it.each(['not json', '[]', '{"permissions": []}', '{"permissions": {"deny": "command(*)"}}', '{"permissions": {"deny": [null, 7, {}]}}'])('does not overwrite unexpected settings: %s', async content => {
    await mkdir(path.dirname(settingsFile()), { recursive: true });
    await writeFile(settingsFile(), content);
    await expect(restrictAgy(home)).rejects.toThrow();
    expect(await readFile(settingsFile(), 'utf8')).toBe(content);
  });
});

it('forces API key mode while leaving an old Google login token untouched', async () => {
  await mkdir(path.dirname(settingsFile()), { recursive: true });
  const token = path.join(path.dirname(settingsFile()), 'antigravity-oauth-token');
  await writeFile(token, 'fake-old-login-token');
  await writeFile(settingsFile(), JSON.stringify({ modelProvider: 'google', trustedWorkspaces: ['/fixture'] }));
  await restrictAgy(home);
  expect(await readFile(token, 'utf8')).toBe('fake-old-login-token');
  expect(await json(settingsFile())).toMatchObject({ modelProvider: 'gemini', trustedWorkspaces: ['/fixture'] });
});
