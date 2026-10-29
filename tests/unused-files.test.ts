import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MapFile, MapImport, ProjectMap, UnusedExcludeKind } from '../src/shared/contracts';
import { MAX_FILE_BYTES, scanProject } from '../src/core/project/files';
import { scriptFilesOf, unusedFiles, type ScriptFiles } from '../src/core/analysis/unused-files';

const file = (relativePath: string, extra: Partial<MapFile> = {}): MapFile => ({ id: relativePath, relativePath,
  folder: path.posix.dirname(relativePath), start: false, entry: false, checked: 'full', reason: null, ...extra });
const imported = (specifier: string | null, fromFileId = 'from.ts'): MapImport => ({ fromFileId, specifier,
  fileHash: 'hash', startUtf16: 0, endUtf16: 1, startLine: 1, endLine: 1, text: 'import' });
const mapOf = (files: MapFile[], extra: Partial<Omit<ProjectMap, 'unused'>> = {}): Omit<ProjectMap, 'unused'> => ({
  projectId: 'project', files, edges: [], unresolved: [], external: [], complexFunctions: [], exports: [], limited: false, notes: [], ...extra,
});
const scripts = (): ScriptFiles => ({ files: new Set(), failed: [], references: new Set(), referenceFailed: [] });

describe('unused file candidates', () => {
  it('sorts candidates, ignores self imports and counts incoming edges even from tests or unused cycles', () => {
    const map = mapOf(['z.ts', 'a.ts', 'used.ts', 'a.test.ts', 'cycle-a.ts', 'cycle-b.ts'].map(name => file(name)), {
      edges: [
        { ...imported('./a', 'a.ts'), toFileId: 'a.ts', names: [] },
        { ...imported('./used', 'a.test.ts'), toFileId: 'used.ts', names: [] },
        { ...imported('./cycle-b', 'cycle-a.ts'), toFileId: 'cycle-b.ts', names: [] },
        { ...imported('./cycle-a', 'cycle-b.ts'), toFileId: 'cycle-a.ts', names: [] },
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
    const result = unusedFiles(mapOf([file(name, { entry: kind === 'start' })]), {
      ...scripts(), files: new Set(kind === 'script' ? [name] : []),
    });
    expect(result.candidates).toEqual([]);
    expect(result.unsure).toEqual([]);
    expect(result.excluded).toEqual([{ kind, count: 1 }]);
  });

  it('counts only the first matching exclusion, in the specified kind order', () => {
    const names = ['entry.test.config.d.ts', 'unit.test.config.d.ts', 'tool.config.d.ts', 'app/page.d.ts', 'app/page.ts', 'script.ts'];
    const result = unusedFiles(mapOf([...names.map((name, index) => file(name, { entry: index === 0 })), file('next.config.ts')]), {
      ...scripts(), files: new Set(names),
    });
    expect(result.excluded).toEqual([
      { kind: 'start', count: 1 }, { kind: 'test', count: 1 }, { kind: 'config', count: 2 },
      { kind: 'types', count: 1 }, { kind: 'framework', count: 1 }, { kind: 'script', count: 1 },
    ]);
    expect(result.candidates).toEqual([]);
  });

  it('excludes references last and preserves every earlier matching kind', () => {
    const names = ['entry.ts', 'unit.test.ts', 'next.config.ts', 'global.d.ts', 'app/page.ts', 'script.ts', 'referenced.ts'];
    const result = unusedFiles(mapOf([...names.map((name, index) => file(name, { entry: index === 0 })), file('orphan.ts')]), {
      ...scripts(), files: new Set(['script.ts']), references: new Set(names),
    });
    expect(result.excluded).toEqual(['start', 'test', 'config', 'types', 'framework', 'script', 'reference']
      .map(kind => ({ kind, count: 1 })));
    expect(result.candidates).toEqual([{ fileId: 'orphan.ts', relativePath: 'orphan.ts' }]);
    expect(result.unsure).toEqual([]);
  });

  it.each([1, 5, 7])('reports %i failed reference sources with at most five names', count => {
    const referenceFailed = Array.from({ length: count }, (_, i) => ({ relativePath: `p${i}/index.html`, reason: '읽기 실패' }));
    const result = unusedFiles(mapOf([]), { ...scripts(), referenceFailed });
    const names = referenceFailed.slice(0, 5).map(item => `${item.relativePath}(읽기 실패)`).join(', ');
    expect(result.notes).toEqual([
      `설정·HTML 파일 ${count}개를 읽지 못해 거기 적힌 경로를 확인하지 못했어요: ${names}${count > 5 ? ' 외 2개' : ''}`,
      '안 쓰는 파일이 가져다 쓰는 파일은 후보에 나오지 않아요(그 파일이 아직 import하고 있으므로).',
    ]);
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
      edges: [{ ...imported('./a'), toFileId: 'a.ts', names: [] }],
      unresolved: [{ ...imported('./a'), reason: 'ambiguous', candidates: ['a.ts', 'a.test.ts'] }],
    }), scripts());
    expect(result.unsure).toEqual([]);
    expect(result.candidates).toEqual([]);
  });

  it('reports unread files, computed imports and at most five failed package names', () => {
    const result = unusedFiles(mapOf([
      file('a.ts', { checked: 'partial' }), file('b.ts', { checked: 'failed' }), file('c.ts', { checked: 'skipped' }),
    ], { unresolved: [null, '@/dynamic', './relative'].map(specifier => ({ ...imported(specifier), reason: 'not-static', candidates: [] })) }), {
      ...scripts(), failed: Array.from({ length: 7 }, (_, i) => ({ relativePath: `p${i}/package.json`, reason: '읽기 실패' })),
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
    expect(await read()).toEqual({ ...scripts(), files: new Set(['b/run.ts']), failed: [{ relativePath: 'a/package.json', reason: 'JSON 형식으로 읽을 수 없어요.' }] });
    const limited = await read(Buffer.byteLength('{broken'));
    expect(limited.files.size).toBe(0);
    expect(limited.failed[1]).toEqual({ relativePath: 'b/package.json', reason: '지도의 읽기 한도에 닿아 읽지 않았어요.' });
  });

  it('does not read any package at zero budget', async () => {
    await put('package.json', '{broken');
    expect(await read(0)).toEqual({ ...scripts(), failed: [{ relativePath: 'package.json', reason: '지도의 읽기 한도에 닿아 읽지 않았어요.' }] });
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

  it('reads config entries and HTML sources, including comments, spaces and static backticks without executing them', async () => {
    const names = ['src/main/main.ts', 'src/preload/preload.ts', 'src/renderer/main.tsx', 'src/comment.ts', 'src/with space.ts'];
    for (const name of names) await put(name, '');
    await put('forge.config.ts', [
      "export default { entry: 'src/main/main.ts', preload: `src/preload/preload.ts`, other: 'src/with space.ts' };",
      '// "src/comment.ts"', "throw new Error('must not execute');",
    ].join('\n'));
    await put('index.html', '<script src="/src/renderer/main.tsx"></script>');
    expect(await read()).toEqual({ ...scripts(), references: new Set(names) });
  });

  it('keeps strings after a comment apostrophe paired, as in forge.config.ts', async () => {
    for (const name of ['src/main/main.ts', 'src/preload/preload.ts']) await put(name, '');
    await put('forge.config.ts', [
      "// tree-sitter 0.21's source build selects C++17.",
      "export default { ignore: ['tree-sitter'], build: [{ entry: 'src/main/main.ts' }, { entry: 'src/preload/preload.ts' }] };",
    ].join('\n'));
    expect((await read()).references).toEqual(new Set(['src/main/main.ts', 'src/preload/preload.ts']));
  });

  it('resolves leading slashes from both the source folder and root, but relative paths only from the source folder', async () => {
    const names = ['src/app.ts', 'pages/src/app.ts', 'pages/x.ts', 'x.ts', 'web/src/app.ts', 'pages/parent.ts'];
    for (const name of names) await put(name, '');
    await put('pages/index.html', '<script src="/src/app.ts"></script><script src="./x.ts"></script>');
    await put('pages/nested/index.html', '<script src="../parent.ts"></script>');
    await put('web/vite.config.ts', "export default { entry: 'src/app.ts' };");
    expect((await read()).references).toEqual(new Set(names.filter(name => name !== 'x.ts')));
  });

  it('ignores URLs, globs, interpolated templates, empty strings, bare names, outside paths and non-code matches', async () => {
    for (const name of ['src/a.ts', 'a.js', 'a.ts', 'bare.ts', 'style.css']) await put(name, '');
    await put('vite.config.ts', [
      "'src/**/*.ts'", "'https://x.dev/a.js'", '`${dir}/a.ts`', '`${"./a.ts"}`', "''", "'bare'",
      "'../a.ts'", "'/../a.ts'", "'./style.css'",
    ].join(';\n'));
    await put('nested/vite.config.ts', "'../../a.ts';");
    await put('ordinary.ts', "'./a.ts';");
    await put('index.htm', '<script src="./a.ts"></script>');
    expect(await read()).toEqual(scripts());
  });

  it('collects every extensionless match and JS counterpart through the existing candidate rules', async () => {
    const names = ['src/job.ts', 'src/job.js', 'src/job/index.ts', 'src/run.ts', 'src/run.js'];
    for (const name of [...names, 'src/job.d.ts']) await put(name, '');
    await put('vite.config.ts', "['src/job', './src/run.js'];");
    expect((await read()).references).toEqual(new Set(names));
  });

  it('uses the same config rule for exclusion and reference source selection', async () => {
    const configs = ['vite.config.ts', 'nested/tool.config.cjs', '.eslintrc.js', 'nested/.customrc.mjs', 'web/next.config.mts'];
    const ordinary = ['config.ts', 'tool.config.json', 'nested.config/helper.ts', 'eslintrc.js', '.rc.json'];
    for (const name of [...configs, ...ordinary]) await put(name, '');
    const result = await read(0);
    const selected = result.referenceFailed.map(item => item.relativePath);
    const excluded = [...configs, ...ordinary].filter(name =>
      unusedFiles(mapOf([file(name)]), scripts()).excluded.some(item => item.kind === 'config'));
    expect(selected).toEqual(configs.sort((a, b) => a.localeCompare(b)));
    expect(selected).toEqual(excluded.sort((a, b) => a.localeCompare(b)));
  });

  it('reads all packages before config and HTML sources, then uses the shared remaining UTF-8 byte budget in path order', async () => {
    const manifest = '{"scripts":{"dev":"run.ts"}}';
    const config = "'./run.ts'; // 시험";
    for (const folder of ['y', 'z']) {
      await put(`${folder}/package.json`, manifest);
      await put(`${folder}/run.ts`, '');
    }
    await put('a.config.ts', config);
    await put('b.html', '<script src="./run.ts"></script>');
    await put('run.ts', '');
    const exhausted = await read(Buffer.byteLength(manifest) * 2);
    expect(exhausted).toEqual({ ...scripts(), files: new Set(['y/run.ts', 'z/run.ts']), referenceFailed: [
      { relativePath: 'a.config.ts', reason: '지도의 읽기 한도에 닿아 읽지 않았어요.' },
      { relativePath: 'b.html', reason: '지도의 읽기 한도에 닿아 읽지 않았어요.' },
    ] });
    const partial = await read(Buffer.byteLength(manifest) * 2 + Buffer.byteLength(config));
    expect(partial.references).toEqual(new Set(['run.ts']));
    expect(partial.referenceFailed).toEqual([exhausted.referenceFailed[1]]);
    const short = await read(Buffer.byteLength(manifest) * 2 + Buffer.byteLength(config) - 1);
    expect(short.references.size).toBe(0);
    expect(short.referenceFailed).toEqual(['a.config.ts', 'b.html'].map(relativePath => ({
      relativePath, reason: '파일이 초기 읽기 크기 제한을 넘습니다.',
    })));
  });

  it.each(['deleted', 'linked', 'oversized'] as const)('continues when a config becomes %s after scanning', async change => {
    await put('a.config.ts', "'./run.ts';");
    await put('b.html', '<script src="./run.ts"></script>');
    await put('run.ts', '');
    const project = await scanProject(root, 'project');
    const name = path.join(root, 'a.config.ts');
    await rm(name);
    if (change === 'linked') await symlink(path.join(root, 'b.html'), name);
    if (change === 'oversized') await writeFile(name, ' '.repeat(MAX_FILE_BYTES + 1));
    const result = await scriptFilesOf(root, project.files, new Map(project.files.map(file => [file.relativePath, file])), MAX_FILE_BYTES * 2, () => false);
    expect(result.references).toEqual(new Set(['run.ts']));
    expect(result.failed).toEqual([]);
    expect(result.referenceFailed).toEqual([{ relativePath: 'a.config.ts', reason: change === 'linked'
      ? '심볼릭 링크와 폴더 밖 파일은 읽지 않습니다.' : change === 'oversized'
        ? '파일이 초기 읽기 크기 제한을 넘습니다.' : '파일을 읽지 못했어요.' }]);
  });

  it.each([0, 100])('cancels before and between reference reads at a budget of %i bytes', async bytes => {
    await put('a.config.ts', '');
    await put('b.html', '');
    await expect(read(bytes, () => true)).rejects.toMatchObject({ code: 'CANCELLED' });
    const stop = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    await expect(read(bytes, stop)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it('checks cancellation between the last package and first reference source', async () => {
    await put('z/package.json', '{}');
    await put('a.config.ts', '');
    const stop = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    await expect(read(100, stop)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(stop).toHaveBeenCalledTimes(2);
  });
});

describe('unused value exports', () => {
  const exported = (fileId: string, name: string, startLine = 1): ProjectMap['exports'][number] => ({ fileId, fileHash: 'hash',
    name, displayName: name, kind: 'value', startUtf16: startLine * 10, endUtf16: startLine * 10 + 5, startLine, endLine: startLine, usedInFile: false });

  it('matches names per target file, counts tests, ignores self imports and sorts by path and range', () => {
    const exports = [exported('z.ts', 'same'), exported('a.ts', 'later', 3), exported('a.ts', 'same'),
      exported('a.ts', 'default', 2), exported('a.ts', 'used'), exported('a.ts', 'testOnly')];
    const result = unusedFiles(mapOf(['z.ts', 'a.ts', 'from.ts', 'from.test.ts'].map(name => file(name)), { exports,
      edges: [
        { ...imported('./a'), toFileId: 'a.ts', names: ['used'] },
        { ...imported('./z'), toFileId: 'z.ts', names: ['same'] },
        { ...imported('./a', 'from.test.ts'), toFileId: 'a.ts', names: ['testOnly'] },
        { ...imported('./a', 'a.ts'), toFileId: 'a.ts', names: ['same', 'later', 'default'] },
        { ...imported('./a', 'a.ts'), toFileId: 'a.ts', names: 'all' },
      ],
    }), scripts());
    expect(result.exports.candidates.map(item => [item.relativePath, item.name, item.startLine])).toEqual([
      ['a.ts', 'same', 1], ['a.ts', 'default', 2], ['a.ts', 'later', 3],
    ]);
    expect(result.exports.candidates[0]).toEqual({ ...exports[2], relativePath: 'a.ts' });
    expect(result.exports.unsure).toEqual([]);
    expect(result.exports.notes).toEqual([
      "시험 파일이 가져다 쓰는 export도 '쓰임'으로 봐요.",
      'export 이름만 비교했어요. 객체 안 속성이나 클래스 메서드가 쓰이는지는 보지 않아요.',
    ]);
  });

  it('does not offer any names when a different file imports all names', () => {
    const result = unusedFiles(mapOf([file('a.ts'), file('from.ts')], {
      exports: [exported('a.ts', 'a'), exported('a.ts', 'b')],
      edges: [{ ...imported('./a'), toFileId: 'a.ts', names: ['a'] }, { ...imported('./a'), toFileId: 'a.ts', names: 'all' }],
    }), scripts());
    expect(result.exports).toEqual({ candidates: [], notes: [], unsure: [{ fileId: 'a.ts', relativePath: 'a.ts', count: 2,
      reason: '모두 가져오는 import(* as, export *)가 있어 어느 이름을 쓰는지 정할 수 없어요.' }] });
  });

  it.each(['dynamic', 'alias', 'unresolved'] as const)('reports %s uncertainty even alongside a named import', kind => {
    const extra: Partial<ProjectMap> = kind === 'alias' ? { external: [imported('@/a')] }
      : { unresolved: [{ ...imported('./a'), reason: kind === 'dynamic' ? 'not-static' : 'ambiguous',
        candidates: kind === 'dynamic' ? [] : ['a.ts'] }] };
    const source = mapOf([file('from.ts'), file('a.ts')], { ...extra, exports: [exported('a.ts', 'used'), exported('a.ts', 'maybe')],
      edges: [{ ...imported('./a'), toFileId: 'a.ts', names: ['used'] }],
    });
    const result = unusedFiles(source, scripts());
    expect(result.candidates.map(item => item.fileId)).toEqual(['from.ts']);
    expect(result.unsure).toEqual([]);
    expect(result.exports.candidates).toEqual([]);
    expect(result.exports.unsure).toEqual([{ fileId: 'a.ts', relativePath: 'a.ts', count: 2,
      reason: kind === 'dynamic' ? '동적 import(또는 require)로 쓰일 수 있어요.' : kind === 'alias'
        ? '경로 별칭으로 쓰일 수 있어요.' : '대상을 확정하지 못한 import가 이 파일을 가리킬 수 있어요.' }]);
    const withoutNamedImport = unusedFiles({ ...source, edges: [] }, scripts());
    expect(withoutNamedImport.exports.unsure).toEqual(result.exports.unsure);
    expect(withoutNamedImport.unsure).toEqual([{ fileId: 'a.ts', relativePath: 'a.ts', reason: result.exports.unsure[0].reason }]);
  });

  it('omits orphan-file exports and every exclusion kind but examines learning-only starts', () => {
    const excluded = ['entry.ts', 'unit.test.ts', 'next.config.ts', 'global.d.ts', 'app/page.ts', 'script.ts', 'referenced.ts'];
    const files = [...excluded.map(name => file(name, { entry: name === 'entry.ts' })), file('orphan.ts'), file('learning.ts', { start: true })];
    const result = unusedFiles(mapOf(files, { exports: files.map(item => exported(item.id, 'value')),
      edges: [...excluded, 'learning.ts'].map(toFileId => ({ ...imported('./file'), toFileId, names: [] })),
    }), { ...scripts(), files: new Set(['script.ts']), references: new Set(['referenced.ts']) });
    expect(result.candidates.map(item => item.fileId)).toEqual(['orphan.ts']);
    expect(result.exports.candidates.map(item => item.fileId)).toEqual(['learning.ts']);
    expect(result.excluded).toEqual(['start', 'test', 'config', 'types', 'framework', 'script', 'reference'].map(kind => ({ kind, count: 1 })));
    expect(result.exports.unsure).toEqual([]);
    const isolatedStart = unusedFiles(mapOf([file('learning.ts', { start: true })]), scripts());
    expect(isolatedStart.candidates.map(item => item.fileId)).toEqual(['learning.ts']);
  });

  it('preserves default display names and local-use tags, and repeats the unread-file note', () => {
    const result = unusedFiles(mapOf([file('a.ts', { checked: 'partial' }), file('z.ts'), file('from.ts')], {
      exports: [{ ...exported('a.ts', 'default'), displayName: 'default (Named)', kind: 'class', usedInFile: true }, exported('z.ts', 'default')],
      edges: ['a.ts', 'z.ts'].map(toFileId => ({ ...imported('./file'), toFileId, names: [] })),
    }), scripts());
    expect(result.exports.candidates.map(item => [item.displayName, item.usedInFile])).toEqual([['default (Named)', true], ['default', false]]);
    expect(result.exports.notes).toContain(result.notes[0]);
    expect(result.notes[0]).toBe('끝까지 읽지 못한 파일 1개가 가져다 쓰는 파일이 후보에 섞였을 수 있어요.');
    const empty = unusedFiles(mapOf([file('a.ts', { checked: 'failed' })]), scripts());
    expect(empty.exports).toEqual({ candidates: [], unsure: [], notes: [result.notes[0]] });
  });
});
