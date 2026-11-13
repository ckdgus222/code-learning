import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { scanProject, readAllowed } from '../src/core/project/files';
import { analyzeSource } from '../src/core/analysis/syntax';
import { findFunctionCalls, type CallsCache } from '../src/core/analysis/calls';
import { MAP_LIMITS } from '../src/core/analysis/project-map';
import type { FunctionCalls, ProjectFiles } from '../src/shared/contracts';
let root: string;
let source: string;
let project: ProjectFiles;
beforeEach(async () => { root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-python-return-'))); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function prepare(text: string) {
  source = text;
  await writeFile(path.join(root, 'main.py'), text);
  project = await scanProject(root, randomUUID());
}
async function targetOf(name = 'run') {
  const file = project.files.find(file => file.relativePath === 'main.py')!;
  const { hash } = await readAllowed(root, 'main.py');
  const symbol = analyzeSource(source, 'main.py', { projectId: project.id, fileId: file.id, fileHash: hash }).symbols.find(symbol => symbol.name === name)!;
  expect(symbol).toBeDefined();
  return { fileId: file.id, fileHash: hash, startUtf16: symbol.evidence.startUtf16, endUtf16: symbol.evidence.endUtf16 };
}
async function search(name = 'run', limits = MAP_LIMITS, cache?: CallsCache) {
  return findFunctionCalls(root, project.id, project.files, await targetOf(name), limits, undefined, cache);
}
function evidence(result: FunctionCalls, raw: string, displayed = raw) {
  const annotation = result.returnAnnotation;
  expect(annotation).toBeDefined();
  expect(annotation).toMatchObject({ fileId: result.fileId, fileHash: result.fileHash, text: displayed });
  expect(source.slice(annotation!.startUtf16, annotation!.endUtf16)).toBe(raw);
  expect(annotation!.startLine).toBe(source.slice(0, annotation!.startUtf16).split('\n').length);
  expect(annotation!.endLine).toBe(source.slice(0, annotation!.endUtf16).split('\n').length);
}
const size = (result: FunctionCalls) => [result.calls, result.callers ?? [], result.typedCallers, result.maybeCallers, result.values,
  result.returnAnnotation ? [result.returnAnnotation] : []].flat().reduce((sum, item) => sum + JSON.stringify(item).length, 0);

describe('Python written return annotations', () => {
  it.each([
    ['plain', 'def run() -> int:\n    return 1\n', 'int'],
    ['async', 'async def run() -> str:\n    return "ok"\n', 'str'],
    ['decorated', '@decorate\ndef run() -> list[int]:\n    return []\n', 'list[int]'],
    ['forward string', 'def run() -> "FutureType":\n    pass\n', '"FutureType"'],
    ['union', 'def run() -> int | None:\n    return None\n', 'int | None'],
  ])('retains the %s annotation as source evidence', async (_, text, annotation) => {
    await prepare(text);
    evidence(await search(), annotation);
  });

  it('uses the chosen nested function annotation rather than its enclosing function', async () => {
    await prepare('def outer() -> int:\n    def run() -> str:\n        return "x"\n    return 1\n');
    evidence(await search(), 'str');
    evidence(await search('outer'), 'int');
  });

  it('retains the full multiline source range with a shortened display line', async () => {
    await prepare('def run() -> tuple[\n    int,\n    str,\n]:\n    pass\n');
    const result = await search();
    const raw = 'tuple[\n    int,\n    str,\n]';
    const shown = result.returnAnnotation?.text;
    expect(shown).toMatch(/^tuple\[.*…$/);
    expect(shown).not.toContain('\n');
    evidence(result, raw, shown!);
  });

  it('reports UTF-16 positions after astral Unicode without shifting annotation evidence', async () => {
    await prepare('# 😀 한글\ndef run() -> "결과😀":\n    pass\n');
    evidence(await search(), '"결과😀"');
  });

  it('does not infer a return annotation from a returned literal', async () => {
    await prepare('def run():\n    return 123\n');
    expect((await search()).returnAnnotation).toBeUndefined();
  });

  it('does not collect a return annotation expression as a function body call', async () => {
    await prepare('def helper():\n    return int\ndef run() -> helper():\n    return 1\n');
    const result = await search();
    evidence(result, 'helper()');
    expect(result.calls).toEqual([]);
  });

  it('caps long display text while retaining the complete original range', async () => {
    const raw = `"${'A'.repeat(400)}"`;
    await prepare(`def run() -> ${raw}:\n    pass\n`);
    const result = await search();
    expect(result.returnAnnotation?.text.length).toBeLessThanOrEqual(300);
    expect(result.returnAnnotation?.text).toMatch(/…$/);
    evidence(result, raw, result.returnAnnotation!.text);
  });

  it('withholds annotation evidence when the parsed file is incomplete', async () => {
    await prepare('def run() -> int:\n    return 1\n@@@\n');
    expect((await search()).returnAnnotation).toBeUndefined();
  });

  it('withholds annotation evidence when the node traversal is cut short', async () => {
    await prepare(`def run() -> int:\n    return 1\n${'x = 1\n'.repeat(20)}`);
    const result = await search('run', { ...MAP_LIMITS, nodesPerFile: 20 });
    expect(result.limited).toBe(true);
    expect(result.returnAnnotation).toBeUndefined();
  });

  it('charges the annotation alongside calls and values against the exact shared result budget', async () => {
    await prepare('def helper():\n    pass\ndef run(p: int) -> str:\n    local = "x"\n    helper()\n    return local\n');
    const full = await search();
    evidence(full, 'str');
    expect(full.calls).toHaveLength(1);
    expect(full.values.length).toBeGreaterThan(0);
    const exact = await search('run', { ...MAP_LIMITS, results: size(full) });
    evidence(exact, 'str');
    expect(exact.limited).toBe(false);
    const tight = await search('run', { ...MAP_LIMITS, results: size(full) - 1 });
    expect(tight.limited).toBe(true);
    expect(tight.returnAnnotation).toBeUndefined();
    expect(size(tight)).toBeLessThanOrEqual(size(full) - 1);
  });

  it('preserves annotation evidence with cached facts and rejects stale selected hashes or cancellation', async () => {
    await prepare('def run() -> int:\n    return 1\n');
    const cache: CallsCache = { texts: new Map(), parsed: new Map() };
    const fresh = await search('run', MAP_LIMITS, cache);
    evidence(fresh, 'int');
    expect((await search('run', MAP_LIMITS, cache)).returnAnnotation).toEqual(fresh.returnAnnotation);
    const target = await targetOf();
    await expect(findFunctionCalls(root, project.id, project.files, { ...target, fileHash: '0'.repeat(64) }, MAP_LIMITS, undefined, cache)).rejects.toMatchObject({ code: 'CHANGED' });
    await expect(findFunctionCalls(root, project.id, project.files, target, MAP_LIMITS, () => true, cache)).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
