import { afterEach, expect, it } from 'vitest';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanProject, readAllowed } from '../src/core/project/files';
import { analyzeSource } from '../src/core/analysis/syntax';
import { findFunctionCalls } from '../src/core/analysis/calls';
import { findValueShapes } from '../src/core/analysis/shapes';
import { newStopSlots } from '../src/core/analysis/side-stop';
import { changeUsers } from '../src/renderer/change-users';
import { buildProjectMap, MAP_LIMITS } from '../src/core/analysis/project-map';
import { findProjectRoutes } from '../src/core/analysis/routes';
import { buildFeatureFlows } from '../src/core/analysis/feature-flow';
import { searchSymbols } from '../src/renderer/symbol-search';

let root: string;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

it('keeps Java outside calls, values, map and names, and ignores Spring annotations without imports', async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-java-boundaries-')));
  const text = '@RestController class Order { @GetMapping("/orders") int total(int value) { return helper(value); } int helper(int value) { return value; } }';
  await writeFile(path.join(root, 'Order.java'), text);
  const project = await scanProject(root, 'p');
  const file = project.files.find(file => file.relativePath === 'Order.java')!;
  const { hash } = await readAllowed(root, file.relativePath);
  const symbol = analyzeSource(text, file.relativePath, { projectId: 'p', fileId: file.id, fileHash: hash }).symbols[0];
  await expect(findFunctionCalls(root, 'p', project.files, {
    fileId: file.id, fileHash: hash, startUtf16: symbol.evidence.startUtf16, endUtf16: symbol.evidence.endUtf16,
  }, MAP_LIMITS)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  await expect(findValueShapes(root, 'p', project.files, { fileId: file.id, fileHash: hash,
    startUtf16: symbol.evidence.startUtf16, endUtf16: symbol.evidence.endUtf16 }, [], newStopSlots()))
    .rejects.toMatchObject({ code: 'UNSUPPORTED' });
  const map = await buildProjectMap(root, 'p', project.files, []);
  expect(map.files).toEqual([]);
  expect(map.symbols).toEqual([]);
  expect(map.edges).toEqual([]);
  expect(changeUsers(map.files, map.edges, [{ kind: 'modified', path: 'Order.java', oldPath: null, fileId: file.id }])).toEqual([]);
  expect(searchSymbols(map, 'total')).toEqual({ hits: [], total: 0 });
  const routes = await findProjectRoutes(root, 'p', project.files);
  expect(routes.routes).toEqual([]);
  expect(routes.requests).toEqual([]);
  expect(await buildFeatureFlows(root, 'p', project.files, routes)).toEqual([]);
});
