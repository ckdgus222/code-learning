import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Evidence, ProjectView, SourceView } from '../src/shared/contracts';
import type { WorkerRequest, WorkerResponse } from '../src/workers/analysis';

const worker = vi.hoisted(() => ({ data: { root: '', projectId: 'aliases', stop: new SharedArrayBuffer(4) },
  receive: null as null | ((request: WorkerRequest) => Promise<void>), send: vi.fn<(response: WorkerResponse) => void>() }));
vi.mock('node:worker_threads', () => ({ workerData: worker.data, parentPort: {
  on: (_event: string, receive: (request: WorkerRequest) => Promise<void>) => { worker.receive = receive; },
  postMessage: worker.send,
} }));
let root: string;
afterEach(async () => {
  vi.restoreAllMocks();
  Atomics.store(new Int32Array(worker.data.stop), 0, 0);
  if (root) await rm(root, { recursive: true, force: true });
});

it('refreshes the guide after only paths changes while reusing the unchanged source analysis', async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-alias-worker-')));
  worker.data.root = root;
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'main.ts'), "import { value } from '@/api'; export function run() { return value; }");
  await writeFile(path.join(root, 'src/first.ts'), 'export const value = 1;');
  await writeFile(path.join(root, 'src/second.ts'), 'export const value = 2;');
  await writeFile(path.join(root, 'tsconfig.json'), '{"compilerOptions":{"paths":{"@/api":["src/first"]}}}');
  const files = await import('../src/core/project/files');
  const scanProject = vi.spyOn(files, 'scanProject');
  await import('../src/workers/analysis');
  await worker.receive!({ id: 1, kind: 'scan' });
  expect(scanProject).toHaveBeenCalledWith(root, 'aliases', expect.any(Function));
  const scanned = worker.send.mock.lastCall![0].result;
  expect(scanned.ok).toBe(true);
  if (!scanned.ok) throw new Error('scan failed');
  const project = scanned.value as ProjectView;
  const fileId = project.files.find(file => file.relativePath === 'main.ts')!.id;
  await worker.receive!({ id: 2, kind: 'read', target: fileId });
  const first = worker.send.mock.lastCall![0].result;
  expect(first.ok).toBe(true);
  if (!first.ok) throw new Error('first read failed');
  const source = first.value as SourceView;
  expect(source.guide?.imports[0].target?.relativePath).toBe('src/first.ts');
  await writeFile(path.join(root, 'tsconfig.json'), '{"compilerOptions":{"paths":{"@/api":["src/second"]}}}');
  await worker.receive!({ id: 3, kind: 'read', target: fileId });
  const second = worker.send.mock.lastCall![0].result;
  expect(second.ok).toBe(true);
  if (!second.ok) throw new Error('second read failed');
  const refreshed = second.value as SourceView;
  expect(refreshed.hash).toBe(source.hash);
  expect(refreshed.analysis).toBe(source.analysis);
  expect(refreshed.guide?.imports[0].target?.relativePath).toBe('src/second.ts');
});

it('forwards the shared stop flag to scanning even when the root has no files', async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-stop-worker-')));
  worker.data.root = root;
  Atomics.store(new Int32Array(worker.data.stop), 0, 1);
  vi.resetModules();
  await import('../src/workers/analysis');
  await worker.receive!({ id: 4, kind: 'scan' });
  expect(worker.send.mock.lastCall![0]).toEqual({ id: 4,
    result: { ok: false, code: 'CANCELLED', message: '탐색을 멈췄습니다.' } });
});

it('reads Python symbols without building a TS/JS file guide', async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-python-worker-')));
  worker.data.root = root;
  await writeFile(path.join(root, 'main.py'), 'def total(value):\n    if value:\n        return value\n');
  vi.resetModules();
  await import('../src/workers/analysis');
  await worker.receive!({ id: 5, kind: 'scan' });
  const scanned = worker.send.mock.lastCall![0].result;
  if (!scanned.ok) throw new Error(scanned.message);
  const file = (scanned.value as ProjectView).files.find(file => file.relativePath === 'main.py')!;
  await worker.receive!({ id: 6, kind: 'read', target: file.id });
  const read = worker.send.mock.lastCall![0].result;
  if (!read.ok) throw new Error(read.message);
  const source = read.value as SourceView;
  expect(source.guide).toBeNull();
  expect(source.analysis.language).toBe('python');
  expect(source.analysis.symbols.map(symbol => symbol.name)).toEqual(['total']);
  expect(source.analysis.symbols[0].steps[0].title).toBe('조건 확인');
});

it('accepts Python class evidence and rejects it after the source changes', async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'learning-class-worker-')));
  worker.data.root = root;
  const text = 'from dataclasses import dataclass\n@dataclass\nclass Item:\n    name: str\n';
  await writeFile(path.join(root, 'main.py'), text);
  vi.resetModules();
  await import('../src/workers/analysis');
  await worker.receive!({ id: 7, kind: 'scan' });
  const scanned = worker.send.mock.lastCall![0].result;
  if (!scanned.ok) throw new Error(scanned.message);
  const file = (scanned.value as ProjectView).files.find(file => file.relativePath === 'main.py')!;
  await worker.receive!({ id: 8, kind: 'read', target: file.id });
  const read = worker.send.mock.lastCall![0].result;
  if (!read.ok) throw new Error(read.message);
  const source = read.value as SourceView;
  const evidence = source.analysis.classes![0].evidence;
  await worker.receive!({ id: 9, kind: 'evidence', target: evidence.id });
  const shown = worker.send.mock.lastCall![0].result;
  if (!shown.ok) throw new Error(shown.message);
  const value = shown.value as { source: SourceView; evidence: Evidence };
  expect(value.evidence).toEqual(evidence);
  expect(value.evidence).toMatchObject({ startLine: 2, endLine: 4 });
  expect(value.source.text.slice(value.evidence.startUtf16, value.evidence.endUtf16)).toBe('@dataclass\nclass Item:\n    name: str');

  await writeFile(path.join(root, 'main.py'), text + '# changed\n');
  await worker.receive!({ id: 10, kind: 'evidence', target: evidence.id });
  expect(worker.send.mock.lastCall![0].result).toMatchObject({ ok: false, code: 'CHANGED' });
  await worker.receive!({ id: 11, kind: 'evidence', target: evidence.id });
  expect(worker.send.mock.lastCall![0].result).toMatchObject({ ok: false, code: 'NOT_ALLOWED' });
});
