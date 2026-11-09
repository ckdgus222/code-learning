import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { flipFuses, FuseState, FuseV1Options, FuseVersion, getCurrentFuseWire } from '@electron/fuses';

const { runCommand, spawnApp } = vi.hoisted(() => ({ runCommand: vi.fn(), spawnApp: vi.fn() }));
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFileSync: runCommand,
  spawn: spawnApp,
}));
const { checkFuses, hashApp, createInspectableCopy, checkPlainLaunch } =
  await import(new URL('../scripts/fuse-check.mjs', import.meta.url).href);

let temp: string;
const copies: { executablePath: string; cleanup: () => Promise<void> }[] = [];
// A tiny fuse wire exercises the real @electron/fuses reader/writer without launching Electron.
const wire = Buffer.concat([Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'), Buffer.from([1, 9]), Buffer.from('010011011')]);

async function fixture(platform: 'darwin' | 'win32' = 'win32') {
  const directory = path.join(temp, platform === 'darwin' ? 'Code Learning.app' : 'app-1.0.0');
  const executable = platform === 'darwin' ? path.join(directory, 'Contents/MacOS/Code Learning') : path.join(directory, 'Code Learning.exe');
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, platform === 'darwin' ? 'launcher' : wire);
  await mkdir(path.join(directory, '_CodeSignature'));
  await writeFile(path.join(directory, '_CodeSignature/CodeResources'), 'signature');
  if (platform === 'win32') return { directory, executable, binary: executable };
  const framework = path.join(directory, 'Contents/Frameworks/Electron Framework.framework');
  const binary = path.join(framework, 'Versions/A/Electron Framework');
  await mkdir(path.dirname(binary), { recursive: true });
  await writeFile(binary, wire);
  await symlink('A', path.join(framework, 'Versions/Current'), 'dir');
  await symlink(path.join('Versions', 'Current', 'Electron Framework'), path.join(framework, 'Electron Framework'));
  return { directory, executable, binary };
}

beforeEach(async () => {
  temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'fuse-check-test-')));
  runCommand.mockReset();
  spawnApp.mockReset();
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const copy of copies.splice(0)) await copy.cleanup().catch(() => {});
  await rm(temp, { recursive: true, force: true });
});

describe('release fuse checks', () => {
  it('reads the release wire from both executable and Framework layouts', async () => {
    for (const platform of ['win32', 'darwin'] as const) await checkFuses((await fixture(platform)).executable);
  });

  it.each([
    [FuseV1Options.RunAsNode, true],
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable, true],
    [FuseV1Options.EnableNodeCliInspectArguments, true],
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, false],
    [FuseV1Options.OnlyLoadAppFromAsar, false],
    [FuseV1Options.GrantFileProtocolExtraPrivileges, false],
  ] as const)('rejects the wrong state for fuse %i', async (option, state) => {
    const { executable } = await fixture();
    await flipFuses(executable, { version: FuseVersion.V1, [option]: state });
    await expect(checkFuses(executable)).rejects.toThrow(`Unexpected fuse: ${FuseV1Options[option]}`);
  });

  it('rejects a missing fuse wire', async () => {
    const { executable } = await fixture();
    await writeFile(executable, 'not Electron');
    await expect(checkFuses(executable)).rejects.toThrow('sentinel');
  });
});

