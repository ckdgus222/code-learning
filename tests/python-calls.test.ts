import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { scanProject, readAllowed } from '../src/core/project/files';
import { analyzeSource } from '../src/core/analysis/syntax';
import { findFunctionCalls } from '../src/core/analysis/calls';
import { MAP_LIMITS } from '../src/core/analysis/project-map';
import type { CallLink, ProjectFiles } from '../src/shared/contracts';

let root: string;
let project: ProjectFiles;
beforeEach(async () => { root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-python-calls-'))); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function prepare(sources: Record<string, string>) {
  for (const [relative, text] of Object.entries(sources)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text);
  }
  project = await scanProject(root, randomUUID());
}
async function targetOf(name: string, relative = 'main.py') {
  const file = project.files.find(item => item.relativePath === relative)!;
  const { text, hash } = await readAllowed(root, relative);
  const symbol = analyzeSource(text, relative, { projectId: project.id, fileId: file.id, fileHash: hash })
    .symbols.find(item => item.name === name);
  expect(symbol, `${relative}: ${name}`).toBeDefined();
  return { fileId: file.id, fileHash: hash, startUtf16: symbol!.evidence.startUtf16, endUtf16: symbol!.evidence.endUtf16 };
}
async function callsOf(name: string, limits = MAP_LIMITS, shouldStop?: () => boolean) {
  return findFunctionCalls(root, project.id, project.files, await targetOf(name), limits, shouldStop);
}
function expectUnknown(call: CallLink | undefined) {
  expect(call).toBeDefined();
  expect(call?.status).toBe('unknown');
  if (call?.status === 'unknown') expect(call.reason.length).toBeGreaterThan(0);
}

