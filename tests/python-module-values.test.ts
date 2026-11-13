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
const main = 'import own.settings as api\ndef run():\n    return api.LIMIT\n';
beforeEach(async () => { root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-python-module-values-'))); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function prepare(extra: Record<string, string> = {}) {
  sources = { 'own/__init__.py': '', 'own/settings.py': 'LIMIT: int = 2 + 3\n', 'own/main.py': main, ...extra };
  for (const [relative, source] of Object.entries(sources)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), source);
  }
  project = await scanProject(root, randomUUID());
}
async function targetOf(name = 'run', relative = 'own/main.py') {
  const file = project.files.find(file => file.relativePath === relative)!;
  const source = await readAllowed(root, relative);
  const symbol = analyzeSource(source.text, relative, { projectId: project.id, fileId: file.id, fileHash: source.hash }).symbols.find(symbol => symbol.name === name)!;
  expect(symbol).toBeDefined();
  return { fileId: file.id, fileHash: source.hash, startUtf16: symbol.evidence.startUtf16, endUtf16: symbol.evidence.endUtf16 };
}
async function search(limits = MAP_LIMITS, cache?: CallsCache, name = 'run') {
  return findFunctionCalls(root, project.id, project.files, await targetOf(name), limits, undefined, cache);
}
function card(result: FunctionCalls, name = 'api.LIMIT'): NameValue {
  const rows = result.values.filter(value => value.name === name);
  expect(rows, name).toHaveLength(1);
  return rows[0];
}
function unknown(value: NameValue) { expect(value.unknown).toBeTruthy(); expect(value.initial).toBeNull(); expect(value.fixed).toBeNull(); }
async function linked(value: NameValue, name = 'api.LIMIT', group: NameValue['group'] = 'outside') {
  const file = project.files.find(file => file.relativePath === 'own/settings.py')!;
  const source = await readAllowed(root, file.relativePath);
  expect(value).toMatchObject({ name, group, role: 'import', type: 'int', fixed: null, index: null, unknown: null, assignments: [],
    declaredAt: { fileId: file.id, fileHash: source.hash, text: 'LIMIT' }, initial: { kind: 'value', fileId: file.id, fileHash: source.hash, text: '2 + 3' } });
  for (const site of [value.declaredAt!, value.initial!]) expect(source.text.slice(site.startUtf16, site.endUtf16)).toBe(site.text);
  expect(value.notes.length).toBeGreaterThan(0);
}

