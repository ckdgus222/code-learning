import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { scanProject, readAllowed } from '../src/core/project/files';
import { analyzeSource } from '../src/core/analysis/syntax';
import { findFunctionCalls, type CallsCache } from '../src/core/analysis/calls';
import { MAP_LIMITS } from '../src/core/analysis/project-map';
import type { FunctionCalls, NameValue, ProjectFiles, ValueSite } from '../src/shared/contracts';

let root: string;
let project: ProjectFiles;
let text: string;
beforeEach(async () => { root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-python-values-'))); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function prepare(source: string) {
  text = source;
  await writeFile(path.join(root, 'main.py'), text);
  project = await scanProject(root, randomUUID());
}
async function targetOf(name = 'run') {
  const file = project.files.find(file => file.relativePath === 'main.py')!;
  const { text: source, hash } = await readAllowed(root, 'main.py');
  const symbol = analyzeSource(source, 'main.py', { projectId: project.id, fileId: file.id, fileHash: hash }).symbols.find(item => item.name === name);
  expect(symbol, name).toBeDefined();
  return { fileId: file.id, fileHash: hash, startUtf16: symbol!.evidence.startUtf16, endUtf16: symbol!.evidence.endUtf16 };
}
async function search(name = 'run', limits = MAP_LIMITS, shouldStop?: () => boolean) {
  return findFunctionCalls(root, project.id, project.files, await targetOf(name), limits, shouldStop);
}
function named(result: FunctionCalls, name: string, group?: NameValue['group']): NameValue {
  const values = result.values.filter(value => value.name.normalize('NFKC') === name.normalize('NFKC') && (!group || value.group === group));
  expect(values, `${group ?? 'any'} ${name}`).toHaveLength(1);
  return values[0];
}
const writes = (value: NameValue) => value.assignments.map(site => site.text);
function checkSite(site: ValueSite, result: FunctionCalls) {
  expect(site.fileId).toBe(result.fileId);
  expect(site.fileHash).toBe(result.fileHash);
  expect(text.slice(site.startUtf16, site.endUtf16).split('\n')[0]).toBe(site.text);
  expect(text.slice(0, site.startUtf16).split('\n').length).toBe(site.startLine);
}
const resultSize = (result: FunctionCalls) => [result.calls, result.callers ?? [], result.typedCallers, result.maybeCallers, result.values]
  .flat().reduce((sum, row) => sum + JSON.stringify(row).length, 0);

describe('Python values written in the chosen function', () => {
  it('lists annotated, default, keyword-only and rest parameters without incoming argument indexes', async () => {
    await prepare('def run(first: int, /, label: str = "hello", *args: float, enabled: bool = True, **kwargs: str):\n    return first\n');
    const result = await search();
    expect(result.values.filter(value => value.group === 'parameter').map(value => value.name)).toEqual(['first', 'label', 'args', 'enabled', 'kwargs']);
    expect(named(result, 'first')).toMatchObject({ role: 'parameter', type: 'int', index: null, initial: null, fixed: null });
    expect(named(result, 'label')).toMatchObject({ type: 'str', initial: { kind: 'default', text: '"hello"' } });
    expect(named(result, 'enabled')).toMatchObject({ type: 'bool', initial: { kind: 'default', text: 'True' } });
    for (const name of ['args', 'kwargs']) expect(named(result, name)).toMatchObject({ shape: 'rest', role: 'parameter', index: null });
    expect(result.values.every(value => value.index === null && value.fixed === null)).toBe(true);
  });

  it('groups repeated assignments into one card and preserves their source order', async () => {
    await prepare('def run():\n    x = 1\n    x = 2\n    x += 3\n    return x\n');
    const x = named(await search(), 'x');
    expect(x).toMatchObject({ group: 'inside', role: 'assignment', initial: { kind: 'value', text: '1' }, unknown: null, fixed: null });
    expect(writes(x)).toEqual(['x = 2', 'x += 3']);
  });

  it('groups NFKC-equivalent spellings in the same scope', async () => {
    await prepare('def run():\n    ｘ = 1\n    x = 2\n    return ｘ\n');
    const x = named(await search(), 'x');
    expect(x.initial?.text).toBe('1');
    expect(writes(x)).toEqual(['x = 2']);
    expect(x.unknown).toBeNull();
  });

  it('shows expressions as written without calculating or treating uppercase names as fixed', async () => {
    await prepare('TOTAL: Final[int] = 2 + 3\ndef run():\n    answer = TOTAL * 2\n    return answer\n');
    const result = await search();
    expect(named(result, 'TOTAL')).toMatchObject({ group: 'outside', type: 'Final[int]', fixed: null, initial: { text: '2 + 3' } });
    expect(named(result, 'answer')).toMatchObject({ fixed: null, initial: { text: 'TOTAL * 2' } });
  });

  it('retains the first unconditional expression and annotates later conditional writes', async () => {
    await prepare('def run(flag):\n    x = 1\n    if flag:\n        x = 2\n    return x\n');
    const x = named(await search(), 'x');
    expect(x.initial?.text).toBe('1');
    expect(writes(x)).toEqual(['x = 2']);
    expect(x.notes.length).toBeGreaterThan(0);
  });

  it.each([
    ['conditional first write', '    if flag:\n        x = 1', 'x = 1'],
    ['augmented first write', '    x += 1', 'x += 1'],
    ['loop first write', '    for item in items:\n        x = item', 'x = item'],
  ])('does not present a %s as an initial value', async (_, body, written) => {
    await prepare(`def run(flag, items):\n${body}\n    return x\n`);
    const x = named(await search(), 'x');
    expect(x.initial).toBeNull();
    expect(writes(x)).toContain(written);
    expect(x.notes.length).toBeGreaterThan(0);
  });

  it('keeps annotation-only locals without inventing a value or an outside name', async () => {
    await prepare('x = 99\ndef run():\n    x: int\n    return x\n');
    const result = await search();
    expect(named(result, 'x')).toMatchObject({ group: 'inside', type: 'int', initial: null, fixed: null });
    expect(result.values.some(value => value.group === 'outside' && value.name === 'x')).toBe(false);
  });

  it('finds only the module values actually used by the chosen function', async () => {
    await prepare('rate = 10\nunused = 20\ndef run():\n    return rate\n');
    const result = await search();
    expect(named(result, 'rate')).toMatchObject({ group: 'outside', role: 'assignment', initial: { text: '10' }, fixed: null });
    expect(result.values.some(value => value.name === 'unused')).toBe(false);
  });

  it('identifies enclosing parameters with the enclosing function evidence', async () => {
    await prepare('def outer(limit: int = 10):\n    def run(step: int):\n        return limit + step\n    return run\n');
    const outer = await targetOf('outer');
    const result = await search();
    expect(named(result, 'limit')).toMatchObject({ group: 'outside', role: 'parameter', type: 'int', index: null,
      initial: { kind: 'default', text: '10' }, outerFunction: { ...outer, name: 'outer' } });
    expect(named(result, 'step')).toMatchObject({ group: 'parameter', type: 'int', index: null, outerFunction: null });
  });

  it('keeps loop bindings as loop source text rather than an item value', async () => {
    await prepare('def run(items):\n    for item in items:\n        pass\n    return item\n');
    const item = named(await search(), 'item');
    expect(item).toMatchObject({ group: 'inside', role: 'for', fixed: null, initial: null });
    expect(writes(item).some(value => value.includes('for item in items'))).toBe(true);
    expect(item.notes.length).toBeGreaterThan(0);
  });

  it('keeps destructuring as the written pattern without extracting element values', async () => {
    await prepare('def run(pair):\n    left, right = pair\n    return left + right\n');
    const result = await search();
    for (const name of ['left', 'right']) {
      expect(named(result, name)).toMatchObject({ group: 'inside', shape: 'destructured', fixed: null, initial: { kind: 'pattern' } });
      expect(named(result, name).initial?.text).toContain('left, right = pair');
    }
  });

  it('does not pretend a context manager expression is the value returned by entering it', async () => {
    await prepare('def run(manager):\n    with manager() as resource:\n        pass\n    return resource\n');
    const resource = named(await search(), 'resource');
    expect(resource).toMatchObject({ group: 'inside', initial: null, fixed: null });
    expect(resource.notes.length).toBeGreaterThan(0);
  });

  it('marks exception bindings with their lifetime limitation', async () => {
    await prepare('def run():\n    try:\n        pass\n    except Exception as error:\n        pass\n    return error\n');
    const error = named(await search(), 'error');
    expect(error).toMatchObject({ group: 'inside', role: 'catch', initial: null, fixed: null });
    expect(error.notes.length).toBeGreaterThan(0);
  });

  it('retains deletion after a written value instead of presenting the name as fixed', async () => {
    await prepare('def run():\n    x = 1\n    del x\n    return x\n');
    const x = named(await search(), 'x');
    expect(x.initial?.text).toBe('1');
    expect(writes(x)).not.toContain('del x');
    expect(x.notes.join(' ')).toContain('del x');
    expect(x.fixed).toBeNull();
  });

  it('does not turn annotation, default, attribute or keyword names into outside body references', async () => {
    await prepare('TYPE = 1\nDEFAULT = 2\nRESULT = 3\nattribute = 4\nkeyword = 5\ndef run(obj: TYPE = DEFAULT) -> RESULT:\n    sink(keyword=obj.attribute)\n');
    const result = await search();
    expect(named(result, 'obj')).toMatchObject({ type: 'TYPE', initial: { kind: 'default', text: 'DEFAULT' } });
    expect(result.values.filter(value => value.group === 'outside').map(value => value.name))
      .not.toEqual(expect.arrayContaining(['TYPE']));
    for (const name of ['TYPE', 'DEFAULT', 'RESULT', 'attribute', 'keyword']) expect(result.values.some(value => value.group === 'outside' && value.name === name)).toBe(false);
  });

  it('does not collect annotation expressions as body calls', async () => {
    await prepare('def helper():\n    return int\ndef run():\n    value: helper() = 1\n    return value\n');
    const result = await search();
    expect(result.calls).toEqual([]);
    expect(named(result, 'value')).toMatchObject({ type: 'helper()', initial: { text: '1' } });
  });

  it('does not collect lambda or nested-function body references into the chosen function', async () => {
    await prepare('HIDDEN = 1\nREMOTE = 2\ndef run():\n    callback = lambda: HIDDEN\n    def inner():\n        return REMOTE\n    return callback\n');
    const result = await search();
    expect(named(result, 'callback')).toMatchObject({ group: 'inside' });
    expect(result.values.filter(value => value.group === 'outside').map(value => value.name)).not.toEqual(expect.arrayContaining(['HIDDEN']));
    expect(result.values.some(value => ['HIDDEN', 'REMOTE'].includes(value.name))).toBe(false);
  });

  it('keeps comprehension bindings separate and reads the first iterable from the enclosing scope', async () => {
    await prepare('items = [1, 2]\ndef run():\n    rows = [items for items in items]\n    return rows\n');
    const result = await search();
    expect(named(result, 'items', 'outside')).toMatchObject({ initial: { text: '[1, 2]' } });
    expect(named(result, 'items', 'inside')).toMatchObject({ role: 'for', fixed: null });
    expect(result.values.filter(value => value.name === 'items')).toHaveLength(2);
  });

  it('binds comprehension named expressions in the enclosing function without inventing initialization', async () => {
    await prepare('found = 99\ndef run(items):\n    rows = [(found := item) for item in items]\n    return found\n');
    const result = await search();
    const found = named(result, 'found');
    expect(found).toMatchObject({ group: 'inside', initial: null, fixed: null });
    expect(writes(found).some(value => value.includes('found := item'))).toBe(true);
    expect(found.notes.length).toBeGreaterThan(0);
  });

  it('keeps own metadata when a global name cannot be resolved', async () => {
    await prepare('shared = 10\ndef run(p: int = 1):\n    global shared\n    local = 3\n    shared = 20\n    return p + local + shared\n');
    const result = await search();
    expect(named(result, 'shared').unknown).toBeTruthy();
    expect(named(result, 'shared').initial).toBeNull();
    expect(named(result, 'p')).toMatchObject({ group: 'parameter', type: 'int', initial: { text: '1' } });
    expect(named(result, 'local')).toMatchObject({ group: 'inside', initial: { text: '3' }, unknown: null });
  });

  it('keeps own metadata when a nonlocal name cannot be resolved', async () => {
    await prepare('def outer():\n    shared = 10\n    def run(p: int = 1):\n        nonlocal shared\n        local = 3\n        shared = 20\n        return p + local + shared\n    return run\n');
    const result = await search();
    expect(named(result, 'shared').unknown).toBeTruthy();
    expect(named(result, 'shared').initial).toBeNull();
    expect(named(result, 'p')).toMatchObject({ type: 'int', initial: { text: '1' } });
    expect(named(result, 'local')).toMatchObject({ initial: { text: '3' }, unknown: null });
  });

  it.each(['exec("shared = 2")\n', '@@@\n'])('withholds outside origins but retains written parameter metadata in an unclear file: %j', async extra => {
    await prepare(`shared = 1\ndef run(p: int = 3):\n    return shared + p\n${extra}`);
    const result = await search();
    expect(named(result, 'shared').unknown).toBeTruthy();
    expect(named(result, 'shared').initial).toBeNull();
    expect(named(result, 'p')).toMatchObject({ group: 'parameter', type: 'int', initial: { text: '3' }, fixed: null });
    expect(named(result, 'p').notes.length).toBeGreaterThan(0);
  });

  it('reports imported value origins as unsupported instead of inventing their initial value', async () => {
    await prepare('from elsewhere import LIMIT\ndef run():\n    return LIMIT\n');
    const value = named(await search(), 'LIMIT');
    expect(value).toMatchObject({ group: 'outside', role: 'import', initial: null, fixed: null });
    expect(value.unknown || value.notes.join(' ')).toBeTruthy();
  });

  it('keeps every displayed source range tied to the selected file hash and leaves the source unchanged', async () => {
    await prepare('offset = 4\ndef run(p: int = 1):\n    value: int = p + offset\n    value = value + 1\n    return value\n');
    const result = await search();
    expect(result.values.length).toBeGreaterThan(0);
    for (const value of result.values) {
      if (value.declaredAt) checkSite(value.declaredAt, result);
      if (value.initial) checkSite(value.initial, result);
      for (const site of value.assignments) checkSite(site, result);
    }
    expect(await readFile(path.join(root, 'main.py'), 'utf8')).toBe(text);
    const target = await targetOf();
    await expect(findFunctionCalls(root, project.id, project.files, { ...target, fileHash: '0'.repeat(64) }, MAP_LIMITS)).rejects.toMatchObject({ code: 'CHANGED' });
    await expect(findFunctionCalls(root, project.id, project.files, { ...target, endUtf16: target.endUtf16 - 1 }, MAP_LIMITS)).rejects.toMatchObject({ code: 'CHANGED' });
  });

  it('counts value cards against the shared result budget instead of returning an unbounded extra list', async () => {
    await prepare('def helper():\n    pass\ndef run(p):\n    x = 1\n    helper()\n    return p + x\n');
    const full = await search();
    expect(full.values.length).toBeGreaterThan(0);
    expect(full.calls).toHaveLength(1);
    const budget = resultSize(full) - 1;
    const limited = await search('run', { ...MAP_LIMITS, results: budget });
    expect(limited.limited).toBe(true);
    expect(resultSize(limited)).toBeLessThanOrEqual(budget);
    expect(limited.notes.some(note => note.includes('한도'))).toBe(true);
  });

  it('honors cancellation while inspecting a function that has value metadata', async () => {
    await prepare('def run(p: int):\n    x = p + 1\n    return x\n');
    await expect(search('run', MAP_LIMITS, () => true)).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it.each([
    'shared = 10\ndef run():\n    global shared\n    return shared\n',
    'def outer():\n    shared = 10\n    def run():\n        nonlocal shared\n        return shared\n    return run\n',
  ])('does not resolve a global or nonlocal read merely because it has no assignment: %j', async source => {
    await prepare(source);
    const shared = named(await search(), 'shared');
    expect(shared.unknown).toBeTruthy();
    expect(shared.initial).toBeNull();
    expect(shared.fixed).toBeNull();
  });

  it('upgrades cached Python facts when a previously inspected file becomes the selected function', async () => {
    await prepare('def run(p: int = 3):\n    value = p + 1\n    return value\n');
    await writeFile(path.join(root, 'other.py'), 'def other():\n    pass\n');
    project = await scanProject(root, project.id);
    const other = project.files.find(file => file.relativePath === 'other.py')!;
    const source = await readAllowed(root, other.relativePath);
    const symbol = analyzeSource(source.text, other.relativePath, { projectId: project.id, fileId: other.id, fileHash: source.hash }).symbols[0];
    const cache: CallsCache = { texts: new Map(), parsed: new Map() };
    await findFunctionCalls(root, project.id, project.files, { fileId: other.id, fileHash: source.hash,
      startUtf16: symbol.evidence.startUtf16, endUtf16: symbol.evidence.endUtf16 }, MAP_LIMITS, undefined, cache);
    const target = await targetOf();
    const cached = await findFunctionCalls(root, project.id, project.files, target, MAP_LIMITS, undefined, cache);
    const fresh = await search();
    expect(named(cached, 'p')).toMatchObject({ type: 'int', initial: { text: '3' } });
    expect(named(cached, 'value')).toMatchObject({ initial: { text: 'p + 1' } });
    expect(cached.values).toEqual(fresh.values);
  });

  it.each([
    ['boolean short-circuit', 'flag and (x := 1)', 'x := 1'],
    ['conditional expression', 'y = (x := 1) if flag else 2', 'x := 1'],
    ['chained comparison', '0 > 1 > (x := 2)', 'x := 2'],
  ])('does not invent an unconditional initial value for a %s assignment', async (_, expression, assignment) => {
    await prepare(`def run(flag):\n    ${expression}\n    return x\n`);
    const x = named(await search(), 'x');
    expect(x).toMatchObject({ group: 'inside', initial: null, fixed: null });
    expect(writes(x).some(written => written.includes(assignment))).toBe(true);
    expect(x.notes.length).toBeGreaterThan(0);
  });

  it('does not link a class-private reference to an unrelated module declaration', async () => {
    await prepare('__secret: int = 99\n__secret = 100\nclass C:\n    def run(self):\n        return __secret\n');
    const value = named(await search('C.run'), '__secret');
    expect(value.unknown).toBeTruthy();
    expect(value).toMatchObject({ declaredAt: null, type: null, initial: null, assignments: [], fixed: null });
    expect(await readFile(path.join(root, 'main.py'), 'utf8')).toBe(text);
  });

  it('retains the written declaration of a class-private parameter without claiming a runtime value', async () => {
    await prepare('class C:\n    def run(self, __secret: int = 3):\n        return __secret\n');
    const result = await search('C.run');
    const value = named(result, '__secret', 'parameter');
    expect(value.declaredAt).not.toBeNull();
    checkSite(value.declaredAt!, result);
    expect(value.declaredAt?.text).toBe('__secret');
    expect(value.fixed).toBeNull();
    expect(await readFile(path.join(root, 'main.py'), 'utf8')).toBe(text);
  });
});
