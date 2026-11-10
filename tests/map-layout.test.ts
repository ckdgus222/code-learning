import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { BIG_FOLDER_LIMIT, boxName, boxPlace, closeArea, expandableIds, FILE_VIEW_LIMIT, fileViewFolder, fileViewOf, folderArrows, folderFileList, foldersWithFiles,
  importCycles, linkedArrows, matchCallStep, matchFunction, matchImport, NEIGHBOR_LIMIT, NEIGHBOR_ROW_HEIGHT, neighborhoodGraph, shownBigFolder, visibleGraph } from '../src/renderer/map-layout';
import { buildProjectMap } from '../src/core/analysis/project-map';
import { analyzeSource } from '../src/core/analysis/syntax';
import { readAllowed, scanProject } from '../src/core/project/files';
import type { MapFile, ProjectMap, SourceView } from '../src/shared/contracts';

const file = (id: string, folder: string): MapFile =>
  ({ id, relativePath: `${folder ? `${folder}/` : ''}${id}.ts`, folder, start: false, entry: false, checked: 'full', reason: null });
const edge = (from: string, to: string) => ({ fromFileId: from, toFileId: to, names: [], fileHash: 'h', startUtf16: 0, endUtf16: 1,
  startLine: 1, endLine: 1, text: 'import', specifier: './x' });
// Two folders: a→b twice, b→a once, and one import inside folder a.
const map: ProjectMap = { projectId: 'p', files: [file('a1', 'a'), file('a2', 'a'), file('b1', 'b'), file('b2', 'b')],
  edges: [edge('a1', 'b1'), edge('a2', 'b1'), edge('b2', 'a1'), edge('a1', 'a2')], unresolved: [], external: [], complexFunctions: [], exports: [], unused: { exports: { candidates: [], unsure: [], notes: [] }, candidates: [], unsure: [], excluded: [], notes: [] }, limited: false, notes: [] };
const summary = (graph: ReturnType<typeof visibleGraph>) => graph.arrows.map(arrow => [arrow.source, arrow.target, arrow.items.length]);
const backs = (graph: ReturnType<typeof visibleGraph>) => graph.arrows.filter(arrow => arrow.back).map(arrow => arrow.id);

