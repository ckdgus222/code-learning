import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { scanProject, readAllowed } from '../src/core/project/files';
import { analyzeSource } from '../src/core/analysis/syntax';
import { findFunctionCalls } from '../src/core/analysis/calls';
import { MAP_LIMITS } from '../src/core/analysis/project-map';
import { pythonArgumentAt } from '../src/renderer/python-arguments';
let root: string;
beforeEach(async () => { root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-python-arguments-'))); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function inspect(text: string, name = 'target') {
  await writeFile(path.join(root, 'main.py'), text);
  const project = await scanProject(root, randomUUID());
  const file = project.files[0];
  const source = await readAllowed(root, 'main.py');
  const symbol = analyzeSource(text, 'main.py', { projectId: project.id, fileId: file.id, fileHash: source.hash }).symbols.find(symbol => symbol.name === name)!;
  expect(symbol).toBeDefined();
  return findFunctionCalls(root, project.id, project.files, { fileId: file.id, fileHash: source.hash,
    startUtf16: symbol.evidence.startUtf16, endUtf16: symbol.evidence.endUtf16 }, MAP_LIMITS);
}

describe('Python argument metadata through the analysis API', () => {
  it('classifies slash, ordinary, typed rest and keyword-only parameters', async () => {
    const result = await inspect('def target(a: int, /, b: str = "x", *args: float, flag: bool = True, **kwargs: str):\n    return a\n');
    expect(result.values.filter(value => value.group === 'parameter').map(value => [value.name, value.parameterKind, value.index])).toEqual([
      ['a', 'positional-only', 0], ['b', 'positional-or-keyword', 1], ['args', 'var-positional', null], ['flag', 'keyword-only', null], ['kwargs', 'var-keyword', null],
    ]);
    expect(result.values.find(value => value.name === 'b')).toMatchObject({ type: 'str', initial: { kind: 'default', text: '"x"' } });
    expect(result.values.find(value => value.name === 'args')).toMatchObject({ type: 'float', shape: 'rest' });
  });
  it('classifies a bare star without giving keyword-only parameters positional indexes', async () => {
    const result = await inspect('def target(a, *, required, optional=1):\n    return a\n');
    expect(result.values.map(value => [value.name, value.parameterKind, value.index])).toEqual([
      ['a', 'positional-or-keyword', 0], ['required', 'keyword-only', null], ['optional', 'keyword-only', null],
    ]);
  });
  it('keeps source spellings for NFKC-equivalent parameter and keyword names', async () => {
    const result = await inspect('def target(ｘ):\n    return ｘ\ndef caller():\n    target(x=SOURCE)\n');
    expect(result.values[0]).toMatchObject({ name: 'ｘ', parameterKind: 'positional-or-keyword', index: 0 });
    expect(result.callers?.[0].args).toEqual([{ text: 'SOURCE', spread: false, keyword: 'x' }]);
  });
  it('does not attach own input mapping to enclosing parameters', async () => {
    const result = await inspect('def outer(limit: int = 1):\n    def target(step):\n        return limit + step\n    return target\n');
    expect(result.values.find(value => value.name === 'step')).toMatchObject({ parameterKind: 'positional-or-keyword', index: 0 });
    const outer = result.values.find(value => value.name === 'limit')!;
    expect(outer.parameterKind).toBeUndefined();
    expect(outer.index).toBeNull();
  });
  it.each([
    ['duplicate', 'a, a'],
    ['normalized duplicate', 'x, ｘ'],
    ['default order', 'a=1, b'],
    ['bare star without keyword parameters', 'a, *'],
  ])('omits classification for the whole malformed %s signature', async (_, signature) => {
    const result = await inspect(`def target(${signature}):\n    pass\n`);
    const parameters = result.values.filter(value => value.group === 'parameter');
    expect(parameters.length).toBeGreaterThan(0);
    expect(parameters.every(value => value.parameterKind === undefined && value.index === null)).toBe(true);
  });
  it('does not publish input correspondence for private class parameters', async () => {
    const result = await inspect('class C:\n    def target(self, __secret):\n        return __secret\n', 'C.target');
    expect(result.values.filter(value => value.group === 'parameter').every(value => value.parameterKind === undefined && value.index === null)).toBe(true);
  });
  it('does not publish input correspondence from an incomplete file', async () => {
    const result = await inspect('def target(a):\n    return a\n@@@\n');
    expect(result.values[0].parameterKind).toBeUndefined();
    expect(result.values[0].index).toBeNull();
  });
  it('retains keyword names separately from their written value expressions', async () => {
    const result = await inspect('def target(a, b, *, c):\n    return a\ndef caller():\n    target(SOURCE, b=2 + 3, c=helper())\n');
    expect(result.callers?.[0].args).toEqual([
      { text: 'SOURCE', spread: false }, { text: '2 + 3', spread: false, keyword: 'b' }, { text: 'helper()', spread: false, keyword: 'c' },
    ]);
  });
  it.each(['*items', '**options', 'x for x in items'])('keeps unsupported call argument form %s unresolved', async expression => {
    const result = await inspect(`def target(a):\n    return a\ndef caller():\n    target(${expression})\n`);
    expect(result.callers).toHaveLength(1);
    expect(result.callers![0].args).toBeNull();
  });
  it('keeps an empty argument list distinguishable from unknown syntax', async () => {
    const result = await inspect('def target(a=1):\n    return a\ndef caller():\n    target()\n');
    expect(result.callers?.[0].args).toEqual([]);
  });
  it.each(['__debug__', '__ｄｅｂｕｇ__'])('withholds correspondence for the reserved parameter %s', async name => {
    const result = await inspect(`def target(${name}, b=2):\n    return b\ndef caller():\n    target(1)\n`);
    const parameters = result.values.filter(value => value.group === 'parameter');
    expect(parameters).toHaveLength(2);
    expect(parameters.every(value => value.parameterKind === undefined && value.index === null)).toBe(true);
    expect(result.callers).toHaveLength(1);
    for (const value of parameters) expect(pythonArgumentAt(result.callers![0], value, parameters, false).kind).toBe('unknown');
  });
  it.each(['__debug__', '__ｄｅｂｕｇ__'])('withholds defaults for the reserved keyword %s', async name => {
    const result = await inspect(`def target(a=5, **kwargs):\n    return a\ndef caller():\n    target(${name}=1)\n`);
    expect(result.callers).toHaveLength(1);
    expect(result.callers![0].args).toBeNull();
    const parameters = result.values.filter(value => value.group === 'parameter');
    expect(pythonArgumentAt(result.callers![0], parameters[0], parameters, false).kind).toBe('unknown');
  });
});
