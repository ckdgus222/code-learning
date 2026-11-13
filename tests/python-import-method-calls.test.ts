import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { scanProject, readAllowed } from '../src/core/project/files';
import { analyzeSource } from '../src/core/analysis/syntax';
import { findFunctionCalls, type CallsCache } from '../src/core/analysis/calls';
import { MAP_LIMITS } from '../src/core/analysis/project-map';
import type { CallLink, FunctionCalls, ProjectFiles } from '../src/shared/contracts';
let root: string;
let project: ProjectFiles;
const model = 'class C:\n    def work(self, value=0):\n        return value\n';
const main = 'from .models import C as Alias\ndef run():\n    Alias.work(1)\n';
beforeEach(async () => { root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-python-import-methods-'))); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function prepare(extra: Record<string, string> = {}) {
  for (const [relative, text] of Object.entries({ 'pkg/__init__.py': '', 'pkg/models.py': model, 'pkg/main.py': main, ...extra })) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text);
  }
  project = await scanProject(root, randomUUID());
}
async function targetOf(relative: string, name: string) {
  const file = project.files.find(file => file.relativePath === relative)!;
  const { text, hash } = await readAllowed(root, relative);
  const symbol = analyzeSource(text, relative, { projectId: project.id, fileId: file.id, fileHash: hash }).symbols.find(symbol => symbol.name === name)!;
  expect(symbol, name).toBeDefined();
  return { fileId: file.id, fileHash: hash, startUtf16: symbol.evidence.startUtf16, endUtf16: symbol.evidence.endUtf16 };
}
async function search(relative = 'pkg/main.py', name = 'run', limits = MAP_LIMITS, cache?: CallsCache) {
  return findFunctionCalls(root, project.id, project.files, await targetOf(relative, name), limits, undefined, cache);
}
function unknown(call: CallLink | undefined) {
  expect(call).toMatchObject({ status: 'unknown' });
  if (call?.status === 'unknown') expect(call.reason).toBeTruthy();
}
async function typed(call: CallLink | undefined, name = 'C.work', relative = 'pkg/models.py') {
  expect(call).toMatchObject({ status: 'typed', target: { ...await targetOf(relative, name), name } });
  if (call?.status === 'typed') expect(call.basis).toBeTruthy();
}
const size = (result: FunctionCalls) => [result.calls, result.callers ?? [], result.typedCallers, result.maybeCallers, result.values,
  result.returnAnnotation ? [result.returnAnnotation] : []].flat().reduce((sum, item) => sum + JSON.stringify(item).length, 0);

