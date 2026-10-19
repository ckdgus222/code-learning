import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { scanProject } from '../src/core/project/files';
import { buildProjectMap, MAP_LIMITS } from '../src/core/analysis/project-map';
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
  sandbox = await mkdtemp('/private/tmp/learning-map-test-');
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
        // No TypeScript `.js` → `.ts` substitution: x.ts and e.js.ts are not taken.
        [13, 'not-found', []],
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
