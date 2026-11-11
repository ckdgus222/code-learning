import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFile, mkdtemp, realpath, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { scanProject } from '../src/core/project/files';
import { buildProjectMap, MAP_LIMITS } from '../src/core/analysis/project-map';
import { buildOverview } from '../src/core/analysis/overview';
import { analyzeSource } from '../src/core/analysis/syntax';
import { matchFunction } from '../src/renderer/map-layout';
import type { ProjectFiles, ProjectMap } from '../src/shared/contracts';
import { complexitySource, legacySource } from './complexity-fixture';

let sandbox: string;
let root: string;
async function put(relative: string, data: string | Buffer) {
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), data);
}
// Every import form the map handles, one per line, so expected results can name their line.
const mainSource = [
  "import { a } from './a';",
  "import b from './b.js';",
  "import { c } from './c';",
  "import { d } from './d';",
  "import x from '@/utils';",
  "import React from 'react';",
  "export * from './re';",
  "import type { T } from './types';",
  "import '../styles.css';",
  "import { z } from '../../outside';",
  "import { m } from './missing';",
  "import { i } from './ignored';",
  "import { x2 } from './x.js';",
  "import { e } from './e.js';",
  "import cfg from './vite.config';",
  "const lazy = import('./lazy');",
  "const old = require('./old');",
  "import fs = require('fs');",
  "import { y as } from './a';",
  "import { w } from './a\\u002fb';",
  "import { f1 } from './foo/';",
  "import { f2 } from './foo.ts/';",
  "import { g } from './dir/';",
  "import { f3 } from './foo/.';",
  "import { up } from './dir/..';",
].join('\n') + '\n';
beforeEach(async () => {
  sandbox = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-map-test-')));
  root = path.join(sandbox, 'project');
  await mkdir(root);
  await put('.gitignore', 'src/ignored.ts\n');
  await put('styles.css', 'body {}\n');
  await put('src/main.ts', mainSource);
  for (const file of ['a.ts', 'b.js', 'b.js.ts', 'c/index.ts', 'd.ts', 'd/index.ts', 're.ts', 'types.ts', 'ignored.ts', 'x.ts', 'e.js.ts',
    'vite.config.ts', 'foo.ts', 'dir.ts', 'dir/index.ts']) {
    await put(`src/${file}`, 'export const value = 1;\n');
  }
});
afterEach(async () => { await rm(sandbox, { recursive: true, force: true }); });

async function mapOf(project: ProjectFiles, starts: string[] = [], limits = MAP_LIMITS): Promise<ProjectMap> {
  return buildProjectMap(root, project.id, project.files, starts, limits);
}
// Results by path and line, which the expected lists use.
function readable(project: ProjectFiles, map: ProjectMap) {
  const pathOf = (id: string) => project.files.find(file => file.id === id)!.relativePath;
  return {
    edges: map.edges.map(edge => [pathOf(edge.fromFileId), edge.startLine, pathOf(edge.toFileId)]),
    unresolved: map.unresolved.map(item => [item.startLine, item.reason, item.candidates]),
    external: map.external.map(item => [item.startLine, item.specifier]),
  };
}

describe('project map from static imports', () => {
  it('resolves Vue and SCSS imports as exact non-code files', async () => {
    await put('src/main.ts', "import Card from './Card.vue';\nimport './theme.scss';\n");
    await put('src/Card.vue', '<template><p>Hello</p></template>');
    await put('src/theme.scss', '$color: red;');
    const project = await scanProject(root, randomUUID());
    const result = await mapOf(project);
    const main = project.files.find(file => file.relativePath === 'src/main.ts')!;
    const targets = ['src/Card.vue', 'src/theme.scss'].map(relativePath => project.files.find(file => file.relativePath === relativePath)!);
    expect(result.edges).toHaveLength(2);
    expect(result.edges.map(item => [item.fromFileId, item.toFileId])).toEqual(targets.map(file => [main.id, file.id]));
    for (const target of targets) expect(result.files.find(file => file.id === target.id)?.checked).toBe('not-code');
    expect(result.unresolved).toEqual([]);
  });

  it('connects only relative imports with exactly one fitting file and sorts the rest by reason', async () => {
    const project = await scanProject(root, randomUUID());
    const map = await mapOf(project);
    expect(readable(project, map)).toEqual({
      edges: [
        ['src/main.ts', 1, 'src/a.ts'],
        // An extension that names a listed file type is taken as written: b.js, not b.js.ts.
        ['src/main.ts', 2, 'src/b.js'],
        ['src/main.ts', 3, 'src/c/index.ts'],
        ['src/main.ts', 7, 'src/re.ts'],
        ['src/main.ts', 8, 'src/types.ts'],
        ['src/main.ts', 9, 'styles.css'],
        ['src/main.ts', 13, 'src/x.ts'],
        // `.config` is not a listed file type, so the name may still take a code extension.
        ['src/main.ts', 15, 'src/vite.config.ts'],
        // A trailing slash names a folder: only dir/index.ts, not dir.ts.
        ['src/main.ts', 23, 'src/dir/index.ts'],
      ],
      unresolved: [
        [4, 'ambiguous', ['src/d.ts', 'src/d/index.ts']],
        [10, 'outside', []],
        [11, 'not-found', []],
        // Excluded by .gitignore, so it is not in the opened folder's list.
        [12, 'not-found', []],
        // Substitution follows x.ts, but never appends .ts to e.js.
        [14, 'not-found', []],
        [16, 'not-static', []],
        [17, 'not-static', []],
        [18, 'not-static', []],
        [19, 'syntax', []],
        // './a\u002fb' means a/b; its first piece './a' must not lead to a.ts.
        [20, 'unreadable', []],
        // Folders foo/ and foo.ts/ do not exist; foo.ts is a file, not either folder.
        [21, 'not-found', []],
        [22, 'not-found', []],
        // './foo/.' is the folder foo, and './dir/..' is src itself: neither has an index file.
        [24, 'not-found', []],
        [25, 'not-found', []],
      ],
      external: [[5, '@/utils'], [6, 'react']],
    });
  });

  it('keeps each import statement as its evidence: line, text, range and the file hash', async () => {
    const project = await scanProject(root, randomUUID());
    const map = await mapOf(project);
    const hash = createHash('sha256').update(mainSource).digest('hex');
    const lines = mainSource.split('\n');
    for (const item of [...map.edges, ...map.unresolved, ...map.external]) {
      expect(item.fileHash).toBe(hash);
      expect(mainSource.slice(item.startUtf16, item.endUtf16)).toBe(item.text);
      expect(item.endLine).toBe(item.startLine);
      // A declaration covers its line; `import()` and `require()` cover only the call inside it.
      expect(lines[item.startLine - 1]).toContain(item.text);
    }
    expect(map.edges[0].text).toBe("import { a } from './a';");
    expect(map.unresolved.find(item => item.startLine === 16)!.text).toBe("import('./lazy')");
  });

  it('marks how far each file was examined and which ones start the reading', async () => {
    await put('src/bad.ts', Buffer.from([0x69, 0x6d, 0xff, 0xfe, 0x0a]));
    const project = await scanProject(root, randomUUID());
    const start = project.files.find(file => file.relativePath === 'src/a.ts')!.id;
    const map = await mapOf(project, [start]);
    const byPath = new Map(map.files.map(file => [file.relativePath, file]));
    expect(byPath.get('src/a.ts')).toMatchObject({ checked: 'full', reason: null, start: true, folder: 'src' });
    // The syntax error in its last line means other imports inside an error could have been missed.
    expect(byPath.get('src/main.ts')).toMatchObject({ checked: 'partial', reason: '구문 오류가 있어 오류 구역 안의 import와 함수는 놓쳤을 수 있어요.', start: false });
    expect(byPath.get('src/bad.ts')).toMatchObject({ checked: 'failed', reason: 'UTF-8로 읽을 수 없는 파일입니다.' });
    expect(byPath.get('styles.css')).toMatchObject({ checked: 'not-code', folder: '' });
    expect(byPath.has('src/ignored.ts')).toBe(false);
    expect(map.limited).toBe(false);
  });

  it('stops at its limits and says so, without guessing the rest', async () => {
    const project = await scanProject(root, randomUUID());
    const tight = await mapOf(project, [], { ...MAP_LIMITS, files: 2 });
    expect(tight.limited).toBe(true);
    expect(tight.files.filter(file => file.checked === 'skipped').length).toBe(tight.files.filter(file => file.checked !== 'not-code').length - 2);
    expect(tight.notes).toEqual(['지도는 파일 2개·합계 16 MiB까지만 읽어요. 나머지 파일의 연결은 보지 않았어요.']);
    const shallow = await mapOf(project, [], { ...MAP_LIMITS, nodesPerFile: 20 });
    const main = shallow.files.find(file => file.relativePath === 'src/main.ts')!;
    expect(main).toMatchObject({ checked: 'partial', reason: '분석량 한도에 닿아 파일 뒷부분의 import와 함수는 보지 않았어요.' });
    expect(shallow.edges.length).toBeLessThan(7);
  });

  it.each([
    ['deleted', async () => rm(path.join(root, 'styles.css'))],
    ['excluded', async () => appendFile(path.join(root, '.gitignore'), 'styles.css\n')],
    ['replaced by a link', async () => {
      await rm(path.join(root, 'styles.css'));
      await writeFile(path.join(sandbox, 'elsewhere.css'), 'body {}\n');
      await symlink(path.join(sandbox, 'elsewhere.css'), path.join(root, 'styles.css'));
    }],
  ])('does not connect a target %s after the folder was opened', async (_name, change) => {
    const project = await scanProject(root, randomUUID());
    await change();
    const map = await mapOf(project);
    expect(readable(project, map).unresolved).toContainEqual([9, 'unavailable', ['styles.css']]);
    expect(readable(project, map).edges.some(([, line]) => line === 9)).toBe(false);
  });

  it('lists the functions over a complexity limit, measured as the analyzer measures them', async () => {
    await put('src/complexity.ts', complexitySource);
    await put('lib/legacy.js', legacySource);
    const project = await scanProject(root, randomUUID());
    const map = await mapOf(project);
    const pathOf = (id: string) => project.files.find(file => file.id === id)!.relativePath;
    const lineOf = (text: string, name: string) => text.slice(0, text.indexOf(name)).split('\n').length;
    // In path order (lib/ before src/), then in source order.
    expect(map.complexFunctions.map(item => [pathOf(item.fileId), item.name, item.startLine, item.lines, item.depth])).toEqual([
      ['lib/legacy.js', 'legacy', 1, 6, 5],
      ['src/complexity.ts', 'lines61', lineOf(complexitySource, 'function lines61'), 61, 0],
      ['src/complexity.ts', 'depth5', lineOf(complexitySource, 'function depth5'), 7, 5],
      ['src/complexity.ts', 'bigInner', lineOf(complexitySource, 'function bigInner'), 61, 0],
    ]);
    for (const [relativePath, text] of [['lib/legacy.js', legacySource], ['src/complexity.ts', complexitySource]]) {
      const file = project.files.find(item => item.relativePath === relativePath)!;
      const hash = createHash('sha256').update(text).digest('hex');
      const symbols = analyzeSource(text, relativePath, { projectId: project.id, fileId: file.id, fileHash: hash }).symbols;
      for (const item of map.complexFunctions.filter(entry => entry.fileId === file.id)) {
        expect(item.fileHash).toBe(hash);
        const symbol = symbols.find(entry => entry.evidence.startUtf16 === item.startUtf16)!;
        expect([symbol.name, symbol.evidence.endUtf16, symbol.evidence.startLine, symbol.evidence.endLine, symbol.complexity])
          .toEqual([item.name, item.endUtf16, item.startLine, item.endLine, { lines: item.lines, depth: item.depth }]);
      }
    }
  });

  it('lists only the functions it reached in a file cut short by the node limit', async () => {
    const long = (name: string) => `function ${name}() {\n${Array.from({ length: 61 }, (_, index) => `  step(${index});`).join('\n')}\n}\n`;
    await put('src/two.ts', long('first') + long('second'));
    const project = await scanProject(root, randomUUID());
    const map = await mapOf(project, [], { ...MAP_LIMITS, nodesPerFile: 50 });
    const two = project.files.find(file => file.relativePath === 'src/two.ts')!;
    expect(map.files.find(file => file.id === two.id)).toMatchObject({ checked: 'partial' });
    // The first function was reached, so it is measured in full; the second was not reached.
    expect(map.complexFunctions.filter(item => item.fileId === two.id).map(item => [item.name, item.lines])).toEqual([['first', 61]]);
  });

  it('lists functions in a file of 1000 nested functions without checking every outer function again', async () => {
    // Looking up each function's outer functions made this take about 30 s.
    await put('src/nested.ts', `${'function f() {'.repeat(1000)}${'}'.repeat(1000)}\n`);
    const project = await scanProject(root, randomUUID());
    const nested = project.files.filter(file => file.relativePath === 'src/nested.ts');
    const started = Date.now();
    const map = await mapOf({ ...project, files: nested });
    expect(Date.now() - started).toBeLessThan(5000);
    expect([map.files[0].checked, map.complexFunctions]).toEqual(['full', []]);
  });

  it('stops between files when asked, instead of being ended in the middle of a parse', async () => {
    const project = await scanProject(root, randomUUID());
    let asked = 0;
    await expect(buildProjectMap(root, project.id, project.files, [], MAP_LIMITS, () => ++asked > 2))
      .rejects.toMatchObject({ code: 'CANCELLED' });
    expect(asked).toBe(3);
  });

  it('bounds what it reads by the bytes left, not by the size seen when the folder opened', async () => {
    const project = await scanProject(root, randomUUID());
    // As if every file had been tiny when the folder opened and has grown since.
    const stale = project.files.map(file => ({ ...file, size: 1 }));
    const map = await buildProjectMap(root, project.id, stale, [], { ...MAP_LIMITS, bytes: 100 });
    expect(map.limited).toBe(true);
    expect(map.files.find(file => file.relativePath === 'src/main.ts')).toMatchObject({ checked: 'skipped' });
    expect(map.files.filter(file => file.checked === 'full').every(file => !file.relativePath.endsWith('main.ts'))).toBe(true);
  });

  it('only reads the project', async () => {
    const before = await readFile(path.join(root, 'src/main.ts'), 'utf8');
    const project = await scanProject(root, randomUUID());
    await mapOf(project);
    expect(await readFile(path.join(root, 'src/main.ts'), 'utf8')).toBe(before);
  });
});

