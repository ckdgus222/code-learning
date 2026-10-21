import { describe, expect, it } from 'vitest';
import type { ProjectFile } from '../src/shared/contracts';
import { ancestorFolderPaths, buildFileTree, filterFileTree, type TreeFolder } from '../src/renderer/file-tree';

const file = (relativePath: string): ProjectFile => ({ id: relativePath, relativePath, size: 10 });

describe('file tree', () => {
  it('puts folders before files and sorts each group by name without changing the input', () => {
    const files = ['z.ts', 'zebra/z.ts', 'alpha/z.ts', 'a.ts', 'alpha/a.ts'].map(file);
    const before = structuredClone(files);
    const tree = buildFileTree(files);
    expect(tree.children.map(child => [child.kind, child.name])).toEqual([
      ['folder', 'alpha'], ['folder', 'zebra'], ['file', 'a.ts'], ['file', 'z.ts'],
    ]);
    expect((tree.children[0] as TreeFolder).children.map(child => child.name)).toEqual(['a.ts', 'z.ts']);
    expect(files).toEqual(before);
  });

  it('keeps each deep folder, shares ancestors and keeps root files at the root', () => {
    const main = file('api/src/main.ts');
    const helper = file('api/src/helper.ts');
    const rootFile = file('README.md');
    expect(buildFileTree([main, helper, rootFile])).toEqual({ kind: 'folder', name: '', path: '', children: [
      { kind: 'folder', name: 'api', path: 'api', children: [
        { kind: 'folder', name: 'src', path: 'api/src', children: [
          { kind: 'file', name: 'helper.ts', file: helper }, { kind: 'file', name: 'main.ts', file: main },
        ] },
      ] },
      { kind: 'file', name: 'README.md', file: rootFile },
    ] });
  });

  it('matches paths without case sensitivity and keeps only matching files and their ancestors', () => {
    const tree = buildFileTree(['api/src/main.ts', 'api/src/helper.ts', 'api/test/main.test.ts', 'web/view.ts', 'README.md'].map(file));
    const before = structuredClone(tree);
    expect(filterFileTree(tree, 'SRC/MAIN')).toEqual(buildFileTree([file('api/src/main.ts')]));
    expect(filterFileTree(tree, 'api/src')).toEqual(buildFileTree(['api/src/main.ts', 'api/src/helper.ts'].map(file)));
    expect(filterFileTree(tree, 'readme')).toEqual(buildFileTree([file('README.md')]));
    expect(tree).toEqual(before);
    expect(filterFileTree(tree, '')).toBe(tree);
    expect(filterFileTree(tree, 'absent').children).toEqual([]);
  });

  it('handles an empty project', () => {
    expect(buildFileTree([])).toEqual({ kind: 'folder', name: '', path: '', children: [] });
    expect(filterFileTree(buildFileTree([]), 'main').children).toEqual([]);
  });

  it('returns all ancestors from the top down, without including the file', () => {
    expect(ancestorFolderPaths('api/src/services/main.ts')).toEqual(['api', 'api/src', 'api/src/services']);
    expect(ancestorFolderPaths('src/main.ts')).toEqual(['src']);
    expect(ancestorFolderPaths('main.ts')).toEqual([]);
  });
});
