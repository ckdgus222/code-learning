import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { scanProject, readAllowed } from '../src/core/project/files';
import { analyzeSource } from '../src/core/analysis/syntax';
import { findFunctionCalls, type CallsCache } from '../src/core/analysis/calls';
import { MAP_LIMITS } from '../src/core/analysis/project-map';
import type { FunctionCalls, NameValue, ProjectFiles } from '../src/shared/contracts';

let root: string;
let project: ProjectFiles;
let sources: Record<string, string>;
const statement = 'from .settings import LIMIT as limit';
const main = `${statement}\ndef run():\n    return limit\n`;
beforeEach(async () => { root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-python-import-values-'))); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function prepare(extra: Record<string, string> = {}) {
  sources = { 'own/__init__.py': '', 'own/settings.py': 'LIMIT: int = 2 + 3\n', 'own/main.py': main, ...extra };
  for (const [relative, source] of Object.entries(sources)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), source);
  }
  project = await scanProject(root, randomUUID());
}
async function targetOf(relative = 'own/main.py', name = 'run') {
  const file = project.files.find(file => file.relativePath === relative)!;
  const source = await readAllowed(root, relative);
  const symbol = analyzeSource(source.text, relative, { projectId: project.id, fileId: file.id, fileHash: source.hash }).symbols.find(symbol => symbol.name === name)!;
  expect(symbol).toBeDefined();
  return { fileId: file.id, fileHash: source.hash, startUtf16: symbol.evidence.startUtf16, endUtf16: symbol.evidence.endUtf16 };
}
async function search(limits = MAP_LIMITS, cache?: CallsCache, chosenName = 'run') {
  return findFunctionCalls(root, project.id, project.files, await targetOf('own/main.py', chosenName), limits, undefined, cache);
}
function valueOf(result: FunctionCalls, name = 'limit'): NameValue {
  const matches = result.values.filter(value => value.name === name);
  expect(matches, name).toHaveLength(1);
  return matches[0];
}
function unknown(value: NameValue) {
  expect(value.unknown).toBeTruthy();
  expect(value.initial).toBeNull();
  expect(value.fixed).toBeNull();
}
async function linked(value: NameValue, group: NameValue['group'] = 'outside') {
  const file = project.files.find(file => file.relativePath === 'own/settings.py')!;
  const source = await readAllowed(root, file.relativePath);
  expect(value).toMatchObject({ name: 'limit', group, role: 'import', type: 'int', fixed: null, index: null,
    unknown: null, assignments: [], declaredAt: { fileId: file.id, fileHash: source.hash, text: 'LIMIT' },
    initial: { kind: 'export', fileId: file.id, fileHash: source.hash, text: '2 + 3' } });
  expect(value.notes.length).toBeGreaterThan(0);
  for (const site of [value.declaredAt!, value.initial!]) expect(source.text.slice(site.startUtf16, site.endUtf16)).toBe(site.text);
}
const size = (result: FunctionCalls) => [result.calls, result.callers ?? [], result.typedCallers, result.maybeCallers, result.values].flat().reduce((sum, row) => sum + JSON.stringify(row).length, 0);

