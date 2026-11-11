import { describe, expect, it } from 'vitest';
import type { MapFile, ProjectMap } from '../src/shared/contracts';
import { readingOrder, READING_STARTS, READING_STEPS, supportFile } from '../src/core/analysis/reading-order';

const file = (relativePath: string, checked: MapFile['checked'] = 'full'): MapFile => ({
  id: relativePath, relativePath, folder: '', start: false, entry: false, checked, reason: null,
});
const edge = (fromFileId: string, toFileId: string): ProjectMap['edges'][number] => ({
  fromFileId, toFileId, fileHash: 'hash', specifier: toFileId, text: 'import', names: [],
  startUtf16: 0, endUtf16: 1, startLine: 1, endLine: 1,
});

describe('reading order', () => {
  it('lists the start before its neighbors and deeper imports', () => {
    const result = readingOrder(['a', 'b', 'c', 'd'].map(name => file(name)), [edge('a', 'b'), edge('b', 'c'), edge('a', 'd')], false);
    expect(result).toEqual({ steps: [
      { kind: 'start', fileId: 'a', reaches: 3 },
      { kind: 'next', fileId: 'b', depth: 1, usedBy: 1 },
      { kind: 'next', fileId: 'd', depth: 1, usedBy: 1 },
      { kind: 'next', fileId: 'c', depth: 2, usedBy: 1 },
    ], total: 4, incomplete: false });
  });

  it('breaks equal distances by distinct importers, then by path', () => {
    const edges = [edge('start', 'a'), edge('start', 'b'), edge('start', 'z'), edge('a', 'z')];
    const result = readingOrder(['start', 'a', 'b', 'z'].map(name => file(name)), edges, false);
    expect(result.steps.map(step => step.fileId)).toEqual(['start', 'z', 'a', 'b']);
    // The path decides between `a` and `b`, not the order the files were given in.
    expect(readingOrder(['z', 'b', 'a', 'start'].map(name => file(name)), edges, false)).toEqual(result);
    expect(result.steps[1]).toEqual({ kind: 'next', fileId: 'z', depth: 1, usedBy: 2 });
  });

  it('chooses only three starts by reach, then path, leaving other roots out', () => {
    const files = ['a', 'b', 'c', 'z', 'x', 'y'].map(name => file(name));
    const edges = ['a', 'b', 'c', 'z'].map(name => edge(name, 'x'));
    edges.push(edge('z', 'y'));
    const result = readingOrder(files, edges, false);
    expect(READING_STARTS).toBe(3);
    expect(result.steps.filter(step => step.kind === 'start')).toEqual([
      { kind: 'start', fileId: 'z', reaches: 2 }, { kind: 'start', fileId: 'a', reaches: 1 }, { kind: 'start', fileId: 'b', reaches: 1 },
    ]);
    expect(result.steps.map(step => step.fileId)).toEqual(['z', 'a', 'b', 'x', 'y']);
    expect(result.total).toBe(5);
  });

  it('uses the nearest selected start even when a larger root is farther away', () => {
    const result = readingOrder(['a', 'b', 'c', 'd'].map(name => file(name)), [edge('a', 'c'), edge('c', 'd'), edge('b', 'd')], false);
    expect(result.steps).toEqual([
      { kind: 'start', fileId: 'a', reaches: 2 }, { kind: 'start', fileId: 'b', reaches: 1 },
      { kind: 'next', fileId: 'd', depth: 1, usedBy: 2 }, { kind: 'next', fileId: 'c', depth: 1, usedBy: 1 },
    ]);
  });

  it('removes support files and non-code from both ends before counting imports', () => {
    const excluded = ['src/a.test.ts', 'tests/helper.ts', 'test/helper.py', 'test_a.py', 'vite.config.ts', 'env.d.ts', 'style.css'];
    const files = [...excluded.map(name => file(name, name === 'style.css' ? 'not-code' : 'full')), file('start.ts'), file('shared.ts')];
    const edges = excluded.flatMap(name => [edge(name, 'start.ts'), edge(name, 'shared.ts'), edge('start.ts', name)]);
    expect(readingOrder(files, [...edges, edge('start.ts', 'shared.ts')], false)).toEqual({
      steps: [{ kind: 'start', fileId: 'start.ts', reaches: 1 }, { kind: 'next', fileId: 'shared.ts', depth: 1, usedBy: 1 }],
      total: 2, incomplete: false,
    });
  });

  it('ignores duplicate imports, self imports and either missing endpoint', () => {
    const files = ['a', 'b'].map(name => file(name));
    const edges = [edge('a', 'a'), edge('b', 'b'), edge('a', 'b'), edge('a', 'b'), edge('a', 'missing'), edge('missing', 'a')];
    expect(readingOrder(files, edges, false)).toEqual({ steps: [
      { kind: 'start', fileId: 'a', reaches: 1 }, { kind: 'next', fileId: 'b', depth: 1, usedBy: 1 },
    ], total: 2, incomplete: false });
  });

  it('visits a reachable cycle only once and gives no order for cycles without roots', () => {
    const files = ['a', 'b', 'c'].map(name => file(name));
    expect(readingOrder(files, [edge('a', 'b'), edge('b', 'c'), edge('c', 'b')], false)).toEqual({ steps: [
      { kind: 'start', fileId: 'a', reaches: 2 }, { kind: 'next', fileId: 'b', depth: 1, usedBy: 2 },
      { kind: 'next', fileId: 'c', depth: 2, usedBy: 1 },
    ], total: 3, incomplete: false });
    expect(readingOrder(files, [edge('a', 'b'), edge('b', 'a')], false)).toEqual({ steps: [], total: 0, incomplete: false });
    expect(readingOrder(files, [], false)).toEqual({ steps: [], total: 0, incomplete: false });
    expect(readingOrder([], [], false)).toEqual({ steps: [], total: 0, incomplete: false });
  });

  it('caps the steps at thirty but counts all forty files in a chain', () => {
    const files = Array.from({ length: 40 }, (_, index) => file(`${index}.ts`));
    const edges = files.slice(1).map((item, index) => edge(files[index].id, item.id));
    const result = readingOrder(files, edges, false);
    expect(READING_STEPS).toBe(30);
    expect(result.steps).toHaveLength(30);
    expect(result.total).toBe(40);
    expect(result.steps[0]).toEqual({ kind: 'start', fileId: '0.ts', reaches: 39 });
    expect(result.steps[29]).toEqual({ kind: 'next', fileId: '29.ts', depth: 29, usedBy: 1 });
  });

  it('is independent of input order, has no duplicates and only positive next counts', () => {
    const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(name => file(name));
    const edges = [edge('a', 'f'), edge('b', 'f'), edge('c', 'e'), edge('d', 'e'), edge('e', 'g'), edge('g', 'e'), edge('f', 'g')];
    const result = readingOrder(files, edges, false);
    expect(readingOrder(files.toReversed(), edges.toReversed(), false)).toEqual(result);
    expect(new Set(result.steps.map(step => step.fileId)).size).toBe(result.steps.length);
    for (const step of result.steps.filter(step => step.kind === 'next')) {
      expect(step.depth).toBeGreaterThanOrEqual(1);
      expect(step.usedBy).toBeGreaterThanOrEqual(1);
    }
  });

  it.each(['partial', 'failed', 'skipped'] as const)('reports %s support files even with no steps', checked => {
    const files = [file('tests/helper.ts', checked), file('a'), file('b')];
    expect(readingOrder(files, [], false)).toEqual({ steps: [], total: 0, incomplete: true });
    expect(readingOrder(files, [edge('a', 'b')], false).incomplete).toBe(true);
  });

  it.each([false, true])('reports linksCut=%s independently of file state and empty order', linksCut => {
    const files = [file('a'), file('b'), file('style.css', 'not-code')];
    expect(readingOrder(files, [], linksCut)).toEqual({ steps: [], total: 0, incomplete: linksCut });
    expect(readingOrder(files, [edge('a', 'b')], linksCut).incomplete).toBe(linksCut);
  });
});

it.each([
  'src/a.test.ts', 'src/a.spec.ts', 'src/a.e2e.ts', 'src/a-test.ts', 'src/__tests__/a.ts', 'e2e/a.ts', 'src/e2e/a.ts',
  'tests/helper.ts', 'test/helper.py', 'src/tests/helper.ts', 'pkg/test_a.py', 'pkg/a_test.py', 'conftest.py', 'pkg/conftest.py',
  'vite.config.ts', '.eslintrc.js', 'src/env.d.ts', 'src/env.d.mts', 'src/env.d.cts', 'src/env.D.TS',
])('excludes support file %s', name => expect(supportFile(name)).toBe(true));

it.each([
  'src/testing.ts', 'src/contest.py', 'src/latest/a.ts', 'src/config.ts', 'src/a.ts', 'pkg/test_a.ts', 'pkg/a_test.ts',
  'pkg/conftest.ts', 'pkg/test.py', 'tests.ts', 'src/tested/a.ts', 'vite.config.json', 'src/env.d.tsx',
])('keeps ordinary file %s', name => expect(supportFile(name)).toBe(false));