describe('import cycles', () => {
  it('groups a two-file loop, sorts paths and retains repeated import lines in input order', () => {
    const files = [file('b', ''), file('a', '')];
    const imports = [edge('b', 'a'), edge('a', 'b'), { ...edge('a', 'b'), startLine: 2, startUtf16: 10 }];
    expect(importCycles({ ...map, files, edges: imports })).toEqual([{ files: [files[1], files[0]], imports }]);
  });

  it('keeps a three-file loop without its incoming or outgoing tails', () => {
    const files = ['tail', 'c', 'b', 'a', 'head'].map(id => file(id, ''));
    const imports = [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')];
    expect(importCycles({ ...map, files, edges: [edge('head', 'a'), ...imports, edge('c', 'tail')] }))
      .toEqual([{ files: [files[3], files[2], files[1]], imports }]);
  });

  it('sorts separate components by size and then first relative path, even when linked one way', () => {
    const files = ['a', 'b', 'c', 'd', 'x', 'y', 'z'].map(id => file(id, ''));
    const edges = [edge('c', 'd'), edge('d', 'c'), edge('a', 'b'), edge('b', 'a'),
      edge('x', 'y'), edge('y', 'z'), edge('z', 'x'), edge('b', 'c'), edge('d', 'x')];
    expect(importCycles({ ...map, files, edges }).map(group => group.files.map(file => file.id)))
      .toEqual([['x', 'y', 'z'], ['a', 'b'], ['c', 'd']]);
  });

  it('counts a self import but excludes a lone file without one', () => {
    const files = [file('a', ''), file('b', '')];
    const imports = [edge('a', 'a')];
    expect(importCycles({ ...map, files, edges: imports })).toEqual([{ files: [files[0]], imports }]);
  });

  it('returns no groups for an empty map or a branching acyclic graph', () => {
    expect(importCycles({ ...map, files: [], edges: [] })).toEqual([]);
    const files = ['a', 'b', 'c', 'd'].map(id => file(id, ''));
    expect(importCycles({ ...map, files, edges: [edge('a', 'b'), edge('a', 'c'), edge('b', 'c'), edge('c', 'd')] })).toEqual([]);
  });

  it('handles a 1,000-file chain and loop without recursion', () => {
    const files = Array.from({ length: 1000 }, (_, index) => file(String(index).padStart(4, '0'), 'src'));
    const chain = files.slice(1).map((file, index) => edge(files[index].id, file.id));
    expect(importCycles({ ...map, files, edges: chain })).toEqual([]);
    const imports = [...chain, edge(files.at(-1)!.id, files[0].id)];
    expect(importCycles({ ...map, files, edges: imports })).toEqual([{ files, imports }]);
  });

  it('ignores unknown sources and targets, including apparent loops through missing files', () => {
    const files = [file('a', ''), file('b', '')];
    const imports = [edge('a', 'b'), edge('b', 'a')];
    const unknown = [edge('a', 'missing'), edge('missing', 'a'), edge('missing', 'missing')];
    expect(importCycles({ ...map, files, edges: [...unknown, ...imports] })).toEqual([{ files, imports }]);
    expect(importCycles({ ...map, files, edges: unknown })).toEqual([]);
    expect(importCycles({ ...map, files: [], edges: unknown })).toEqual([]);
  });
});

describe('big folder lists and neighbourhoods', () => {
  it('lists only direct files, counts distinct non-self neighbours across folders and sorts all three keys', () => {
    const source = { ...map, files: [file('z', 'a'), file('b', 'a'), file('a', 'a'), file('used', 'a'),
      file('child', 'a/child'), file('outside', 'b')], edges: [
      edge('outside', 'used'), edge('child', 'used'), edge('outside', 'used'), edge('used', 'used'),
      edge('a', 'outside'), edge('a', 'outside'), edge('b', 'outside'),
    ] };
    expect(folderFileList(source, 'a').map(({ file, uses, usedBy }) => [file.id, uses, usedBy]))
      .toEqual([['used', 0, 2], ['a', 1, 0], ['b', 1, 0], ['z', 0, 0]]);
    expect(folderFileList(source, 'absent')).toEqual([]);
  });

  it('places users on the left, the chosen file in the middle and dependencies on the right', () => {
    const source = { ...map, files: [file('center', 'a'), file('user', 'b'), file('dep', 'c'), file('mutual', 'd')],
      edges: [edge('user', 'center'), edge('center', 'dep'), edge('center', 'dep'), edge('mutual', 'center'),
        edge('center', 'mutual'), edge('user', 'dep'), edge('center', 'center')] };
    const graph = neighborhoodGraph(source, 'center');
    expect(graph.boxes.map(box => [box.id, box.x, box.y])).toEqual([
      ['user', 0, 0], ['mutual', 0, NEIGHBOR_ROW_HEIGHT], ['center', 320, 0], ['dep', 640, 0],
    ]);
    expect(graph.boxes.every(box => box.kind === 'file' && box.count === 1 && box.file?.id === box.id)).toBe(true);
    expect(graph.boxes.map(box => [box.label, boxName(box)]))
      .toEqual([['user.ts', 'b/user.ts'], ['mutual.ts', 'd/mutual.ts'], ['center.ts', 'a/center.ts'], ['dep.ts', 'c/dep.ts']]);
    expect(summary(graph)).toEqual([['user', 'center', 1], ['center', 'dep', 2], ['mutual', 'center', 1], ['center', 'mutual', 1]]);
    expect(backs(graph)).toEqual(['center->mutual']);
    expect(graph.users).toEqual([source.files[1], source.files[3]]);
    expect(graph.used).toEqual([source.files[2], source.files[3]]);
    expect(graph.hidden).toEqual({ users: 0, used: 0 });
  });

  it('keeps the first twenty paths per column and counts hidden boxes after assigning mutual neighbours to the left', () => {
    expect(NEIGHBOR_LIMIT).toBe(20);
    expect(NEIGHBOR_ROW_HEIGHT).toBe(160);
    const users = Array.from({ length: 22 }, (_, i) => file(`user${String(i).padStart(2, '0')}`, 'users'));
    const used = Array.from({ length: 21 }, (_, i) => file(`used${String(i).padStart(2, '0')}`, 'used'));
    const source = { ...map, files: [file('center', 'a'), ...users.toReversed(), ...used.toReversed()], edges: [
      ...users.map(file => edge(file.id, 'center')), ...used.map(file => edge('center', file.id)),
      edge('center', users[0].id), edge('center', users[21].id),
    ] };
    const graph = neighborhoodGraph(source, 'center');
    expect(graph.boxes).toHaveLength(41);
    expect(graph.boxes.filter(box => box.x === 0).map(box => box.id)).toEqual(users.slice(0, 20).map(file => file.id));
    expect(graph.boxes.filter(box => box.x === 640).map(box => box.id)).toEqual(used.slice(0, 20).map(file => file.id));
    expect(graph.hidden).toEqual({ users: 2, used: 1 });
    expect(graph.users).toEqual(users);
    expect(graph.used).toEqual([...used, users[0], users[21]]);
    expect(graph.arrows).toHaveLength(41);
    expect(graph.arrows.every(arrow => graph.boxes.some(box => box.id === arrow.source) && graph.boxes.some(box => box.id === arrow.target))).toBe(true);
    expect(graph.boxes.filter(box => box.x === 0).at(-1)?.y).toBe(19 * 160);
  });

  it('keeps an isolated file and ignores self imports and missing selections', () => {
    const source = { ...map, edges: [edge('a1', 'a1')] };
    expect(neighborhoodGraph(source, 'a1')).toMatchObject({ boxes: [{ id: 'a1', x: 320, y: 0 }], arrows: [], users: [], used: [], hidden: { users: 0, used: 0 } });
    expect(neighborhoodGraph(source, 'absent')).toEqual({ boxes: [], arrows: [], users: [], used: [], hidden: { users: 0, used: 0 } });
  });

  it('detects exposed big direct-file groups and leaf folders only when all ancestors are open', () => {
    expect(BIG_FOLDER_LIMIT).toBe(30);
    const source = { ...map, files: [
      ...Array.from({ length: 31 }, (_, i) => file(`a${i}`, 'a')),
      ...Array.from({ length: 31 }, (_, i) => file(`b${i}`, 'b/leaf')),
      ...Array.from({ length: 30 }, (_, i) => file(`c${i}`, 'c')),
      file('child', 'a/child'),
    ] };
    const expandable = expandableIds(source);
    const folders = foldersWithFiles(source).toReversed();
    expect(shownBigFolder(new Set(['folder:a']), folders, expandable)).toBeNull();
    expect(shownBigFolder(new Set(['folder:a', 'files:a']), folders, expandable)).toBe('a');
    expect(shownBigFolder(new Set(['files:a']), folders, expandable)).toBeNull();
    expect(shownBigFolder(new Set(['folder:b/leaf']), folders, expandable)).toBeNull();
    expect(shownBigFolder(new Set(['folder:c']), folders, expandable)).toBeNull();
    expect(shownBigFolder(new Set(['folder:c', 'folder:b', 'folder:b/leaf']), folders, expandable)).toBe('b/leaf');
    expect(shownBigFolder(expandable, folders, expandable)).toBe('a');
    expect(shownBigFolder(new Set(['files:']), [{ folder: '', count: 31 }], new Set(['files:']))).toBe('');
  });
});

describe('file view of one folder', () => {
  const nested: ProjectMap = { ...map, files: [file('other', 'web'), file('child', 'api/src/child'), file('main', 'api/src'),
    file('root', ''), file('config', 'api'), file('helper', 'api/src'), file('sibling', 'api/test')], edges: [] };
  const expandable = expandableIds(nested);

  it('counts direct files in path order without adding folders that have only descendants', () => {
    const source = { ...nested, files: [...nested.files, file('deep', 'packages/lib/src')] };
    expect(foldersWithFiles(source)).toEqual([
      { folder: '', count: 1 }, { folder: 'api', count: 1 }, { folder: 'api/src', count: 2 },
      { folder: 'api/src/child', count: 1 }, { folder: 'api/test', count: 1 },
      { folder: 'packages/lib/src', count: 1 }, { folder: 'web', count: 1 },
    ]);
    expect(foldersWithFiles({ ...map, files: [] })).toEqual([]);
  });

  it.each([80, 81])('keeps all %i direct files when a folder is opened, without truncating at the limit', count => {
    expect(FILE_VIEW_LIMIT).toBe(80);
    const source = { ...map, files: Array.from({ length: count }, (_, index) => file(`file${index}`, 'src')), edges: [] };
    const graph = visibleGraph(source, fileViewOf('src', expandableIds(source)));
    expect(graph.boxes).toHaveLength(count);
    expect(graph.boxes.every(box => box.kind === 'file')).toBe(true);
  });

  it('opens ancestors and the chosen direct-file group while leaving every other file grouped', () => {
    const opened = fileViewOf('api/src', expandable);
    expect(opened).toEqual(new Set(['folder:api', 'folder:api/src', 'files:api/src']));
    const boxes = visibleGraph(nested, opened).boxes;
    expect(boxes.filter(box => box.kind === 'file').map(box => box.id).sort()).toEqual(['helper', 'main']);
    expect(boxes.filter(box => box.kind === 'folder').map(box => box.id).sort())
      .toEqual(['files:', 'files:api', 'folder:api/src/child', 'folder:api/test', 'folder:web']);
  });

  it('opens leaf files without inventing a direct-file group or opening a sibling', () => {
    const opened = fileViewOf('api/test', expandable);
    expect(opened).toEqual(new Set(['folder:api', 'folder:api/test']));
    expect(visibleGraph(nested, opened).boxes.filter(box => box.kind === 'file').map(box => box.id)).toEqual(['sibling']);
    expect(fileViewOf('removed', expandable)).toEqual(new Set());
  });

  it('opens only the root direct-file group when choosing the root', () => {
    const opened = fileViewOf('', expandable);
    expect(opened).toEqual(new Set(['files:']));
    expect(visibleGraph(nested, opened).boxes.map(box => box.id).sort()).toEqual(['folder:api', 'folder:web', 'root']);
  });

  it('recognizes exactly matching file views independent of set order, including the root', () => {
    const folders = foldersWithFiles(nested);
    for (const { folder } of folders) {
      expect(fileViewFolder(new Set([...fileViewOf(folder, expandable)].reverse()), folders, expandable)).toBe(folder);
    }
    expect(fileViewFolder(new Set(), folders, expandable)).toBeNull();
    expect(fileViewFolder(new Set(['folder:api', 'folder:api/src']), folders, expandable)).toBeNull();
    expect(fileViewFolder(new Set(['folder:api', 'folder:api/src', 'folder:web']), folders, expandable)).toBeNull();
    expect(fileViewFolder(new Set([...fileViewOf('api/src', expandable), 'folder:api/test']), folders, expandable)).toBeNull();
    expect(fileViewFolder(new Set(), [], new Set())).toBeNull();
  });
});

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

describe('box places in connection lists', () => {
  const nested: ProjectMap = { ...map, files: [file('root', ''), file('config', 'api'), file('main', 'api/src'),
    file('auth', 'api/src/auth'), file('common', 'api/src/common'), file('inner', 'api/src/test'), file('outer', 'api/test'),
    file('child', 'api/src/바로 아래 파일'), file('page', 'web')], edges: [] };
  const opened = new Set(['folder:api', 'folder:api/src']);

  it('places deep and top-level folders in their parent areas with trailing slashes', () => {
    const boxes = visibleGraph(nested, opened).boxes;
    expect(boxPlace(boxes.find(box => box.id === 'folder:api/src/auth')!)).toEqual({ area: 'api/src', short: 'auth/' });
    expect(boxPlace(boxes.find(box => box.id === 'folder:api/test')!)).toEqual({ area: 'api', short: 'test/' });
    expect(boxPlace(boxes.find(box => box.id === 'folder:web')!)).toEqual({ area: '', short: 'web/' });
  });

  it('places direct-file groups inside their own areas, including the root', () => {
    const boxes = visibleGraph(nested, opened).boxes;
    expect(boxPlace(boxes.find(box => box.id === 'files:api/src')!)).toEqual({ area: 'api/src', short: '바로 아래 파일' });
    expect(boxPlace(boxes.find(box => box.id === 'files:')!)).toEqual({ area: '', short: '바로 아래 파일' });
  });

  it('places files in their folders with only their basenames', () => {
    const boxes = visibleGraph(nested, expandableIds(nested)).boxes;
    expect(boxPlace(boxes.find(box => box.id === 'main')!)).toEqual({ area: 'api/src', short: 'main.ts' });
    expect(boxPlace(boxes.find(box => box.id === 'root')!)).toEqual({ area: '', short: 'root.ts' });
  });

  it('keeps short names unique within each area before and after direct-file groups open', () => {
    const grouped = visibleGraph(nested, opened).boxes;
    expect(grouped.map(box => box.id)).toEqual(expect.arrayContaining(['folder:api/test', 'folder:api/src/test',
      'files:api/src', 'folder:api/src/바로 아래 파일']));
    expect(boxPlace(grouped.find(box => box.id === 'folder:api/src/바로 아래 파일')!))
      .toEqual({ area: 'api/src', short: '바로 아래 파일/' });
    const ungrouped = visibleGraph(nested, new Set([...opened, 'files:', 'files:api', 'files:api/src'])).boxes;
    expect(ungrouped.some(box => box.id.startsWith('files:'))).toBe(false);
    expect(ungrouped.map(box => box.id)).toEqual(expect.arrayContaining(['root', 'config', 'main']));
    for (const boxes of [grouped, ungrouped, visibleGraph(nested, expandableIds(nested)).boxes]) {
      const places = boxes.map(boxPlace);
      expect(new Set(places.map(place => JSON.stringify([place.area, place.short]))).size).toBe(boxes.length);
    }
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
  beforeEach(async () => { sandbox = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-map-layout-test-'))); });
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

  it('finds the same Python import evidence for multiple edges from one statement', async () => {
    await writeFile(path.join(sandbox, 'a.py'), '');
    await writeFile(path.join(sandbox, 'b.py'), '');
    const { source, items } = await entries('main.py', '# 😀\nfrom . import a, b\n');
    expect(items).toHaveLength(2);
    expect(items.every(item => 'toFileId' in item)).toBe(true);
    for (const item of items) {
      expect(matchImport(source, item)).toMatchObject({ status: 'found', evidence: { startUtf16: item.startUtf16, endUtf16: item.endUtf16 } });
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
