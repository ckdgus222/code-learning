import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { matchFunction, matchImport, visibleGraph } from '../src/renderer/map-layout';
import { buildProjectMap } from '../src/core/analysis/project-map';
import { analyzeSource } from '../src/core/analysis/syntax';
import { readAllowed, scanProject } from '../src/core/project/files';
import type { MapFile, ProjectMap, SourceView } from '../src/shared/contracts';

const file = (id: string, folder: string): MapFile =>
  ({ id, relativePath: `${folder}/${id}.ts`, folder, start: false, checked: 'full', reason: null });
const edge = (from: string, to: string) => ({ fromFileId: from, toFileId: to, fileHash: 'h', startUtf16: 0, endUtf16: 1,
  startLine: 1, endLine: 1, text: 'import', specifier: './x' });
// Two folders: a→b twice, b→a once, and one import inside folder a.
const map: ProjectMap = { projectId: 'p', files: [file('a1', 'a'), file('a2', 'a'), file('b1', 'b'), file('b2', 'b')],
  edges: [edge('a1', 'b1'), edge('a2', 'b1'), edge('b2', 'a1'), edge('a1', 'a2')], unresolved: [], external: [], complexFunctions: [], limited: false, notes: [] };
const summary = (graph: ReturnType<typeof visibleGraph>) => graph.arrows.map(arrow => [arrow.source, arrow.target, arrow.items.length]);
const backs = (graph: ReturnType<typeof visibleGraph>) => graph.arrows.filter(arrow => arrow.back).map(arrow => arrow.id);

describe('design view and file view of the project map', () => {
  it('counts arrows between folders by direction and leaves out imports inside one folder', () => {
    const graph = visibleGraph(map, new Set());
    // a and b use each other, so one arrow has to run right to left; it is marked.
    expect(graph.boxes.map(box => [box.id, box.kind, box.label, box.x, box.y])).toEqual([
      ['folder:b', 'folder', 'b · 파일 2개', 0, 0], ['folder:a', 'folder', 'a · 파일 2개', 320, 96]]);
    expect(summary(graph)).toEqual([['folder:a', 'folder:b', 2], ['folder:b', 'folder:a', 1]]);
    expect(backs(graph)).toEqual(['folder:a->folder:b']);
  });

  it('shows the files of an expanded folder and keeps arrows to folders still closed', () => {
    const graph = visibleGraph(map, new Set(['a']));
    expect(graph.boxes.map(box => box.id)).toEqual(['folder:b', 'a1', 'a2']);
    expect(summary(graph)).toEqual([['a1', 'folder:b', 1], ['a2', 'folder:b', 1], ['folder:b', 'a1', 1], ['a1', 'a2', 1]]);
    // One column per folder, files by row.
    expect(graph.boxes.map(box => [box.x, box.y])).toEqual([[0, 0], [320, 0], [320, 112]]);
  });

  it('puts a folder left of the folders it uses, so arrows run left to right', () => {
    const used: ProjectMap = { ...map, files: [file('l1', 'lib'), file('m1', 'main')], edges: [edge('m1', 'l1')] };
    expect(visibleGraph(used, new Set()).boxes.map(box => [box.id, box.x])).toEqual([['folder:main', 0], ['folder:lib', 320]]);
  });

  it('orders a chain without a cycle by its longest path, so no arrow runs backwards', () => {
    // zapp uses blib and shared, blib uses shared: by name blib would come first and zapp→blib run backwards.
    const chain: ProjectMap = { ...map, files: [file('z', 'zapp'), file('b', 'blib'), file('s', 'shared')],
      edges: [edge('z', 'b'), edge('z', 's'), edge('b', 's')] };
    const graph = visibleGraph(chain, new Set());
    expect(graph.boxes.map(box => box.id)).toEqual(['folder:zapp', 'folder:blib', 'folder:shared']);
    expect(backs(graph)).toEqual([]);
  });

  it('shows every file when every folder is expanded', () => {
    expect(summary(visibleGraph(map, new Set(['a', 'b'])))).toEqual([['a1', 'b1', 1], ['a2', 'b1', 1], ['b2', 'a1', 1], ['a1', 'a2', 1]]);
  });
});

