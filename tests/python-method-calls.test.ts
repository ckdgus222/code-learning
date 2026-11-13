import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { scanProject, readAllowed } from '../src/core/project/files';
import { analyzeSource } from '../src/core/analysis/syntax';
import { findFunctionCalls } from '../src/core/analysis/calls';
import { MAP_LIMITS } from '../src/core/analysis/project-map';
import type { CallLink, ProjectFiles } from '../src/shared/contracts';
let root: string;
let source: string;
let project: ProjectFiles;
const plainClass = 'class C:\n    def work(self, value=0):\n        return value\n';
beforeEach(async () => { root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-python-methods-'))); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function prepare(text: string) {
  source = text;
  await writeFile(path.join(root, 'main.py'), text);
  project = await scanProject(root, randomUUID());
}
async function targetOf(name: string) {
  const file = project.files.find(file => file.relativePath === 'main.py')!;
  const { hash } = await readAllowed(root, 'main.py');
  const symbol = analyzeSource(source, 'main.py', { projectId: project.id, fileId: file.id, fileHash: hash }).symbols.find(symbol => symbol.name === name)!;
  expect(symbol, name).toBeDefined();
  return { fileId: file.id, fileHash: hash, startUtf16: symbol.evidence.startUtf16, endUtf16: symbol.evidence.endUtf16 };
}
async function search(name = 'run', limits = MAP_LIMITS) {
  return findFunctionCalls(root, project.id, project.files, await targetOf(name), limits);
}
function unknown(call: CallLink | undefined) {
  expect(call).toMatchObject({ status: 'unknown' });
  if (call?.status === 'unknown') expect(call.reason).toBeTruthy();
}
async function typed(call: CallLink | undefined, name = 'C.work') {
  expect(call).toMatchObject({ status: 'typed', target: { ...await targetOf(name), name } });
  if (call?.status === 'typed') expect(call.basis).toBeTruthy();
}

describe('Python same-file method candidates', () => {
  it.each(['C.work(1)', '(C).work(1)', '(C.work)(1)'])('finds a typed candidate for %s without a confirmed reverse edge', async call => {
    await prepare(`${plainClass}\ndef run():\n    ${call}\n`);
    const result = await search();
    await typed(result.calls[0]);
    const incoming = await search('C.work');
    expect(incoming.callers).toEqual([]);
    expect(incoming.typedCallers).toHaveLength(1);
    expect(incoming.typedCallers[0]).toMatchObject({ fileId: result.fileId, fileHash: result.fileHash, text: call, args: [{ text: '1', spread: false }] });
    expect(incoming.maybeCallers).toEqual([]);
  });

  it.each(['self', 'this_instance'])('infers the direct instance method first parameter named %s', async receiver => {
    await prepare(`${plainClass}    def run(${receiver}):\n        ${receiver}.work(1)\n`);
    await typed((await search('C.run')).calls[0]);
  });

  it('infers an arbitrary classmethod receiver name with an unshadowed builtin decorator', async () => {
    await prepare(`${plainClass}    @classmethod\n    def run(klass):\n        klass.work(1)\n`);
    await typed((await search('C.run')).calls[0]);
  });

  it('supports a single builtin staticmethod target', async () => {
    await prepare('class C:\n    @staticmethod\n    def work(value):\n        return value\ndef run():\n    C.work(1)\n');
    await typed((await search()).calls[0]);
  });

  it.each(['item: C', '*, item: C'])('uses the written parameter type for %s', async parameters => {
    await prepare(`${plainClass}\ndef run(${parameters}):\n    item.work(1)\n`);
    await typed((await search()).calls[0]);
  });

  it('keeps unrelated instance field writes and reads from blocking a method candidate', async () => {
    await prepare(`${plainClass}    def run(self):\n        self.value = 1\n        other = self.value\n        self.work(other)\n`);
    await typed((await search('C.run')).calls[0]);
  });

  it('matches normalized method spellings while retaining source names', async () => {
    await prepare('class C:\n    def ｗork(self):\n        pass\ndef run():\n    C.work()\n');
    await typed((await search()).calls[0], 'C.ｗork');
  });

  it.each([
    ['inheritance', 'class C(Base):\n    def work(self):\n        pass\n'],
    ['metaclass', 'class C(metaclass=Meta):\n    def work(self):\n        pass\n'],
    ['decorated class', '@decorate\nclass C:\n    def work(self):\n        pass\n'],
    ['conditional class', 'if flag:\n    class C:\n        def work(self):\n            pass\n'],
    ['duplicate class', `${plainClass}${plainClass}`],
    ['reassigned class', `${plainClass}C = replacement\n`],
    ['duplicate method', `${plainClass}    def work(self):\n        pass\n`],
    ['decorated method', 'class C:\n    @decorate\n    def work(self):\n        pass\n'],
    ['property', 'class C:\n    @property\n    def work(self):\n        pass\n'],
    ['descriptor hook', `${plainClass}    def __getattribute__(self, name):\n        pass\n`],
    ['shadowed builtin', `staticmethod = decorate\nclass C:\n    @staticmethod\n    def work(value):\n        pass\n`],
  ])('withholds candidates for %s', async (_, declaration) => {
    await prepare(`${declaration}\ndef run():\n    C.work()\n`);
    unknown((await search()).calls[0]);
  });

  it.each([
    ['receiver reassignment', '        self = other\n        self.work()'],
    ['method assignment', '        self.work = other\n        self.work()'],
    ['method deletion', '        del self.work\n        self.work()'],
    ['receiver escape', '        alias = self\n        alias.work = other\n        self.work()'],
    ['method value escape', '        saved = self.work\n        self.work()'],
  ])('withholds an instance candidate after %s', async (_, body) => {
    await prepare(`${plainClass}    def run(self):\n${body}\n`);
    unknown((await search('C.run')).calls.at(-1));
  });

  it('withholds a class method changed outside its declaration', async () => {
    await prepare(`${plainClass}C.work = replacement\ndef run():\n    C.work()\n`);
    unknown((await search()).calls[0]);
  });

  it('does not infer a staticmethod first parameter as self', async () => {
    await prepare(`${plainClass}    @staticmethod\n    def run(self):\n        self.work()\n`);
    unknown((await search('C.run')).calls[0]);
  });

  it.each(['"C"', 'list[C]', 'C | None'])('does not resolve unsupported parameter type %s', async type => {
    await prepare(`${plainClass}def run(item: ${type}):\n    item.work()\n`);
    unknown((await search()).calls[0]);
  });

  it.each(['C().work()', 'super().work()', 'item.child.work()'])('does not guess a class for receiver expression %s', async expression => {
    await prepare(`${plainClass}def run(item: C):\n    ${expression}\n`);
    const result = await search();
    const method = result.calls.find(call => call.text.includes('.work('));
    unknown(method);
  });

  it('does not resolve a private method spelling', async () => {
    await prepare('class C:\n    def __work(self):\n        pass\n    def run(self):\n        self.__work()\n');
    unknown((await search('C.run')).calls[0]);
  });

  it('does not infer a receiver from an invalid whole signature', async () => {
    await prepare(`${plainClass}    def run(self, value=1, required):\n        self.work()\n`);
    unknown((await search('C.run')).calls[0]);
  });

  it('keeps an unrelated unknown caller with the same method name only as a possible caller', async () => {
    await prepare(`${plainClass}def run(item):\n    item.work()\n`);
    const incoming = await search('C.work');
    expect(incoming.callers).toEqual([]);
    expect(incoming.typedCallers).toEqual([]);
    expect(incoming.maybeCallers).toHaveLength(1);
    expect(incoming.maybeCallers[0]).toMatchObject({ text: 'item.work()' });
  });
  it('does not use a class name before its class body has finished creating it', async () => {
    await prepare(`${plainClass}    C.work()\n`);
    const incoming = await search('C.work');
    expect(incoming.typedCallers).toEqual([]);
    expect(incoming.callers).toEqual([]);
    expect(incoming.maybeCallers).toHaveLength(1);
  });

  it('rejects stale selected hashes and honors cancellation before method analysis', async () => {
    await prepare(`${plainClass}def run():\n    C.work()\n`);
    const target = await targetOf('run');
    await expect(findFunctionCalls(root, project.id, project.files, { ...target, fileHash: '0'.repeat(64) }, MAP_LIMITS)).rejects.toMatchObject({ code: 'CHANGED' });
    await expect(findFunctionCalls(root, project.id, project.files, target, MAP_LIMITS, () => true)).rejects.toMatchObject({ code: 'CANCELLED' });
  });
  it('bounds displayed member names while preserving the full function evidence', async () => {
    const name = 'method_' + 'x'.repeat(1_000);
    await prepare(`class C:\n    def ${name}(self):\n        pass\ndef run():\n    C.${name}()\n`);
    const call = (await search()).calls[0];
    expect(call.status).toBe('typed');
    if (call.status !== 'typed') throw new Error('Expected a method candidate');
    const incoming = await search(call.target.name);
    expect(incoming.names.property).toHaveLength(1);
    expect(incoming.names.property[0].length).toBeLessThanOrEqual(301);
    expect(incoming.names.property[0]).toMatch(/…$/);
    expect(source.slice(call.target.startUtf16, call.target.endUtf16)).toContain(`def ${name}(self)`);
  });
});