describe('Python imported class method candidates', () => {
  it.each([
    ['from .models import C as Alias', 'Alias.work(1)'],
    ['from pkg.models import C', 'C.work(1)'],
    ['import pkg.models as m', 'm.C.work(1)'],
    ['import pkg.models', 'pkg.models.C.work(1)'],
    ['from . import models as m', 'm.C.work(1)'],
    ['from pkg import models', 'models.C.work(1)'],
  ])('links %s to original evidence without confirmed reverse callers', async (declaration, expression) => {
    await prepare({ 'pkg/main.py': `${declaration}\ndef run():\n    ${expression}\n` });
    const result = await search();
    await typed(result.calls[0]);
    expect(result.values).toEqual([]);
    const incoming = await search('pkg/models.py', 'C.work');
    expect(incoming.callers).toEqual([]);
    expect(incoming.typedCallers).toHaveLength(1);
    expect(incoming.typedCallers[0]).toMatchObject({ fileId: result.fileId, fileHash: result.fileHash, text: expression });
    expect(incoming.maybeCallers).toEqual([]);
  });

  it.each([
    ['from .models import C as Alias', 'value: Alias'],
    ['import pkg.models as m', 'value: m.C'],
    ['from .models import C as Alias', '*, value: Alias'],
  ])('uses an imported type on parameter %s / %s', async (declaration, parameter) => {
    await prepare({ 'pkg/main.py': `${declaration}\ndef run(${parameter}):\n    value.work(1)\n` });
    await typed((await search()).calls[0]);
  });

  it('keeps separate class identities for different attributes of one module binding', async () => {
    await prepare({ 'pkg/models.py': model.replaceAll('C', 'A') + model.replaceAll('C', 'B'),
      'pkg/main.py': 'import pkg.models as m\ndef run():\n    m.A.work(1)\n    m.B.work(2)\n' });
    const result = await search();
    await typed(result.calls[0], 'A.work');
    await typed(result.calls[1], 'B.work');
    expect((await search('pkg/models.py', 'A.work')).typedCallers.map(call => call.text)).toEqual(['m.A.work(1)']);
  });

  it('compares import order within the caller rather than class offsets from another file', async () => {
    await prepare({ 'pkg/models.py': '# padding\n'.repeat(100) + model });
    await typed((await search()).calls[0]);
  });

  it.each([
    ['inheritance', 'class C(Base):\n    def work(self):\n        pass\n'],
    ['decorator', '@decorate\n' + model],
    ['duplicate class', model + model],
    ['reassigned class', model + 'C = replacement\n'],
    ['conditional class', 'if flag:\n' + model.split('\n').filter(Boolean).map(line => '    ' + line).join('\n') + '\n'],
    ['descriptor hook', model + '    def __getattribute__(self, name):\n        pass\n'],
    ['decorated member', 'class C:\n    @decorate\n    def work(self):\n        pass\n'],
    ['reexport', 'from .original import C\n'],
    ['duplicate member', model + '    def work(self):\n        pass\n'],
  ])('does not promote an unsupported destination %s to a candidate', async (_, text) => {
    await prepare({ 'pkg/models.py': text, 'pkg/original.py': model });
    unknown((await search()).calls[0]);
  });

  it.each([
    ['receiver mutation', '    value.work = replacement'],
    ['receiver alias mutation', '    alias = value\n    alias.work = replacement'],
    ['receiver escape', '    consume(value)'],
    ['method escape', '    saved = value.work'],
    ['method deletion', '    del value.work'],
  ])('honors third-file imported receiver effects: %s', async (_, body) => {
    await prepare({ 'pkg/effects.py': `from .models import C as ImportedC\ndef mutate(value: ImportedC):\n${body}\n` });
    unknown((await search()).calls[0]);
  });

  it('does not let unrelated field use in another file block a method', async () => {
    await prepare({ 'pkg/effects.py': 'from .models import C as ImportedC\ndef mutate(value: ImportedC):\n    value.field = 1\n    return value.field\n' });
    await typed((await search()).calls[0]);
  });

  it.each([
    ['duplicate binding', 'from .models import C as Alias\nfrom .models import C as Alias\ndef run():\n    Alias.work()\n'],
    ['late import', 'def run(value: Alias):\n    value.work()\nfrom .models import C as Alias\n'],
    ['conditional import', 'if flag:\n    from .models import C as Alias\ndef run():\n    Alias.work()\n'],
    ['reassigned module', 'import pkg.models as m\nm = replacement\ndef run():\n    m.C.work()\n'],
  ])('withholds an uncertain source binding: %s', async (_, text) => {
    await prepare({ 'pkg/main.py': text });
    unknown((await search()).calls[0]);
  });

  it.each(['"Alias"', 'list[Alias]', 'Alias | None'])('does not guess unsupported imported parameter annotation %s', async annotation => {
    await prepare({ 'pkg/main.py': `from .models import C as Alias\ndef run(value: ${annotation}):\n    value.work()\n` });
    unknown((await search()).calls[0]);
  });

  it('does not follow an additional object attribute beyond the imported class', async () => {
    await prepare({ 'pkg/main.py': 'import pkg.models as m\ndef run():\n    m.C.child.work()\n' });
    unknown((await search()).calls[0]);
  });

  it('does not claim an external class has a project method target', async () => {
    await prepare({ 'pkg/main.py': 'from external import C\ndef run():\n    C.work()\n' });
    const call = (await search()).calls[0];
    expect(call).toBeDefined();
    expect(['unknown', 'external']).toContain(call.status);
  });

  it('rejects package/module collisions instead of choosing one class', async () => {
    await prepare({ 'pkg/models/__init__.py': model });
    unknown((await search()).calls[0]);
  });

  it('honors a parent initializer that replaces the imported module', async () => {
    await prepare({ 'pkg/__init__.py': 'from . import models\nmodels = replacement\n' });
    unknown((await search()).calls[0]);
  });

  it('does not follow cyclic reexports to invent a class', async () => {
    await prepare({ 'pkg/models.py': 'from .other import C\n', 'pkg/other.py': 'from .models import C\n' });
    unknown((await search()).calls[0]);
  });

  it('keeps imported and destination own receiver contexts correct when reusing a cache', async () => {
    await prepare({ 'pkg/models.py': model + '    def own(self):\n        self.work(2)\n' });
    const cache: CallsCache = { texts: new Map(), parsed: new Map() };
    await typed((await search('pkg/main.py', 'run', MAP_LIMITS, cache)).calls[0]);
    await typed((await search('pkg/models.py', 'C.own', MAP_LIMITS, cache)).calls[0]);
    const incoming = await search('pkg/models.py', 'C.work', MAP_LIMITS, cache);
    expect(incoming.typedCallers).toHaveLength(2);
    expect(incoming.callers).toEqual([]);
  });

  it('withholds unread targets and charges typed candidates to the shared result budget', async () => {
    await prepare();
    const short = await search('pkg/main.py', 'run', { ...MAP_LIMITS, files: 1 });
    expect(short.limited).toBe(true);
    unknown(short.calls[0]);
    const full = await search();
    await typed(full.calls[0]);
    const tight = await search('pkg/main.py', 'run', { ...MAP_LIMITS, results: size(full) - 1 });
    expect(tight.limited).toBe(true);
    expect(size(tight)).toBeLessThanOrEqual(size(full) - 1);
  });

  it('rejects stale destination navigation and honors cancellation', async () => {
    await prepare();
    const destination = await targetOf('pkg/models.py', 'C.work');
    await writeFile(path.join(root, 'pkg/models.py'), model + '# changed\n');
    await expect(findFunctionCalls(root, project.id, project.files, destination, MAP_LIMITS)).rejects.toMatchObject({ code: 'CHANGED' });
    await expect(findFunctionCalls(root, project.id, project.files, await targetOf('pkg/main.py', 'run'), MAP_LIMITS, () => true)).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