describe('Python function calls', () => {
  it('links direct calls and reverse callers with matching evidence, without value inference', async () => {
    await prepare({ 'main.py': 'async def run():\n    return helper(7)\n\ndef helper(value):\n    return value\n\nrun()\n' });
    const helper = await targetOf('helper');
    const run = await callsOf('run');
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]).toMatchObject({ status: 'linked', text: 'helper(7)', target: { ...helper, name: 'helper' },
      args: [{ text: '7', spread: false }], inFunction: { name: 'run' } });
    expect(run.values).toEqual([]);
    expect(run.typedCallers).toEqual([]);
    const incoming = await callsOf('helper');
    expect(incoming.callers).toHaveLength(1);
    expect(incoming.callers![0]).toMatchObject({ text: 'helper(7)', inFunction: { name: 'run' } });
    expect(incoming.values).toMatchObject([{ name: 'value', role: 'parameter', fixed: null, index: 0, parameterKind: 'positional-or-keyword' }]);
    expect(run.callers).toHaveLength(1);
    expect(run.callers![0]).toMatchObject({ text: 'run()', inFunction: null });
  });

  it('keeps recursion and nested bodies attached to their own functions', async () => {
    await prepare({ 'main.py': 'def helper():\n    pass\n\ndef outer():\n    def inner(n):\n        helper()\n        return inner(n - 1)\n    return inner(2)\n' });
    const outer = await callsOf('outer');
    expect(outer.calls.map(call => call.text)).toEqual(['inner(2)']);
    expect(outer.calls[0]).toMatchObject({ status: 'linked', target: { name: 'inner' } });
    const inner = await callsOf('inner');
    expect(inner.calls.map(call => call.text)).toEqual(['helper()', 'inner(n - 1)']);
    expect(inner.calls.every(call => call.status === 'linked')).toBe(true);
    expect(inner.callers?.map(call => call.text)).toEqual(['inner(n - 1)', 'inner(2)']);
    expect((await callsOf('helper')).callers?.map(call => call.inFunction?.name)).toEqual(['inner']);
  });

  it('preserves keyword arguments separately and leaves unpacked arguments unresolved', async () => {
    await prepare({ 'main.py': 'def target(value):\n    pass\n\ndef run(args, kwargs):\n    target(1, "two")\n    target(value=1)\n    target(*args)\n    target(**kwargs)\n' });
    const result = await callsOf('run');
    expect(result.calls.map(call => call.status)).toEqual(['linked', 'linked', 'linked', 'linked']);
    expect(result.calls.map(call => call.args)).toEqual([[{ text: '1', spread: false }, { text: '"two"', spread: false }], [{ text: '1', spread: false, keyword: 'value' }], null, null]);
    expect(result.values).toMatchObject([{ name: 'args', role: 'parameter', index: 0 }, { name: 'kwargs', role: 'parameter', index: 1 }]);
  });

  it('does not split an unparenthesized generator argument into separate positional arguments', async () => {
    await prepare({ 'main.py': 'def target(values):\n    pass\ndef run():\n    target(item for item in [1])\n' });
    const result = await callsOf('run');
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toMatchObject({ status: 'linked', target: { name: 'target' }, args: null });
  });

  it('keeps imported names and attribute calls unresolved even when a matching local file exists', async () => {
    await prepare({ 'main.py': 'from other import target\nimport other\n\ndef run():\n    target()\n    other.target()\n',
      'other.py': 'def target():\n    pass\n' });
    const result = await callsOf('run');
    expect(result.calls.map(call => call.text)).toEqual(['target()', 'other.target()']);
    result.calls.forEach(expectUnknown);
    const target = await targetOf('target', 'other.py');
    const incoming = await findFunctionCalls(root, project.id, project.files, target, MAP_LIMITS);
    expect(incoming.callers).toEqual([]);
    expect(incoming.maybeCallers).toEqual(expect.arrayContaining([
      expect.objectContaining({ fileId: result.fileId, text: 'target()', reason: expect.any(String) }),
    ]));
  });

  it('does not mistake a parameter for the outer function', async () => {
    await prepare({ 'main.py': 'def target():\n    pass\n\ndef parameter(target):\n    target()\n' });
    expectUnknown((await callsOf('parameter')).calls[0]);
    expect((await callsOf('target')).callers).toEqual([]);
  });

  it.each([
    ['assignment', '    target()\n    target = replacement'],
    ['deletion', '    target()\n    del target'],
    ['for binding', '    for target in values:\n        pass\n    target()'],
    ['with binding', '    with manager as target:\n        pass\n    target()'],
    ['except binding', '    try:\n        pass\n    except Exception as target:\n        pass\n    target()'],
    ['match binding', '    match value:\n        case {"fn": target}:\n            pass\n    target()'],
  ])('does not mistake a local %s for the outer function', async (_, body) => {
    await prepare({ 'main.py': `def target():\n    pass\n\ndef run():\n${body}\n` });
    expectUnknown((await callsOf('run')).calls.find(call => call.text === 'target()'));
    expect((await callsOf('target')).callers).toEqual([]);
  });

  it('does not settle global or nonlocal declarations', async () => {
    await prepare({ 'main.py': 'def target():\n    pass\n\ndef global_user():\n    global target\n    target()\n\ndef outer():\n    def local():\n        pass\n    def inner():\n        nonlocal local\n        local()\n    inner()\n' });
    expectUnknown((await callsOf('global_user')).calls[0]);
    expectUnknown((await callsOf('inner')).calls[0]);
  });

  it('does not settle conditional definitions or calls before a local definition', async () => {
    await prepare({ 'main.py': 'if enabled:\n    def conditional():\n        pass\n\ndef run():\n    conditional()\n    late()\n    def late():\n        pass\n' });
    const result = await callsOf('run');
    expect(result.calls.map(call => call.text)).toEqual(['conditional()', 'late()']);
    result.calls.forEach(expectUnknown);
  });

  it('keeps calls before a module definition out of confirmed reverse callers', async () => {
    await prepare({ 'main.py': 'target()\ndef target():\n    pass\ntarget()\n' });
    const result = await callsOf('target');
    expect(result.callers?.map(call => call.startLine)).toEqual([4]);
    expect(result.maybeCallers.map(call => call.startLine)).toContain(1);
    expect(result.maybeCallers.find(call => call.startLine === 1)?.reason).toBeTruthy();
  });

  it('accepts decorated evidence ranges but does not settle calls to decorated functions', async () => {
    const text = 'def helper():\n    pass\n\n@decorate\ndef wrapped():\n    helper()\n\ndef run():\n    wrapped()\n';
    await prepare({ 'main.py': text });
    const target = await targetOf('wrapped');
    expect(text.slice(target.startUtf16, target.endUtf16)).toMatch(/^@decorate\ndef wrapped/);
    const result = await callsOf('wrapped');
    expect(result).toMatchObject(target);
    expect(result.calls[0]).toMatchObject({ status: 'linked', target: { name: 'helper' }, inFunction: { name: 'wrapped', startUtf16: target.startUtf16, endUtf16: target.endUtf16 } });
    expectUnknown((await callsOf('run')).calls[0]);
  });

  it('does not settle reassigned names or dynamically changed module names', async () => {
    await prepare({ 'main.py': 'def target():\n    pass\ntarget = replacement\ndef run():\n    target()\n' });
    expectUnknown((await callsOf('run')).calls[0]);
    await prepare({ 'main.py': 'def target():\n    pass\nexec("target = replacement")\ndef run():\n    target()\n' });
    expectUnknown((await callsOf('run')).calls.find(call => call.text === 'target()'));
  });

  it('does not confirm calls from a file with syntax errors', async () => {
    await prepare({ 'main.py': 'def target():\n    pass\ndef run():\n    target()\n@@@\n' });
    const result = await callsOf('run');
    expectUnknown(result.calls.find(call => call.text === 'target()'));
    expect(result.unexamined.some(file => file.relativePath === 'main.py' && file.reason.length > 0)).toBe(true);
  });

  it('rejects stale hashes, forged function ranges and unregistered file ids without changing source', async () => {
    const text = 'def target():\n    pass\n';
    await prepare({ 'main.py': text });
    const target = await targetOf('target');
    const find = (request: typeof target) => findFunctionCalls(root, project.id, project.files, request, MAP_LIMITS);
    await expect(find({ ...target, fileHash: '0'.repeat(64) })).rejects.toMatchObject({ code: 'CHANGED' });
    await expect(find({ ...target, endUtf16: target.endUtf16 - 1 })).rejects.toMatchObject({ code: 'CHANGED' });
    await expect(find({ ...target, fileId: randomUUID() })).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
    await callsOf('target');
    expect(await readFile(path.join(root, 'main.py'), 'utf8')).toBe(text);
  });

  it('honors cancellation', async () => {
    await prepare({ 'main.py': 'def target():\n    pass\n' });
    await expect(callsOf('target', MAP_LIMITS, () => true)).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('marks unread files when the file budget is exhausted', async () => {
    await prepare({ 'main.py': 'def target():\n    pass\n', 'other.py': 'from main import target\ntarget()\n' });
    const result = await callsOf('target', { ...MAP_LIMITS, files: 1 });
    expect(result.limited).toBe(true);
    expect(result.unexamined).toEqual(expect.arrayContaining([expect.objectContaining({ relativePath: 'other.py', reason: expect.any(String) })]));
    expect(result.callers).toEqual([]);
  });

  it('never settles an early call when the node budget hides a later reassignment', async () => {
    await prepare({ 'main.py': `def target():\n    pass\ndef run():\n    target()\n${'value = 1\n'.repeat(100)}target = replacement\n` });
    const result = await callsOf('run', { ...MAP_LIMITS, nodesPerFile: 60 });
    expectUnknown(result.calls.find(call => call.text === 'target()'));
    expect(result.unexamined.some(file => file.relativePath === 'main.py' && file.reason.length > 0)).toBe(true);
  });

  it('matches NFKC-equivalent identifiers while preserving the written function name', async () => {
    await prepare({ 'main.py': 'def ｋｅｅｐ():\n    pass\ndef run():\n    keep()\n    ｋｅｅｐ()\ndef shadow():\n    ｋｅｅｐ = replacement\n    keep()\n' });
    const target = await targetOf('ｋｅｅｐ');
    const result = await callsOf('run');
    expect(result.calls).toHaveLength(2);
    for (const call of result.calls) expect(call).toMatchObject({ status: 'linked', target: { ...target, name: 'ｋｅｅｐ' } });
    expect(result.calls.map(call => call.text)).toEqual(['keep()', 'ｋｅｅｐ()']);
    const incoming = await callsOf('ｋｅｅｐ');
    expect(incoming.name).toBe('ｋｅｅｐ');
    expect(incoming.names.local).toEqual(['ｋｅｅｐ']);
    expect(incoming.callers?.map(call => call.inFunction?.name)).toEqual(['run', 'run']);
    expectUnknown((await callsOf('shadow')).calls[0]);
  });

  it('skips the class namespace when resolving a bare name inside a method', async () => {
    await prepare({ 'main.py': 'def target():\n    pass\nclass Example:\n    def target(self):\n        pass\n    def run(self):\n        target()\n' });
    const target = await targetOf('target');
    const result = await callsOf('Example.run');
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toMatchObject({ status: 'linked', target: { ...target, name: 'target' }, inFunction: { name: 'Example.run' } });
    expect((await callsOf('Example.target')).callers).toEqual([]);
    expect((await callsOf('target')).callers?.map(call => call.inFunction?.name)).toEqual(['Example.run']);
  });

  it('does not treat a class-body comprehension as a caller of a class-local function', async () => {
    await prepare({ 'main.py': 'class Example:\n    def target():\n        pass\n    values = [target() for item in [1]]\n' });
    const result = await callsOf('Example.target');
    expect(result.callers).toEqual([]);
    expect(result.maybeCallers).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'target()', startLine: 4, reason: expect.any(String) }),
    ]));
  });

  it('does not resolve a nested class-body call through its enclosing class namespace', async () => {
    await prepare({ 'main.py': 'class Outer:\n    def target():\n        pass\n    class Inner:\n        target()\n' });
    const result = await callsOf('Outer.target');
    expect(result.callers).toEqual([]);
    expect(result.maybeCallers).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'target()', startLine: 5, reason: expect.any(String) }),
    ]));
  });

  it('does not settle an eager comprehension call before its enclosing function defines the name', async () => {
    await prepare({ 'main.py': 'def outer():\n    values = [target() for item in [1]]\n    def target():\n        pass\n' });
    const result = await callsOf('outer');
    expect(result.calls).toHaveLength(1);
    expectUnknown(result.calls[0]);
    expect((await callsOf('target')).callers).toEqual([]);
  });

  it('does not settle an eager class-body call before the module defines the name', async () => {
    await prepare({ 'main.py': 'class Example:\n    target()\ndef target():\n    pass\n' });
    const result = await callsOf('target');
    expect(result.callers).toEqual([]);
    expect(result.maybeCallers).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'target()', startLine: 2, reason: expect.any(String) }),
    ]));
  });

  it('does not resolve a class-private name to the identically written module function', async () => {
    await prepare({ 'main.py': 'def __target():\n    pass\nclass Example:\n    def method(self):\n        __target()\n' });
    const result = await callsOf('Example.method');
    expect(result.calls).toHaveLength(1);
    expectUnknown(result.calls[0]);
    expect((await callsOf('__target')).callers).toEqual([]);
  });

  it('does not resolve an implicit class cell to an identically named module function', async () => {
    await prepare({ 'main.py': 'def __class__():\n    pass\nclass Example:\n    def method(self):\n        __class__()\n' });
    const result = await callsOf('Example.method');
    expect(result.calls).toHaveLength(1);
    expectUnknown(result.calls[0]);
    expect((await callsOf('__class__')).callers).toEqual([]);
  });

  it('omits lambda-body calls with a scope note and keeps lambda parameters out of the enclosing scope', async () => {
    await prepare({ 'main.py': 'def target():\n    pass\ndef run():\n    callback = lambda target: target()\n    target()\n' });
    const result = await callsOf('run');
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toMatchObject({ status: 'linked', startLine: 5, target: { name: 'target' } });
    expect(result.notes.some(note => note.includes('람다'))).toBe(true);
    expect((await callsOf('target')).callers?.map(call => call.startLine)).toEqual([5]);
  });

  it('uses comprehension locals for its body but the outer scope for its first iterable', async () => {
    const expressions = ['[target() for target in target()]', '{target() for target in target()}',
      '{target(): 1 for target in target()}', '(target() for target in target())'];
    for (const expression of expressions) {
      const text = `def target():\n    return []\ndef run():\n    return ${expression}\n`;
      await prepare({ 'main.py': text });
      const bodyStart = text.indexOf('target()', text.indexOf('return ' + expression));
      const iterableStart = text.lastIndexOf('target()');
      const result = await callsOf('run');
      expect(result.calls).toHaveLength(2);
      expectUnknown(result.calls.find(call => call.startUtf16 === bodyStart));
      expect(result.calls.find(call => call.startUtf16 === iterableStart)).toMatchObject({ status: 'linked', target: { name: 'target' } });
      expect((await callsOf('target')).callers?.map(call => call.startUtf16)).toEqual([iterableStart]);
    }
  });

  it('does not settle an outer name made local by a named expression inside a comprehension', async () => {
    await prepare({ 'main.py': 'def target():\n    pass\ndef run():\n    target()\n    values = [(target := item) for item in items]\n' });
    const result = await callsOf('run');
    expect(result.calls).toHaveLength(1);
    expectUnknown(result.calls[0]);
    expect((await callsOf('target')).callers).toEqual([]);
  });

  it('counts UTF-8 bytes and reports files outside the remaining read budget', async () => {
    const text = '# 한글 경계\ndef target():\n    pass\n';
    await prepare({ 'main.py': text, 'other.py': 'from main import target\ntarget()\n' });
    const bytes = Buffer.byteLength(text);
    const result = await callsOf('target', { ...MAP_LIMITS, bytes });
    expect(result.limited).toBe(true);
    expect(result.unexamined).toEqual(expect.arrayContaining([
      expect.objectContaining({ relativePath: 'other.py', reason: expect.any(String) }),
    ]));
    expect(result.callers).toEqual([]);
    await expect(callsOf('target', { ...MAP_LIMITS, bytes: bytes - 1 })).rejects.toMatchObject({ code: 'IO' });
  });

  it('keeps a call at the result-size boundary and reports truncation below it', async () => {
    await prepare({ 'main.py': 'def target():\n    pass\ndef run():\n    target()\n' });
    const complete = await callsOf('run');
    expect(complete.calls).toHaveLength(1);
    const size = JSON.stringify(complete.calls[0]).length;
    const exact = await callsOf('run', { ...MAP_LIMITS, results: size });
    expect(exact.calls).toEqual(complete.calls);
    expect(exact.limited).toBe(false);
    const tight = await callsOf('run', { ...MAP_LIMITS, results: size - 1 });
    expect(tight.calls).toEqual([]);
    expect(tight.limited).toBe(true);
    expect(tight.notes.some(note => note.includes('한도'))).toBe(true);
  });

  it('refuses a selected file deleted after it was registered', async () => {
    await prepare({ 'main.py': 'def target():\n    pass\n' });
    const target = await targetOf('target');
    await rm(path.join(root, 'main.py'));
    await expect(findFunctionCalls(root, project.id, project.files, target, MAP_LIMITS)).rejects.toMatchObject({ code: 'IO' });
  });

  it('refuses a selected file replaced by a link even when its contents have the same hash', async context => {
    const text = 'def target():\n    pass\n';
    await prepare({ 'main.py': text });
    const target = await targetOf('target');
    await writeFile(path.join(root, 'replacement.py'), text);
    await rm(path.join(root, 'main.py'));
    try { await symlink(path.join(root, 'replacement.py'), path.join(root, 'main.py')); } catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) { context.skip(); return; }
      throw error;
    }
    await expect(findFunctionCalls(root, project.id, project.files, target, MAP_LIMITS)).rejects.toMatchObject({ code: 'IO' });
    expect(await readFile(path.join(root, 'replacement.py'), 'utf8')).toBe(text);
  });
});
