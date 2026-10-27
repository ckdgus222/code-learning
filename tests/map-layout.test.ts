import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { boxName, closeArea, expandableIds, folderArrows, linkedArrows, matchCallStep, matchFunction, matchImport, visibleGraph } from '../src/renderer/map-layout';
import { buildProjectMap } from '../src/core/analysis/project-map';
import { analyzeSource } from '../src/core/analysis/syntax';
import { readAllowed, scanProject } from '../src/core/project/files';
import type { MapFile, ProjectMap, SourceView } from '../src/shared/contracts';

const file = (id: string, folder: string): MapFile =>
  ({ id, relativePath: `${folder ? `${folder}/` : ''}${id}.ts`, folder, start: false, checked: 'full', reason: null });
const edge = (from: string, to: string) => ({ fromFileId: from, toFileId: to, fileHash: 'h', startUtf16: 0, endUtf16: 1,
  startLine: 1, endLine: 1, text: 'import', specifier: './x' });
// Two folders: a→b twice, b→a once, and one import inside folder a.
const map: ProjectMap = { projectId: 'p', files: [file('a1', 'a'), file('a2', 'a'), file('b1', 'b'), file('b2', 'b')],
  edges: [edge('a1', 'b1'), edge('a2', 'b1'), edge('b2', 'a1'), edge('a1', 'a2')], unresolved: [], external: [], complexFunctions: [], limited: false, notes: [] };
const summary = (graph: ReturnType<typeof visibleGraph>) => graph.arrows.map(arrow => [arrow.source, arrow.target, arrow.items.length]);
const backs = (graph: ReturnType<typeof visibleGraph>) => graph.arrows.filter(arrow => arrow.back).map(arrow => arrow.id);

describe('box names in connection lists', () => {
  const named: ProjectMap = { ...map, files: [file('root', ''), file('index', 'web'),
    { ...file('a', 'web/app'), relativePath: 'web/app/index.ts' },
    { ...file('b', 'web/lib'), relativePath: 'web/lib/index.ts' }], edges: [] };

  it('uses full relative paths for files with the same basename', () => {
    const boxes = visibleGraph(named, expandableIds(named)).boxes;
    expect(boxes.filter(box => box.label === 'index.ts').map(boxName).sort())
      .toEqual(['web/app/index.ts', 'web/index.ts', 'web/lib/index.ts']);
  });

  it('names root and nested direct-file groups separately from areas', () => {
    const boxes = visibleGraph(named, new Set(['folder:web'])).boxes;
    expect(boxes.map(box => [box.id, boxName(box)])).toEqual([
      ['files:', '(최상위 폴더) 바로 아래 파일'], ['files:web', 'web 바로 아래 파일'],
      ['folder:web/app', 'web/app'], ['folder:web/lib', 'web/lib']]);
  });
});

describe('design view and file view of the project map', () => {
  it('counts arrows between folders by direction and leaves out imports inside one folder', () => {
    const graph = visibleGraph(map, new Set());
    // a and b use each other, so one arrow has to run right to left; it is marked.
    expect(graph.boxes.map(box => [box.id, box.kind, box.label, box.x, box.y])).toEqual([
      ['folder:b', 'folder', 'b · 파일 2개', 0, 0], ['folder:a', 'folder', 'a · 파일 2개', 320, 0]]);
    expect(summary(graph)).toEqual([['folder:a', 'folder:b', 2], ['folder:b', 'folder:a', 1]]);
    expect(backs(graph)).toEqual(['folder:a->folder:b']);
  });

  it('shows the files of an expanded folder and keeps arrows to folders still closed', () => {
    const graph = visibleGraph(map, new Set(['folder:a']));
    expect(graph.boxes.map(box => box.id)).toEqual(['a1', 'folder:b', 'a2']);
    expect(summary(graph)).toEqual([['a1', 'folder:b', 1], ['a2', 'folder:b', 1], ['folder:b', 'a1', 1], ['a1', 'a2', 1]]);
    // Boxes with the same use-chain level share a column, ordered by path.
    expect(graph.boxes.map(box => [box.x, box.y])).toEqual([[0, 0], [0, 112], [320, 0]]);
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
    expect(summary(visibleGraph(map, new Set(['folder:a', 'folder:b'])))).toEqual([['a1', 'b1', 1], ['a2', 'b1', 1], ['b2', 'a1', 1], ['a1', 'a2', 1]]);
  });
});

