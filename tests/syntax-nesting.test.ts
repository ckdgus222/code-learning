import { describe, expect, it } from 'vitest';
import type Parser from 'tree-sitter';
import { analyzeSource, NESTED_NOTE, NESTING_FREE, NESTING_LIMIT, parse, parseTree } from '../src/core/analysis/syntax';
import { readFacts } from '../src/core/analysis/names';
import { describeFile } from '../src/core/analysis/file-guide';
import { splitFileChunks } from '../src/core/analysis/file-chunks';
import { AppError } from '../src/shared/errors';
import { deepSources } from './nesting-fixture';

const context = { projectId: 'project', fileId: 'file', fileHash: 'hash' };
const array = (depth: number) => `${'['.repeat(depth)}0${']'.repeat(depth)}`;

// An independent stack walk includes punctuation as well as named nodes.
function weightOf(root: Parser.SyntaxNode) {
  const pending = [{ node: root, depth: 0 }];
  let weight = 0;
  let deepest = 0;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    weight += Math.max(0, depth - NESTING_FREE);
    deepest = Math.max(deepest, depth);
    for (const child of node.children) pending.push({ node: child, depth: depth + 1 });
  }
  return { weight, deepest };
}

describe('syntax nesting weight', () => {
  it.each([
    ['empty', 'x.ts', ''],
    ['TypeScript', 'x.ts', 'export function total(a: number) { return a + 1; }'],
    ['TSX', 'x.tsx', 'export const View = () => <div><span>Hello</span></div>;'],
    ['Python', 'x.py', 'import os\ndef total(a):\n    return a + 1\n'],
    ['300 additions', 'x.ts', Array(300).fill('a').join(' + ')],
    ['1000 additions', 'x.ts', Array(1000).fill('a').join(' + ')],
    ['100 chained methods', 'x.ts', `a${'.method()'.repeat(100)}`],
    ['3000 functions', 'x.ts', Array.from({ length: 3000 }, (_, i) => `function f${i}() { return ${i}; }`).join('\n')],
    ['300000 array values', 'x.ts', `[${Array(300_000).fill('0').join(',')}]`],
    ['2000 shallow arrays', 'x.ts', `${array(60)};`.repeat(2000)],
    ['syntax error', 'x.ts', 'function broken( {'],
  ])('accepts %s', (_name, path, text) => {
    expect(parse(text, path)).not.toBeNull();
  }, 30_000);

  it.each(deepSources)('skips structure analysis of %s', (_name, extension, text) => {
    const path = `x.${extension}`;
    expect(parse(text, path)).toBeNull();
    const analysis = analyzeSource(text, path, context);
    expect(analysis.symbols).toEqual([]);
    expect(analysis.imports).toEqual([]);
    expect(analysis.classes ?? []).toEqual([]);
    expect(analysis.warnings).toContain(NESTED_NOTE);
    expect(analysis.warnings.some(note => note.includes('분석할 수 있는 함수가 없습니다'))).toBe(false);
    const facts = readFacts({ id: 'file', relativePath: path, size: text.length }, text, 'hash', 200_000, true);
    expect(facts).toMatchObject({ complete: false, incompleteReason: NESTED_NOTE, functions: [], calls: [], references: [], variables: [] });
    expect(facts.exports.size).toBe(0);
    if (path.endsWith('.py')) return;
    expect(() => describeFile(text, path, 'file', 'hash', analysis, [])).toThrowError(new AppError('LIMIT', NESTED_NOTE));
    expect(() => splitFileChunks(text, path, 'file', 'hash')).toThrowError(new AppError('LIMIT', NESTED_NOTE));
  }, 30_000);

  it('accepts the last array depth within the weight limit and rejects the next depth', () => {
    let low = 1;
    let high = 5000;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      const { weight } = weightOf(parseTree(array(middle), 'x.ts'));
      if (weight <= NESTING_LIMIT) low = middle;
      else high = middle;
    }
    expect(weightOf(parseTree(array(low), 'x.ts')).weight).toBeLessThanOrEqual(NESTING_LIMIT);
    expect(weightOf(parseTree(array(high), 'x.ts')).weight).toBeGreaterThan(NESTING_LIMIT);
    expect(parse(array(low), 'x.ts')).not.toBeNull();
    expect(parse(array(high), 'x.ts')).toBeNull();
  }, 30_000);

  it('accepts a weight exactly at the limit and rejects any more', () => {
    // 1,999,305 for the deep array, 3 for each 63-deep array and 2 for each run of 63 negations.
    const negations = `${'!'.repeat(63)}0;`;
    const atLimit = `${array(1216)};${`${array(63)};`.repeat(231)}${negations}`;
    expect(weightOf(parseTree(atLimit, 'x.ts')).weight).toBe(NESTING_LIMIT);
    expect(parse(atLimit, 'x.ts')).not.toBeNull();
    expect(parse(atLimit + negations, 'x.ts')).toBeNull();
  });

  it('adds no weight at exactly the free depth', () => {
    const text = array(NESTING_FREE - 2);
    expect(weightOf(parseTree(text, 'x.ts'))).toEqual({ weight: 0, deepest: NESTING_FREE });
    expect(parse(`${text};`.repeat(2000), 'x.ts')).not.toBeNull();
  }, 30_000);

  it('adds weight across separate branches', () => {
    const text = array(1000);
    expect(parse(text, 'x.ts')).not.toBeNull();
    expect(parse(`${text};${text};`, 'x.ts')).toBeNull();
  });

  it('exposes an unchecked tree for a walk with its own depth limit', () => {
    const text = array(5000);
    expect(parseTree(text, 'x.ts').hasError).toBe(false);
    expect(parseTree(text, 'x.py').hasError).toBe(false);
  });
});
