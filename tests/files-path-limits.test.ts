import { beforeEach, expect, it, vi } from 'vitest';
import path from 'node:path';
import { assertAllowed, pathPolicy, scanProject } from '../src/core/project/files';

// macOS rejects absolute paths over its OS limit before the app's 1,024-unit relative limit.
// Model only directory enumeration and metadata to exercise the exact application boundary on all hosts.
const disk = vi.hoisted(() => new Map<string, 'directory' | 'file'>());
vi.mock('node:fs/promises', () => ({
  lstat: async (absolute: string) => {
    const kind = disk.get(absolute);
    if (!kind) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return { dev: 1, ino: 1, nlink: 1, size: 0, isDirectory: () => kind === 'directory', isSymbolicLink: () => false };
  },
  realpath: async (absolute: string) => absolute,
  open: vi.fn(() => { throw new Error('No file contents should be read'); }),
  opendir: async (absolute: string) => ({
    async *[Symbol.asyncIterator]() {
      for (const [name, kind] of disk) {
        if (name === absolute || path.dirname(name) !== absolute) continue;
        yield { name: path.basename(name), isDirectory: () => kind === 'directory',
          isFile: () => kind === 'file', isSymbolicLink: () => false };
      }
    },
  }),
}));
const root = path.resolve('virtual-project');
beforeEach(() => { disk.clear(); disk.set(root, 'directory'); });

it.each(['ascii', 'NFC', 'NFD', 'NFC expansion'])('bounds all three entry points at 1,024 units for %s', async spelling => {
  const segment = spelling === 'ascii' ? 'a'.repeat(90) : spelling === 'NFC' ? '가'.repeat(90)
    : spelling === 'NFD' ? '가'.repeat(45).normalize('NFD') : '\u0344'.repeat(45);
  const base = Array(10).fill(segment).join('/');
  const length = Math.max(base.length, base.normalize('NFC').length);
  const atLimit = `${base}/${'z'.repeat(1024 - length - 4)}.ts`;
  const overLimit = atLimit.replace(/\.ts$/, 'z.ts');
  expect(Math.max(atLimit.length, atLimit.normalize('NFC').length)).toBe(1024);
  for (let depth = 1; depth <= 10; depth++) disk.set(path.join(root, ...Array(depth).fill(segment)), 'directory');
  disk.set(path.join(root, atLimit), 'file');
  disk.set(path.join(root, overLimit), 'file');

  const project = await scanProject(root, 'limits');
  expect(project.files.map(file => file.relativePath)).toEqual([atLimit]);
  expect(project.excluded).toEqual({ '경로 길이·깊이 제한': 1 });
  expect(await pathPolicy(root)(atLimit)).toBeNull();
  expect(await pathPolicy(root)(overLimit)).toBe('경로 길이·깊이 제한');
  await expect(assertAllowed(root, atLimit)).resolves.toBeUndefined();
  await expect(assertAllowed(root, overLimit)).rejects.toMatchObject({ code: 'NOT_ALLOWED', message: expect.stringContaining('경로 길이·깊이 제한') });
});