describe('arrows linked to one box', () => {
  it('keeps incoming and outgoing arrows in input order and counts boxes rather than imports', () => {
    const arrows = visibleGraph(map, new Set(['folder:a'])).arrows;
    expect(linkedArrows(arrows, 'a1')).toEqual({ arrows: [arrows[0], arrows[2], arrows[3]],
      linked: new Set(['folder:b', 'a2']), uses: 2, usedBy: 1 });
    const grouped = visibleGraph(map, new Set()).arrows;
    expect(linkedArrows(grouped, 'folder:a')).toEqual({ arrows: grouped, linked: new Set(['folder:b']), uses: 1, usedBy: 1 });
  });

  it('returns no arrows or linked boxes for a box with no connections', () => {
    const arrows = visibleGraph({ ...map, files: [...map.files, file('alone', 'alone')] }, new Set()).arrows;
    expect(linkedArrows(arrows, 'folder:alone')).toEqual({ arrows: [], linked: new Set(), uses: 0, usedBy: 0 });
    expect(linkedArrows([], 'folder:a')).toEqual({ arrows: [], linked: new Set(), uses: 0, usedBy: 0 });
  });
});

describe('opening project areas one level at a time', () => {
  const deep: ProjectMap = { ...map,
    files: [file('a', 'web/app'), file('b', 'web/lib'), file('c', 'api/src'),
      { ...file('readme', ''), relativePath: 'README.md' }],
    edges: [edge('a', 'b'), edge('a', 'c'), edge('b', 'c')] };
  const ids = (graph: ReturnType<typeof visibleGraph>) => graph.boxes.map(box => box.id).sort();

  it('starts with top-level areas and one direct-file group, counting all descendants', () => {
    const graph = visibleGraph(deep, new Set());
    expect(ids(graph)).toEqual(['files:', 'folder:api', 'folder:web']);
    expect(graph.boxes.map(box => [box.id, box.count, box.label])).toEqual([
      ['folder:web', 2, 'web · 파일 2개'], ['files:', 1, '(최상위 폴더) 바로 아래 파일 · 1개'],
      ['folder:api', 1, 'api · 파일 1개']]);
    expect(summary(graph)).toEqual([['folder:web', 'folder:api', 2]]);
  });

  it('replaces an opened area with its immediate children and reveals internal imports', () => {
    const graph = visibleGraph(deep, new Set(['folder:web']));
    expect(ids(graph)).toEqual(['files:', 'folder:api', 'folder:web/app', 'folder:web/lib']);
    expect(summary(graph)).toEqual([['folder:web/app', 'folder:web/lib', 1],
      ['folder:web/app', 'folder:api', 1], ['folder:web/lib', 'folder:api', 1]]);
    const leaf = visibleGraph(deep, new Set(['folder:web', 'folder:web/app', 'files:']));
    expect(ids(leaf)).toEqual(['a', 'folder:api', 'folder:web/lib', 'readme']);
    expect(summary(leaf)).toEqual([['a', 'folder:web/lib', 1], ['a', 'folder:api', 1], ['folder:web/lib', 'folder:api', 1]]);
  });

  it('groups direct files separately when an opened area also has subfolders', () => {
    const mixed = { ...deep, files: [...deep.files, file('index', 'web')] };
    const opened = new Set(['folder:web']);
    const graph = visibleGraph(mixed, opened);
    expect(graph.boxes.find(box => box.id === 'files:web')).toMatchObject({ label: 'web 바로 아래 파일 · 1개', count: 1 });
    expect(ids(graph)).not.toContain('index');
    opened.add('files:web');
    expect(ids(visibleGraph(mixed, opened))).toContain('index');
    expect(ids(visibleGraph(mixed, closeArea(opened, 'folder:web')))).toEqual(['files:', 'folder:api', 'folder:web']);
  });

  it('opens all ancestors and file groups for file view, including files at the root', () => {
    const all = expandableIds(deep);
    expect([...all].sort()).toEqual(['files:', 'folder:api', 'folder:api/src', 'folder:web', 'folder:web/app', 'folder:web/lib']);
    const graph = visibleGraph(deep, all);
    expect(ids(graph)).toEqual(deep.files.map(file => file.id).sort());
    expect(graph.boxes.every(box => box.kind === 'file')).toBe(true);
    expect(graph.arrows.flatMap(arrow => arrow.items)).toEqual(deep.edges);
  });

  it('stacks equal levels by full path, with importing boxes to the left', () => {
    const graph = visibleGraph({ ...deep, edges: [edge('c', 'a'), edge('c', 'readme')] }, new Set());
    expect(graph.boxes.map(box => [box.id, box.x, box.y])).toEqual([
      ['folder:api', 0, 0], ['files:', 320, 0], ['folder:web', 320, 112]]);
    expect(backs(graph)).toEqual([]);
  });

  it('compacts cycle levels beside eight disconnected areas, marking backward arrows', () => {
    const cyclic = { ...map, files: [file('a', 'a'), file('b', 'b'),
      ...Array.from({ length: 8 }, (_, index) => file(`extra${index}`, `extra${index}`))], edges: [edge('a', 'b'), edge('b', 'a')] };
    const graph = visibleGraph(cyclic, new Set());
    expect([...new Set(graph.boxes.map(box => box.x))]).toEqual([0, 320, 640]);
    expect(backs(graph)).toEqual(['folder:a->folder:b']);
    expect(graph.boxes.slice(2).map(box => box.y)).toEqual(Array.from({ length: 8 }, (_, index) => index * 112));
  });

  it('ignores paths missing from the map and descendants hidden by a closed parent', () => {
    expect(visibleGraph(deep, new Set(['folder:gone', 'files:gone', 'folder:web/app']))).toEqual(visibleGraph(deep, new Set()));
    expect(visibleGraph({ ...deep, files: [], edges: [] }, new Set(['folder:web']))).toEqual({ boxes: [], arrows: [] });
    expect(visibleGraph({ ...deep, edges: [edge('missing', 'a'), edge('a', 'missing')] }, new Set()).arrows).toEqual([]);
  });

  it('keeps 100 root files in one group until opened, and folds them back into one', () => {
    const root = { ...map, files: Array.from({ length: 100 }, (_, index) => file(`f${index}`, '')), edges: [] };
    expect(visibleGraph(root, new Set()).boxes).toMatchObject([{ id: 'files:', count: 100 }]);
    const opened = new Set(['files:']);
    expect(visibleGraph(root, opened).boxes).toHaveLength(100);
    expect(visibleGraph(root, opened).boxes.every(box => box.kind === 'file')).toBe(true);
    expect(visibleGraph(root, closeArea(opened, 'files:')).boxes).toMatchObject([{ id: 'files:', count: 100 }]);
  });

  it('closes only an area and its descendants, preserving similarly named siblings and the input', () => {
    const opened = new Set(['folder:a', 'folder:a/b', 'files:a', 'files:a/b', 'folder:ab', 'files:ab']);
    expect([...closeArea(opened, 'folder:a')]).toEqual(['folder:ab', 'files:ab']);
    expect(opened.size).toBe(6);
    expect([...closeArea(opened, 'files:a')]).toEqual(['folder:a', 'folder:a/b', 'files:a/b', 'folder:ab', 'files:ab']);
  });

  it('distinguishes a folder named files:a from the direct files of a', () => {
    const names = { ...map, files: [file('root', 'a'), file('child', 'a/b'), file('other', 'files:a')], edges: [] };
    const opened = new Set(['folder:a', 'files:a', 'folder:files:a']);
    expect(ids(visibleGraph(names, opened))).toEqual(['folder:a/b', 'other', 'root']);
    expect(ids(visibleGraph(names, closeArea(opened, 'files:a')))).toEqual(['files:a', 'folder:a/b', 'other']);
    expect(ids(visibleGraph(names, closeArea(opened, 'folder:files:a')))).toEqual(['folder:a/b', 'folder:files:a', 'root']);
    expect([...closeArea(opened, 'folder:a')]).toEqual(['folder:files:a']);
  });

  it('keeps the text-list connections between innermost folders', () => {
    expect(folderArrows(map)).toEqual(visibleGraph(map, new Set()).arrows);
    expect(summary({ boxes: [], arrows: folderArrows(deep) })).toEqual([
      ['folder:web/app', 'folder:web/lib', 1], ['folder:web/app', 'folder:api/src', 1], ['folder:web/lib', 'folder:api/src', 1]]);
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
      guide: null, analysis: analyzeSource(read, relativePath, { projectId: project.id, fileId: target.id, fileHash: hash }) };
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

  it('finds the step of a call from the call search: a call expression, or an arrow whose body is the call', async () => {
    const text = "function run() {\n  check(1);\n}\nconst quick = () => save('q');\nboot();\n";
    const { source } = await entries('calls.ts', text);
    const site = (piece: string) => ({ fileId: source.fileId, fileHash: source.hash, startUtf16: text.indexOf(piece), endUtf16: text.indexOf(piece) + piece.length });
    const found = (piece: string) => {
      const match = matchCallStep(source, site(piece));
      return match.status === 'found' ? [match.symbol.name, match.step.kind] : match.status;
    };
    expect([found('check(1)'), found("save('q')"), found('boot()')]).toEqual([['run', 'call_expression'], ['quick', 'expression_body'], 'missing']);
    expect(matchCallStep({ ...source, hash: 'other' }, site('check(1)'))).toEqual({ status: 'changed' });
  });
});
