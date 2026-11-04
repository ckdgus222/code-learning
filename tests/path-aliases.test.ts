import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanProject } from '../src/core/project/files';
import { NO_ALIASES, readPathAliases, resolveImport, type PathAliases } from '../src/core/analysis/path-aliases';
import { candidatesFor } from '../src/core/analysis/project-map';
import type { ProjectFile } from '../src/shared/contracts';

let root: string;
beforeEach(async () => { root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-path-aliases-'))); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function put(name: string, text: string) {
  await mkdir(path.dirname(path.join(root, name)), { recursive: true });
  await writeFile(path.join(root, name), text);
}
async function read(bytes = 256 * 1024, stop?: () => boolean) {
  const project = await scanProject(root, 'aliases');
  return readPathAliases(root, project.files, bytes, stop);
}
const known = (names: string[]) => new Map(names.map(relativePath => [relativePath, { id: relativePath, relativePath, size: 0 } satisfies ProjectFile]));
const aliases = (paths: Record<string, string[]>, baseUrl: string | null = null): PathAliases => ({ configs: [{ folder: '', readable: true, baseUrl,
  paths: Object.entries(paths).map(([pattern, targets]) => ({ pattern, targets })) }], notes: [], bytesRead: 0 });
const resolved = (names: string[], config: PathAliases, specifier = '@/api', from = 'main.ts') => resolveImport(from, specifier, known(names), config);
const project = (candidates: string[], sure = true) => ({ kind: 'project', candidates, via: 'alias', sure });

describe('one import resolver', () => {
  it.each([false, true])('prefers an exact pattern regardless of declaration order (%s)', reverse => {
    const entries: [string, string[]][] = [['@/api*', ['wild/api*']], ['@/api', ['exact/api']]];
    const config = aliases(Object.fromEntries(reverse ? entries.reverse() : entries));
    expect(resolved(['wild/api.ts', 'exact/api.ts'], config)).toEqual(project(['exact/api.ts']));
  });
  it.each([false, true])('uses the longest matching prefix (%s)', reverse => {
    const entries: [string, string[]][] = [['@/*', ['general/*']], ['@/a*', ['specific/a*']]];
    expect(resolved(['general/api.ts', 'specific/api.ts'], aliases(Object.fromEntries(reverse ? entries.reverse() : entries))))
      .toEqual(project(['specific/api.ts']));
  });
  it('checks wildcard suffixes and chooses the first target with candidates', () => {
    const config = aliases({ '@/*/end': ['missing/*', 'src/*', 'fallback/*'] });
    expect(resolved(['src/api.ts', 'fallback/api.ts'], config, '@/api/end')).toEqual(project(['src/api.ts']));
    expect(resolved(['src/api.ts'], config, '@/api/no')).toEqual({ kind: 'external' });
    expect(resolved([], config, '@/api/end')).toEqual(project([]));
  });
  it.each([['~/*', '~/api'], ['#lib', '#lib']])('supports %s', (pattern, specifier) => {
    expect(resolved(['src/api.ts'], aliases({ [pattern]: [pattern.includes('*') ? './src/*' : './src/api'] }), specifier))
      .toEqual(project(['src/api.ts']));
  });
  it('uses baseUrl only when paths did not match and leaves absent packages external', () => {
    const config = aliases({ '@/api': ['missing'] }, 'src');
    expect(resolved(['src/components/Button.tsx'], config, 'components/Button')).toEqual(project(['src/components/Button.tsx']));
    expect(resolved(['src/react.ts'], config, 'react')).toEqual(project(['src/react.ts']));
    expect(resolved([], config, 'react')).toEqual({ kind: 'external' });
    expect(resolved(['src/@/api.ts'], config)).toEqual(project([]));
  });
  it.each(['../shared/*', '/shared/*', 'src/../../shared/*'])('stops at an outside target %s', target => {
    expect(resolved(['src/api.ts'], aliases({ '@/*': [target, 'src/*'] }))).toEqual({ kind: 'outside' });
  });
  it('checks traversal after wildcard replacement', () => {
    expect(resolved(['fallback.ts'], aliases({ '@/*': ['src/*', 'fallback'] }), '@/../../shared')).toEqual({ kind: 'outside' });
  });
  it.each([
    [['types/api.d.ts', 'src/api.ts'], ['types/*', 'src/*'], ['types/api.d.ts']],
    [['src/api.d.ts', 'src/api/index.ts'], ['src/*'], ['src/api/index.ts', 'src/api.d.ts']],
    [['src/api.d.ts', 'src/api.ts'], ['src/*'], ['src/api.ts', 'src/api.d.ts']],
    [['src/api.ts', 'src/api/index.ts'], ['src/*'], ['src/api.ts', 'src/api/index.ts']],
    [['src/api.mjs', 'fallback/api.ts'], ['src/*', 'fallback/*'], ['src/api.mjs']],
    [['src/api.cjs', 'fallback/api.ts'], ['src/*', 'fallback/*'], ['src/api.cjs']],
    [['src/api.mts', 'fallback/api.ts'], ['src/*', 'fallback/*'], ['src/api.mts']],
    [['src/api.cts', 'fallback/api.ts'], ['src/*', 'fallback/*'], ['src/api.cts']],
    [['src/api.d.mts', 'fallback/api.ts'], ['src/*', 'fallback/*'], ['src/api.d.mts']],
    [['src/api.d.cts', 'fallback/api.ts'], ['src/*', 'fallback/*'], ['src/api.d.cts']],
  ])('retains uncertain candidates %j without trying later targets', (names, targets, candidates) => {
    expect(resolved(names, aliases({ '@/*': targets }))).toEqual(project(candidates, false));
  });
  it.each(['src/api.ts', 'src/api.tsx', 'src/api.js', 'src/api.jsx', 'src/api/index.ts'])('confirms the unique extensionless target %s', name => {
    expect(resolved([name], aliases({ '@/*': ['src/*'] }))).toEqual(project([name]));
  });
  it.each([
    ['main.js', '@/api.js', ['src/api.js', 'src/api.ts']],
    ['main.ts', '@/api.jsx', ['src/api.jsx', 'src/api.tsx']],
    ['main.js', '@/api.mjs', ['src/api.ts']],
    ['main.js', '@/api.cjs', ['src/api.cts']],
  ])('does not confirm explicit extensions in %s: %s', (from, specifier, names) => {
    const result = resolved(names, aliases({ '@/*': ['src/*'] }), specifier, from);
    expect(result).toEqual(project(names, false));
  });
  it('does not confirm an explicit target extension even when only a counterpart exists', () => {
    expect(resolved(['src/api.ts', 'fallback.ts'], aliases({ '@api': ['src/api.mjs', 'fallback.ts'] }), '@api'))
      .toEqual(project(['src/api.ts'], false));
  });
  it.each(['styles/mdx.css', 'env.mjs', 'api.ts'])('confirms the unique exact file %s', name => {
    expect(resolved([name], aliases({ '@/*': ['*'] }), `@/${name}`)).toEqual(project([name]));
    expect(resolved([name], aliases({ '@file': [name] }), '@file')).toEqual(project([name]));
  });
  it('does not confirm an exact file with another candidate or package boundary', () => {
    expect(resolved(['styles/mdx.css', 'styles/mdx.css.ts'], aliases({ '@/*': ['*'] }), '@/styles/mdx.css'))
      .toEqual(project(['styles/mdx.css', 'styles/mdx.css.ts'], false));
    expect(resolved(['env.mjs', 'env.mjs/package.json'], aliases({ '@/*': ['*'] }), '@/env.mjs'))
      .toEqual(project(['env.mjs'], false));
  });
  it.each(['api.d.ts', 'api.d.mts', 'api.d.cts'])('does not confirm an exact declaration file %s', name => {
    expect(resolved([name], aliases({ '@/*': ['*'] }), `@/${name}`)).toEqual(project([name], false));
  });
  it.each([[[]], [['lib/index.ts']]])('stops at a package folder, preserving candidates %j', names => {
    expect(resolved(['lib/package.json', 'fallback.ts', ...names], aliases({ '@lib': ['lib', 'fallback'] }), '@lib'))
      .toEqual(project(names, false));
  });
  it.each(['./api', './api.js', './api/', './api/.', '../', '../../outside', './api.d.ts', './vite.config'])('preserves relative rules for %s', specifier => {
    const files = known(['src/api.ts', 'src/api.js', 'src/api.d.ts', 'src/api/index.ts', 'src/vite.config.ts']);
    const candidates = candidatesFor('src/main.ts', specifier, files);
    expect(resolveImport('src/main.ts', specifier, files, NO_ALIASES)).toEqual(candidates === null ? { kind: 'outside' }
      : { kind: 'project', candidates, via: 'relative', sure: true });
  });
});

describe('project config reader', () => {
  it('reads JSON comments and trailing commas while preserving strings', async () => {
    await put('tsconfig.json', `\uFEFF{ // comment
      "compilerOptions": { /* comment */ "paths": { "@/*": ["./src/*",], "#url": ["src/http://literal"], }, },
    }`);
    const config = await read();
    expect(config.notes).toEqual([]);
    expect(resolved(['src/api.ts'], config)).toEqual(project(['src/api.ts']));
    expect(config.configs[0].paths[1].targets).toEqual(['src/http:/literal']);
  });
  it('uses a child baseUrl with paths declared in a parent', async () => {
    await put('configs/base.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['src/*'] } } }));
    await put('web/tsconfig.json', JSON.stringify({ extends: '../configs/base', compilerOptions: { baseUrl: '.' } }));
    expect(resolved(['web/src/api.ts', 'configs/src/api.ts'], await read(), '@/api', 'web/main.ts')).toEqual(project(['web/src/api.ts']));
  });
  it('keeps the baseUrl declaration folder when a child declares paths', async () => {
    await put('configs/base.json', JSON.stringify({ compilerOptions: { baseUrl: '../shared' } }));
    await put('web/tsconfig.json', JSON.stringify({ extends: '../configs/base.json', compilerOptions: { paths: { '@/*': ['*'] } } }));
    expect(resolved(['shared/api.ts', 'web/api.ts'], await read(), '@/api', 'web/main.ts')).toEqual(project(['shared/api.ts']));
  });
  it('retains a parent paths origin without baseUrl and ignores references after inheritance', async () => {
    await put('configs/base.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['src/*'] } } }));
    await put('web/tsconfig.json', JSON.stringify({ extends: '../configs/base', references: [{ path: '../other' }] }));
    const config = await read();
    expect(resolved(['configs/src/api.ts'], config, '@/api', 'web/main.ts')).toEqual(project(['configs/src/api.ts']));
    expect(config.notes).toEqual([]);
  });
  it('merges extends arrays in order and reads shared parents once', async () => {
    const base = JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } });
    const later = JSON.stringify({ compilerOptions: { paths: { '@/*': ['later/*'] } } });
    const child = JSON.stringify({ extends: ['../base.json', '../later.json'] });
    await put('base.json', base); await put('later.json', later);
    await put('web/tsconfig.json', child); await put('api/tsconfig.json', child);
    const config = await read();
    expect(resolved(['later/api.ts', 'src/api.ts'], config, '@/api', 'web/main.ts')).toEqual(project(['later/api.ts']));
    expect(config.bytesRead).toBe(Buffer.byteLength(base + later + child + child));
  });
  it('keeps web aliases separate from api and prefers tsconfig over jsconfig in the same folder', async () => {
    await put('web/tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['src/*'] } } }));
    await put('web/jsconfig.json', 'broken and must not be read');
    await put('api/jsconfig.json', JSON.stringify({ compilerOptions: { paths: { '~/*': ['*'] } } }));
    const config = await read();
    expect(config.configs).toHaveLength(2);
    expect(config.notes).toEqual([]);
    expect(resolved(['web/src/api.ts'], config, '@/api', 'web/main.ts')).toEqual(project(['web/src/api.ts']));
    expect(resolved(['web/src/api.ts'], config, '@/api', 'api/main.ts')).toEqual({ kind: 'external' });
    expect(resolved(['api/api.ts'], config, '~/api', 'api/main.ts')).toEqual(project(['api/api.ts']));
    expect(resolved(['web/src/api.ts'], config, '@/api', 'website/main.ts')).toEqual({ kind: 'external' });
  });
  it('reports package extends and references without loading them', async () => {
    await put('tsconfig.json', JSON.stringify({ extends: '@framework/config', references: [{ path: './app.json' }] }));
    await put('app.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['src/*'] } } }));
    const config = await read();
    expect(config.notes).toEqual([
      'tsconfig tsconfig.json의 extends가 패키지(@framework/config)를 가리켜 거기 적힌 별칭은 읽지 못했어요.',
      'tsconfig tsconfig.json는 다른 설정을 참조해요. 거기 적힌 경로 별칭은 아직 따라가지 않아요.',
    ]);
    expect(resolved(['src/api.ts'], config)).toEqual({ kind: 'external' });
  });
  it.each(['{ broken', '{ "compilerOptions": { "paths": { "@/**": ["src/*"] } } }'])('keeps an invalid child boundary: %s', async text => {
    await put('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['src/*'] } } }));
    await put('web/tsconfig.json', text);
    const config = await read();
    expect(config.configs.find(item => item.folder === 'web')?.readable).toBe(false);
    expect(config.notes).toHaveLength(1);
    expect(resolved(['src/api.ts'], config, '@/api', 'web/main.ts')).toEqual({ kind: 'external' });
    expect(resolved(['src/api.ts'], config, '@/api', 'main.ts')).toEqual(project(['src/api.ts']));
  });
  it.each([
    { moduleSuffixes: ['.native', ''] }, { module: 'nodenext' }, { moduleResolution: 'NodeNext' }, { moduleResolution: 'node16' },
  ])('disables aliases and baseUrl for inherited options %j', async option => {
    await put('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['src/*'] } } }));
    await put('base.json', JSON.stringify({ compilerOptions: { ...option, baseUrl: '.', paths: { '@/*': ['src/*', 'fallback.ts'] } } }));
    await put('web/tsconfig.json', JSON.stringify({ extends: '../base.json' }));
    const config = await read();
    expect(config.configs.find(item => item.folder === 'web')).toEqual({ folder: 'web', readable: true, baseUrl: null, paths: [] });
    expect(config.notes).toHaveLength(1);
    expect(resolved(['src/api.ts', 'fallback.ts'], config, '@/api', 'web/main.ts')).toEqual({ kind: 'external' });
  });
  it('supports bundler resolution and the default module suffix', async () => {
    await put('tsconfig.json', JSON.stringify({ compilerOptions: { moduleSuffixes: [''], moduleResolution: 'bundler', paths: { '@/*': ['src/*'] } } }));
    expect(resolved(['src/api.ts'], await read())).toEqual(project(['src/api.ts']));
  });
  it.each(['./base.json', '../outside.json', './missing'])('stops failed inheritance %s', async parent => {
    await put('tsconfig.json', JSON.stringify({ extends: parent }));
    await put('base.json', JSON.stringify({ extends: './tsconfig.json' }));
    const config = await read();
    expect(config.configs[0].readable).toBe(false);
    expect(config.notes.length).toBeGreaterThan(0);
  });
  it('stops inheritance after ten levels', async () => {
    await put('tsconfig.json', '{"extends":"./base0"}');
    for (let index = 0; index < 11; index++) await put(`base${index}.json`, JSON.stringify({ extends: `./base${index + 1}` }));
    const config = await read();
    expect(config.configs[0].readable).toBe(false);
    expect(config.notes.join(' ')).toContain('10단계');
  });
  it('retains a boundary when the budget cannot read it and never exceeds that budget', async () => {
    const configText = JSON.stringify({ compilerOptions: { paths: { '@/*': ['src/*'] } } });
    await put('tsconfig.json', configText); await put('web/tsconfig.json', configText);
    const config = await read(Buffer.byteLength(configText));
    expect(config.bytesRead).toBe(Buffer.byteLength(configText));
    expect(config.configs.find(item => item.folder === 'web')?.readable).toBe(false);
    expect(resolved(['src/api.ts'], config, '@/api', 'web/main.ts')).toEqual({ kind: 'external' });
    const tooSmall = await read(1);
    expect(tooSmall.bytesRead).toBe(0);
    expect(tooSmall.configs.every(item => !item.readable)).toBe(true);
    expect(tooSmall.notes).toHaveLength(2);
  });
  it('charges malformed JSON bytes and rejects changed or symlinked configs without leaking contents', async () => {
    await put('tsconfig.json', '{"private marker":');
    const config = await read();
    expect(config.bytesRead).toBe(Buffer.byteLength('{"private marker":'));
    expect(config.notes.join(' ')).not.toContain('private marker');
    const files = (await scanProject(root, 'aliases')).files;
    await rm(path.join(root, 'tsconfig.json'));
    await put('other.json', '{}');
    await symlink(path.join(root, 'other.json'), path.join(root, 'tsconfig.json'));
    expect((await readPathAliases(root, files, 1024)).configs[0].readable).toBe(false);
  });
  it('cancels before reading and after a config read', async () => {
    await expect(read(1000, () => true)).rejects.toMatchObject({ code: 'CANCELLED' });
    await put('tsconfig.json', '{}');
    let checks = 0;
    await expect(read(1000, () => ++checks === 4)).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});

it('says nothing about resolution options in a config that declares no aliases', async () => {
  // A NestJS server config (dog-walk api/) uses nodenext without paths: there is no alias to skip.
  await put('api/tsconfig.json', JSON.stringify({ compilerOptions: { module: 'nodenext', moduleResolution: 'nodenext', moduleSuffixes: ['.native', ''] } }));
  await put('api/src/main.ts', 'export {};');
  const found = await read();
  expect(found.notes).toEqual([]);
  expect(found.configs).toEqual([{ folder: 'api', readable: true, baseUrl: null, paths: [] }]);
});

it('reads a config with an unclosed string in one pass and reports it instead of stalling', async () => {
  // Backslashes and quotes over 100 KiB made the old regular expression backtrack for tens of seconds.
  await put('tsconfig.json', `{"compilerOptions":{"paths":{"@/*":["${'\\"'.repeat(80_000)}`);
  const started = performance.now();
  const found = await read();
  expect(performance.now() - started).toBeLessThan(2000);
  expect(found.configs).toEqual([{ folder: '', readable: false, baseUrl: null, paths: [] }]);
  expect(found.notes[0]).toMatch(/경로 별칭을 확인하지 못했어요/);
});

it('skips a config whose base or joined targets are longer than any real path', async () => {
  const baseUrl = 'b'.repeat(1100);
  const targets = Array.from({ length: 5 }, (_, index) => `t${index}/*`);
  await put('tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl, paths: { '@/*': targets } } }));
  const found = await read();
  expect(found.configs).toEqual([{ folder: '', readable: false, baseUrl: null, paths: [] }]);
  expect(found.notes).toEqual(['tsconfig tsconfig.json를 읽지 못해 경로 별칭을 확인하지 못했어요(paths가 너무 큼).']);
});

it('merges a parent extended many times only once', async () => {
  // Eight levels (within the ten-level limit), each extending the next ten times, used to multiply into 100 million merges.
  for (let level = 0; level < 8; level++) {
    const parent = level === 7 ? undefined : Array.from({ length: 10 }, () => `./c${level + 1}.json`);
    await put(`c${level}.json`, JSON.stringify({ ...(parent ? { extends: parent } : {}), compilerOptions: level === 7 ? { paths: { '@/*': ['src/*'] } } : {} }));
  }
  await put('tsconfig.json', JSON.stringify({ extends: './c0.json' }));
  const started = performance.now();
  const found = await read();
  expect(performance.now() - started).toBeLessThan(2000);
  expect(found.configs).toEqual([{ folder: '', readable: true, baseUrl: null, paths: [{ pattern: '@/*', targets: ['src/*'] }] }]);
});

it('skips configs with too many patterns or targets and leaves very long names unresolved', async () => {
  await put('a/tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': Array.from({ length: 11 }, (_, index) => `t${index}/*`) } } }));
  await put('b/tsconfig.json', JSON.stringify({ compilerOptions: { paths: Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`@p${index}/*`, ['src/*']])) } }));
  const found = await read();
  expect(found.configs.map(config => config.readable)).toEqual([false, false]);
  expect(found.notes).toEqual(['tsconfig a/tsconfig.json를 읽지 못해 경로 별칭을 확인하지 못했어요(paths가 너무 큼).',
    'tsconfig b/tsconfig.json를 읽지 못해 경로 별칭을 확인하지 못했어요(paths가 너무 큼).']);
  const long = `@/${'x'.repeat(1100)}`;
  expect(resolved([`src/${'x'.repeat(1100)}.ts`], aliases({ '@/*': ['src/*'] }), long)).toEqual({ kind: 'external' });
});

it('copies only the options alias resolution reads when a parent with many options is extended repeatedly', async () => {
  const options = Object.fromEntries(Array.from({ length: 5000 }, (_, index) => [`option${index}`, true]));
  await put('base.json', JSON.stringify({ compilerOptions: { ...options, paths: { '@/*': ['src/*'] } } }));
  await put('tsconfig.json', JSON.stringify({ extends: Array.from({ length: 10 }, () => './base.json') }));
  const started = performance.now();
  const found = await read();
  expect(performance.now() - started).toBeLessThan(2000);
  expect(found.configs.find(config => config.folder === '')).toEqual({ folder: '', readable: true, baseUrl: null, paths: [{ pattern: '@/*', targets: ['src/*'] }] });
});

it('skips a config extending more files or packages than any real one, with a single note', async () => {
  await put('tsconfig.json', JSON.stringify({ extends: Array.from({ length: 11 }, (_, index) => `package-${index}/tsconfig.json`), compilerOptions: { paths: { '@/*': ['src/*'] } } }));
  const found = await read();
  expect(found.configs).toEqual([{ folder: '', readable: false, baseUrl: null, paths: [] }]);
  expect(found.notes).toEqual(['tsconfig tsconfig.json를 읽지 못해 경로 별칭을 확인하지 못했어요(extends가 10개를 넘음).']);
});