describe('isolated inspect-enabled copies', () => {
  it.each(['darwin', 'win32'] as const)('changes only the copy inspect fuse on %s and removes the copy', async platform => {
    const { executable, directory } = await fixture(platform);
    const original = await hashApp(directory);
    const before = await getCurrentFuseWire(executable);
    const copy = await createInspectableCopy(executable, platform);
    copies.push(copy);
    expect(await getCurrentFuseWire(copy.executablePath)).toEqual({ ...before, [FuseV1Options.EnableNodeCliInspectArguments]: FuseState.ENABLE });
    expect(await hashApp(directory)).toBe(original);
    if (platform === 'darwin') {
      const copiedApp = path.resolve(copy.executablePath, '../../..');
      const link = path.join(copiedApp, 'Contents/Frameworks/Electron Framework.framework/Electron Framework');
      expect(await readlink(link)).toBe(path.join('Versions', 'Current', 'Electron Framework'));
      expect(await realpath(link)).toBe(path.join(copiedApp, 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework'));
      expect(runCommand.mock.calls).toEqual([
        ['codesign', ['--verify', '--deep', '--strict', directory]],
        ['codesign', ['--force', '--deep', '--sign', '-', copiedApp]],
        ['codesign', ['--verify', '--deep', '--strict', copiedApp]],
      ]);
    }
    if (platform === 'win32') expect(runCommand).not.toHaveBeenCalled();
    await copy.cleanup();
    expect(existsSync(copy.executablePath)).toBe(false);
  });

  it.each(['fuse', 'resource'] as const)('rejects a %s link back to the source before changing or signing the copy', async target => {
    const { executable, directory, binary } = await fixture('darwin');
    const link = target === 'fuse'
      ? path.join(directory, 'Contents/Frameworks/Electron Framework.framework/Electron Framework')
      : path.join(directory, 'external-resource');
    if (target === 'fuse') await rm(link);
    await symlink(binary, link);
    const original = await hashApp(directory);
    await expect(createInspectableCopy(executable, 'darwin')).rejects.toThrow('escapes temporary app copy');
    expect(await hashApp(directory)).toBe(original);
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1, 2])('propagates codesign failure at step %i and removes the temporary copy', async step => {
    const { executable, directory } = await fixture('darwin');
    const original = await hashApp(directory);
    let copiedApp: string | undefined;
    for (let index = 0; index < step; index++) runCommand.mockImplementationOnce(() => undefined);
    runCommand.mockImplementationOnce((_command: string, args: string[]) => {
      if (step > 0) copiedApp = args.at(-1);
      throw new Error('signature failed');
    });
    await expect(createInspectableCopy(executable, 'darwin')).rejects.toThrow('signature failed');
    expect(await hashApp(directory)).toBe(original);
    if (copiedApp) expect(existsSync(copiedApp)).toBe(false);
  });

  it.each(['framework', 'signature', 'added file', 'removed file'] as const)('detects release %s changes even when its launcher is unchanged', async change => {
    const { executable, directory, binary } = await fixture('darwin');
    const launcher = await readFile(executable);
    const copy = await createInspectableCopy(executable, 'darwin');
    copies.push(copy);
    const signature = path.join(directory, '_CodeSignature/CodeResources');
    if (change === 'framework') await writeFile(binary, 'changed framework');
    if (change === 'signature') await writeFile(signature, 'changed signature');
    if (change === 'added file') await writeFile(path.join(directory, 'extra'), 'added');
    if (change === 'removed file') await rm(signature);
    expect(await readFile(executable)).toEqual(launcher);
    await expect(copy.cleanup()).rejects.toThrow('Distributed app changed');
    expect(existsSync(copy.executablePath)).toBe(false);
  });
});

describe('plain release startup', () => {
  let child: EventEmitter & { pid: number | undefined; exitCode: number | null; signalCode: string | null };
  let kill: ReturnType<typeof vi.spyOn>;
  let profile: string;

  beforeEach(() => {
    profile = path.join(temp, 'profile');
    child = Object.assign(new EventEmitter(), { pid: 12345 as number | undefined, exitCode: null as number | null, signalCode: null as string | null });
    spawnApp.mockReturnValue(child);
    kill = vi.spyOn(process, 'kill').mockImplementation(() => { child.emit('close'); return true; });
    runCommand.mockImplementation(() => { child.emit('close'); });
  });

  it('requires a fresh database and a live process, then stops the process tree', async () => {
    spawnApp.mockImplementationOnce(() => {
      void writeFile(path.join(profile, 'learning.sqlite'), 'database');
      return child;
    });
    await checkPlainLaunch('release-executable', profile);
    expect(spawnApp).toHaveBeenCalledWith('release-executable', [`--user-data-dir=${profile}`], {
      detached: process.platform !== 'win32', stdio: 'ignore', windowsHide: true,
    });
    if (process.platform === 'win32') expect(runCommand).toHaveBeenCalledWith('taskkill.exe', ['/PID', '12345', '/T', '/F'], { windowsHide: true });
    if (process.platform !== 'win32') expect(kill).toHaveBeenCalledWith(-12345, 'SIGKILL');
  });

  it('rejects stale profile data before launching', async () => {
    await mkdir(profile);
    await writeFile(path.join(profile, 'learning.sqlite'), 'stale');
    await expect(checkPlainLaunch('release-executable', profile)).rejects.toThrow('without learning.sqlite');
    expect(spawnApp).not.toHaveBeenCalled();
  });

  it('rejects early exit even if the process created a database', async () => {
    spawnApp.mockImplementationOnce(() => {
      void writeFile(path.join(profile, 'learning.sqlite'), 'database');
      child.exitCode = 1;
      return child;
    });
    await expect(checkPlainLaunch('release-executable', profile)).rejects.toThrow('exited during startup');
  });

  it('propagates launch errors without attempting to kill an absent PID', async () => {
    child.pid = undefined;
    spawnApp.mockImplementationOnce(() => {
      queueMicrotask(() => { child.emit('error', new Error('spawn failed')); child.emit('close'); });
      return child;
    });
    await expect(checkPlainLaunch('missing', profile)).rejects.toThrow('spawn failed');
    expect(kill).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('fails the deadline and still stops the process tree when no database appears', async () => {
    await expect(checkPlainLaunch('release-executable', profile, 250)).rejects.toThrow('startup deadline');
    expect(process.platform === 'win32' ? runCommand : kill).toHaveBeenCalledTimes(1);
  });
});
