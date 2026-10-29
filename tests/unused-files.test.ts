import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MapFile, MapImport, ProjectMap, UnusedExcludeKind } from '../src/shared/contracts';
import { MAX_FILE_BYTES, scanProject } from '../src/core/project/files';
import { scriptFilesOf, unusedFiles, type ScriptFiles } from '../src/core/analysis/unused-files';

const file = (relativePath: string, extra: Partial<MapFile> = {}): MapFile => ({ id: relativePath, relativePath,
  folder: path.posix.dirname(relativePath), start: false, checked: 'full', reason: null, ...extra });
const imported = (specifier: string | null, fromFileId = 'from.ts'): MapImport => ({ fromFileId, specifier,
  fileHash: 'hash', startUtf16: 0, endUtf16: 1, startLine: 1, endLine: 1, text: 'import' });
const mapOf = (files: MapFile[], extra: Partial<Omit<ProjectMap, 'unused'>> = {}): Omit<ProjectMap, 'unused'> => ({
  projectId: 'project', files, edges: [], unresolved: [], external: [], complexFunctions: [], limited: false, notes: [], ...extra,
});
const scripts = (): ScriptFiles => ({ files: new Set(), failed: [] });

describe('unused file candidates', () => {
  it('sorts candidates, ignores self imports and counts incoming edges even from tests or unused cycles', () => {
    const map = mapOf(['z.ts', 'a.ts', 'used.ts', 'a.test.ts', 'cycle-a.ts', 'cycle-b.ts'].map(name => file(name)), {
      edges: [
        { ...imported('./a', 'a.ts'), toFileId: 'a.ts' },
        { ...imported('./used', 'a.test.ts'), toFileId: 'used.ts' },
        { ...imported('./cycle-b', 'cycle-a.ts'), toFileId: 'cycle-b.ts' },
        { ...imported('./cycle-a', 'cycle-b.ts'), toFileId: 'cycle-a.ts' },
      ],
    });
    const result = unusedFiles(map, scripts());
    expect(result.candidates).toEqual(['a.ts', 'z.ts'].map(relativePath => ({ fileId: relativePath, relativePath })));
    expect(result.notes).toEqual(['안 쓰는 파일이 가져다 쓰는 파일은 후보에 나오지 않아요(그 파일이 아직 import하고 있으므로).']);
  });

  it.each<[string, UnusedExcludeKind]>([
    ['entry.ts', 'start'], ['unit.test.ts', 'test'], ['unit.spec.tsx', 'test'], ['__tests__/unit.js', 'test'],
    ['app.e2e-spec.ts', 'test'], ['unit-test.mjs', 'test'], ['web/chat.e2e.ts', 'test'], ['e2e/helpers.ts', 'test'], ['vite.config.ts', 'config'], ['.eslintrc.js', 'config'],
    ['next.config.mjs', 'config'], ['global.d.ts', 'types'], ['global.d.mts', 'types'], ['global.d.cts', 'types'],
    ['scripts/seed.js', 'script'],
  ])('excludes %s as %s', (name, kind) => {
    const result = unusedFiles(mapOf([file(name, { start: kind === 'start' })]), {
      ...scripts(), files: new Set(kind === 'script' ? [name] : []),
    });
    expect(result.candidates).toEqual([]);
    expect(result.unsure).toEqual([]);
    expect(result.excluded).toEqual([{ kind, count: 1 }]);
  });

  it('counts only the first matching exclusion, in the specified kind order', () => {
    const names = ['entry.test.config.d.ts', 'unit.test.config.d.ts', 'tool.config.d.ts', 'app/page.d.ts', 'app/page.ts', 'script.ts'];
    const result = unusedFiles(mapOf([...names.map((name, index) => file(name, { start: index === 0 })), file('next.config.ts')]), {
      ...scripts(), files: new Set(names),
    });
    expect(result.excluded).toEqual([
      { kind: 'start', count: 1 }, { kind: 'test', count: 1 }, { kind: 'config', count: 2 },
      { kind: 'types', count: 1 }, { kind: 'framework', count: 1 }, { kind: 'script', count: 1 },
    ]);
    expect(result.candidates).toEqual([]);
  });

  it.each(['', 'web/'])('excludes Next conventions only under the configured root %s', root => {
    const appNames = ['page', 'layout', 'route', 'loading', 'error', 'global-error', 'not-found', 'template', 'default',
      'opengraph-image', 'twitter-image', 'icon', 'apple-icon', 'sitemap', 'robots', 'manifest'];
    const framework = ['', 'src/'].flatMap(src => [
      ...appNames.map(name => `${root}${src}app/(group)/[id]/${name}.tsx`),
      `${root}${src}pages/nested/anything.js`, `${root}${src}middleware.ts`, `${root}${src}instrumentation.js`,
    ]);
    const ordinary = [`${root}app/helper.ts`, `${root}src/app/not-page.ts`, `${root}lib/middleware.ts`,
      `${root}other/pages/page.ts`, `${root}apps/page.ts`, ...(root ? ['website/app/page.ts', 'app/page.ts'] : [])];
    const result = unusedFiles(mapOf([...framework, ...ordinary, `${root}next.config.ts`].map(name => file(name))), scripts());
    expect(result.candidates.map(item => item.relativePath)).toEqual(ordinary.sort((a, b) => a.localeCompare(b)));
    expect(result.excluded).toEqual([{ kind: 'config', count: 1 }, { kind: 'framework', count: framework.length }]);
    expect(unusedFiles(mapOf([file(`${root}app/page.ts`)]), scripts()).candidates).toHaveLength(1);
  });

  it('separates unresolved targets and relative dynamic imports, in path order', () => {
    const map = mapOf(['from.ts', 'z.ts', 'a.ts', 'lazy.ts', 'lazy/index.ts'].map(name => file(name)), {
      unresolved: [
        { ...imported('./z'), reason: 'unavailable', candidates: ['z.ts'] },
        { ...imported('./a'), reason: 'ambiguous', candidates: ['a.ts', 'missing.ts'] },
        { ...imported('./lazy'), reason: 'not-static', candidates: [] },
      ],
    });
    const result = unusedFiles(map, scripts());
    expect(result.candidates.map(item => item.relativePath)).toEqual(['from.ts']);
    expect(result.unsure).toEqual([
      { fileId: 'a.ts', relativePath: 'a.ts', reason: '대상을 확정하지 못한 import가 이 파일을 가리킬 수 있어요.' },
      { fileId: 'lazy.ts', relativePath: 'lazy.ts', reason: '동적 import(또는 require)로 쓰일 수 있어요.' },
      { fileId: 'lazy/index.ts', relativePath: 'lazy/index.ts', reason: '동적 import(또는 require)로 쓰일 수 있어요.' },
      { fileId: 'z.ts', relativePath: 'z.ts', reason: '대상을 확정하지 못한 import가 이 파일을 가리킬 수 있어요.' },
    ].sort((a, b) => a.relativePath.localeCompare(b.relativePath)));
  });

  it.each([
    ['@/lib/foo.js', 'src/lib/foo.ts'], ['@/lib/index', 'src/lib/index.ts'], ['@/lib', 'src/lib/index.ts'],
    ['~/utils', 'src/utils.ts'], ['@/lib/foo.cjs', 'src/lib/foo.cts'], ['pkg/lib/foo', 'lib/foo.mts'],
  ])('normalizes both %s and %s before checking alias tails', (specifier, name) => {
    const map = mapOf([file(name), file(`unrelated-${name}`)], { external: [imported(specifier)] });
    const result = unusedFiles(map, scripts());
    // A path prefix may differ, but the complete tail must start at a path-segment boundary.
    expect(result.unsure).toContainEqual({ fileId: name, relativePath: name, reason: '경로 별칭으로 쓰일 수 있어요.' });
  });

  it('requires a path boundary and ignores package-only names and non-code files', () => {
    const result = unusedFiles(mapOf([file('src/notlib/foo.ts'), file('react.ts'), file('src/lib/foobar.ts'),
      file('style.css'), file('ignored.ts', { checked: 'not-code' })], { external: [imported('@/lib/foo'), imported('react')] }), scripts());
    expect(result.unsure).toEqual([]);
    expect(result.candidates.map(item => item.relativePath)).toEqual(['react.ts', 'src/lib/foobar.ts', 'src/notlib/foo.ts']);
  });

  it('keeps known used and excluded files out of unsure', () => {
    const result = unusedFiles(mapOf([file('a.ts'), file('a.test.ts')], {
      edges: [{ ...imported('./a'), toFileId: 'a.ts' }],
      unresolved: [{ ...imported('./a'), reason: 'ambiguous', candidates: ['a.ts', 'a.test.ts'] }],
    }), scripts());
    expect(result.unsure).toEqual([]);
    expect(result.candidates).toEqual([]);
  });

  it('reports unread files, computed imports and at most five failed package names', () => {
    const result = unusedFiles(mapOf([
      file('a.ts', { checked: 'partial' }), file('b.ts', { checked: 'failed' }), file('c.ts', { checked: 'skipped' }),
    ], { unresolved: [null, '@/dynamic', './relative'].map(specifier => ({ ...imported(specifier), reason: 'not-static', candidates: [] })) }), {
      files: new Set(), failed: Array.from({ length: 7 }, (_, i) => ({ relativePath: `p${i}/package.json`, reason: '읽기 실패' })),
    });
    expect(result.notes).toEqual([
      '끝까지 읽지 못한 파일 3개가 가져다 쓰는 파일이 후보에 섞였을 수 있어요.',
      '코드로 정하는 가져오기가 2곳 있어 후보가 실제로 쓰일 수 있어요.',
      'package.json 7개를 읽지 못해 실행 명령에 적힌 파일을 확인하지 못했어요: p0/package.json(읽기 실패), p1/package.json(읽기 실패), p2/package.json(읽기 실패), p3/package.json(읽기 실패), p4/package.json(읽기 실패) 외 2개',
      '안 쓰는 파일이 가져다 쓰는 파일은 후보에 나오지 않아요(그 파일이 아직 import하고 있으므로).',
    ]);
  });
});