describe('TypeScript counterparts for explicit JavaScript extensions', () => {
  it.each([
    ['a.ts', './b.js', ['b.ts'], 'b.ts'],
    ['a.tsx', './b.js', ['b.tsx'], 'b.tsx'],
    ['a.ts', './c.jsx', ['c.tsx'], 'c.tsx'],
    ['a.mts', './d.mjs', ['d.mts'], 'd.mts'],
    ['a.cts', './e.cjs', ['e.cts'], 'e.cts'],
    ['a.js', './b.js', ['b.ts'], null],
    ['a.ts', './b.js', ['b.js', 'b.ts'], null],
    ['a.ts', './b.js', ['b.ts', 'b.tsx'], null],
    ['a.ts', './b.js', ['b.d.ts'], null],
  ])('%s importing %s considers %j', async (from, specifier, targets, expected) => {
    await put(`extensions/${from}`, `import '${specifier}';`);
    for (const target of targets) await put(`extensions/${target}`, 'export const value = 1;');
    const project = await scanProject(root, randomUUID());
    const result = await buildProjectMap(root, project.id, project.files, []);
    const fileId = project.files.find(file => file.relativePath === `extensions/${from}`)!.id;
    if (expected) expect(result.edges.find(item => item.fromFileId === fileId)).toMatchObject({ toFileId: project.files.find(file => file.relativePath === `extensions/${expected}`)!.id });
    else expect(result.unresolved.find(item => item.fromFileId === fileId)).toMatchObject({ reason: targets.length > 1 ? 'ambiguous' : 'not-found' });
  });
});

describe('unused files in the project map', () => {
  it('excludes code referenced by config and HTML files while retaining ordinary candidates', async () => {
    await put('references/forge.config.ts', "export default { entry: 'main-entry.ts' };");
    await put('references/index.html', '<script src="/references/renderer-entry.ts"></script>');
    for (const name of ['main-entry.ts', 'renderer-entry.ts', 'orphan.ts']) await put(`references/${name}`, '');
    const project = await scanProject(root, randomUUID());
    const files = project.files.filter(file => file.relativePath.startsWith('references/'));
    const result = await buildProjectMap(root, project.id, files, []);
    expect(result.unused.candidates.map(file => file.relativePath)).toEqual(['references/orphan.ts']);
    expect(result.unused.excluded).toEqual([{ kind: 'config', count: 1 }, { kind: 'reference', count: 2 }]);
  });

  it('fills candidates, uncertainty and exclusions from code and package scripts', async () => {
    await put('unused/from.ts', "import './used';\nimport('./lazy');\nimport '@/lib/foo.js';\n");
    for (const name of ['used.ts', 'lazy.ts', 'lib/foo.ts', 'orphan.ts', 'seed.ts', 'unit.test.ts']) await put(`unused/${name}`, '');
    await put('unused/package.json', JSON.stringify({ scripts: { seed: 'node ./seed.ts' } }));
    const project = await scanProject(root, randomUUID());
    const files = project.files.filter(file => file.relativePath.startsWith('unused/'));
    const start = files.find(file => file.relativePath === 'unused/from.ts')!.id;
    const result = await buildProjectMap(root, project.id, files, [start], MAP_LIMITS, undefined, [start]);
    expect(result.unused.candidates).toEqual([{ fileId: files.find(file => file.relativePath === 'unused/orphan.ts')!.id, relativePath: 'unused/orphan.ts' }]);
    expect(result.unused.unsure.map(file => [file.relativePath, file.reason])).toEqual([
      ['unused/lazy.ts', '동적 import(또는 require)로 쓰일 수 있어요.'],
      ['unused/lib/foo.ts', '경로 별칭으로 쓰일 수 있어요.'],
    ]);
    expect(result.unused.excluded).toEqual([{ kind: 'start', count: 1 }, { kind: 'test', count: 1 }, { kind: 'script', count: 1 }]);
  });

  it.each([0, 10])('uses only the %i bytes left after code analysis for package.json and reports failure', async remaining => {
    const code = 'const value = 1;';
    await put('budget/run.ts', code);
    await put('budget/package.json', JSON.stringify({ scripts: { dev: 'node run.ts' } }));
    const project = await scanProject(root, randomUUID());
    const result = await buildProjectMap(root, project.id, project.files.filter(file => file.relativePath.startsWith('budget/')), [], {
      ...MAP_LIMITS, bytes: Buffer.byteLength(code) + remaining,
    });
    expect(result.files[0].checked).toBe('full');
    expect(result.unused.candidates.map(file => file.relativePath)).toEqual(['budget/run.ts']);
    expect(result.unused.notes).toContain(`package.json 1개를 읽지 못해 실행 명령에 적힌 파일을 확인하지 못했어요: budget/package.json(${remaining ? '파일이 초기 읽기 크기 제한을 넘습니다.' : '지도의 읽기 한도에 닿아 읽지 않았어요.'})`);
  });
});

