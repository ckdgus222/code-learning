import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { scanProject, readAllowed } from '../src/core/project/files';
import { analyzeSource } from '../src/core/analysis/syntax';
import { findFunctionCalls } from '../src/core/analysis/calls';
import { MAP_LIMITS } from '../src/core/analysis/project-map';
import type { CallLink, ProjectFiles } from '../src/shared/contracts';

vi.mock('../src/core/project/files', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/core/project/files')>();
  return { ...actual, readAllowed: vi.fn(actual.readAllowed) };
});

let root: string;
let project: ProjectFiles;
const plainTarget = 'def target(value=0):\n    return value\n';
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-python-import-calls-')));
  vi.mocked(readAllowed).mockClear();
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function prepare(sources: Record<string, string>) {
  const files = { 'own/__init__.py': '', 'own/helper.py': plainTarget, ...sources };
  for (const [relative, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text);
  }
  project = await scanProject(root, randomUUID());
}
async function targetOf(relative: string, name: string) {
  const file = project.files.find(item => item.relativePath === relative)!;
  const { text, hash } = await readAllowed(root, relative);
  const symbol = analyzeSource(text, relative, { projectId: project.id, fileId: file.id, fileHash: hash }).symbols.find(item => item.name === name);
  expect(symbol, `${relative}: ${name}`).toBeDefined();
  return { fileId: file.id, fileHash: hash, startUtf16: symbol!.evidence.startUtf16, endUtf16: symbol!.evidence.endUtf16 };
}
async function callsOf(relative = 'own/main.py', name = 'run', limits = MAP_LIMITS) {
  return findFunctionCalls(root, project.id, project.files, await targetOf(relative, name), limits);
}
function expectUnknown(call: CallLink | undefined) {
  expect(call).toBeDefined();
  expect(call?.status).toBe('unknown');
  if (call?.status === 'unknown') expect(call.reason).toBeTruthy();
}

const importForms = [
  ['from .helper import target as alias', 'alias(7)'],
  ['from own.helper import target', 'target(7)'],
  ['from . import helper as api', 'api.target(7)'],
  ['import own.helper as api', 'api.target(7)'],
  ['import own.helper', 'own.helper.target(7)'],
];