describe('package script files', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp('/private/tmp/learning-unused-test-'); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  async function put(name: string, text: string) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), text);
  }
  async function read(bytes = 1024 * 1024, shouldStop = () => false) {
    const project = await scanProject(root, 'project');
    const files = [...project.files].reverse();
    return scriptFilesOf(root, files, new Map(files.map(file => [file.relativePath, file])), bytes, shouldStop);
  }

  it('reads string commands, quoted spaces, nested packages and all extensionless matches without running commands', async () => {
    const names = ['src/server.ts', 'scripts/seed.js', 'scripts/seed data.js', 'scripts/single data.js', "scripts/seed's data.js",
      'scripts/job.ts', 'scripts/job.js', 'scripts/job/index.ts', 'packages/web/src/run.ts', 'root.cjs'];
    for (const name of names) await put(name, 'export const value = 1;');
    await put('package.json', JSON.stringify({ scripts: {
      dev: 'ts-node src/server.ts', seed: 'node ./scripts/seed.js --x', quoted: 'node "./scripts/seed data.js"',
      single: "node './scripts/single data.js'", apostrophe: 'node "./scripts/seed\'s data.js"', extensionless: 'node scripts/job',
      root: 'node root.cjs', ignored: 123, outside: 'node ../escape.ts /src/absolute.js',
      noExecution: 'touch should-not-exist.ts',
    } }));
    await put('packages/web/package.json', JSON.stringify({ scripts: { start: 'node ./src/run.ts' } }));
    const result = await read();
    expect([...result.files].sort()).toEqual(names.sort());
    expect(result.failed).toEqual([]);
    const project = await scanProject(root, 'project');
    expect(project.files.some(file => file.relativePath === 'should-not-exist.ts')).toBe(false);
  });

  it('ignores paths that escape even if the normalized suffix matches a project file', async () => {
    await put('src/run.ts', '');
    await put('nested/package.json', JSON.stringify({ scripts: { start: 'node ../../src/run.ts /src/run.ts' } }));
    expect((await read()).files.size).toBe(0);
  });

  it.each(['null', '[]', '{}', '{"scripts":null}', '{"scripts":5}', '{"scripts":["src/run.ts"]}'])('ignores non-script JSON %s', async text => {
    await put('package.json', text);
    expect(await read()).toEqual(scripts());
  });

  it('continues after invalid JSON and charges its bytes to the shared budget', async () => {
    await put('a/package.json', '{broken');
    await put('b/package.json', '{"scripts":{"dev":"run.ts"}}');
    await put('b/run.ts', '');
    expect(await read()).toEqual({ files: new Set(['b/run.ts']), failed: [{ relativePath: 'a/package.json', reason: 'JSON 형식으로 읽을 수 없어요.' }] });
    const limited = await read(Buffer.byteLength('{broken'));
    expect(limited.files.size).toBe(0);
    expect(limited.failed[1]).toEqual({ relativePath: 'b/package.json', reason: '지도의 읽기 한도에 닿아 읽지 않았어요.' });
  });

  it('does not read any package at zero budget', async () => {
    await put('package.json', '{broken');
    expect(await read(0)).toEqual({ files: new Set(), failed: [{ relativePath: 'package.json', reason: '지도의 읽기 한도에 닿아 읽지 않았어요.' }] });
  });

  it('reads packages in path order within the total remaining bytes, including UTF-8 bytes', async () => {
    const manifest = JSON.stringify({ scripts: { dev: 'node run.ts' }, name: '시험' });
    for (const folder of ['a', 'b']) {
      await put(`${folder}/package.json`, manifest);
      await put(`${folder}/run.ts`, '');
    }
    const result = await read(Buffer.byteLength(manifest) * 2 - 1);
    expect(result.files).toEqual(new Set(['a/run.ts']));
    expect(result.failed).toEqual([{ relativePath: 'b/package.json', reason: '파일이 초기 읽기 크기 제한을 넘습니다.' }]);
    expect((await read(Buffer.byteLength(manifest) * 2)).files).toEqual(new Set(['a/run.ts', 'b/run.ts']));
  });

  it('rejects a package larger than the remaining code budget', async () => {
    await put('package.json', '{"scripts":{"dev":"node run.ts"}}');
    await put('run.ts', '');
    const result = await read(10);
    expect(result.files.size).toBe(0);
    expect(result.failed).toEqual([{ relativePath: 'package.json', reason: '파일이 초기 읽기 크기 제한을 넘습니다.' }]);
  });

  it.each(['deleted', 'linked', 'oversized'] as const)('continues when a package becomes %s after scanning', async change => {
    await put('a/package.json', '{}');
    await put('b/package.json', '{"scripts":{"dev":"run.ts"}}');
    await put('b/run.ts', '');
    const project = await scanProject(root, 'project');
    const name = path.join(root, 'a/package.json');
    await rm(name);
    if (change === 'linked') await symlink(path.join(root, 'b/package.json'), name);
    if (change === 'oversized') await writeFile(name, ' '.repeat(MAX_FILE_BYTES + 1));
    const result = await scriptFilesOf(root, project.files, new Map(project.files.map(file => [file.relativePath, file])), MAX_FILE_BYTES * 2, () => false);
    expect(result.files).toEqual(new Set(['b/run.ts']));
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ relativePath: 'a/package.json', reason: expect.any(String) });
  });

  it('cancels before a read and between packages, including at zero budget', async () => {
    await put('a/package.json', '{}');
    await put('b/package.json', '{}');
    await expect(read(100, () => true)).rejects.toMatchObject({ code: 'CANCELLED' });
    const stop = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    await expect(read(0, stop)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(stop).toHaveBeenCalledTimes(2);
  });
});