describe('imported names and declared value exports', () => {
  it.each<[string, string[] | 'all']>([
    ["import a from './target';", ['default']],
    ["import { b, c as d } from './target';", ['b', 'c']],
    ["import a, { b } from './target';", ['default', 'b']],
    ["import * as ns from './target';", 'all'],
    ["export * from './target';", 'all'],
    ["export * as ns from './target';", 'all'],
    ["export { x, y as z } from './target';", ['x', 'y']],
    ["import type { Model } from './target';", ['Model']],
    ["import { type helper, value } from './target';", ['helper', 'value']],
    ["import type Model from './target';", ['default']],
    ["import type * as ns from './target';", 'all'],
    ["export type { Model } from './target';", ['Model']],
    ["export { type Model, helper as h } from './target';", ['Model', 'helper']],
    ["import './target';", []],
  ])('counts names from %s', async (text, names) => {
    await put('names/from.ts', text);
    await put('names/target.ts', 'export const value = 1;');
    const project = await scanProject(root, randomUUID());
    const files = project.files.filter(file => file.relativePath.startsWith('names/'));
    const result = await buildProjectMap(root, project.id, files, []);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].names).toEqual(names);
    expect(result.exports.map(item => item.name)).toEqual(['value']);
  });

  it('lists only top-level value declarations, including destructuring and local export aliases', async () => {
    const text = [
      '// 📦 declarations keep UTF-16 ranges',
      'export function helper() {}',
      'export class Model {}',
      'export const a = 1, b = 2;',
      'export let { key: renamed, nested: { inner }, short = 1, ...rest } = source;',
      'export var [first, , last = 2, ...tail] = list;',
      'export enum Status { Ready }',
      'const local = 1; export { local as publicName };',
      'const called = 2; export { called }; console.log(called);',
      'export type Shape = string; export interface Interface {}',
      'export declare const declared: number; export declare function ambient(): void;',
      'declare class AmbientClass {} export { AmbientClass };',
      'type Private = number; interface PrivateInterface {} export { Private, PrivateInterface };',
      "import imported from './other'; export { imported };",
      'export type { local }; export { type called };',
      'function outer() { const hidden = 1; }',
      'export function recursive() { recursive(); }',
    ].join('\n');
    await put('exports/values.ts', text);
    const project = await scanProject(root, randomUUID());
    const files = project.files.filter(file => file.relativePath === 'exports/values.ts');
    const result = await buildProjectMap(root, project.id, files, []);
    expect(result.files[0].checked).toBe('full');
    expect(result.exports.map(item => [item.name, item.kind, item.usedInFile])).toEqual([
      ['helper', 'function', false], ['Model', 'class', false], ['a', 'value', false], ['b', 'value', false],
      ['renamed', 'value', false], ['inner', 'value', false], ['short', 'value', false], ['rest', 'value', false],
      ['first', 'value', false], ['last', 'value', false], ['tail', 'value', false], ['Status', 'value', false],
      ['publicName', 'value', false], ['called', 'value', true], ['recursive', 'function', true],
    ]);
    for (const item of result.exports) {
      expect(item.fileId).toBe(files[0].id);
      expect(item.fileHash).toBe(createHash('sha256').update(text).digest('hex'));
      expect(item.displayName).toBe(item.name);
      const snippet = text.slice(item.startUtf16, item.endUtf16);
      expect(snippet).not.toMatch(/^export /);
      expect(text.slice(0, item.startUtf16).split('\n')).toHaveLength(item.startLine);
      expect(text.slice(0, item.endUtf16).split('\n')).toHaveLength(item.endLine);
    }
    expect(text.slice(result.exports[2].startUtf16, result.exports[2].endUtf16)).toBe('a = 1');
    expect(text.slice(result.exports[12].startUtf16, result.exports[12].endUtf16)).toBe('local = 1');
  });

  it.each([
    ['export default function named() {}', 'default (named)', 'function', false],
    ['export default function () {}', 'default', 'function', false],
    ['export default class Named {}', 'default (Named)', 'class', false],
    ['export default abstract class Named {}', 'default (Named)', 'class', false],
    ['export default class {}', 'default', 'class', false],
    ['export default () => 1;', 'default', 'function', false],
    ['export default 42;', 'default', 'value', false],
    ['const a = 1; export default a;', 'default (a)', 'value', false],
    ['const a = 1; export { a as default };', 'default (a)', 'value', false],
    ['const a = 1; export default a; console.log(a);', 'default (a)', 'value', true],
    ['export default function recursive() { return recursive(); }', 'default (recursive)', 'function', true],
  ])('describes %s', async (text, displayName, kind, usedInFile) => {
    await put('default.ts', text);
    const project = await scanProject(root, randomUUID());
    const result = await buildProjectMap(root, project.id, project.files.filter(file => file.relativePath === 'default.ts'), []);
    expect(result.files[0].checked).toBe('full');
    expect(result.exports).toHaveLength(1);
    expect(result.exports[0]).toMatchObject({ name: 'default', displayName, kind, usedInFile });
  });

  it.each(['ts', 'js'])('does not treat nested declaration names or export-only names as local uses in %s', async extension => {
    const text = 'export const a = function a(a) {}; export const b = b => 1; export const C = class C {}; const d = 1; export { d };';
    await put(`declaration-names.${extension}`, text);
    const project = await scanProject(root, randomUUID());
    const result = await buildProjectMap(root, project.id, project.files.filter(file => file.relativePath === `declaration-names.${extension}`), []);
    expect(result.exports.map(item => [item.name, item.usedInFile])).toEqual([['a', false], ['b', false], ['C', false], ['d', false]]);
  });

  it('ignores broken exports and exports beyond the analysis budget', async () => {
    await put('limited.ts', 'export function first() {}\nexport function broken( {\n');
    const project = await scanProject(root, randomUUID());
    const files = project.files.filter(file => file.relativePath === 'limited.ts');
    const result = await buildProjectMap(root, project.id, files, []);
    expect(result.files[0].checked).toBe('partial');
    expect(result.exports.map(item => item.name)).toEqual(['first']);
    await put('limited.ts', 'const before = 1;\nexport const beyond = 2;');
    const limited = await buildProjectMap(root, project.id, files, [], { ...MAP_LIMITS, nodesPerFile: 3 });
    expect(limited.files[0].checked).toBe('partial');
    expect(limited.exports).toEqual([]);
  });

  it('treats type-only imports and reexports as use of the target value', async () => {
    await put('typed/values.ts', 'export class Model {}\nexport function helper() {}\nexport const unused = 1;\nexport default class Default {}');
    await put('typed/from.test.ts', "import type { Model } from './values';\nimport { type helper } from './values';\nexport { default } from './values';");
    const project = await scanProject(root, randomUUID());
    const result = await buildProjectMap(root, project.id, project.files.filter(file => file.relativePath.startsWith('typed/')), []);
    expect(result.unused.exports.candidates.map(item => item.name)).toEqual(['unused']);
  });
});


it('maps every overview entry before candidate limits without excluding learning-only starts', async () => {
  await put('package.json', JSON.stringify({ main: 'boot.ts', bin: 'cli.ts' }));
  await put('boot.ts', Array.from({ length: 8 }, (_, i) => `export function f${i}() {}`).join('\n'));
  await put('cli.ts', 'export const cli = 1;');
  await put('index.ts', "import './helper';");
  await put('helper.ts', 'export function helper() {}');
  const project = await scanProject(root, randomUUID());
  const files = project.files.filter(file => !file.relativePath.includes('/'));
  const overview = await buildOverview(root, { ...project, files });
  const helper = files.find(file => file.relativePath === 'helper.ts')!;
  const result = await buildProjectMap(root, project.id, files, [...overview.candidates.map(item => item.fileId), helper.id],
    MAP_LIMITS, undefined, overview.entryFileIds);
  expect(result.files.filter(file => file.entry).map(file => file.relativePath)).toEqual(['boot.ts', 'cli.ts', 'index.ts']);
  expect(result.files.find(file => file.relativePath === 'cli.ts')).toMatchObject({ entry: true, start: false });
  expect(result.files.find(file => file.id === helper.id)).toMatchObject({ entry: false, start: true });
  expect(result.unused.excluded).toContainEqual({ kind: 'start', count: 3 });
  expect(result.unused.exports.candidates.map(item => item.name)).toEqual(['helper']);
});

