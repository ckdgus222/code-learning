import { mkdtemp, realpath, mkdir, rm, readFile, writeFile, readdir, symlink, link, lstat, stat, open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { saveExport } from '../src/main/export-file';
import { AppError } from '../src/shared/errors';

vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open), stat: vi.fn(actual.stat) };
});

let temporary: string, project: string, outside: string;
const running = () => null;
beforeEach(async () => {
  temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-export-')));
  project = path.join(temporary, 'Project'); outside = path.join(temporary, 'outside');
  await mkdir(path.join(project, 'deep', 'nested'), { recursive: true });
  await mkdir(outside);
});
afterEach(async () => { await rm(temporary, { recursive: true, force: true }); });

it.each(['md', 'MD'])('saves exact text, replaces an existing .%s and leaves no temporary file', async extension => {
  const name = `지도.${extension}`, file = path.join(outside, name);
  expect(await saveExport(project, file, '# 지도\n\n내용\n', running)).toBe(name);
  expect(await readFile(file, 'utf8')).toBe('# 지도\n\n내용\n');
  expect(await saveExport(project, file, 'replacement', running)).toBe(name);
  expect(await readFile(file, 'utf8')).toBe('replacement');
  expect(await readdir(outside)).toEqual([name]);
});

it.each(['map.txt', 'map', 'map.md.txt'])('rejects %s before writing', async name => {
  await expect(saveExport(project, path.join(outside, name), 'text', running)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  expect(await readdir(outside)).toEqual([]);
});

it.each(['', 'deep/nested'])('rejects the project and descendant %s', async relative => {
  const folder = path.join(project, relative), before = await readdir(folder);
  await expect(saveExport(project, path.join(folder, 'map.md'), 'text', running)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  expect(await readdir(folder)).toEqual(before);
});

it('rejects a parent reached through a directory symlink', async context => {
  const shortcut = path.join(outside, 'shortcut');
  try { await symlink(project, shortcut, 'dir'); } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) { context.skip(); return; }
    throw error;
  }
  await expect(saveExport(project, path.join(shortcut, 'deep/map.md'), 'text', running)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  expect(await readdir(path.join(project, 'deep'))).toEqual(['nested']);
  // A link straight to a folder inside the project: no part of the written path names the project folder itself.
  const inner = path.join(outside, 'inner');
  await symlink(path.join(project, 'deep'), inner, 'dir');
  await expect(saveExport(project, path.join(inner, 'map.md'), 'text', running)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  expect(await readdir(path.join(project, 'deep'))).toEqual(['nested']);
});

it('rejects different case when the filesystem identifies the same folder', async context => {
  const alias = path.join(temporary, 'pROJECT');
  const identity = await stat(alias, { bigint: true }).catch(() => null);
  const original = await stat(project, { bigint: true });
  if (!identity || identity.ino !== original.ino || identity.dev !== original.dev) { context.skip(); return; }
  await expect(saveExport(project, path.join(alias, 'map.md'), 'text', running)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  expect(await readdir(project)).toEqual(['deep']);
});

it('rejects a different Unicode spelling when it names the same folder', async context => {
  const unicode = path.join(temporary, '한글');
  await mkdir(unicode);
  const alias = unicode.normalize('NFD');
  const identity = await stat(alias, { bigint: true }).catch(() => null);
  const original = await stat(unicode, { bigint: true });
  if (!identity || identity.ino !== original.ino || identity.dev !== original.dev) { context.skip(); return; }
  await expect(saveExport(unicode, path.join(alias, 'map.md'), 'text', running)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  expect(await readdir(unicode)).toEqual([]);
});

it.for(['symbolic', 'hard'])('replaces the chosen %s link without writing its project target', async (kind, context) => {
  const source = path.join(project, 'original.md'), target = path.join(outside, 'map.md');
  await writeFile(source, 'project stays');
  try { await (kind === 'symbolic' ? symlink(source, target) : link(source, target)); } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) { context.skip(); return; }
    throw error;
  }
  await saveExport(project, target, 'exported', running);
  expect(await readFile(source, 'utf8')).toBe('project stays');
  expect(await readFile(target, 'utf8')).toBe('exported');
  expect((await lstat(target)).isSymbolicLink()).toBe(false);
  // As bigints: a Windows file id can be above 2^53, where two different ids are the same number.
  expect((await stat(target, { bigint: true })).ino).not.toBe((await stat(source, { bigint: true })).ino);
  expect(await readdir(outside)).toEqual(['map.md']);
});

it('fails closed for missing destination or project folders and removes temporary files on rename failure', async () => {
  await expect(saveExport(project, path.join(outside, 'missing/map.md'), 'text', running)).rejects.toMatchObject({ code: 'IO' });
  await expect(saveExport(path.join(temporary, 'missing'), path.join(outside, 'map.md'), 'text', running)).rejects.toMatchObject({ code: 'IO' });
  await mkdir(path.join(outside, 'map.md'));
  await expect(saveExport(project, path.join(outside, 'map.md'), 'text', running)).rejects.toMatchObject({ code: 'IO' });
  expect(await readdir(outside)).toEqual(['map.md']);
  expect(await readdir(path.join(outside, 'map.md'))).toEqual([]);
});

it('allows the parent of the project', async () => {
  expect(await saveExport(project, path.join(temporary, 'map.md'), 'text', running)).toBe('map.md');
  expect(await readFile(path.join(temporary, 'map.md'), 'utf8')).toBe('text');
});

it.each([1, 2])('preserves the stop error at check %i and cleans up without replacing existing content', async stopAt => {
  const file = path.join(outside, 'map.md');
  const error = new AppError(stopAt === 1 ? 'CANCELLED' : 'CHANGED', 'stopped');
  for (const existing of [false, true]) {
    if (existing) await writeFile(file, 'original');
    let checks = 0;
    const stopped = vi.fn(() => ++checks === stopAt ? error : null);
    await expect(saveExport(project, file, 'new text', stopped)).rejects.toBe(error);
    expect(stopped).toHaveBeenCalledTimes(stopAt);
    expect(await readdir(outside)).toEqual(existing ? ['map.md'] : []);
    if (existing) expect(await readFile(file, 'utf8')).toBe('original');
  }
});

it('never truncates or removes another file when exclusive creation collides', async () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const existing = `.map-export-${id}.tmp`;
  await writeFile(path.join(outside, existing), 'belongs to another writer');
  vi.mocked(randomUUID).mockReturnValueOnce(id);
  await expect(saveExport(project, path.join(outside, 'map.md'), 'text', running)).rejects.toMatchObject({ code: 'IO' });
  expect(await readFile(path.join(outside, existing), 'utf8')).toBe('belongs to another writer');
  expect(await readdir(outside)).toEqual([existing]);
});

it('cleans up a partly written temporary file after a write error and preserves the chosen file', async () => {
  const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  await writeFile(path.join(outside, 'map.md'), 'original');
  vi.mocked(open).mockImplementationOnce(async (...args) => {
    const handle = await original.open(...args);
    const write = handle.writeFile.bind(handle);
    handle.writeFile = async () => { await write('partial'); throw new Error('disk error'); };
    return handle;
  });
  await expect(saveExport(project, path.join(outside, 'map.md'), 'text', running)).rejects.toMatchObject({ code: 'IO', message: '파일을 저장하지 못했어요.' });
  expect(await readFile(path.join(outside, 'map.md'), 'utf8')).toBe('original');
  expect(await readdir(outside)).toEqual(['map.md']);
});

it('fails closed when an ancestor identity cannot be read', async () => {
  const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(stat).mockResolvedValueOnce(await original.stat(project, { bigint: true }));
  vi.mocked(stat).mockRejectedValueOnce(new Error('ancestor inaccessible'));
  await expect(saveExport(project, path.join(outside, 'map.md'), 'text', running)).rejects.toMatchObject({ code: 'IO', message: '고른 위치에 저장할 수 없어요.' });
  expect(await readdir(outside)).toEqual([]);
});