describe('finding the code evidence of a map entry', () => {
  let sandbox: string;
  beforeEach(async () => { sandbox = await mkdtemp('/private/tmp/learning-map-layout-test-'); });
  afterEach(async () => { await rm(sandbox, { recursive: true, force: true }); });

  async function entries(relativePath: string, text: string) {
    await mkdir(path.dirname(path.join(sandbox, relativePath)), { recursive: true });
    await writeFile(path.join(sandbox, relativePath), text);
    const project = await scanProject(sandbox, randomUUID());
    const target = project.files.find(item => item.relativePath === relativePath)!;
    const projectMap = await buildProjectMap(sandbox, project.id, project.files, []);
    const { text: read, hash } = await readAllowed(sandbox, relativePath);
    const source: SourceView = { projectId: project.id, fileId: target.id, relativePath, text: read, hash,
      analysis: analyzeSource(read, relativePath, { projectId: project.id, fileId: target.id, fileHash: hash }) };
    return { source, items: [...projectMap.edges, ...projectMap.unresolved, ...projectMap.external].filter(item => item.fromFileId === target.id),
      functions: projectMap.complexFunctions.filter(item => item.fileId === target.id) };
  }

  it('picks the right one of two imports on one line by its range, including one with a syntax error', async () => {
    const { source, items } = await entries('two.ts', "import { a } from './a'; import { b } from './b';\nimport { c as } from './c';\n");
    expect(items.map(item => matchImport(source, item).status)).toEqual(['found', 'found', 'found']);
    for (const item of items) {
      const found = matchImport(source, item);
      if (found.status === 'found') expect(source.text.slice(found.evidence.startUtf16, found.evidence.endUtf16)).toBe(item.text);
    }
  });

  it('does not match once the file has another hash', async () => {
    const { source, items } = await entries('one.ts', "import { a } from './a';\n");
    expect(matchImport({ ...source, hash: 'other' }, items[0])).toEqual({ status: 'changed' });
  });

  it('has no evidence for imports the analyzer did not look at', async () => {
    // The analyzer skips a function with an error in it, and stops after 200 functions.
    const broken = await entries('broken.ts', "function broken() { const a = ; import('./lazy'); }\n");
    expect(broken.items.map(item => [item.text, matchImport(broken.source, item).status])).toEqual([["import('./lazy')", 'missing']]);
    const functions = Array.from({ length: 201 }, (_, index) => `function f${index}() {}`).join('\n');
    const many = await entries('many.ts', `${functions}\nimport { z } from './z';\n`);
    expect(many.items.map(item => [item.text, matchImport(many.source, item).status])).toEqual([["import { z } from './z';", 'missing']]);
  });

  it('finds the function of a complexity list entry, but not in a changed file or past the analyzer limits', async () => {
    const long = `function long() {\n${'  step();\n'.repeat(61)}}`;
    const { source, functions } = await entries('long.ts', `function short() {}\n${long}\n`);
    const found = matchFunction(source, functions[0]);
    expect(found.status === 'found' && [found.symbol.name, source.text.slice(found.symbol.evidence.startUtf16, found.symbol.evidence.endUtf16)])
      .toEqual(['long', long]);
    expect(matchFunction({ ...source, hash: 'other' }, functions[0])).toEqual({ status: 'changed' });
    // The analyzer lists 200 functions; the 201st is still measured for the map.
    const many = await entries('many-long.ts', `${Array.from({ length: 200 }, (_, index) => `function f${index}() {}`).join('\n')}\n${long}\n`);
    expect(many.functions.map(item => [item.name, matchFunction(many.source, item).status])).toEqual([['long', 'missing']]);
  });
});
