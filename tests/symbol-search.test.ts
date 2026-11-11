import { describe, expect, it, vi } from 'vitest';
import type { MapFile, MapSymbol, ProjectMap, SourceView } from '../src/shared/contracts';
import { analyzeSource } from '../src/core/analysis/syntax';
import { findSymbol, searchSymbols, SYMBOL_HIT_LIMIT, symbolsIncomplete } from '../src/renderer/symbol-search';

const file = (id: string, relativePath: string): MapFile => ({ id, relativePath, folder: '', start: false, entry: false, checked: 'full', reason: null });
const symbol = (name: string, extra: Partial<MapSymbol> = {}): MapSymbol => ({ name, kind: 'function', fileId: 'a', fileHash: 'hash',
  startUtf16: 0, endUtf16: 15, startLine: 1, endLine: 1, ...extra });
const map: ProjectMap = { projectId: 'p', files: [file('a', 'a.ts'), file('b', 'b.py')], symbols: [], symbolsCut: false,
  edges: [], external: [], unresolved: [], complexFunctions: [], exports: [], limited: false, notes: [],
  unused: { candidates: [], unsure: [], excluded: [], notes: [], exports: { candidates: [], unsure: [], notes: [] } } };

it.each(['', ' \t\n '])('has no matches for empty query %j', query => {
  expect(searchSymbols({ ...map, symbols: [symbol('f')] }, query)).toEqual({ hits: [], total: 0 });
});

it.each([[' f ', 'f', 'function'], ['c', 'C', 'class']] as const)('puts a one-letter name first for %j', (query, name, kind) => {
  const exact = symbol(name, { kind });
  const result = searchSymbols({ ...map, symbols: [symbol(`${name}irst`), exact] }, query);
  expect(result.total).toBe(2);
  expect(result.hits[0].symbol).toBe(exact);
});

it.each(['a.b', '(', '*'])('matches %j literally and ignores case', query => {
  const item = symbol(`prefix${query.toUpperCase()}suffix`);
  expect(searchSymbols({ ...map, symbols: [symbol('axb'), item] }, query)).toEqual({ hits: [{ symbol: item, relativePath: 'a.ts' }], total: 1 });
});

it('sorts exact full or final names, prefixes, then substrings, with length, path and offset ties', () => {
  const names = ['xxfoo', 'C.fooz', 'fooz', 'Long.foo', 'foo'];
  const laterPath = symbol('foo', { fileId: 'b' });
  const laterOffset = symbol('foo', { startUtf16: 20 });
  const result = searchSymbols({ ...map, symbols: [laterPath, laterOffset, ...names.map(name => symbol(name))] }, 'FOO');
  expect(result.hits.map(hit => [hit.symbol.name, hit.relativePath, hit.symbol.startUtf16])).toEqual([
    ['foo', 'a.ts', 0], ['foo', 'a.ts', 20], ['foo', 'b.py', 0], ['Long.foo', 'a.ts', 0],
    ['fooz', 'a.ts', 0], ['C.fooz', 'a.ts', 0], ['xxfoo', 'a.ts', 0],
  ]);
});

it('counts all matches, returns only 50 and excludes missing files without mutating the map', () => {
  const source = { ...map, symbols: [symbol('f', { fileId: 'missing' }), ...Array.from({ length: 53 }, (_, i) => symbol('f', { startUtf16: i }))] };
  const before = structuredClone(source);
  const result = searchSymbols(source, 'f');
  expect(SYMBOL_HIT_LIMIT).toBe(50);
  expect(result.total).toBe(53);
  expect(result.hits).toHaveLength(50);
  expect(result.hits.at(-1)?.symbol.startUtf16).toBe(49);
  expect(source).toEqual(before);
});

it.each(['limited', 'symbolsCut'] as const)('says names may be missing when %s', flag => {
  expect(symbolsIncomplete({ ...map, [flag]: true })).toBe(true);
});
it.each(['partial', 'failed', 'skipped'] as const)('says names may be missing for a %s file', checked => {
  expect(symbolsIncomplete({ ...map, files: [{ ...map.files[0], checked }] })).toBe(true);
});
it.each(['full', 'not-code'] as const)('does not mark %s files as incomplete', checked => {
  expect(symbolsIncomplete({ ...map, files: [{ ...map.files[0], checked }] })).toBe(false);
});

describe('findSymbol', () => {
  const text = 'function f() {}';
  const source: SourceView = { projectId: 'p', fileId: 'a', hash: 'hash', relativePath: 'a.ts', text, guide: null,
    analysis: analyzeSource(text, 'a.ts', { projectId: 'p', fileId: 'a', fileHash: 'hash' }) };
  const item = symbol('f', { endUtf16: text.length });

  it.each([null, undefined])('drops an unreadable file (%s)', async value => {
    expect(await findSymbol(item, async () => value, () => 0)).toEqual({ status: 'dropped' });
  });

  it('drops the result when the revision changes while the file is being read, even with matching hash', async () => {
    let revision = 0;
    let finish!: (value: SourceView) => void;
    const read = vi.fn(() => new Promise<SourceView>(resolve => { finish = resolve; }));
    const pending = findSymbol(item, read, () => revision);
    expect(read).toHaveBeenCalledWith('a');
    revision++;
    finish(source);
    expect(await pending).toEqual({ status: 'dropped' });
  });

  it.each([{ hash: 'different' }, { fileId: 'b' }])('rejects a changed file %j before matching a range', async change => {
    expect(await findSymbol(item, async () => ({ ...source, ...change }), () => 0)).toEqual({ status: 'changed' });
  });

  it('returns the analyzer function only for the exact range', async () => {
    expect(await findSymbol(item, async () => source, () => 0)).toEqual({ status: 'function', symbol: source.analysis.symbols[0] });
    expect(await findSymbol({ ...item, endUtf16: item.endUtf16 - 1 }, async () => source, () => 0)).toEqual({ status: 'range' });
    expect(await findSymbol({ ...item, startUtf16: 1 }, async () => source, () => 0)).toEqual({ status: 'range' });
  });

  it('marks only the range for a class, even if a function happens to have the same range', async () => {
    expect(await findSymbol({ ...item, kind: 'class' }, async () => source, () => 0)).toEqual({ status: 'range' });
    expect(await findSymbol({ ...item, kind: 'class' }, async () => ({ ...source, hash: 'changed' }), () => 0)).toEqual({ status: 'changed' });
  });

  it('marks only the range of the 201st function, and still requires the original hash', async () => {
    const text = Array.from({ length: 201 }, (_, i) => `function f${i}() {}`).join('\n');
    const opened = { ...source, text, analysis: analyzeSource(text, 'a.ts', { projectId: 'p', fileId: 'a', fileHash: 'hash' }) };
    expect(opened.analysis.symbols).toHaveLength(200);
    const last = symbol('f200', { startUtf16: text.indexOf('function f200'), endUtf16: text.length, startLine: 201, endLine: 201 });
    expect(await findSymbol(last, async () => opened, () => 0)).toEqual({ status: 'range' });
    expect(await findSymbol(last, async () => ({ ...opened, hash: 'new' }), () => 0)).toEqual({ status: 'changed' });
  });
});
