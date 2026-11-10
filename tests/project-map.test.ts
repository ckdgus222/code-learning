import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFile, mkdtemp, realpath, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { scanProject } from '../src/core/project/files';
import { buildProjectMap, MAP_LIMITS } from '../src/core/analysis/project-map';
import { buildOverview } from '../src/core/analysis/overview';
import { analyzeSource } from '../src/core/analysis/syntax';
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
