import { execFile } from 'node:child_process';
import { open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ForgeHookFn } from '@electron-forge/shared-types';

const execFileAsync = promisify(execFile);
// Thin and universal (fat), 32/64-bit, in both byte orders.
const machOMagic = new Set([
  0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe,
  0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca,
]);

export async function isMachOFile(filePath: string): Promise<boolean> {
  const file = await open(filePath, 'r');
  try {
    const header = Buffer.alloc(4);
    const { bytesRead } = await file.read(header, 0, 4, 0);
    return bytesRead === 4 && machOMagic.has(header.readUInt32BE(0));
  } finally {
    await file.close();
  }
}

async function unpackedMachOFiles(appPath: string): Promise<string[]> {
  const unpackedPath = path.join(appPath, 'Contents/Resources/app.asar.unpacked');
  const entries = await readdir(unpackedPath, { recursive: true, withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(entry.parentPath, entry.name);
    if (await isMachOFile(filePath)) files.push(filePath);
  }
  return files.sort();
}

export const signMacPackages: ForgeHookFn<'postPackage'> = async (_config, result) => {
  if (result.platform !== 'darwin') return;

  for (const outputPath of result.outputPaths) {
    const appPath = path.join(outputPath, 'Code Learning.app');
    const files = await unpackedMachOFiles(appPath);
    for (const file of files) {
      await execFileAsync('codesign', ['--force', '--sign', '-', file]);
    }
    await execFileAsync('codesign', ['--force', '--deep', '--sign', '-', appPath]);
    for (const file of files) {
      await execFileAsync('codesign', ['--verify', '--strict', file]);
    }
    await execFileAsync('codesign', ['--verify', '--deep', '--strict', appPath]);
  }
};
