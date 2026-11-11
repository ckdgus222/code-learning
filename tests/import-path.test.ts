import { describe, expect, it } from 'vitest';
import type { MapFile } from '../src/shared/contracts';
import type { MapLink } from '../src/renderer/map-layout';
import { importPath, pathGraph } from '../src/renderer/import-path';

const file = (id: string): MapFile => ({ id, relativePath: `${id}.ts`, folder: '', start: false, entry: false, checked: 'full', reason: null });
const link = (fromFileId: string, toFileId: string, guess?: string): MapLink => ({ fromFileId, toFileId, guess,
  names: [], fileHash: 'hash', startUtf16: 0, endUtf16: 10, startLine: 1, endLine: 1, text: `import '${toFileId}'`, specifier: toFileId });
const files = ['a', 'b', 'c', 'd', 'e'].map(file);
const find = (links: MapLink[], from = 'a', to = 'd') => importPath(pathGraph(files, links), from, to);

describe('import paths', () => {
  it('groups repeated imports in input order and returns the original files and evidence', () => {
    const links = [link('a', 'b'), { ...link('a', 'b'), startLine: 2 }];
    const result = find(links, 'a', 'b');
    expect(result).toEqual({ status: 'found', guessed: false, steps: [{ from: files[0], to: files[1], links }] });
    if (result.status !== 'found') throw new Error('Expected a path');
    expect(result.steps[0].from).toBe(files[0]);
    expect(result.steps[0].to).toBe(files[1]);
    expect(result.steps[0].links[0]).toBe(links[0]);
    expect(result.steps[0].links[1]).toBe(links[1]);
  });

  it('reconstructs three steps in forward order', () => {
    const links = [link('c', 'd'), link('b', 'c'), link('a', 'b')];
    expect(find(links)).toEqual({ status: 'found', guessed: false, steps: [
      { from: files[0], to: files[1], links: [links[2]] },
      { from: files[1], to: files[2], links: [links[1]] },
      { from: files[2], to: files[3], links: [links[0]] },
    ] });
  });

  it('takes two steps instead of an earlier three-step route', () => {
    const result = find([link('a', 'b'), link('b', 'c'), link('c', 'd'), link('a', 'e'), link('e', 'd')]);
    expect(result.status === 'found' && result.steps.map(step => step.to.id)).toEqual(['e', 'd']);
  });

  it.each([['b', 'c'], ['c', 'b']])('breaks equal-length ties by the first outgoing import (%s before %s)', (first, second) => {
    const links = [link('a', first), link('a', second), link(second, 'd'), link(first, 'd')];
    const graph = pathGraph(files, links);
    const result = importPath(graph, 'a', 'd');
    expect(result.status === 'found' && result.steps.map(step => step.to.id)).toEqual([first, 'd']);
    expect(importPath(graph, 'a', 'd')).toEqual(result);
  });

  it('only follows import direction and reports settled reverse paths', () => {
    expect(find([link('b', 'a')], 'a', 'b')).toEqual({ status: 'none', reverse: 'settled' });
    expect(find([link('b', 'a')])).toEqual({ status: 'none', reverse: null });
  });

  it.each(['a', 'missing'])('returns same before searching, including an unknown id (%s)', id => {
    expect(find([link('a', 'a'), link('a', 'b'), link('b', 'a')], id, id)).toEqual({ status: 'same' });
  });

  it('drops self imports, finishes cycles and still reaches a destination beyond the cycle', () => {
    const links = [link('a', 'a'), link('a', 'b'), link('b', 'a'), link('b', 'c'), link('c', 'b'), link('c', 'd')];
    const graph = pathGraph(files, links);
    expect(graph.outgoing.get('a')!.has('a')).toBe(false);
    const result = importPath(graph, 'a', 'd');
    expect(result.status === 'found' && result.steps.map(step => step.to.id)).toEqual(['b', 'c', 'd']);
    expect(importPath(graph, 'a', 'e')).toEqual({ status: 'none', reverse: null });
  });

  it('drops edges from and to missing files, including routes through them', () => {
    const graph = pathGraph(files, [link('a', 'missing'), link('missing', 'd')]);
    expect([...graph.outgoing.values()].every(neighbors => neighbors.size === 0)).toBe(true);
    for (const [from, to] of [['a', 'd'], ['a', 'missing'], ['missing', 'd'], ['missing', 'other']]) {
      expect(importPath(graph, from, to)).toEqual({ status: 'none', reverse: null });
    }
  });

  it('prefers a settled two-step path over a guessed shortcut', () => {
    const result = find([link('a', 'd', 'candidate'), link('a', 'b'), link('b', 'd')]);
    expect(result.status === 'found' && result.steps.map(step => step.to.id)).toEqual(['b', 'd']);
    expect(result).toMatchObject({ guessed: false });
  });

  it('marks a guessed-only path, including an empty reason', () => {
    const links = [link('a', 'd', '')];
    expect(find(links)).toEqual({ status: 'found', guessed: true, steps: [{ from: files[0], to: files[3], links }] });
  });

  it('marks only the guessed step of a mixed path', () => {
    const result = find([link('a', 'b'), link('b', 'd', 'candidate')]);
    expect(result).toMatchObject({ status: 'found', guessed: true });
    expect(result.status === 'found' && result.steps.map(step => step.links[0].guess)).toEqual([undefined, 'candidate']);
  });

  it('stably puts settled evidence first without changing neighbor order or mutating inputs', () => {
    const links = [link('a', 'b', 'first guess'), link('a', 'c'), link('a', 'b'),
      link('a', 'b', 'second guess'), { ...link('a', 'b'), startLine: 2 }, link('b', 'd'), link('c', 'd')];
    const original = [...links];
    const result = find(links);
    expect(result).toMatchObject({ status: 'found', guessed: false });
    if (result.status !== 'found') throw new Error('Expected a path');
    expect(result.steps.map(step => step.to.id)).toEqual(['b', 'd']);
    expect(result.steps[0].links).toEqual([links[2], links[4], links[0], links[3]]);
    expect(result.steps.every(step => step.links[0].guess === undefined)).toBe(true);
    expect(links).toEqual(original);
  });

  it('reports guessed reverse paths but prefers a longer settled reverse path', () => {
    expect(find([link('d', 'a', 'candidate')])).toEqual({ status: 'none', reverse: 'guessed' });
    expect(find([link('d', 'b'), link('b', 'a', 'candidate')])).toEqual({ status: 'none', reverse: 'guessed' });
    expect(find([link('d', 'a', 'candidate'), link('d', 'b'), link('b', 'a')])).toEqual({ status: 'none', reverse: 'settled' });
  });

  it('chooses the shortest full-graph route when every route needs a guess', () => {
    const result = find([link('a', 'b', 'candidate'), link('b', 'c'), link('c', 'd'), link('a', 'e', 'candidate'), link('e', 'd', 'candidate')]);
    expect(result.status === 'found' && result.steps.map(step => step.to.id)).toEqual(['e', 'd']);
    expect(result).toMatchObject({ guessed: true });
  });

  it('returns 999 ordered steps without recursion for a thousand-file chain', () => {
    const chain = Array.from({ length: 1000 }, (_, i) => file(String(i)));
    const links = chain.slice(1).map((target, i) => link(String(i), target.id));
    const result = importPath(pathGraph(chain, links), '0', '999');
    expect(result).toMatchObject({ status: 'found', guessed: false });
    if (result.status !== 'found') throw new Error('Expected a path');
    expect(result.steps).toHaveLength(999);
    expect(result.steps.map(step => [step.from.id, step.to.id])).toEqual(links.map(item => [item.fromFileId, item.toFileId]));
  });
});