describe('path aliases in the map', () => {
  it('connects an alias and removes its target from unused candidates', async () => {
    await put('tsconfig.json', '{"compilerOptions":{"paths":{"@/*":["src/*"]}}}');
    await put('src/alias-entry.ts', "import { value } from '@/alias-target';");
    await put('src/alias-target.ts', 'export const value = 1;');
    const project = await scanProject(root, randomUUID());
    const map = await mapOf(project);
    expect(readable(project, map).edges).toContainEqual(['src/alias-entry.ts', 1, 'src/alias-target.ts']);
    expect(map.unused.candidates.map(file => file.relativePath)).not.toContain('src/alias-target.ts');
    expect(map.notes).toContain('tsconfig 1개의 경로 별칭을 따라갔어요.');
  });
  it('keeps every ambiguous alias target unsure instead of unused', async () => {
    await put('tsconfig.json', '{"compilerOptions":{"paths":{"@/*":["src/*"]}}}');
    await put('src/alias-entry.ts', "import { value } from '@/alias-target';");
    await put('src/alias-target.ts', 'export const value = 1;');
    await put('src/alias-target.js', 'export const value = 2;');
    const project = await scanProject(root, randomUUID());
    const map = await mapOf(project);
    const item = map.unresolved.find(item => item.specifier === '@/alias-target');
    expect(item).toMatchObject({ reason: 'ambiguous', candidates: ['src/alias-target.ts', 'src/alias-target.js'],
      reasonText: '경로 별칭이 가리키는 파일을 하나로 정하지 못했어요.' });
    expect(map.edges.some(item => item.specifier === '@/alias-target')).toBe(false);
    expect(map.unused.unsure.map(file => file.relativePath)).toEqual(expect.arrayContaining(['src/alias-target.ts', 'src/alias-target.js']));
    expect(map.unused.candidates.map(file => file.relativePath)).not.toEqual(expect.arrayContaining(['src/alias-target.ts']));
    expect(map.unused.candidates.map(file => file.relativePath)).not.toEqual(expect.arrayContaining(['src/alias-target.js']));
  });
  it.each([{ moduleSuffixes: ['.native', ''] }, { module: 'nodenext' }, { moduleResolution: 'NodeNext' }, { moduleResolution: 'node16' }])(
    'does not draw aliases under %j', async options => {
      await put('tsconfig.json', JSON.stringify({ compilerOptions: { ...options, paths: { '@/*': ['src/*', 'fallback.ts'] } } }));
      await put('src/alias-entry.ts', "import { value } from '@/alias-target';");
      await put('src/alias-target.ts', 'export const value = 1;');
      await put('fallback.ts', 'export const value = 2;');
      const project = await scanProject(root, randomUUID());
      const map = await mapOf(project);
      expect(map.edges.some(item => item.specifier === '@/alias-target')).toBe(false);
      expect(map.notes.join(' ')).toContain('경로 별칭을 따라가지 않았어요.');
    });
  it('subtracts config bytes from the existing map budget', async () => {
    await put('tsconfig.json', '{}');
    const project = await scanProject(root, randomUUID());
    const map = await mapOf(project, [], { ...MAP_LIMITS, bytes: 2 });
    expect(map.limited).toBe(true);
    expect(map.files.every(file => file.checked === 'skipped')).toBe(true);
    expect(map.edges).toEqual([]);
  });
});