describe('Python module attribute value origins', () => {
  it.each([
    ['import own.settings as api', 'api.LIMIT'],
    ['import own.settings', 'own.settings.LIMIT'],
    ['from . import settings as api', 'api.LIMIT'],
    ['from own import settings', 'settings.LIMIT'],
    ['from .. import settings as api', 'api.LIMIT'],
  ])('links an explicitly imported module field: %s', async (declaration, access) => {
    const nested = declaration.startsWith('from ..');
    await prepare({ [nested ? 'own/sub/main.py' : 'own/main.py']: `${declaration}\ndef run():\n    return ${access}\n`,
      ...(nested ? { 'own/sub/__init__.py': '' } : {}), 'other/settings.py': 'LIMIT = 999\n' });
    const result = nested ? await findFunctionCalls(root, project.id, project.files, await targetOf('run', 'own/sub/main.py'), MAP_LIMITS) : await search();
    await linked(card(result, access), access);
    for (const [relative, source] of Object.entries(sources)) expect(await readFile(path.join(root, relative), 'utf8')).toBe(source);
  });

  it('marks a function-local module binding as inside', async () => {
    await prepare({ 'own/main.py': 'def run():\n    import own.settings as api\n    return api.LIMIT\n' });
    await linked(card(await search()), 'api.LIMIT', 'inside');
  });

  it('deduplicates normalized access paths while preserving distinct fields and aliases', async () => {
    await prepare({ 'own/settings.py': 'A = 1\nB = 2\n', 'own/main.py': 'import own.settings as api\nimport own.settings as other\ndef run():\n    return api.A + api.Ａ + api.B + other.A\n' });
    const values = (await search()).values;
    expect(values.filter(value => value.name.normalize('NFKC') === 'api.A')).toHaveLength(1);
    expect(values.map(value => value.name)).toEqual(expect.arrayContaining(['api.B', 'other.A']));
    expect(values.filter(value => value.initial?.kind === 'value')).toHaveLength(3);
  });

  it('keeps a from-imported object root instead of labeling its member as the exported object', async () => {
    await prepare({ 'own/settings.py': 'OBJ = object()\n', 'own/main.py': 'from .settings import OBJ\ndef run():\n    return OBJ.attr, OBJ.other\n' });
    const result = await search();
    expect(card(result, 'OBJ')).toMatchObject({ initial: { kind: 'export', text: 'object()' } });
    expect(result.values.some(value => value.name === 'OBJ.attr')).toBe(false);
    expect(result.values.some(value => value.name === 'OBJ.other')).toBe(false);
  });

  it('keeps a module object read separate from a resolved field', async () => {
    await prepare({ 'own/main.py': 'import own.settings as api\ndef run():\n    api\n    return api.LIMIT\n' });
    const result = await search();
    unknown(card(result, 'api'));
    await linked(card(result));
  });

  it('withholds both module and field origins when the module escapes in a returned tuple', async () => {
    await prepare({ 'own/main.py': 'import own.settings as api\ndef run():\n    return api, api.LIMIT\n' });
    const result = await search();
    unknown(card(result, 'api'));
    unknown(card(result));
  });

  it('does not present an object member as the module export expression', async () => {
    await prepare({ 'own/settings.py': 'OBJ = object()\n', 'own/main.py': 'import own.settings as api\ndef run():\n    return api.OBJ.attr\n' });
    const result = await search();
    expect(result.values.some(value => value.initial !== null)).toBe(false);
    expect(result.values.some(value => value.unknown)).toBe(true);
  });

  it.each(['getattr(api, "LIMIT")', 'api[key]'])('does not invent a statically named field for %s', async expression => {
    await prepare({ 'own/main.py': `import own.settings as api\ndef run(key):\n    return ${expression}\n` });
    expect((await search()).values.some(value => value.initial !== null)).toBe(false);
  });

  it('omits successfully linked function callees from value cards', async () => {
    await prepare({ 'own/settings.py': 'def helper():\n    return 1\n', 'own/main.py': 'import own.settings as api\ndef run():\n    return api.helper()\n' });
    const result = await search();
    expect(result.calls[0]).toMatchObject({ status: 'linked' });
    expect(result.values).toEqual([]);
  });

  it.each([
    'import own.settings as api\napi = other\ndef run():\n    return api.LIMIT\n',
    'if flag:\n    import own.settings as api\ndef run():\n    return api.LIMIT\n',
    'import own.settings as api\nimport own.settings as api\ndef run():\n    return api.LIMIT\n',
  ])('does not resolve an ambiguous module binding: %j', async source => {
    await prepare({ 'own/main.py': source });
    const result = await search();
    expect(result.values.some(value => value.initial !== null)).toBe(false);
    expect(result.values.some(value => value.unknown)).toBe(true);
  });

  it('does not mistake a parameter for a module imported under the same name', async () => {
    await prepare({ 'own/main.py': 'import own.settings as api\ndef run(api):\n    return api.LIMIT\n' });
    const result = await search();
    expect(card(result, 'api')).toMatchObject({ group: 'parameter', initial: null });
    expect(result.values.some(value => value.initial !== null)).toBe(false);
  });

  it('withholds a private attribute referenced from a class method', async () => {
    await prepare({ 'own/settings.py': '__secret = 99\n', 'own/main.py': 'import own.settings as api\nclass C:\n    def run(self):\n        return api.__secret\n' });
    const result = await search(MAP_LIMITS, undefined, 'C.run');
    expect(result.values.some(value => value.initial !== null)).toBe(false);
    expect(result.values.some(value => value.unknown)).toBe(true);
  });

  it('withholds a module field changed from another project file', async () => {
    await prepare({ 'own/mutator.py': 'import own.settings as other\nother.LIMIT = 99\n' });
    unknown(card(await search()));
  });

  it.each([
    ['(api).LIMIT = 99', false],
    ['(api).LIMIT = 99', true],
    ['(api).__dict__.update(LIMIT=99)', false],
    ['(api).__dict__.update(LIMIT=99)', true],
  ])('blocks parenthesized mutation %s for direct-from-import=%s', async (mutation, direct) => {
    await prepare({ 'own/mutator.py': `import own.settings as api\n${mutation}\n`,
      'own/main.py': direct ? 'from .settings import LIMIT as limit\ndef run():\n    return limit\n' : main });
    unknown(card(await search(), direct ? 'limit' : 'api.LIMIT'));
  });

  it.each(['(api).LIMIT', '(api.LIMIT)'])('preserves the module source for parenthesized read %s', async access => {
    await prepare({ 'own/main.py': `import own.settings as api\ndef run():\n    return ${access}\n` });
    await linked(card(await search()));
  });

  it('does not confuse a member of a parenthesized exported object with that object', async () => {
    await prepare({ 'own/settings.py': 'OBJ = object()\n', 'own/main.py': 'import own.settings as api\ndef run():\n    return (api.OBJ).attr\n' });
    const result = await search();
    expect(result.values.some(value => value.initial !== null)).toBe(false);
    expect(result.values.some(value => value.unknown)).toBe(true);
  });

  it('does not add a value card for a linked parenthesized callee', async () => {
    await prepare({ 'own/settings.py': 'def helper():\n    return 1\n', 'own/main.py': 'import own.settings as api\ndef run():\n    return (api.helper)()\n' });
    const result = await search();
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toMatchObject({ status: 'linked' });
    expect(result.values).toEqual([]);
  });

  it('does not promote a parent package import to an unimported child module', async () => {
    await prepare({ 'own/main.py': 'import own\ndef run():\n    return own.settings.LIMIT\n' });
    const result = await search();
    expect(result.values.some(value => value.initial !== null)).toBe(false);
    expect(result.values.some(value => value.unknown)).toBe(true);
  });

  it('reports only the package for external module fields', async () => {
    await prepare({ 'own/main.py': 'import math\ndef run():\n    return math.pi\n' });
    expect(card(await search(), 'math.pi')).toMatchObject({ external: 'math', initial: null, fixed: null });
  });

  it('does not double-charge metadata reads and withholds source beyond the file budget', async () => {
    await prepare();
    const bytes = Object.values(sources).reduce((sum, source) => sum + Buffer.byteLength(source), 0);
    const full = await search({ ...MAP_LIMITS, files: 3, bytes });
    await linked(card(full));
    expect(full.limited).toBe(false);
    const limited = await search({ ...MAP_LIMITS, files: 1 });
    expect(limited.limited).toBe(true);
    unknown(card(limited));
  });

  it('upgrades cached facts without changing field source evidence', async () => {
    await prepare({ 'own/other.py': 'def other():\n    pass\n' });
    const cache: CallsCache = { texts: new Map(), parsed: new Map() };
    await findFunctionCalls(root, project.id, project.files, await targetOf('other', 'own/other.py'), MAP_LIMITS, undefined, cache);
    const result = await search(MAP_LIMITS, cache);
    await linked(card(result));
    expect(result.values).toEqual((await search()).values);
  });

  it('rejects stale selected source and cancellation', async () => {
    await prepare();
    const target = await targetOf();
    await expect(findFunctionCalls(root, project.id, project.files, { ...target, fileHash: '0'.repeat(64) }, MAP_LIMITS)).rejects.toMatchObject({ code: 'CHANGED' });
    await expect(findFunctionCalls(root, project.id, project.files, target, MAP_LIMITS, () => true)).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('includes module field origins in the shared result budget', async () => {
    await prepare();
    const full = await search();
    await linked(card(full));
    const budget = JSON.stringify(card(full)).length - 1;
    const limited = await search({ ...MAP_LIMITS, results: budget });
    expect(limited.limited).toBe(true);
    const rows = [limited.calls, limited.callers ?? [], limited.typedCallers, limited.maybeCallers, limited.values].flat();
    expect(rows.reduce((sum, row) => sum + JSON.stringify(row).length, 0)).toBeLessThanOrEqual(budget);
  });
});
