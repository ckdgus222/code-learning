import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertAllowed, pathPolicy, scanProject } from '../src/core/project/files';

const complexMessage = '.gitignore에 너무 복잡하거나 긴 규칙이 있어 이 범위를 열지 않습니다.';
const pathLimit = '경로 길이·깊이 제한';
let root: string;
async function put(relative: string, text = '') {
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), text);
}
beforeEach(async () => { root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-limits-'))); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('gitignore complexity limits', () => {
  it.each([
    '**/x/**/x/**/b', 'a/**/**/**/b', '**/*[a/]*[a/]b', '*[.-0]*[.-0]*[.-0]b', '*[a/]*[a/]b', '*[a/]*[a/]*b', '!*[a/]*a*',
    '**/x/**/x/**', 'a'.repeat(1025), '가/**/**/**/b', '가/**/**/**/b'.normalize('NFD'),
  ])('closes the root or only the nested scope for rule %j', async rule => {
    await put('safe.ts');
    await put('.gitignore', rule);
    await expect(scanProject(root, 'limits')).rejects.toMatchObject({ code: 'NOT_ALLOWED', message: complexMessage });
    await expect(assertAllowed(root, 'safe.ts')).rejects.toMatchObject({ code: 'NOT_ALLOWED', message: complexMessage });
    expect(await pathPolicy(root)('safe.ts')).toBe('복잡한 .gitignore 규칙');
    await put('.gitignore', '');
    await put('sub/.gitignore', rule);
    await put('sub/main.ts');
    const project = await scanProject(root, 'limits');
    expect(project.files.map(file => file.relativePath)).toEqual(['.gitignore', 'safe.ts']);
    expect(project.excluded).toEqual({ '복잡한 .gitignore 규칙': 1 });
    expect(await pathPolicy(root)('sub/main.ts')).toBe('복잡한 .gitignore 규칙');
    await expect(assertAllowed(root, 'sub/main.ts')).rejects.toMatchObject({ code: 'NOT_ALLOWED', message: complexMessage });
  });

  it.each([
    ['a/**/**/b', 'a/b', 'a/x/b', 'a/x/y/b'],
    ['**/**/**/b', 'b', 'a/b'],
    ['x/**/x/**/b', 'x/x/b', 'x/a/x/a/b'],
    ['**/stage/**/*.js', 'stage/a.js', 'src/stage/lib/a.js'],
    ['a*', 'ab'], ['abc/*', 'abc/d'], ['src/**/*', 'src/a/b'], ['f*o/*/*', 'foo/b/c'], ['*.[oa]', 'x.o'],
    ['*.py[cod]', 'main.pyc'], ['**/*.py[cod]', 'sub/main.pyc'],
    ['*[!b]*[!b]*[!b]b', 'aaab'], ['*a*a*a*a*b', 'aaaab'],
    ['[a-z]', 'a'], ['[!b]', 'a'], ['a'.repeat(1024)],
    [Array.from({ length: 40 }, (_, i) => `**/build-${i + 1}`).join('\n'), 'build-1', 'sub/build-40'],
    [String.raw`\*\*/\*\*/\*\*/b`],
  ])('preserves allowed rule %j', async (rule, ...ignored) => {
    await put('.gitignore', rule);
    await put('safe.ts');
    expect((await scanProject(root, 'limits')).files.map(file => file.relativePath)).toContain('safe.ts');
    const policy = pathPolicy(root);
    expect(await policy('safe.ts')).toBeNull();
    for (const relative of ignored) expect(await policy(`${relative}/main.ts`)).toBe('.gitignore');
  });

  it('allows 200 heavy lines in one .gitignore and closes the scope at 201', async () => {
    const heavy = (count: number) => Array.from({ length: count }, (_, i) => `**/build-${i}/**`).join('\n');
    await put('safe.ts');
    await put('.gitignore', `*.log\n${heavy(200)}`);
    await expect(scanProject(root, 'limits')).resolves.toMatchObject({ id: 'limits' });
    expect(await pathPolicy(root)('build-0/a.ts')).toBe('.gitignore');
    await put('.gitignore', heavy(201));
    await expect(scanProject(root, 'limits')).rejects.toMatchObject({ code: 'NOT_ALLOWED', message: complexMessage });
    expect(await pathPolicy(root)('safe.ts')).toBe('복잡한 .gitignore 규칙');
  });

  it('ignores long comment lines, removes CR only for the limit, and checks raw text before NFC', async () => {
    await put('.gitignore', `#${'a'.repeat(2048)}\r\n\r\n${'a'.repeat(1024)}\r\n`);
    await expect(scanProject(root, 'limits')).resolves.toMatchObject({ id: 'limits' });
    // NFC would shorten this to 513 units, but the original line already exceeds 1,024.
    await put('.gitignore', '가'.repeat(513).normalize('NFD'));
    expect(await pathPolicy(root)('safe.ts')).toBe('복잡한 .gitignore 규칙');
    // U+0344 expands under NFC, so normalized rules must be checked too.
    await put('.gitignore', '\u0344'.repeat(513));
    await expect(scanProject(root, 'limits')).resolves.toMatchObject({ id: 'limits' });
    expect(await pathPolicy(root)('safe.ts')).toBe('복잡한 .gitignore 규칙');
  });
});

describe('path limits before ignore rules', () => {
  it('allows 21 components, limits traversal beyond depth 20, and rejects 22 components on reads and history', async () => {
    const folder = Array(20).fill('a').join('/');
    const allowed = `${folder}/ok.ts`;
    const excluded = `${folder}/extra/no.ts`;
    await put(allowed);
    await put(excluded);
    const project = await scanProject(root, 'limits');
    expect(project.files.map(file => file.relativePath)).toEqual([allowed]);
    expect(project.warnings.join(' ')).toContain('깊이 20');
    expect(await pathPolicy(root)(allowed)).toBeNull();
    expect(await pathPolicy(root)(excluded)).toBe(pathLimit);
    await expect(assertAllowed(root, allowed)).resolves.toBeUndefined();
    await expect(assertAllowed(root, excluded)).rejects.toMatchObject({ code: 'NOT_ALLOWED', message: expect.stringContaining(pathLimit) });
  });

  it('rejects oversized paths before trying to load unreadable parent rules', async () => {
    await put('.gitignore', 'a'.repeat(1025));
    for (const relative of ['a'.repeat(1025), `${Array(21).fill('a').join('/')}/main.ts`]) {
      expect(await pathPolicy(root)(relative)).toBe(pathLimit);
      await expect(assertAllowed(root, relative)).rejects.toMatchObject({ code: 'NOT_ALLOWED', message: expect.stringContaining(pathLimit) });
    }
  });
});

describe('scan cancellation', () => {
  it('cancels before entering an empty root', async () => {
    await expect(scanProject(root, 'limits', () => true)).rejects.toMatchObject({ code: 'CANCELLED', message: '탐색을 멈췄습니다.' });
  });

  it.each([3, 4])('propagates cancellation at the last folder entry or its only item (check %i)', async stopAt => {
    await put('last/main.ts');
    let checks = 0;
    await expect(scanProject(root, 'limits', () => ++checks === stopAt)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(checks).toBe(stopAt);
  });
});