describe('Python project maps', () => {
  it('settles relative and own-package imports after reading initializers, preserving statement evidence and TS results', async () => {
    const beforeProject = await scanProject(root, randomUUID());
    const before = await mapOf(beforeProject);
    const sources: Record<string, string> = {
      'app/__init__.py': 'from .models import Item\n',
      'app/models.py': 'class Item: pass\n',
      'app/service.py': '# 😀\nfrom .models import Item\nimport os.path\nfrom os import getenv\nfrom fastapi.responses import Response\nfrom . import models, service, absent\nfrom .missing import X\nfrom ... import outside\nfrom . import (x as)\n',
      'app/api.py': 'from app.service import total\nimport app.models, app.models as same\nfrom __future__ import annotations\n',
      'main.py': 'from app.api import run\n',
    };
    for (const [name, source] of Object.entries(sources)) await put(name, source);
    const project = await scanProject(root, randomUUID());
    const result = await mapOf(project);
    const pythonIds = new Set(project.files.filter(file => file.relativePath.endsWith('.py')).map(file => file.id));
    const pathOf = (id: string) => project.files.find(file => file.id === id)!.relativePath;
    const pythonEdges = result.edges.filter(edge => pythonIds.has(edge.fromFileId));
    // The syntax error makes service.py non-plain, so its otherwise valid imports remain candidates.
    expect(pythonEdges.map(edge => [pathOf(edge.fromFileId), edge.startLine, pathOf(edge.toFileId)])).toEqual([
      ['app/__init__.py', 1, 'app/models.py'], ['app/api.py', 1, 'app/service.py'], ['app/api.py', 2, 'app/models.py'],
    ]);
    expect(result.external.filter(item => pythonIds.has(item.fromFileId)).map(item => item.specifier)).toEqual(['os', 'os', 'fastapi']);
    expect(result.unresolved.filter(item => pythonIds.has(item.fromFileId)).map(item => item.reason))
      .toEqual(['ambiguous', 'ambiguous', 'ambiguous', 'ambiguous', 'not-found', 'outside', 'syntax', 'ambiguous']);
    expect(result.unresolved.find(item => pathOf(item.fromFileId) === 'main.py')).toMatchObject({ candidates: ['app/api.py'],
      reasonText: '코드만으로는 확정하지 못했어요. 실행 방법, Python 버전, 설치된 패키지에 따라 이 파일이 아닐 수 있어요.' });
    expect(result.exports.every(item => !pythonIds.has(item.fileId))).toBe(true);
    expect(result.notes).toContain('Python import는 점으로 시작하는 상대 import와, 파일이 속한 최상위 패키지 이름으로 시작하는 import만 확실한 선으로 이었어요. 그 밖의 import는 실행 방법·Python 버전·설치된 패키지에 따라 달라져서, 후보 파일을 ‘확인 못 함’에 적고 지도에는 추정(촘촘한 점선)으로 이었어요. importlib처럼 실행 중에 정하는 import는 보지 않았어요.');
    expect(result.files.filter(file => pythonIds.has(file.id)).map(file => [file.relativePath, file.checked]))
      .toEqual(Object.keys(sources).sort((a, b) => a.localeCompare(b)).map(name => [name, name === 'app/service.py' ? 'partial' : 'full']));
    for (const item of [...result.edges, ...result.external, ...result.unresolved].filter(item => pythonIds.has(item.fromFileId))) {
      const source = sources[pathOf(item.fromFileId)];
      const analysis = analyzeSource(source, pathOf(item.fromFileId), { projectId: project.id, fileId: item.fromFileId, fileHash: item.fileHash });
      expect(source.slice(item.startUtf16, item.endUtf16)).toBe(item.text);
      expect(item.fileHash).toBe(createHash('sha256').update(source).digest('hex'));
      expect(analysis.imports.some(entry => entry.evidence.startUtf16 === item.startUtf16 && entry.evidence.endUtf16 === item.endUtf16)).toBe(true);
    }
    const ts = { ...result, edges: result.edges.filter(item => !pythonIds.has(item.fromFileId)),
      external: result.external.filter(item => !pythonIds.has(item.fromFileId)), unresolved: result.unresolved.filter(item => !pythonIds.has(item.fromFileId)) };
    expect(readable(project, ts)).toEqual(readable(beforeProject, before));
    expect(result.unused.candidates.map(item => item.relativePath)).toEqual(before.unused.candidates.map(item => item.relativePath));
    expect(result.unused.unsure.map(item => item.relativePath)).toEqual(before.unused.unsure.map(item => item.relativePath));
    expect(result.edges.slice(-pythonEdges.length)).toEqual(pythonEdges);
  });

  it('makes several arrows from one statement, deduplicates modules and includes decorated complex functions', async () => {
    const source = `from . import models, service, models\n@decorate\ndef long():\n${'    work()\n'.repeat(61)}`;
    await put('pkg/__init__.py', '');
    await put('pkg/main.py', source);
    await put('pkg/models.py', '');
    await put('pkg/service.py', '');
    const project = await scanProject(root, randomUUID());
    const result = await mapOf(project);
    const main = project.files.find(file => file.relativePath === 'pkg/main.py')!;
    const edges = result.edges.filter(item => item.fromFileId === main.id);
    expect(edges.map(edge => project.files.find(file => file.id === edge.toFileId)!.relativePath)).toEqual(['pkg/models.py', 'pkg/service.py']);
    expect(edges[0].startUtf16).toBe(edges[1].startUtf16);
    const fn = result.complexFunctions.find(item => item.fileId === main.id)!;
    const analyzed = analyzeSource(source, 'pkg/main.py', { projectId: project.id, fileId: main.id, fileHash: fn.fileHash }).symbols[0];
    expect(fn).toMatchObject({ name: 'long', lines: 61, startUtf16: analyzed.evidence.startUtf16, endUtf16: analyzed.evidence.endUtf16 });
    expect(source.slice(fn.startUtf16, fn.endUtf16)).toMatch(/^@decorate/);
  });

  it('withholds arrows through an initializer cut short by the node budget', async () => {
    await put('pkg/__init__.py', 'pass\n'.repeat(40));
    await put('pkg/main.py', 'from . import models\n');
    await put('pkg/models.py', '');
    const project = await scanProject(root, randomUUID());
    const result = await mapOf(project, [], { ...MAP_LIMITS, nodesPerFile: 20 });
    expect(result.files.find(file => file.relativePath === 'pkg/__init__.py')).toMatchObject({ checked: 'partial', reason: expect.stringContaining('분석량 한도') });
    const main = project.files.find(file => file.relativePath === 'pkg/main.py')!;
    expect(result.edges.filter(item => item.fromFileId === main.id)).toEqual([]);
    expect(result.unresolved.filter(item => item.fromFileId === main.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'ambiguous', candidates: ['pkg/models.py'], reasonText: expect.stringContaining('import 동작을 바꿀 수 있는 이름') }),
    ]));
  });

  it.each(['deleted', 'excluded', 'linked'] as const)('rechecks target availability after the scan: %s', async change => {
    await put('pkg/main.py', 'from .model import X\n');
    await put('pkg/model.py', 'class X: pass\n');
    const project = await scanProject(root, randomUUID());
    if (change === 'excluded') await appendFile(path.join(root, '.gitignore'), 'pkg/model.py\n');
    if (change !== 'excluded') await rm(path.join(root, 'pkg/model.py'));
    if (change === 'linked') await symlink(path.join(root, 'src/a.ts'), path.join(root, 'pkg/model.py'));
    const result = await mapOf(project);
    const main = project.files.find(file => file.relativePath === 'pkg/main.py')!;
    expect(result.unresolved.filter(item => item.fromFileId === main.id)).toMatchObject([{ reason: 'unavailable', candidates: ['pkg/model.py'] }]);
    expect(result.files.find(file => file.relativePath === 'pkg/model.py')?.checked).toBe('failed');
  });

  it('keeps unreadable Python files failed and does not add the read-Python note for them', async () => {
    await put('broken.py', Buffer.from([0xff, 0xfe]));
    const project = await scanProject(root, randomUUID());
    const result = await mapOf(project);
    expect(result.files.find(file => file.relativePath === 'broken.py')).toMatchObject({ checked: 'failed', reason: 'UTF-8로 읽을 수 없는 파일입니다.' });
    expect(result.notes.some(note => note.startsWith('Python import'))).toBe(false);
  });

  it.each(['file', 'byte'] as const)('shares the %s limit across languages', async kind => {
    await put('a.py', 'pass\n');
    await put('b.ts', 'const b = 1;\n');
    await put('c.py', 'pass\n');
    const project = await scanProject(root, randomUUID());
    const files = project.files.filter(file => ['a.py', 'b.ts', 'c.py'].includes(file.relativePath));
    const limits = { ...MAP_LIMITS, ...(kind === 'file' ? { files: 2 } : { bytes: Buffer.byteLength('pass\nconst b = 1;\n') }) };
    const result = await buildProjectMap(root, project.id, files, [], limits);
    expect(result.files.map(file => [file.relativePath, file.checked])).toEqual([['a.py', 'full'], ['b.ts', 'full'], ['c.py', 'skipped']]);
    expect(result.limited).toBe(true);
    expect(result.notes).toContain(`지도는 파일 ${limits.files}개·합계 ${limits.bytes / 1024 / 1024} MiB까지만 읽어요. 나머지 파일의 연결은 보지 않았어요.`);
  });

  it('uses the same code placement predicate for a TS import of a skipped Python file', async () => {
    await put('a.ts', "import './z.py';\n");
    await put('z.py', 'pass\n');
    const project = await scanProject(root, randomUUID());
    const result = await buildProjectMap(root, project.id, project.files.filter(file => ['a.ts', 'z.py'].includes(file.relativePath)), [], { ...MAP_LIMITS, files: 1 });
    expect(result.files.map(file => [file.relativePath, file.checked])).toEqual([['a.ts', 'full'], ['z.py', 'skipped']]);
    expect(result.edges).toHaveLength(1);
  });

  it('clips long Python evidence text and ignores dynamic calls and future imports', async () => {
    const source = `from __future__ import annotations\nimportlib.import_module('x')\n__import__('y')\nfrom .model import ${'long_name_'.repeat(40)}\n`;
    await put('pkg/main.py', source);
    await put('pkg/model.py', '');
    const project = await scanProject(root, randomUUID());
    const result = await mapOf(project);
    const main = project.files.find(file => file.relativePath === 'pkg/main.py')!;
    const items = [...result.edges, ...result.unresolved, ...result.external].filter(item => item.fromFileId === main.id);
    expect(items).toHaveLength(1);
    expect(items[0].text.length).toBe(301);
    expect(items[0].text.endsWith('…')).toBe(true);
    expect(source.slice(items[0].startUtf16, items[0].endUtf16).length).toBeGreaterThan(300);
  });

  it('bounds the Python results one map carries and says so', async () => {
    // Six same-named files no import path reaches: each import is one entry of about 230 characters.
    for (let index = 0; index < 6; index++) await put(`lib${index}/a.py`, '');
    await put('main.py', 'import a\n'.repeat(120));
    const project = await scanProject(root, randomUUID());
    const limit = 20_000;
    const result = await mapOf(project, [], { ...MAP_LIMITS, results: limit });
    const main = project.files.find(file => file.relativePath === 'main.py')!;
    const entries = result.unresolved.filter(item => item.fromFileId === main.id);
    expect(entries[0].candidates).toEqual(['lib0/a.py', 'lib1/a.py', 'lib2/a.py', 'lib3/a.py', 'lib4/a.py']);
    expect(entries[0].reasonText).toContain('후보가 더 있지만 처음 5개만 적었어요.');
    expect(entries.length).toBeGreaterThan(10);
    expect(entries.length).toBeLessThan(120);
    const carried = entries.reduce((total, item) => total + item.text.length + (item.specifier?.length ?? 0) + (item.reasonText?.length ?? 0)
      + item.candidates.reduce((sum, name) => sum + name.length, 0) + 100, 0);
    expect(carried).toBeLessThanOrEqual(limit);
    expect(carried).toBeGreaterThan(limit - 1_000);
    expect(result.notes).toContain('Python import 결과가 너무 많아 일부만 적었어요. 그 뒤의 Python import는 연결을 보지 않았어요.');
  });

  it('does not add the result limit note below the limit', async () => {
    await put('lib/a.py', '');
    await put('main.py', 'import a\n');
    const result = await mapOf(await scanProject(root, randomUUID()));
    expect(result.notes.some(note => note.includes('결과가 너무 많아'))).toBe(false);
  });

  it('bounds the Python import statements kept while files are read, however small their results are', async () => {
    // One statement naming the same module again and again: its result
    // is a single short arrow, so only the count of what is kept can stop it.
    const long = `from . import ${Array.from({ length: 20 }, () => 'module_with_a_long_name').join(', ')}\n`;
    await put('pkg/__init__.py', '');
    await put('pkg/module_with_a_long_name.py', '');
    for (let index = 0; index < 3; index++) await put(`pkg/a${index}.py`, long);
    await put('pkg/z.py', 'import os\n');
    const project = await scanProject(root, randomUUID());
    const limit = (long.trimEnd().length + 100 + 10 * 20) * 2;
    const result = await mapOf(project, [], { ...MAP_LIMITS, results: limit });
    const from = (relativePath: string) => {
      const file = project.files.find(item => item.relativePath === relativePath)!;
      return [...result.edges, ...result.unresolved, ...result.external].filter(item => item.fromFileId === file.id);
    };
    expect(from('pkg/a0.py')).toHaveLength(1);
    const target = project.files.find(item => item.relativePath === 'pkg/module_with_a_long_name.py')!;
    expect(result.edges.filter(edge => edge.toFileId === target.id)).toHaveLength(2);
    expect(from('pkg/a2.py')).toHaveLength(0);
    expect(from('pkg/z.py')).toHaveLength(0);
    expect(result.notes.filter(note => note.includes('결과가 너무 많아'))).toHaveLength(1);
  });

  it('counts the names package initializers bind against the same limit', async () => {
    // Assignments bind names without an import statement: 12 names of 200 characters a file, counted as
    // 2,520 characters. The importing file is read before them and the package it names after them.
    const names = Array.from({ length: 12 }, (_, index) => `n${String(index).padStart(199, '0')}=0\n`).join('');
    await put('pkg/__init__.py', '');
    await put('pkg/a.py', 'from .z import b\n');
    for (let index = 0; index < 3; index++) await put(`pkg/p${index}/__init__.py`, names);
    await put('pkg/z/__init__.py', '');
    await put('pkg/z/b.py', '');
    const project = await scanProject(root, randomUUID());
    const a = project.files.find(file => file.relativePath === 'pkg/a.py')!;
    const limits = { ...MAP_LIMITS, results: 5_200 };
    // Two of them fit, and the arrow is drawn.
    const fitting = await buildProjectMap(root, project.id, project.files.filter(file => !file.relativePath.startsWith('pkg/p2/')), [], limits);
    expect(fitting.edges.filter(edge => edge.fromFileId === a.id)).toHaveLength(1);
    expect(fitting.notes.some(note => note.includes('결과가 너무 많아'))).toBe(false);
    // The third does not: the package read after it is left without facts, so the import is only listed.
    const result = await mapOf(project, [], limits);
    expect(result.edges.filter(edge => edge.fromFileId === a.id)).toHaveLength(0);
    expect(result.unresolved.filter(item => item.fromFileId === a.id)).toMatchObject([{ candidates: ['pkg/z/b.py', 'pkg/z/__init__.py'] }]);
    expect(result.notes.filter(note => note.includes('결과가 너무 많아'))).toHaveLength(1);
  });

  it('keeps one entry for an unsettled import however many folders above hold the name and however often a name repeats', async () => {
    // The same package at every level above the importing file, and one from-import repeating a name.
    const levels = Array.from({ length: 15 }, (_, depth) => Array.from({ length: depth }, (_, index) => `d${index}`).join('/'));
    for (const level of levels) {
      await put(path.posix.join(level, 'pkg/__init__.py'), '');
      await put(path.posix.join(level, 'pkg/mod.py'), '');
    }
    await put(path.posix.join(levels.at(-1)!, 'main.py'), `from pkg import ${Array.from({ length: 1_000 }, () => 'mod').join(', ')}\n`);
    const project = await scanProject(root, randomUUID());
    const result = await mapOf(project);
    const main = project.files.find(file => file.relativePath.endsWith('/main.py'))!;
    const entries = [...result.edges, ...result.unresolved, ...result.external].filter(item => item.fromFileId === main.id);
    expect(entries).toHaveLength(1);
    expect(result.unresolved.find(item => item.fromFileId === main.id)).toMatchObject({ reason: 'ambiguous' });
    expect(result.unresolved.find(item => item.fromFileId === main.id)!.candidates).toHaveLength(5);
  });

  it('cuts long Python function names and bounds the hard-function list of one map', async () => {
    // One very long class name repeated in the name of every method, each method nested deeply enough to be listed.
    const className = 'C'.repeat(100_000);
    // One-space indents keep 1,500 methods and the name inside the 256 KiB a file may have.
    const method = (index: number) => ` def m${index}(s):\n  if a:\n   if b:\n    if c:\n     if d:\n      if e:\n       pass\n`;
    await put('big.py', `class ${className}:\n${Array.from({ length: 1_500 }, (_, index) => method(index)).join('')}`);
    const project = await scanProject(root, randomUUID());
    const result = await mapOf(project);
    const big = project.files.find(file => file.relativePath === 'big.py')!;
    const listed = result.complexFunctions.filter(item => item.fileId === big.id);
    expect(listed[0].name).toBe(`${'C'.repeat(300)}….m0`);
    expect(listed.length).toBeGreaterThan(1_000);
    expect(listed.length).toBeLessThan(1_500);
    expect(listed.reduce((total, item) => total + item.name.length + 100, 0)).toBeLessThanOrEqual(500_000);
    expect(result.notes).toContain('어려운 함수가 너무 많아 일부만 적었어요.');
    // The analyzer's own names for the same file are cut the same way.
    const analysis = analyzeSource(await readFile(path.join(root, 'big.py'), 'utf8'), 'big.py', { projectId: project.id, fileId: big.id, fileHash: 'h' });
    expect(analysis.symbols[0].name).toBe(listed[0].name);
    expect(analysis.classes![0].name).toBe(`${'C'.repeat(300)}…`);
  });

  it('does not add the hard-function note below the limit', async () => {
    await put('small.py', 'def f():\n    if a:\n        if b:\n            if c:\n                if d:\n                    if e:\n                        pass\n');
    const result = await mapOf(await scanProject(root, randomUUID()));
    expect(result.complexFunctions.some(item => item.name === 'f')).toBe(true);
    expect(result.notes.some(note => note.includes('어려운 함수가 너무 많아'))).toBe(false);
  });

  it('checks for a cancel at every result of one long Python import', async () => {
    // 50 files, not more: writing and re-checking hundreds of files took a Windows CI machine past the test's time limit.
    const names = Array.from({ length: 50 }, (_, index) => `m${index}`);
    await put('pkg/__init__.py', '');
    for (const name of names) await put(`pkg/${name}.py`, '');
    await put('pkg/main.py', `from . import ${names.join(', ')}\n`);
    const project = await scanProject(root, randomUUID());
    let total = 0;
    const result = await buildProjectMap(root, project.id, project.files, [], MAP_LIMITS, () => { total++; return false; });
    const main = project.files.find(file => file.relativePath === 'pkg/main.py')!;
    expect(result.edges.filter(item => item.fromFileId === main.id)).toHaveLength(50);
    // One statement, 50 results: without a check per result this count stays near the number of files.
    expect(total).toBeGreaterThanOrEqual(100);
    let seen = 0;
    await expect(buildProjectMap(root, project.id, project.files, [], MAP_LIMITS, () => ++seen > total - 25))
      .rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('checks for a cancel at every statement while settling Python imports, even when statements give no result', async () => {
    // A star import from a folder without `__init__.py` runs nothing and gives no entry.
    await put('ns/other.py', '');
    await put('ns/main.py', 'from . import *\n'.repeat(200));
    const project = await scanProject(root, randomUUID());
    let total = 0;
    const result = await buildProjectMap(root, project.id, project.files, [], MAP_LIMITS, () => { total++; return false; });
    const main = project.files.find(file => file.relativePath === 'ns/main.py')!;
    expect([...result.edges, ...result.unresolved, ...result.external].filter(item => item.fromFileId === main.id)).toEqual([]);
    // 200 of the checks were made while settling; without them this count stays far below 200.
    expect(total).toBeGreaterThanOrEqual(200);
    let seen = 0;
    await expect(buildProjectMap(root, project.id, project.files, [], MAP_LIMITS, () => ++seen > total - 100))
      .rejects.toMatchObject({ code: 'CANCELLED', message: '지도 만들기를 취소했어요.' });
    expect(seen).toBe(total - 99);
  });
});

