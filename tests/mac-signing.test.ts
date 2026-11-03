import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ResolvedForgeConfig } from '@electron-forge/shared-types';
import { isMachOFile, signMacPackages } from '../scripts/mac-signing';

const { runCommand } = vi.hoisted(() => ({ runCommand: vi.fn<(...args: unknown[]) => Promise<void>>() }));
vi.mock('node:child_process', () => ({
  execFile: (command: string, args: string[], callback: (error: Error | null) => void) => {
    runCommand(command, args).then(() => callback(null), callback);
  },
}));

let root: string;
let appPath: string;
let unpackedPath: string;
const config = {} as ResolvedForgeConfig;

async function put(relative: string, data: Buffer | string = Buffer.from('cffaedfe', 'hex')) {
  const filePath = path.join(unpackedPath, relative);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, data);
  return filePath;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'mac-signing-'));
  appPath = path.join(root, 'Code Learning.app');
  unpackedPath = path.join(appPath, 'Contents/Resources/app.asar.unpacked');
  runCommand.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('Mach-O detection', () => {
  it.each([
    'feedface', 'cefaedfe', 'feedfacf', 'cffaedfe',
    'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca',
  ])('recognizes thin/fat magic %s using file bytes', async magic => {
    const file = await put('binary', Buffer.from(`${magic}0000000000000000`, 'hex'));
    expect(await isMachOFile(file)).toBe(true);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it.each(['', 'cf', 'cffa', 'cffaed', '00000000', '7f454c46', '4d5a0000', '23212f62'])('rejects short or non-Mach-O bytes %s', async header => {
    const file = await put('not-a-binary.node', Buffer.from(header, 'hex'));
    expect(await isMachOFile(file)).toBe(false);
  });

  it('propagates read failures instead of silently omitting a file', async () => {
    await expect(isMachOFile(path.join(root, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('postPackage ad-hoc signing', () => {
  it('signs every unpacked Mach-O before the bundle, then verifies each file and the bundle', async () => {
    const files = await Promise.all([
      put('node_modules/tree-sitter/prebuilds/darwin-x64/tree-sitter.node'),
      put('node_modules/tree-sitter-javascript/prebuilds/darwin-x64/tree-sitter-javascript.node'),
      put('node_modules/tree-sitter-typescript/prebuilds/darwin-x64/tree-sitter-typescript.node'),
      put('node_modules/tree-sitter-typescript/node_modules/tree-sitter/prebuilds/darwin-x64/tree-sitter.node'),
      put('node_modules/native/prebuilds/darwin-arm64/native.node'),
      put('node_modules/native/lib/example.dylib'),
      put('node_modules/@typescript/typescript-darwin-arm64/lib/tsc'),
      put('node_modules/native/tool $(touch unexpected); name'),
    ]);
    const script = await put('node_modules/scripts/executable', '#!/bin/sh\nexit 0\n');
    await chmod(script, 0o755);
    await put('node_modules/native/prebuilds/linux-x64/native.node', Buffer.from('7f454c46', 'hex'));
    await put('node_modules/native/empty.dylib', '');
    await symlink(files[0], path.join(unpackedPath, 'linked.node'));
    const outside = path.join(root, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'external.node'), Buffer.from('cffaedfe', 'hex'));
    await symlink(outside, path.join(unpackedPath, 'linked-directory'));

    await signMacPackages(config, { platform: 'darwin', arch: 'arm64', outputPaths: [root] });

    const sorted = files.sort();
    expect(runCommand.mock.calls).toEqual([
      ...sorted.map(file => ['codesign', ['--force', '--sign', '-', file]]),
      ['codesign', ['--force', '--deep', '--sign', '-', appPath]],
      ...sorted.map(file => ['codesign', ['--verify', '--strict', file]]),
      ['codesign', ['--verify', '--deep', '--strict', appPath]],
    ]);
  });

  it.each(['linux', 'win32'] as const)('does not read or sign %s packages', async platform => {
    await signMacPackages(config, { platform, arch: 'arm64', outputPaths: [path.join(root, 'missing')] });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('still signs and verifies a bundle with no unpacked directory', async () => {
    await mkdir(appPath);
    await signMacPackages(config, { platform: 'darwin', arch: 'arm64', outputPaths: [root] });
    expect(runCommand.mock.calls).toEqual([
      ['codesign', ['--force', '--deep', '--sign', '-', appPath]],
      ['codesign', ['--verify', '--deep', '--strict', appPath]],
    ]);
  });

  it('handles every package output', async () => {
    const secondOutput = path.join(root, 'second output');
    await mkdir(path.join(secondOutput, 'Code Learning.app'), { recursive: true });
    await mkdir(appPath);
    await signMacPackages(config, { platform: 'darwin', arch: 'arm64', outputPaths: [root, secondOutput] });
    expect(runCommand.mock.calls.map(call => call[1])).toEqual([
      ['--force', '--deep', '--sign', '-', appPath],
      ['--verify', '--deep', '--strict', appPath],
      ['--force', '--deep', '--sign', '-', path.join(secondOutput, 'Code Learning.app')],
      ['--verify', '--deep', '--strict', path.join(secondOutput, 'Code Learning.app')],
    ]);
  });

  it.each([0, 1, 2, 3, 4, 5])('fails packaging immediately when signing/verification command %i fails', async failureIndex => {
    await put('one.node');
    await put('nested/two.node');
    const failure = new Error('codesign failed');
    for (let index = 0; index < failureIndex; index++) runCommand.mockResolvedValueOnce(undefined);
    runCommand.mockRejectedValueOnce(failure);

    await expect(signMacPackages(config, { platform: 'darwin', arch: 'arm64', outputPaths: [root] })).rejects.toBe(failure);
    expect(runCommand).toHaveBeenCalledTimes(failureIndex + 1);
  });

  it('propagates directory errors before invoking codesign', async () => {
    await mkdir(path.dirname(unpackedPath), { recursive: true });
    await writeFile(unpackedPath, 'not a directory');
    await expect(signMacPackages(config, { platform: 'darwin', arch: 'arm64', outputPaths: [root] })).rejects.toMatchObject({ code: 'ENOTDIR' });
    expect(runCommand).not.toHaveBeenCalled();
  });
});