describe('Python calls across imports', () => {
  it.each([
    'for other in [api]:\n    other.target = replacement',
    'for other in (api,):\n    other.target = replacement',
    'copied = [api for _ in [1]]\ncopied[0].target = replacement',
    'copied = (api for _ in [1])\nnext(copied).target = replacement',
    'with api as other:\n    other.target = replacement',
    'if (other := api):\n    other.target = replacement',
  ])('does not follow a module whose object escapes through binding context %s', async setup => {
    await prepare({ 'own/main.py': `import own.helper as api\n${setup}\ndef run():\n    return api.target()\n` });
    expectUnknown((await callsOf()).calls[0]);
  });

  it('keeps direct module calls inside a loop iterable and comprehension without treating the result as the module', async () => {
    await prepare({ 'own/main.py': 'import own.helper as api\nfor value in [api.target()]:\n    pass\nvalues = [api.target() for _ in [1]]\ndef run():\n    return api.target()\n' });
    expect((await callsOf()).calls[0]).toMatchObject({ status: 'linked', target: { name: 'target' } });
    expect((await callsOf('own/helper.py', 'target')).callers).toHaveLength(3);
  });

  it('does not treat a default parameter name as an escape of an outer module with that name', async () => {
    await prepare({ 'own/main.py': 'import own.helper as api\ndef unrelated(api: int = 1):\n    return api\ndef run():\n    return api.target()\n' });
    expect((await callsOf()).calls[0]).toMatchObject({ status: 'linked', target: { name: 'target' } });
  });

  it.each(importForms)('links %s by file identity and finds its reverse caller', async (statement, expression) => {
    await prepare({ 'own/main.py': `${statement}\ndef run():\n    return ${expression}\n` });
    const target = await targetOf('own/helper.py', 'target');
    const result = await callsOf();
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toMatchObject({ status: 'linked', text: expression,
      target: { ...target, name: 'target' }, args: [{ text: '7', spread: false }] });
    expect(result.values).toEqual([]);
    const incoming = await callsOf('own/helper.py', 'target');
    expect(incoming.callers).toHaveLength(1);
    expect(incoming.callers![0]).toMatchObject({ fileId: result.fileId, fileHash: result.fileHash, text: expression, inFunction: { name: 'run' } });
    expect(incoming.maybeCallers).toEqual([]);
    expect(await readFile(path.join(root, 'own/helper.py'), 'utf8')).toBe(plainTarget);
  });

  it('resolves each name in a multi-name from-dot import to its own module', async () => {
    await prepare({ 'own/main.py': 'from . import helper as api, other as alt\ndef run():\n    api.target()\n    alt.target()\n', 'own/other.py': plainTarget });
    const first = await targetOf('own/helper.py', 'target');
    const second = await targetOf('own/other.py', 'target');
    const result = await callsOf();
    expect(result.calls).toMatchObject([{ status: 'linked', target: first }, { status: 'linked', target: second }]);
    const incoming = await callsOf('own/helper.py', 'target');
    expect(incoming.callers?.map(call => call.text)).toEqual(['api.target()']);
    expect(incoming.maybeCallers).toEqual([]);
  });

  it('does not count a same-named function imported from another module as a possible caller', async () => {
    await prepare({ 'own/main.py': 'from .helper import target as first\nfrom .other import target as second\ndef run():\n    first()\n    second()\n', 'own/other.py': plainTarget });
    const incoming = await callsOf('own/helper.py', 'target');
    expect(incoming.callers?.map(call => call.text)).toEqual(['first()']);
    expect(incoming.maybeCallers).toEqual([]);
  });

  it('leaves script-sibling absolute imports unresolved and reports standard-library calls as external', async () => {
    await prepare({ 'main.py': 'from helper import target\nimport math\ndef run():\n    target()\n    math.sqrt(4)\n', 'helper.py': plainTarget });
    const result = await callsOf('main.py');
    expect(result.calls).toHaveLength(2);
    expectUnknown(result.calls[0]);
    expect(result.calls[1]).toMatchObject({ status: 'external', specifier: 'math', text: 'math.sqrt(4)' });
  });

  it.each([
    ['parameter', 'def run(alias):\n    alias()\n'],
    ['later local assignment', 'def run():\n    alias()\n    alias = replacement\n'],
  ])('does not follow an import hidden by a %s', async (_, body) => {
    await prepare({ 'own/main.py': `from .helper import target as alias\n${body}` });
    expectUnknown((await callsOf()).calls[0]);
    expect((await callsOf('own/helper.py', 'target')).callers).toEqual([]);
  });

  it('does not settle a conditional import', async () => {
    await prepare({ 'own/main.py': 'if enabled:\n    from .helper import target as alias\ndef run():\n    alias()\n' });
    expectUnknown((await callsOf()).calls[0]);
    expect((await callsOf('own/helper.py', 'target')).callers).toEqual([]);
  });

  it('does not settle an immediate call before its import executes', async () => {
    await prepare({ 'own/main.py': 'alias()\nfrom .helper import target as alias\nalias()\n' });
    const result = await callsOf('own/helper.py', 'target');
    expect(result.callers?.map(call => call.startLine)).toEqual([3]);
    expect(result.maybeCallers).toEqual(expect.arrayContaining([expect.objectContaining({ startLine: 1, text: 'alias()', reason: expect.any(String) })]));
  });

  it.each([
    ['decorated', '@decorate\ndef target():\n    pass\n'],
    ['conditional', 'if enabled:\n    def target():\n        pass\n'],
    ['reassigned', 'def target():\n    pass\ntarget = replacement\n'],
    ['duplicate', 'def target():\n    pass\ndef target():\n    pass\n'],
    ['re-exported', 'from .other import target\n'],
  ])('does not settle a %s imported target', async (_, helper) => {
    await prepare({ 'own/main.py': 'from .helper import target as alias\ndef run():\n    alias()\n', 'own/helper.py': helper, 'own/other.py': plainTarget });
    expectUnknown((await callsOf()).calls[0]);
  });

  it.each(['first.target = replacement', 'del first.target'])('blocks every alias of a module changed by %s', async change => {
    await prepare({ 'own/main.py': `from . import helper as first\nimport own.helper as second\n${change}\ndef run():\n    second.target()\n` });
    expectUnknown((await callsOf()).calls[0]);
    expect((await callsOf('own/helper.py', 'target')).callers).toEqual([]);
  });

  it('blocks another alias when an intermediate module attribute is replaced', async () => {
    await prepare({ 'own/main.py': 'import own.helper\nimport own.helper as api\nown.helper = replacement\ndef run():\n    api.target()\n' });
    expectUnknown((await callsOf()).calls[0]);
    expect((await callsOf('own/helper.py', 'target')).callers).toEqual([]);
  });

  it('blocks a submodule alias when the write starts from a separately imported package', async () => {
    await prepare({ 'own/main.py': 'import own\nimport own.helper as api\nown.helper.target = replacement\ndef run():\n    api.target()\n' });
    expectUnknown((await callsOf()).calls[0]);
    expect((await callsOf('own/helper.py', 'target')).callers).toEqual([]);
  });

  it('does not settle a module after an ordinary assignment copies its alias and mutates it', async () => {
    await prepare({ 'own/main.py': 'import own.helper as api\nother = api\nother.target = replacement\ndef run():\n    api.target()\n' });
    expectUnknown((await callsOf()).calls[0]);
    expect((await callsOf('own/helper.py', 'target')).callers).toEqual([]);
  });

  it('does not settle a class-private attribute as the same written module attribute', async () => {
    await prepare({ 'own/main.py': 'from . import helper as api\nclass Example:\n    def run(self):\n        api.__target()\n',
      'own/helper.py': 'def __target():\n    pass\n' });
    expectUnknown((await callsOf('own/main.py', 'Example.run')).calls[0]);
    expect((await callsOf('own/helper.py', '__target')).callers).toEqual([]);
  });

  it('does not settle a dotted module import when its initializer replaces the submodule attribute', async () => {
    await prepare({ 'own/__init__.py': 'from . import helper\nhelper = 42\n',
      'own/main.py': 'import own.helper as api\ndef run():\n    api.target()\n' });
    expectUnknown((await callsOf()).calls[0]);
    expect((await callsOf('own/helper.py', 'target')).callers).toEqual([]);
  });

  it('does not ignore private-name mangling on the original name imported inside a class', async () => {
    await prepare({ 'own/main.py': 'class Example:\n    def run(self):\n        from .helper import __target as alias\n        alias()\n',
      'own/helper.py': 'def __target():\n    pass\n' });
    expectUnknown((await callsOf('own/main.py', 'Example.run')).calls[0]);
    expect((await callsOf('own/helper.py', '__target')).callers).toEqual([]);
  });

  it('links a non-private alias imported outside the class even when the original function name is private', async () => {
    await prepare({ 'own/main.py': 'from .helper import __target as alias\nclass Example:\n    def run(self):\n        alias()\n',
      'own/helper.py': 'def __target():\n    pass\n' });
    const target = await targetOf('own/helper.py', '__target');
    expect((await callsOf('own/main.py', 'Example.run')).calls).toMatchObject([{ status: 'linked', target }]);
    expect((await callsOf('own/helper.py', '__target')).callers?.map(call => call.text)).toEqual(['alias()']);
  });

  it.each([
    ['return value', 'def run():\n    return api.target()\n'],
    ['assigned value', 'def run():\n    value = api.target()\n    return value\n'],
  ])('keeps an ordinary module function call linked when its result is a %s', async (_, body) => {
    await prepare({ 'own/main.py': `import own.helper as api\n${body}` });
    const target = await targetOf('own/helper.py', 'target');
    expect((await callsOf()).calls).toMatchObject([{ status: 'linked', target }]);
    expect((await callsOf('own/helper.py', 'target')).callers?.map(call => call.text)).toEqual(['api.target()']);
  });

  it.each([
    ['container escape', 'other = [api][0]\nother.target = replacement\n'],
    ['argument escape', 'accept(api)\n'],
    ['return escape', 'def expose():\n    return api\n'],
  ])('does not settle calls after a module object has a %s', async (_, escape) => {
    await prepare({ 'own/main.py': `import own.helper as api\n${escape}def run():\n    api.target()\n` });
    expectUnknown((await callsOf()).calls[0]);
    expect((await callsOf('own/helper.py', 'target')).callers).toEqual([]);
  });

  it('blocks aliases and local calls when another Python file mutates the target module', async () => {
    await prepare({
      'own/main.py': 'from .helper import target as alias\nfrom . import helper as api\ndef run():\n    alias()\n    api.target()\n',
      'own/helper.py': plainTarget + 'def local_run():\n    target()\n',
      'own/mutate.py': 'import own.helper as changed\nchanged.target = replacement\n',
    });
    const result = await callsOf();
    expect(result.calls).toHaveLength(2);
    for (const call of result.calls) expect(call).toMatchObject({ status: 'unknown', reason: 'reassigned' });
    expect((await callsOf('own/helper.py', 'local_run')).calls[0]).toMatchObject({ status: 'unknown', reason: 'reassigned' });
    expect((await callsOf('own/helper.py', 'target')).callers).toEqual([]);
  });

  it('keeps the target linked when a different module is mutated', async () => {
    await prepare({
      'own/main.py': 'from .helper import target as alias\ndef run():\n    alias()\n',
      'own/other.py': plainTarget,
      'own/mutate.py': 'from . import other as changed\nchanged.target = replacement\n',
    });
    const target = await targetOf('own/helper.py', 'target');
    expect((await callsOf()).calls).toMatchObject([{ status: 'linked', target }]);
    expect((await callsOf('own/helper.py', 'target')).callers?.map(call => call.text)).toEqual(['alias()']);
  });

  it('does not treat an attribute annotation without a value as a module mutation', async () => {
    await prepare({ 'own/main.py': 'from . import helper as api\napi.target: int\ndef run():\n    api.target()\n' });
    const target = await targetOf('own/helper.py', 'target');
    expect((await callsOf()).calls).toMatchObject([{ status: 'linked', target }]);
    expect((await callsOf('own/helper.py', 'target')).callers?.map(call => call.text)).toEqual(['api.target()']);
  });

  it.each([
    ['nested class', 'class Outer:\n    class Inner:\n        api.target = replacement\n'],
    ['comprehension target', 'values = [item for api.target in items]\n'],
    ['with target', 'with manager as api.target:\n    pass\n'],
    ['for destructuring target', 'for api.target, item in items:\n    pass\n'],
  ])('detects module mutations through a %s', async (_, mutation) => {
    await prepare({
      'own/main.py': 'from .helper import target as alias\ndef run():\n    alias()\n',
      'own/mutate.py': `from . import helper as api\n${mutation}`,
    });
    const result = await callsOf();
    expect(result.calls[0]).toMatchObject({ status: 'unknown', reason: 'reassigned' });
    expect(result.unexamined).toEqual([]);
    expect((await callsOf('own/helper.py', 'target')).callers).toEqual([]);
  });

  it.each([
    ['parameter', 'def mutate(api):\n    api.target = replacement\n'],
    ['local assignment', 'def mutate():\n    api = local_object\n    api.target = replacement\n'],
  ])('does not attribute writes through a shadowing %s to the imported module', async (_, mutation) => {
    await prepare({ 'own/main.py': `from . import helper as api\n${mutation}def run():\n    api.target()\n` });
    const target = await targetOf('own/helper.py', 'target');
    expect((await callsOf()).calls).toMatchObject([{ status: 'linked', target }]);
    expect((await callsOf('own/helper.py', 'target')).callers?.map(call => call.text)).toEqual(['api.target()']);
  });

  it('keeps a module/package name collision unresolved', async () => {
    await prepare({ 'own/main.py': 'from .helper import target\ndef run():\n    target()\n', 'own/helper/__init__.py': plainTarget });
    expectUnknown((await callsOf()).calls[0]);
  });

  it.each(['helper = 1\n', 'boot()\n', 'from .other import *\n'])('does not assume a submodule through unsafe initializer %j', async initializer => {
    await prepare({ 'own/__init__.py': initializer, 'own/main.py': 'from . import helper as api\ndef run():\n    api.target()\n', 'own/other.py': '' });
    expectUnknown((await callsOf()).calls[0]);
  });

  it.each([
    ['machinery', 'def __getattr__(name):\n    return replacement\n'],
    ['star import', 'from .other import *\n'],
    ['syntax error', '@@@\n'],
  ])('does not settle an imported module containing %s', async (_, extra) => {
    await prepare({ 'own/main.py': 'from .helper import target\ndef run():\n    target()\n', 'own/helper.py': plainTarget + extra, 'own/other.py': '' });
    expectUnknown((await callsOf()).calls[0]);
  });

  it('terminates circular re-exports without inventing a target', async () => {
    await prepare({ 'own/main.py': 'from .helper import target\ndef run():\n    target()\n',
      'own/helper.py': 'from .other import target\n', 'own/other.py': 'from .helper import target\n' });
    expectUnknown((await callsOf()).calls[0]);
  });

  it('remembers failed reads once per job even when multiple calls need the missing module', async () => {
    await prepare({ 'own/main.py': 'from .helper import target as alias\ndef run():\n    alias()\n    alias()\n    alias()\n' });
    const request = await targetOf('own/main.py', 'run');
    await rm(path.join(root, 'own/helper.py'));
    vi.mocked(readAllowed).mockClear();
    const result = await findFunctionCalls(root, project.id, project.files, request, MAP_LIMITS);
    expect(result.calls).toHaveLength(3);
    result.calls.forEach(expectUnknown);
    expect(vi.mocked(readAllowed).mock.calls.filter(args => args[1] === 'own/helper.py')).toHaveLength(1);
    expect(result.unexamined.filter(file => file.relativePath === 'own/helper.py')).toHaveLength(1);
  });

  it('keeps import targets unknown and reports truncation when file or byte budgets run out', async () => {
    const text = 'from .helper import target\ndef run():\n    target()\n';
    await prepare({ 'own/main.py': text });
    for (const limits of [{ ...MAP_LIMITS, files: 1 }, { ...MAP_LIMITS, bytes: Buffer.byteLength(text) }]) {
      const result = await callsOf('own/main.py', 'run', limits);
      expectUnknown(result.calls[0]);
      expect(result.limited).toBe(true);
      expect(result.unexamined.some(file => file.relativePath === 'own/helper.py')).toBe(true);
      expect(result.notes.some(note => note.includes('한도'))).toBe(true);
    }
  });

  it('honors cancellation after starting to read the imported module', async () => {
    await prepare({ 'own/main.py': 'from .helper import target\ndef run():\n    target()\n' });
    const request = await targetOf('own/main.py', 'run');
    vi.mocked(readAllowed).mockClear();
    await expect(findFunctionCalls(root, project.id, project.files, request, MAP_LIMITS,
      () => vi.mocked(readAllowed).mock.calls.some(args => args[1] === 'own/helper.py'))).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('refuses navigation using imported evidence after the target file changes', async () => {
    await prepare({ 'own/main.py': 'from .helper import target\ndef run():\n    target()\n' });
    const result = await callsOf();
    expect(result.calls[0].status).toBe('linked');
    if (result.calls[0].status !== 'linked') throw new Error('Expected an imported call target');
    const target = result.calls[0].target;
    await writeFile(path.join(root, 'own/helper.py'), '# changed\n' + plainTarget);
    await expect(findFunctionCalls(root, project.id, project.files, target, MAP_LIMITS)).rejects.toMatchObject({ code: 'CHANGED' });
  });
});