describe('map result limits', () => {
  const resultNote = '지도에 담을 TS/JS import·export가 너무 많아 일부 파일만 읽었어요. 나머지 파일의 연결은 보지 않았어요.';
  const functionsNote = '어려운 함수가 너무 많아 일부만 적었어요.';
  const pythonNote = 'Python import 결과가 너무 많아 일부만 적었어요. 그 뒤의 Python import는 연결을 보지 않았어요.';
  const partialReason = '지도의 결과 한도에 닿아 이 파일의 import와 export 일부는 적지 않았어요.';
  const skippedReason = '지도의 결과 한도에 닿아 이 파일은 읽지 않았어요.';
  const deepBody = 'if (a) { if (b) { if (c) { if (d) { if (e) { run(); } } } } }';

  beforeEach(async () => {
    await rm(root, { recursive: true });
    await mkdir(root);
  });

  it.each(['ts', 'js'])('clips only map function names and still finds the original %s symbols by position', async extension => {
    const className = 'C'.repeat(100_000);
    const functionName = 'f'.repeat(301);
    const memberName = 'm'.repeat(301);
    const source = `class ${className} { m0() { ${deepBody} } m1() { ${deepBody} } ${memberName}() { ${deepBody} } }\n`
      + `function ${functionName}() { ${deepBody} }\n`;
    const relativePath = `long.${extension}`;
    await put(relativePath, source);
    const project = await scanProject(root, randomUUID());
    const map = await mapOf(project);
    expect(map.complexFunctions.map(item => item.name)).toEqual([
      `${'C'.repeat(300)}….m0`, `${'C'.repeat(300)}….m1`, `${'C'.repeat(300)}….${'m'.repeat(300)}…`, `${'f'.repeat(300)}…`,
    ]);
    const fileId = project.files[0].id;
    const hash = createHash('sha256').update(source).digest('hex');
    const analysis = analyzeSource(source, relativePath, { projectId: project.id, fileId, fileHash: hash });
    expect(analysis.symbols.map(symbol => symbol.name)).toEqual([
      `${className}.m0`, `${className}.m1`, `${className}.${memberName}`, functionName,
    ]);
    for (const item of map.complexFunctions) {
      expect(matchFunction({ projectId: project.id, fileId, relativePath, hash, text: source, analysis, guide: null }, item).status).toBe('found');
    }
    expect(map.limited).toBe(false);
  });

  it.each(['ts', 'py'])('shares the hard-function limit across languages when %s is read first', async first => {
    const ts = `function f() { ${deepBody} }\n`;
    const py = 'def f():\n if a:\n  if b:\n   if c:\n    if d:\n     if e:\n      pass\n';
    const second = first === 'ts' ? 'py' : 'ts';
    await put(`a.${first}`, first === 'ts' ? ts : py);
    await put(`b.${second}`, second === 'ts' ? ts.repeat(2) : py.repeat(2));
    const project = await scanProject(root, randomUUID());
    const map = await mapOf(project, [], { ...MAP_LIMITS, functions: 202 });
    expect(map.complexFunctions).toHaveLength(2);
    expect(new Set(map.complexFunctions.map(item => item.fileId)).size).toBe(2);
    expect(map.complexFunctions.reduce((sum, item) => sum + item.name.length + 100, 0)).toBe(202);
    expect(map.notes.filter(note => note === functionsNote)).toHaveLength(1);
    expect(map.files.every(file => file.checked === 'full')).toBe(true);
    expect(map.limited).toBe(false);
    const fitting = await mapOf(project, [], { ...MAP_LIMITS, functions: 303 });
    expect(fitting.complexFunctions).toHaveLength(3);
    expect(fitting.notes).not.toContain(functionsNote);
  });

  it('never lists a smaller hard function after one fails to fit', async () => {
    await put('a.ts', `function ${'long'.repeat(40)}() { ${deepBody} }\nfunction f() { ${deepBody} }`);
    await put('b.py', 'def f():\n if a:\n  if b:\n   if c:\n    if d:\n     if e:\n      pass\n');
    const map = await mapOf(await scanProject(root, randomUUID()), [], { ...MAP_LIMITS, functions: 200 });
    expect(map.complexFunctions).toEqual([]);
    expect(map.notes.filter(note => note === functionsNote)).toHaveLength(1);
  });

  it('marks partial and skipped TS files, preserves Python room, and counts only files actually read', async () => {
    const statement = "import 'a';";
    await put('a.ts', `${statement}\n`.repeat(2));
    await put('b.ts', `${statement}\n`.repeat(2));
    await put('c.ts', "import 'c';\n");
    await put('d.py', 'import os\n');
    const project = await scanProject(root, randomUUID());
    const limits = { ...MAP_LIMITS, results: (statement.length + 1 + 100) * 3, files: 3,
      bytes: Buffer.byteLength(`${statement}\n`.repeat(4) + 'import os\n') };
    const map = await mapOf(project, [], limits);
    expect(map.files.map(file => [file.relativePath, file.checked, file.reason])).toEqual([
      ['a.ts', 'full', null], ['b.ts', 'partial', partialReason], ['c.ts', 'skipped', skippedReason], ['d.py', 'full', null],
    ]);
    const python = project.files.find(file => file.relativePath === 'd.py')!;
    expect(map.external.filter(item => item.fromFileId === python.id)).toMatchObject([{ specifier: 'os' }]);
    const ts = map.external.filter(item => item.fromFileId !== python.id);
    expect(ts).toHaveLength(3);
    expect(ts.reduce((sum, item) => sum + item.text.length + item.specifier!.length + 100, 0)).toBe(limits.results);
    expect(map.limited).toBe(true);
    expect(map.notes.filter(note => note === resultNote)).toHaveLength(1);
    expect(map.notes.some(note => note.startsWith('지도는 파일'))).toBe(false);
    expect(map.unused.notes).toContain('끝까지 읽지 못한 파일 2개가 가져다 쓰는 파일이 후보에 섞였을 수 있어요.');
  });

  it('counts exports with imports, keeping exports first and hard functions even when results stop', async () => {
    await put('a.ts', `import 'x';\nexport const x = 1;\nexport const y = 2;\nfunction f() { ${deepBody} }`);
    await put('b.ts', "import 'x';");
    const project = await scanProject(root, randomUUID());
    const map = await mapOf(project, [], { ...MAP_LIMITS, results: 102 });
    expect(map.exports.map(item => item.name)).toEqual(['x']);
    expect(map.external).toEqual([]);
    expect(map.complexFunctions.map(item => item.name)).toEqual(['f']);
    expect(map.files.map(file => file.checked)).toEqual(['partial', 'skipped']);
    expect(map.notes).toContain(resultNote);
  });

  it('bounds exports even without imports and counts both their name and display name', async () => {
    await put('a.ts', 'export default function named() {}\nexport const x = 1;');
    await put('b.ts', 'export const y = 2;');
    const project = await scanProject(root, randomUUID());
    const size = 'default'.length + 'default (named)'.length + 100;
    const map = await mapOf(project, [], { ...MAP_LIMITS, results: size });
    expect(map.exports.map(item => item.name)).toEqual(['default']);
    expect(map.files.map(file => [file.checked, file.reason])).toEqual([['partial', partialReason], ['skipped', skippedReason]]);
    const tooSmall = await mapOf(project, [], { ...MAP_LIMITS, results: size - 1 });
    expect(tooSmall.exports).toEqual([]);
  });

  it('counts the fixed size of every imported name before keeping an edge', async () => {
    const names = ['a', 'b', 'c', 'd'];
    const source = `import { ${names.join(', ')} } from './z';`;
    await put('a.ts', source);
    await put('z.ts', '');
    const project = await scanProject(root, randomUUID());
    const size = source.length + './z'.length + 100 + names.reduce((sum, name) => sum + name.length + 10, 0);
    const fitting = await mapOf(project, [], { ...MAP_LIMITS, results: size });
    expect(fitting.edges).toMatchObject([{ names }]);
    expect(fitting.limited).toBe(false);
    const map = await mapOf(project, [], { ...MAP_LIMITS, results: size - 1 });
    expect(map.edges).toEqual([]);
    expect(map.files[0]).toMatchObject({ checked: 'partial', reason: partialReason });
  });

  it('counts alias candidate paths and the reason text before keeping an ambiguous import', async () => {
    const source = "import '@lib';";
    await put('a.ts', source);
    await put('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@lib': ['./one'] } } }));
    await put('one.ts', '');
    await put('one.js', '');
    const project = await scanProject(root, randomUUID());
    const size = source.length + '@lib'.length + 100 + 'one.ts'.length + 'one.js'.length
      + '경로 별칭이 가리키는 파일을 하나로 정하지 못했어요.'.length;
    const fitting = await mapOf(project, [], { ...MAP_LIMITS, results: size });
    expect(fitting.unresolved).toMatchObject([{ reason: 'ambiguous', candidates: ['one.ts', 'one.js'] }]);
    expect(fitting.limited).toBe(false);
    const map = await mapOf(project, [], { ...MAP_LIMITS, results: size - 1 });
    expect(map.unresolved).toEqual([]);
    expect(map.notes).toContain(resultNote);
  });

  it.each([
    ["import 'external';", 'external', [], null],
    ["import('/dynamic')", '/dynamic', [], 'not-static'],
    ["import { x as } from './z';", './z', [], 'syntax'],
    ["import './z\\u002fb';", null, [], 'unreadable'],
    ["import '/outside';", '/outside', [], 'outside'],
    ["import '../outside';", '../outside', [], 'outside'],
    ["import './missing';", './missing', [], 'not-found'],
    ["import './z';", './z', ['z.ts', 'z/index.ts'], 'ambiguous'],
  ])('bounds every import result path: %s', async (source, specifier, candidates, reason) => {
    await put('a.ts', source);
    await put('z.ts', '');
    await put('z/index.ts', '');
    const project = await scanProject(root, randomUUID());
    const size = source.length + (specifier?.length ?? 0) + 100 + candidates.reduce((sum, name) => sum + name.length, 0);
    const fitting = await mapOf(project, [], { ...MAP_LIMITS, results: size });
    expect([...fitting.external, ...fitting.unresolved]).toHaveLength(1);
    if (reason) expect(fitting.unresolved[0]).toMatchObject({ reason, candidates });
    expect(fitting.limited).toBe(false);
    const map = await mapOf(project, [], { ...MAP_LIMITS, results: size - 1 });
    expect([...map.edges, ...map.external, ...map.unresolved]).toEqual([]);
    expect(map.files[0]).toMatchObject({ checked: 'partial', reason: partialReason });
  });

  it('counts the candidate path of an unavailable target', async () => {
    const source = "import './z';";
    await put('a.ts', source);
    await put('z.ts', '');
    const project = await scanProject(root, randomUUID());
    await rm(path.join(root, 'z.ts'));
    const size = source.length + './z'.length + 100 + 'z.ts'.length;
    const fitting = await mapOf(project, [], { ...MAP_LIMITS, results: size });
    expect(fitting.unresolved).toMatchObject([{ reason: 'unavailable', candidates: ['z.ts'] }]);
    const map = await mapOf(project, [], { ...MAP_LIMITS, results: size - 1 });
    expect(map.unresolved).toEqual([]);
    expect(map.notes).toContain(resultNote);
  });

  it('never keeps a small import after a larger result does not fit, in this or the next file', async () => {
    await put('a.ts', `import '${'x'.repeat(300)}';\nimport 'a';`);
    await put('b.ts', "import 'b';");
    const map = await mapOf(await scanProject(root, randomUUID()), [], { ...MAP_LIMITS, results: 200 });
    expect(map.external).toEqual([]);
    expect(map.files.map(file => file.checked)).toEqual(['partial', 'skipped']);
  });

  it.each([
    ['import pkg.z, pkg.z, pkg.z, pkg.z', 4 * 100],
    ['from os import a, b, c, d', 100 + 4 * 10],
  ])('counts modules or names before collecting the Python statement: %s', async (source, overhead) => {
    await put('pkg/__init__.py', '');
    await put('pkg/a.py', source);
    await put('pkg/b.py', 'import os');
    await put('pkg/z.py', '');
    await put('c.ts', "import 'ts';");
    const project = await scanProject(root, randomUUID());
    const size = source.length + overhead;
    const fitting = await buildProjectMap(root, project.id,
      project.files.filter(file => !['pkg/b.py', 'c.ts'].includes(file.relativePath)), [], { ...MAP_LIMITS, results: size });
    expect([...fitting.edges, ...fitting.external, ...fitting.unresolved]).toHaveLength(1);
    expect(fitting.notes).not.toContain(pythonNote);
    const map = await mapOf(project, [], { ...MAP_LIMITS, results: size - 1 });
    expect(map.external.map(item => item.specifier)).toEqual(['ts']);
    expect(map.edges).toEqual([]);
    expect(map.unresolved).toEqual([]);
    expect(map.notes.filter(note => note === pythonNote)).toHaveLength(1);
    expect(map.files.every(file => file.checked === 'full')).toBe(true);
    expect(map.limited).toBe(false);
  });

  it('discards the initializer whose own names exceed the remaining room', async () => {
    const source = 'from .z import b';
    const name = 'n'.repeat(200);
    await put('pkg/__init__.py', '');
    await put('pkg/a.py', source);
    await put('pkg/z/__init__.py', `${name} = 0`);
    await put('pkg/z/b.py', '');
    const project = await scanProject(root, randomUUID());
    const size = source.length + 100 + 10 + name.length + 10;
    const fitting = await mapOf(project, [], { ...MAP_LIMITS, results: size });
    expect(fitting.edges).toHaveLength(1);
    expect(fitting.unresolved).toEqual([]);
    expect(fitting.notes).not.toContain(pythonNote);
    const map = await mapOf(project, [], { ...MAP_LIMITS, results: size - 1 });
    expect(map.edges).toEqual([]);
    expect(map.unresolved).toMatchObject([{ candidates: ['pkg/z/b.py', 'pkg/z/__init__.py'] }]);
    expect(map.notes.filter(note => note === pythonNote)).toHaveLength(1);
  });
});

