import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ProjectSession, workersStopped } from '../src/main/project-session';

// A stand-in for the analysis worker. The session worker answers scan and read; a map or calls worker
// (one started with map or calls in its workerData) answers after MAP_DELAY ms, or only when asked to
// stop if it is negative. Like the real one it watches the shared stop flag and then replies CANCELLED.
const fakeWorker = `
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const delay = Number(process.env.MAP_DELAY);
// Leaves a file in the project folder when a worker replies after being asked to stop.
const mark = name => fs.writeFileSync(path.join(workerData.root, name + '-' + Math.random().toString(36).slice(2)), '');
const side = workerData.map ?? workerData.calls;
if (side) {
  const job = workerData.map ? 'map' : 'calls';
  const stop = new Int32Array(side.stop);
  const started = Date.now();
  const poll = setInterval(() => {
    if (Atomics.load(stop, 0) === 1) {
      clearInterval(poll);
      // Finishing the file it was on takes a moment.
      setTimeout(() => {
        mark(job + '-replied');
        parentPort.postMessage({ id: 0, result: { ok: false, code: 'CANCELLED', message: 'stopped' } });
      }, 150);
    } else if (delay >= 0 && Date.now() - started >= delay) {
      clearInterval(poll);
      parentPort.postMessage({ id: 0, result: { ok: true, value: job === 'map'
        ? { projectId: workerData.projectId, files: [], edges: [], unresolved: [], external: [], limited: false, notes: [] }
        : { projectId: workerData.projectId, calls: [], callers: [], maybeCallers: [] } } });
    }
  }, 5);
  parentPort.on('message', () => {});
} else {
  const stop = new Int32Array(workerData.stop);
  parentPort.on('message', request => {
    if (request.kind === 'read' && process.env.READ_MODE === 'busy') {
      // Like a parse that cannot be interrupted: blocked until the stop flag rises, then a little longer.
      while (Atomics.load(stop, 0) === 0) Atomics.wait(stop, 0, 0, 10);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
      mark('read-replied');
      parentPort.postMessage({ id: request.id, result: { ok: false, code: 'CANCELLED', message: 'stopped' } });
      return;
    }
    if (request.kind === 'read' && process.env.READ_MODE === 'exit') process.exit(1);
    if (request.kind === 'read' && process.env.READ_MODE === 'error') throw new Error('worker failed');
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
  await workersStopped();
  delete process.env.MAP_DELAY;
  delete process.env.READ_MODE;
  await rm(root, { recursive: true, force: true });
  await rm(workerPath, { force: true });
});

const markers = async (name: string) => (await readdir(root)).filter(entry => entry.startsWith(name)).length;
// A worker reads its environment when it starts, so the mode is set before the session is made.
async function sessionIn(mode: string, timeoutMs?: number) {
  process.env.READ_MODE = mode;
  const made = new ProjectSession(randomUUID(), root, workerPath, () => undefined, timeoutMs);
  await made.open();
  return made;
}
const busyRead = async (on: ProjectSession) => {
  const reading = on.read('f1');
  // Let the request reach the worker before closing.
  await new Promise(resolve => setTimeout(resolve, 50));
  return reading;
};

describe('closing never ends a worker in the middle of its work', () => {
  it('answers at once, and ends the worker only after it has replied', async () => {
    const busy = await sessionIn('busy');
    const reading = busyRead(busy);
    await new Promise(resolve => setTimeout(resolve, 60));
    await busy.close();
    await expect(reading).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(await markers('read-replied')).toBe(0);
    await workersStopped();
    expect(await markers('read-replied')).toBe(1);
  });

  it('lets the next session open and read while the closed one is still finishing', async () => {
    const busy = await sessionIn('busy');
    const reading = busyRead(busy);
    await new Promise(resolve => setTimeout(resolve, 60));
    await busy.close();
    await expect(reading).rejects.toMatchObject({ code: 'CANCELLED' });
    delete process.env.READ_MODE;
    const next = new ProjectSession(randomUUID(), root, workerPath, () => undefined);
    await next.open();
    await expect(next.read('f1')).resolves.toMatchObject({ fileId: 'f1' });
    expect(await markers('read-replied')).toBe(0);
    await next.close();
    await workersStopped();
    expect(await markers('read-replied')).toBe(1);
  });

  it('keeps the same order when a request runs past its time limit', async () => {
    const limited = await sessionIn('busy', 200);
    await expect(limited.read('f1')).rejects.toMatchObject({ code: 'LIMIT' });
    expect(await markers('read-replied')).toBe(0);
    await workersStopped();
    expect(await markers('read-replied')).toBe(1);
  });

  it.each(['exit', 'error'])('ends cleanly when the worker %s without answering', async mode => {
    const failing = await sessionIn(mode);
    await expect(failing.read('f1')).rejects.toMatchObject({ code: 'INTERNAL' });
    await workersStopped();
  });

  it('waits for map workers too: one cancelled and closed, or cancelled and replaced before closing', async () => {
    process.env.MAP_DELAY = '-1';
    const cancelled = session.map();
    session.cancelMap();
    const replacing = session.map();
    await session.close();
    // Watched together: either worker may reply first, and an unwatched rejection fails the run.
    await Promise.all([
      expect(cancelled).rejects.toMatchObject({ code: 'CANCELLED' }),
      expect(replacing).rejects.toMatchObject({ code: 'CANCELLED' }),
    ]);
    await workersStopped();
    expect(await markers('map-replied')).toBe(2);
  });

  it('has nothing to wait for when no worker is busy', async () => {
    await session.close();
    await workersStopped();
    expect(await markers('replied')).toBe(0);
  });
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

describe('the call search runs in a worker of its own', () => {
  const target = { fileId: '6c8af416-7789-478e-8418-a6f851557a8d', fileHash: 'a'.repeat(64), startUtf16: 0, endUtf16: 1 };

  it('replaces the search running when another starts, alongside the map and reads', async () => {
    process.env.MAP_DELAY = '-1';
    const map = session.map();
    const first = session.calls(target);
    const second = session.calls(target);
    await expect(first).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(session.read('f1')).resolves.toMatchObject({ fileId: 'f1' });
    session.cancelCalls();
    await expect(second).rejects.toMatchObject({ code: 'CANCELLED' });
    session.cancelMap();
    await expect(map).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('returns what it found when nothing changed', async () => {
    process.env.MAP_DELAY = '10';
    await expect(session.calls(target)).resolves.toMatchObject({ calls: [], callers: [] });
  });

  it('is waited for on quitting, like the map: a replaced search and the one closed', async () => {
    process.env.MAP_DELAY = '-1';
    const replaced = session.calls(target);
    const closed = session.calls(target);
    await session.close();
    await Promise.all([
      expect(replaced).rejects.toMatchObject({ code: 'CANCELLED' }),
      expect(closed).rejects.toMatchObject({ code: 'CANCELLED' }),
    ]);
    await workersStopped();
    expect(await markers('calls-replied')).toBe(2);
  });
});