describe('Python direct from-import value origins', () => {
  it.each(['from .settings import LIMIT as limit', 'from own.settings import LIMIT as limit', 'from .settings import LIMIT, LIMIT as limit'])('links the source expression for %s', async declaration => {
    await prepare({ 'own/main.py': `${declaration}\ndef run():\n    return limit\n`, 'unrelated/settings.py': 'LIMIT = 999\n' });
    await linked(valueOf(await search()));
    for (const [relative, source] of Object.entries(sources)) expect(await readFile(path.join(root, relative), 'utf8')).toBe(source);
  });

  it('links a function-local import as an inside value', async () => {
    await prepare({ 'own/main.py': `def run():\n    ${statement}\n    return limit\n` });
    await linked(valueOf(await search()), 'inside');
  });

  it.each(['return limit', 'alias = limit\n    return alias', 'consume(limit)'])('does not confuse ordinary imported-value use with module escape: %s', async body => {
    await prepare({ 'own/main.py': `${statement}\ndef run():\n    ${body}\n` });
    await linked(valueOf(await search()));
  });

  it.each([
    ['duplicate', 'LIMIT = 1\nLIMIT = 2\n'],
    ['conditional', 'if flag:\n    LIMIT = 1\n'],
    ['chain', 'LIMIT = OTHER = 1\n'],
    ['destructuring', 'LIMIT, OTHER = pair\n'],
    ['annotation only', 'LIMIT: int\n'],
    ['reexport', 'from .other import LIMIT\n'],
    ['function', 'def LIMIT():\n    pass\n'],
    ['class', 'class LIMIT:\n    pass\n'],
    ['dynamic', 'LIMIT = 1\nexec(code)\n'],
    ['incomplete', 'LIMIT = 1\n@@@\n'],
  ])('withholds unsupported origin %s', async (_, source) => {
    await prepare({ 'own/settings.py': source, 'own/other.py': 'LIMIT = 9\n' });
    unknown(valueOf(await search()));
  });

  it.each([
    `${statement}\nlimit = 8\ndef run():\n    return limit\n`,
    `${statement}\n${statement}\ndef run():\n    return limit\n`,
    `if flag:\n    ${statement}\ndef run():\n    return limit\n`,
    `${statement}\ndef run():\n    global limit\n    return limit\n`,
  ])('does not settle ambiguous or directed local imports: %j', async source => {
    await prepare({ 'own/main.py': source });
    unknown(valueOf(await search()));
  });

  it('does not resolve a private imported origin inside a class method', async () => {
    await prepare({ 'own/settings.py': '__secret: int = 2 + 3\n', 'own/main.py': 'class C:\n    def run(self):\n        from .settings import __secret as limit\n        return limit\n' });
    unknown(valueOf(await search(MAP_LIMITS, undefined, 'C.run')));
  });

  it('links a double-underscore origin imported outside a class', async () => {
    await prepare({ 'own/settings.py': '__secret: int = 2 + 3\n', 'own/main.py': 'from .settings import __secret as limit\ndef run():\n    return limit\n' });
    const file = project.files.find(file => file.relativePath === 'own/settings.py')!;
    const source = await readAllowed(root, file.relativePath);
    const value = valueOf(await search());
    expect(value).toMatchObject({ unknown: null, fixed: null, type: 'int',
      declaredAt: { fileId: file.id, fileHash: source.hash, text: '__secret' },
      initial: { kind: 'export', fileId: file.id, fileHash: source.hash, text: '2 + 3' } });
  });

  it('preserves a subscripted annotation without treating it as generic type parameters or a fixed value', async () => {
    await prepare({ 'own/settings.py': 'from typing import Final\nLIMIT: Final[int] = 2 + 3\n' });
    expect(valueOf(await search())).toMatchObject({ unknown: null, type: 'Final[int]', fixed: null,
      initial: { kind: 'export', text: '2 + 3' } });
  });

  it('does not settle imported calls from a generic function with unsupported type parameters', async () => {
    await prepare({ 'own/settings.py': 'def target[T](value: T):\n    return value\n',
      'own/main.py': 'from .settings import target\ndef run():\n    return target(1)\n' });
    const result = await search();
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toMatchObject({ status: 'unknown' });
    expect(result.calls[0].status === 'unknown' && result.calls[0].reason).toBeTruthy();
  });

  it.each(['api.LIMIT = 99', 'del api.LIMIT', 'escaped = api'])('blocks a changed or escaped source module in another file: %s', async mutation => {
    await prepare({ 'own/mutator.py': `import own.settings as api\n${mutation}\n` });
    unknown(valueOf(await search()));
  });

  it.each([
    ['parent package namespace write', 'import own\nimport own.settings as api\nown.settings.LIMIT = 99\n'],
    ['module dictionary mutation', 'import own.settings as api\napi.__dict__.update(LIMIT=99)\n'],
    ['parent package module escape', 'import own\nimport own.settings as api\nalias = own.settings\nalias.LIMIT = 99\n'],
  ])('withholds the source after %s in another file', async (_, mutation) => {
    await prepare({ 'own/mutator.py': mutation });
    unknown(valueOf(await search()));
  });

  it('does not follow a package child overwritten by its initializer', async () => {
    await prepare({ 'own/__init__.py': 'from . import settings\nsettings = 42\n' });
    unknown(valueOf(await search()));
  });

  it('withholds an origin changed through another module exposing the parent package', async () => {
    await prepare({ 'own/bridge.py': 'import own.settings\n',
      'own/mutator.py': 'import own.bridge as bridge\nbridge.own.settings.LIMIT = 99\n' });
    unknown(valueOf(await search()));
  });

  it('withholds an origin when a sibling import exposes an escaped parent package', async () => {
    await prepare({ 'own/other.py': '',
      'own/mutator.py': 'import own.other\nescape = own\nescape.settings.LIMIT = 99\n' });
    unknown(valueOf(await search()));
  });

  it('does not resolve a reference before the function-local import binds its name', async () => {
    await prepare({ 'own/main.py': `def run():\n    consume(limit)\n    ${statement}\n    return limit\n` });
    unknown(valueOf(await search()));
  });

  it.each(['api.LIMIT.member = 99', 'api.LIMIT[0] = 99'])('retains the written source when only the imported object internals change: %s', async mutation => {
    await prepare({ 'own/mutator.py': `import own.settings as api\n${mutation}\n` });
    await linked(valueOf(await search()));
  });

  it('does not claim module-attribute value following is implemented', async () => {
    await prepare({ 'own/main.py': 'from . import settings\ndef run():\n    return settings.LIMIT\n' });
    const result = await search();
    expect(result.values.some(value => value.initial?.kind === 'export')).toBe(false);
    expect(result.values.some(value => value.name === 'LIMIT')).toBe(false);
  });

  it('identifies external imports without inventing a source expression', async () => {
    await prepare({ 'own/main.py': 'from math import pi as limit\ndef run():\n    return limit\n' });
    expect(valueOf(await search())).toMatchObject({ role: 'import', external: 'math', initial: null, fixed: null });
  });

  it('does not choose arbitrarily between a module and package of the same name', async () => {
    await prepare({ 'own/settings/__init__.py': 'LIMIT = 7\n' });
    unknown(valueOf(await search()));
  });

  it('charges each source once when upgrading metadata and respects file and byte limits', async () => {
    await prepare();
    const bytes = Object.values(sources).reduce((sum, source) => sum + Buffer.byteLength(source), 0);
    const full = await search({ ...MAP_LIMITS, files: Object.keys(sources).length, bytes });
    await linked(valueOf(full));
    expect(full.limited).toBe(false);
    const limited = await search({ ...MAP_LIMITS, files: 1 });
    expect(limited.limited).toBe(true);
    unknown(valueOf(limited));
    const short = await search({ ...MAP_LIMITS, bytes: Buffer.byteLength(main) });
    expect(short.limited).toBe(true);
    unknown(valueOf(short));
  });

  it('upgrades cached call facts to imported value metadata with the same source evidence', async () => {
    await prepare({ 'own/other.py': 'def other():\n    pass\n' });
    const cache: CallsCache = { texts: new Map(), parsed: new Map() };
    await findFunctionCalls(root, project.id, project.files, await targetOf('own/other.py', 'other'), MAP_LIMITS, undefined, cache);
    const cached = await search(MAP_LIMITS, cache);
    await linked(valueOf(cached));
    expect(cached.values).toEqual((await search()).values);
  });

  it('retains selected-source identity and cancellation guards', async () => {
    await prepare();
    const target = await targetOf();
    await expect(findFunctionCalls(root, project.id, project.files, { ...target, fileHash: '0'.repeat(64) }, MAP_LIMITS)).rejects.toMatchObject({ code: 'CHANGED' });
    await expect(findFunctionCalls(root, project.id, project.files, { ...target, fileId: 'unregistered' }, MAP_LIMITS)).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
    await expect(findFunctionCalls(root, project.id, project.files, target, MAP_LIMITS, () => true)).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('counts linked origin metadata in the shared result budget', async () => {
    await prepare();
    const full = await search();
    await linked(valueOf(full));
    const budget = size(full) - 1;
    const limited = await search({ ...MAP_LIMITS, results: budget });
    expect(limited.limited).toBe(true);
    expect(size(limited)).toBeLessThanOrEqual(budget);
  });
});