it.each([
  ['pkg/main.py', '__package__ = "other"\nfrom .sub.models import X\n'],
  ['pkg/main.py', '__name__ = "email.main"\nfrom .sub.models import X\n'],
  ['pkg/__init__.py', 'from .helpers import lookup as __getattr__\n'],
  ['pkg/__init__.py', '__path__ = []\n'],
  ['pkg/sub/__init__.py', '__path__ = []\n'],
])('records machinery in %s during the map scan', async (changed, source) => {
  await put('pkg/__init__.py', '');
  await put('pkg/sub/__init__.py', '');
  await put('pkg/sub/models.py', 'class X: pass\n');
  await put('pkg/main.py', 'from .sub.models import X\n');
  await put(changed, source);
  const project = await scanProject(root, randomUUID());
  const result = await mapOf(project);
  const main = project.files.find(file => file.relativePath === 'pkg/main.py')!;
  expect(result.edges.filter(item => item.fromFileId === main.id)).toEqual([]);
  expect(result.unresolved.filter(item => item.fromFileId === main.id))
    .toMatchObject([{ reason: 'ambiguous', candidates: ['pkg/sub/models.py'], reasonText: expect.stringContaining('import 동작을 바꿀 수 있는 이름') }]);
});

it('withholds a reached import when its own Python file exceeds the node budget', async () => {
  await put('pkg/main.py', `from .model import X\n${'pass\n'.repeat(30)}`);
  await put('pkg/model.py', '');
  const project = await scanProject(root, randomUUID());
  const result = await mapOf(project, [], { ...MAP_LIMITS, nodesPerFile: 20 });
  const main = project.files.find(file => file.relativePath === 'pkg/main.py')!;
  expect(result.files.find(file => file.id === main.id)?.checked).toBe('partial');
  expect(result.edges.filter(item => item.fromFileId === main.id)).toEqual([]);
  expect(result.unresolved.filter(item => item.fromFileId === main.id))
    .toMatchObject([{ reason: 'ambiguous', candidates: ['pkg/model.py'], reasonText: expect.stringContaining('import 동작을 바꿀 수 있는 이름') }]);
});

