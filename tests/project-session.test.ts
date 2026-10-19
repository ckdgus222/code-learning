import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ProjectSession } from '../src/main/project-session';

// A stand-in for the analysis worker. The session worker answers scan and read; a map worker (one
// started with map in its workerData) answers after MAP_DELAY ms, or only when asked to stop if it is
// negative. Like the real one it watches the shared stop flag and then replies CANCELLED.
const fakeWorker = `
const { parentPort, workerData } = require('node:worker_threads');
const delay = Number(process.env.MAP_DELAY);
if (workerData.map) {
  const stop = new Int32Array(workerData.map.stop);
  const started = Date.now();
  const poll = setInterval(() => {
    if (Atomics.load(stop, 0) === 1) {
      clearInterval(poll);
      parentPort.postMessage({ id: 0, result: { ok: false, code: 'CANCELLED', message: 'stopped' } });
    } else if (delay >= 0 && Date.now() - started >= delay) {
      clearInterval(poll);
      parentPort.postMessage({ id: 0, result: { ok: true, value: { projectId: workerData.projectId,
        files: [], edges: [], unresolved: [], external: [], limited: false, notes: [] } } });
    }
  }, 5);
  parentPort.on('message', () => {});
} else {
  parentPort.on('message', request => {
    const file = { id: 'f1', relativePath: 'a.ts', size: 1 };
    const value = request.kind === 'scan'
      ? { id: workerData.projectId, name: 'p', files: [file], excluded: {}, warnings: [],
        overview: { intro: null, candidates: [], checkedFiles: 0, limited: false, notes: [] } }
      : { projectId: workerData.projectId, fileId: 'f1', relativePath: 'a.ts', hash: 'h', text: 'x',
        analysis: { language: 'typescript', symbols: [], imports: [], warnings: [] } };
    parentPort.postMessage({ id: request.id, result: { ok: true, value } });
  });
}`;

let root: string;
let workerPath: string;
let session: ProjectSession;
beforeEach(async () => {
  root = await mkdtemp('/private/tmp/learning-session-test-');
  workerPath = path.join(root, '..', `${path.basename(root)}-worker.cjs`);
  await writeFile(workerPath, fakeWorker);
  await writeFile(path.join(root, 'a.ts'), 'export const a = 1;\n');
  session = new ProjectSession(randomUUID(), root, workerPath, () => undefined);
  await session.open();
});
afterEach(async () => {
  await session.close();
  delete process.env.MAP_DELAY;
  await rm(root, { recursive: true, force: true });
  await rm(workerPath, { force: true });
});

describe('the project map runs in a worker of its own', () => {
  it('keeps answering reads while the map is drawn, and a cancel stops only the map', async () => {
    process.env.MAP_DELAY = '-1';
    const map = session.map();
    await expect(session.read('f1')).resolves.toMatchObject({ fileId: 'f1' });
    session.cancelMap();
    await expect(map).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(session.read('f1')).resolves.toMatchObject({ fileId: 'f1' });
  });

  it('starts a new map right after a cancel, while the old worker is still stopping', async () => {
    process.env.MAP_DELAY = '200';
    const first = session.map();
    session.cancelMap();
    const second = session.map();
    await expect(first).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(second).resolves.toMatchObject({ edges: [] });
  });

  it('refuses a second map while one is being drawn', async () => {
    process.env.MAP_DELAY = '-1';
    const first = session.map();
    await expect(session.map()).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    session.cancelMap();
    await expect(first).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('stops a map that takes too long without closing the session', async () => {
    process.env.MAP_DELAY = '-1';
    await expect(session.map(100)).rejects.toMatchObject({ code: 'LIMIT' });
    await expect(session.read('f1')).resolves.toMatchObject({ fileId: 'f1' });
  });

  it('drops a map when a watched file changes while it is drawn', async () => {
    process.env.MAP_DELAY = '1500';
    // Give the watcher time to start before the change.
    await new Promise(resolve => setTimeout(resolve, 400));
    const map = session.map();
    await writeFile(path.join(root, 'a.ts'), 'export const a = 2;\n');
    await expect(map).rejects.toMatchObject({ code: 'CHANGED' });
  });

  it('returns the map when nothing changed', async () => {
    process.env.MAP_DELAY = '10';
    await expect(session.map()).resolves.toMatchObject({ edges: [], limited: false });
  });

  it('ends the map worker when the session closes', async () => {
    process.env.MAP_DELAY = '-1';
    const map = session.map();
    await session.close();
    await expect(map).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