describe('function and class search names', () => {
  beforeEach(async () => {
    await rm(root, { recursive: true });
    await mkdir(root);
  });

  it('keeps named TS/JS functions and classes in source order, with analyzer ranges', async () => {
    const text = [
      'function declared() { function nested() {} }',
      'const f = () => {};',
      'class C { m() {} field = () => {}; }',
      'const object = { prop: function () {}, method() {} };',
      'const expression = class Named {};',
      'abstract class Base {}',
      'useEffect(() => {}); items.map(x => x);',
      'export default () => {};',
      'function broken() { const x = ; function hidden() {} class Hidden {} }',
      'class Broken { good() {} bad() { const x = ; } }',
    ].join('\n');
    await put('names.ts', text);
    const project = await scanProject(root, randomUUID());
    const map = await mapOf(project);
    expect(map.symbols.map(item => [item.name, item.kind])).toEqual([
      ['declared', 'function'], ['nested', 'function'], ['f', 'function'], ['C', 'class'],
      ['C.m', 'function'], ['C.field', 'function'], ['prop', 'function'], ['method', 'function'],
      ['Named', 'class'], ['Base', 'class'], ['Broken.good', 'function'],
    ]);
    expect(map.symbols.map(item => item.startUtf16)).toEqual(map.symbols.map(item => item.startUtf16).toSorted((a, b) => a - b));
    const file = project.files.find(file => file.relativePath === 'names.ts')!;
    const hash = createHash('sha256').update(text).digest('hex');
    const analysis = analyzeSource(text, file.relativePath, { projectId: project.id, fileId: file.id, fileHash: hash });
    for (const item of map.symbols) {
      expect(item).toMatchObject({ fileId: file.id, fileHash: hash });
      if (item.kind !== 'function') continue;
      expect(matchFunction({ projectId: project.id, fileId: file.id, relativePath: file.relativePath, hash, text, analysis, guide: null }, item).status).toBe('found');
    }
    expect(map.symbolsCut).toBe(false);
  });

  it('keeps Python nested names and decorator ranges, matching analyzer evidence', async () => {
    const text = [
      '@decorate', 'def f():', '    def nested():', '        pass', '    return nested',
      '@decorate', 'class C:', '    @decorate', '    def method(self):', '        pass',
      '    class Inner:', '        pass',
      'def broken():', '    x =', '    def hidden():', '        pass', '    class Hidden:', '        pass',
    ].join('\n');
    await put('names.py', text);
    const project = await scanProject(root, randomUUID());
    const map = await mapOf(project);
    expect(map.symbols.map(item => [item.name, item.kind, item.startLine])).toEqual([
      ['f', 'function', 1], ['nested', 'function', 3], ['C', 'class', 6], ['C.method', 'function', 8], ['C.Inner', 'class', 11],
    ]);
    const file = project.files[0];
    const hash = createHash('sha256').update(text).digest('hex');
    const analysis = analyzeSource(text, file.relativePath, { projectId: project.id, fileId: file.id, fileHash: hash });
    for (const item of map.symbols) {
      expect(item).toMatchObject({ fileId: file.id, fileHash: hash });
      if (item.kind === 'class') {
        expect(analysis.classes?.find(value => value.name === item.name)?.evidence).toMatchObject({ startUtf16: item.startUtf16, endUtf16: item.endUtf16 });
        continue;
      }
      expect(matchFunction({ projectId: project.id, fileId: file.id, relativePath: file.relativePath, hash, text, analysis, guide: null }, item).status).toBe('found');
    }
  });

  it('leaves out a Python class with a syntax error but keeps its sound method, as the analyzer does', async () => {
    const text = 'class Broken:\n    def bad(self):\n        value =\n    def good(self):\n        return 1\n';
    await put('broken.py', text);
    const project = await scanProject(root, randomUUID());
    const map = await mapOf(project);
    expect(map.symbols.map(item => [item.name, item.kind])).toEqual([['Broken.good', 'function']]);
    const analysis = analyzeSource(text, 'broken.py', { projectId: project.id, fileId: project.files[0].id, fileHash: 'h' });
    expect(analysis.classes).toEqual([]);
    expect(analysis.symbols.map(item => item.name)).toEqual(['Broken.good']);
  });

  it.each(['ts', 'py'])('shares the name budget with %s first and stops before a later smaller name', async first => {
    const second = first === 'ts' ? 'py' : 'ts';
    await put(`a.${first}`, first === 'ts' ? 'function a() {}' : 'def a():\n    pass');
    await put(`b.${second}`, second === 'ts' ? 'function longer() {}\nfunction b() {}' : 'def longer():\n    pass\ndef b():\n    pass');
    const project = await scanProject(root, randomUUID());
    const map = await mapOf(project, [], { ...MAP_LIMITS, symbols: 203 });
    expect(map.symbols.map(item => item.name)).toEqual(['a']);
    expect(map.symbols.reduce((sum, item) => sum + item.name.length + 100, 0)).toBeLessThanOrEqual(203);
    expect(map.symbolsCut).toBe(true);
    expect(map.notes.filter(note => note.includes('함수·클래스 이름이 너무 많아'))).toEqual([
      '함수·클래스 이름이 너무 많아 일부만 모았어요. 검색에 나오지 않는 이름이 있을 수 있어요.',
    ]);
    expect(map.limited).toBe(false);
    expect(map.files.every(file => file.checked === 'full')).toBe(true);
    const fitting = await mapOf(project, [], { ...MAP_LIMITS, symbols: 308 });
    expect(fitting.symbols.map(item => item.name)).toEqual(['a', 'longer', 'b']);
    expect(fitting.symbols.map(item => item.fileId)).toEqual([project.files[0].id, project.files[1].id, project.files[1].id]);
    expect(fitting.symbolsCut).toBe(false);
    expect(fitting.notes.some(note => note.includes('함수·클래스 이름이 너무 많아'))).toBe(false);
  });

  it.each(['ts', 'py'])('counts clipped class and member names before storing them (%s)', async extension => {
    const owner = 'C'.repeat(310), name = 'f'.repeat(310);
    const text = extension === 'ts' ? `class ${owner} { ${name}() {} }\nfunction ${name}() {}`
      : `class ${owner}:\n    def ${name}(self):\n        pass\ndef ${name}():\n    pass`;
    await put(`names.${extension}`, text);
    const project = await scanProject(root, randomUUID());
    const map = await mapOf(project, [], { ...MAP_LIMITS, symbols: 1505 });
    expect(map.symbols.map(item => item.name)).toEqual([`${'C'.repeat(300)}…`, `${'C'.repeat(300)}….${'f'.repeat(300)}…`, `${'f'.repeat(300)}…`]);
    expect(map.symbolsCut).toBe(false);
    const cut = await mapOf(project, [], { ...MAP_LIMITS, symbols: 400 });
    expect(cut.symbols).toEqual([]);
    expect(cut.symbolsCut).toBe(true);
    const analysis = analyzeSource(text, `names.${extension}`, { projectId: project.id, fileId: project.files[0].id, fileHash: map.symbols[0].fileHash });
    expect(analysis.symbols[0].name).toBe(extension === 'ts' ? `${owner}.${name}` : map.symbols[1].name);
  });
});
