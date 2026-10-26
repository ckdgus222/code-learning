import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lstat, mkdir, mkdtemp, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { LocalWorkerWorkflow } from '../src/core/ai/workflow';
import type { LearningEvent } from '../src/shared/ai';
import { ProjectSession, workersStopped } from '../src/main/project-session';

// A stand-in for the analysis worker. The session worker answers scan and read; a map or calls worker
// (one started with map or calls in its workerData) answers after MAP_DELAY ms, or only when asked to
// stop if it is negative. Like the real one it watches the shared stop flag and then replies CANCELLED.
const fakeWorker = `
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const delay = Number(process.env.MAP_DELAY);
// Leaves a file in MARK_DIR (outside the project folder) when a worker replies after being asked to stop.
const mark = name => fs.writeFileSync(path.join(process.env.MARK_DIR, name + '-' + Math.random().toString(36).slice(2)), '');
const side = workerData.map ?? workerData.calls ?? workerData.routes ?? workerData.flow ?? workerData.flows;
if (workerData.shapes) {
  // A shapes worker with a stand-in for the checker process: one that only waits until it is ended. It follows
  // side-stop.ts: whoever takes the number from the slot ends the process, and the reply comes after its exit.
  const slots = new Int32Array(workerData.shapes.stop);
  const child = require('node:child_process').spawn('sleep', ['30'], { stdio: 'ignore' });
  mark('shapes-pid-' + child.pid);
  const exited = new Promise(resolve => child.once('exit', resolve));
  Atomics.store(slots, 1, child.pid);
  let finished = false;
  const finish = async result => {
    if (finished) return;
    finished = true;
    if (Atomics.compareExchange(slots, 1, child.pid, 0) === child.pid) child.kill('SIGKILL');
    else Atomics.wait(slots, 2, 0);
    await exited;
    parentPort.postMessage({ id: 0, result });
  };
  const stopped = { ok: false, code: 'CANCELLED', message: 'stopped' };
  // Asked to stop before the number was there: the session could not end the process, so the worker does.
  if (Atomics.load(slots, 0) === 1) finish(stopped);
  else if (delay >= 0) setTimeout(() => finish({ ok: true, value: {
    shapes: { projectId: workerData.projectId, returns: { text: 'number', hasAny: false }, names: [], notes: [] },
    watch: JSON.parse(process.env.SHAPES_WATCH || '{"files":[],"links":[]}') } }), delay);
  else exited.then(() => finish(stopped));
  parentPort.on('message', () => {});
} else if (workerData.git) {
  // A git worker (plan v2.3 C-2): it answers after MAP_DELAY ms, or only when asked to stop if it is negative.
  const stop = new Int32Array(workerData.git.stop);
  const job = workerData.git.job;
  const started = Date.now();
  const value = job.mode === 'history' ? { projectId: workerData.projectId, available: true, reason: null, commits: [] }
    : job.mode === 'changes' ? { projectId: workerData.projectId, commit: job.commit, changes: [], notCompared: [], notes: [] }
    : { projectId: workerData.projectId, commit: job.commit, old: { text: 'old' }, now: null };
  const poll = setInterval(() => {
    if (Atomics.load(stop, 0) === 1) {
      clearInterval(poll);
      mark('git-' + job.mode + '-replied');
      parentPort.postMessage({ id: 0, result: { ok: false, code: 'CANCELLED', message: 'stopped' } });
    } else if (delay >= 0 && Date.now() - started >= delay) {
      clearInterval(poll);
      parentPort.postMessage({ id: 0, result: { ok: true, value } });
    }
  }, 5);
  parentPort.on('message', () => {});
} else if (side) {
  const job = workerData.routes ? 'routes' : workerData.flow ? 'flow' : workerData.flows ? 'flows' : workerData.map ? 'map' : 'calls';
  mark(job + '-started');
  const stop = new Int32Array(side.stop);
  const started = Date.now();
  const poll = setInterval(() => {
    if (Atomics.load(stop, 0) === 1 && !process.env.SIDE_IGNORE_STOP) {
      clearInterval(poll);
      // Finishing the file it was on takes a moment.
      setTimeout(() => {
        mark(job + '-replied');
        parentPort.postMessage({ id: 0, result: { ok: false, code: 'CANCELLED', message: 'stopped' } });
      }, 150);
    } else if (delay >= 0 && Date.now() - started >= delay) {
      clearInterval(poll);
      parentPort.postMessage({ id: 0, result: { ok: true, value: job === 'routes' ? { projectId: workerData.projectId, routesId: require('node:crypto').randomUUID(), routes: [{ method: 'GET', path: '/a', handler: { fileId: 'f1', name: 'read' } }], requests: [], links: [], prefix: null, limited: false, notes: [] }
        : job === 'flows' ? [{ projectId: workerData.projectId, routesId: side.routes.routesId, routeIndex: 0, nodes: [], edges: [], limited: false, notes: [] }]
        : job === 'flow' ? { projectId: workerData.projectId, routesId: side.routes.routesId, routeIndex: side.routeIndex, nodes: [], edges: [], limited: false, notes: [] }
        : job === 'map'
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
        guide: null, analysis: { language: 'typescript', symbols: [], imports: [], warnings: [] } };
    parentPort.postMessage({ id: request.id, result: { ok: true, value } });
  });
}`;

let root: string;
// Outside the project folder: a marker written inside it would be a file change the session sees.
let marks: string;
let workerPath: string;
let session: ProjectSession;
beforeEach(async () => {
  root = await mkdtemp('/private/tmp/learning-session-test-');
  marks = await mkdtemp('/private/tmp/learning-session-marks-');
  process.env.MARK_DIR = marks;
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
  delete process.env.SIDE_IGNORE_STOP;
  delete process.env.SHAPES_WATCH;
  await rm(root, { recursive: true, force: true });
  await rm(marks, { recursive: true, force: true });
  delete process.env.MARK_DIR;
  await rm(workerPath, { force: true });
});

const markers = async (name: string) => (await readdir(marks)).filter(entry => entry.startsWith(name)).length;
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

describe('the value-shape search runs in a worker of its own and ends its checker process', () => {
  const target = { fileId: '6c8af416-7789-478e-8418-a6f851557a8d', fileHash: 'a'.repeat(64), startUtf16: 0, endUtf16: 1 };
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const checkerPids = async () => (await readdir(marks)).filter(entry => entry.startsWith('shapes-pid-')).map(entry => Number(entry.split('-')[2]));
  const until = async (done: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 300 && !await done(); i++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(await done()).toBe(true);
  };
  let deps: string;
  beforeEach(async () => { deps = await mkdtemp('/private/tmp/learning-session-deps-'); });
  afterEach(async () => { await rm(deps, { recursive: true, force: true }); });
  const stateOf = async (file: string) => {
    const state = await lstat(file);
    return { path: file, size: state.size, mtimeMs: state.mtimeMs, ctimeMs: state.ctimeMs, dev: state.dev, ino: state.ino };
  };
  async function watching(files: string[], links: { path: string; target: string }[], events: string[]) {
    process.env.SHAPES_WATCH = JSON.stringify({ files: await Promise.all(files.map(stateOf)), links });
    process.env.MAP_DELAY = '10';
    const made = new ProjectSession(randomUUID(), root, workerPath, event => events.push(event.kind));
    await made.open();
    return made;
  }

  it('returns what it found and ends the checker; with no type files read it sets up no watch', async () => {
    process.env.MAP_DELAY = '10';
    await expect(session.shapes(target, [])).resolves.toMatchObject({ returns: { text: 'number' } });
    const pids = await checkerPids();
    expect(pids.length).toBe(1);
    expect(alive(pids[0])).toBe(false);
  });

  it('ends the checker of a replaced, cancelled, timed-out or closed search, even one stuck in a request', async () => {
    process.env.MAP_DELAY = '-1';
    const replaced = session.shapes(target, []);
    const cancelled = session.shapes(target, []);
    await expect(replaced).rejects.toMatchObject({ code: 'CANCELLED' });
    await until(async () => (await checkerPids()).length === 2);
    session.cancelShapes();
    await expect(cancelled).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(session.shapes(target, [], 200)).rejects.toMatchObject({ code: 'LIMIT' });
    const closed = session.shapes(target, []);
    await until(async () => (await checkerPids()).length === 4);
    await session.close();
    await expect(closed).rejects.toMatchObject({ code: 'CANCELLED' });
    await workersStopped();
    expect((await checkerPids()).filter(alive)).toEqual([]);
  });

  it('watches the type files read: changing one after the result is a project change', async () => {
    const file = path.join(deps, 'index.d.ts');
    await writeFile(file, 'export declare const x: 1;\n');
    const events: string[] = [];
    const made = await watching([file], [], events);
    await made.shapes(target, []);
    await writeFile(file, 'export declare const x: 2;\n');
    await until(() => events.includes('changed'));
    await made.close();
  });

  it('watches a link passed on the way: pointing it at another version is a change even though the old files stay', async () => {
    await mkdir(path.join(deps, 'v1'));
    await mkdir(path.join(deps, 'v2'));
    const link = path.join(deps, 'pkg');
    await symlink('v1', link);
    const events: string[] = [];
    const made = await watching([], [{ path: link, target: 'v1' }], events);
    await made.shapes(target, []);
    await unlink(link);
    await symlink('v2', link);
    await until(() => events.includes('changed'));
    await made.close();
  });

  it('refuses a result whose type files changed between reading and the watch being ready', async () => {
    const file = path.join(deps, 'index.d.ts');
    await writeFile(file, 'export declare const x: 1;\n');
    const made = await watching([file], [], []);
    await writeFile(file, 'export declare const x: 22;\n');
    await expect(made.shapes(target, [])).rejects.toMatchObject({ code: 'CHANGED' });
    await made.close();
  });

  it('can be cancelled or closed while the new watch gets ready, which then watches nothing', async () => {
    const file = path.join(deps, 'index.d.ts');
    await writeFile(file, 'export declare const x: 1;\n');
    const events: string[] = [];
    const made = await watching([file], [], events);
    let waiting = 0;
    made.holdTypeWatch = () => { waiting++; return new Promise(resolve => setTimeout(resolve, 300)); };
    const cancelled = made.shapes(target, []);
    await until(() => waiting === 1);
    made.cancelShapes();
    await expect(cancelled).rejects.toMatchObject({ code: 'CANCELLED' });
    const closed = made.shapes(target, []);
    await until(() => waiting === 2);
    await made.close();
    await expect(closed).rejects.toMatchObject({ code: 'CANCELLED' });
    await writeFile(file, 'export declare const x: 2;\n');
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(events).toEqual([]);
  });

  it('fails a result whose watch reports an error or runs out of time after it was ready, before it is adopted', async () => {
    const file = path.join(deps, 'index.d.ts');
    await writeFile(file, 'export declare const x: 1;\n');
    const events: string[] = [];
    const made = await watching([file], [], events);
    made.holdTypeWatch = async watcher => { watcher.emit('error', new Error('watch failed')); };
    await expect(made.shapes(target, [])).rejects.toMatchObject({ code: 'IO' });
    made.holdTypeWatch = () => new Promise(resolve => setTimeout(resolve, 300));
    await expect(made.shapes(target, [], 30_000, 100)).rejects.toMatchObject({ code: 'LIMIT' });
    // Neither watch was kept: a later change is no event.
    made.holdTypeWatch = undefined;
    await writeFile(file, 'export declare const x: 2;\n');
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(events).toEqual([]);
    await made.close();
  });

  it('keeps the watch of the newer search when a replaced one finishes its checks later', async () => {
    const older = path.join(deps, 'older.d.ts');
    const newer = path.join(deps, 'newer.d.ts');
    await writeFile(older, 'export declare const x: 1;\n');
    await writeFile(newer, 'export declare const y: 1;\n');
    const events: string[] = [];
    const made = await watching([older], [], events);
    // The first search is held after its watch is ready and checked; the second one runs through meanwhile.
    let release = () => {};
    let held = false;
    made.holdTypeWatch = () => { made.holdTypeWatch = undefined; held = true; return new Promise(resolve => { release = resolve; }); };
    // Replacing it cancels it at once, so its result is taken from the start.
    const first = made.shapes(target, []).then(() => null, (error: unknown) => error);
    await until(() => held);
    process.env.SHAPES_WATCH = JSON.stringify({ files: [await stateOf(newer)], links: [] });
    // A session's workers read their environment when they start, so the second one sees the newer file.
    await made.shapes(target, []);
    expect(await first).toMatchObject({ code: 'CANCELLED' });
    release();
    await writeFile(newer, 'export declare const y: 2;\n');
    await until(() => events.includes('changed'));
    await made.close();
  });
});

describe('the changes view runs git in workers of its own (plan v2.3 C-2)', () => {
  const commit = 'a'.repeat(40);

  it('replaces a comparison when another starts, cancels only the comparison, and closing stops the rest', async () => {
    process.env.MAP_DELAY = '-1';
    const first = session.changes(commit);
    const old = session.fileDiff(commit, 'a.ts', null);
    const second = session.changes(commit);
    await expect(first).rejects.toMatchObject({ code: 'CANCELLED' });
    session.cancelChanges();
    await expect(second).rejects.toMatchObject({ code: 'CANCELLED' });
    await session.close();
    await expect(old).rejects.toMatchObject({ code: 'CANCELLED' });
    await workersStopped();
    expect(await markers('git-changes-replied')).toBe(2);
    expect(await markers('git-diff-replied')).toBe(1);
  });

  it('returns the commits, the comparison and old code when nothing changed', async () => {
    process.env.MAP_DELAY = '10';
    await expect(session.gitHistory()).resolves.toMatchObject({ available: true });
    await expect(session.changes(commit)).resolves.toMatchObject({ commit, changes: [] });
    await expect(session.fileDiff(commit, 'a.ts', null)).resolves.toMatchObject({ old: { text: 'old' }, now: null });
    // A file now must be one listed when the folder opened.
    await expect(session.fileDiff(commit, null, '6c8af416-7789-478e-8418-a6f851557a8d')).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
  });
});

describe('saved routes and feature flow sessions', () => {
  it('accepts only the latest routes ID, valid index and unchanged revision', async () => {
    process.env.MAP_DELAY = '0';
    const first = await session.routes(3);
    await expect(session.featureFlow(first.routesId, 0, 3)).resolves.toMatchObject({ routesId: first.routesId, routeIndex: 0 });
    for (const index of [-1, .5, 1]) await expect(session.featureFlow(first.routesId, index, 3)).rejects.toMatchObject({ code: 'CHANGED' });
    await expect(session.featureFlow(first.routesId, 0, 4)).rejects.toMatchObject({ code: 'CHANGED' });
    const second = await session.routes(3);
    expect(second.routesId).not.toBe(first.routesId);
    await expect(session.featureFlow(first.routesId, 0, 3)).rejects.toMatchObject({ code: 'CHANGED' });
  });
  it.each(['routes', 'flow', 'flows'] as const)('cancels %s without blocking source reads', async job => {
    process.env.MAP_DELAY = '0';
    const routes = await session.routes();
    process.env.MAP_DELAY = '-1';
    const pending = job === 'routes' ? session.routes() : job === 'flows' ? session.featureFlows(routes.routesId) : session.featureFlow(routes.routesId, 0);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(session.read('f1')).resolves.toMatchObject({ fileId: 'f1' });
    if (job === 'routes') session.cancelRoutes(); else if (job === 'flows') session.cancelFeatureFlows(); else session.cancelFeatureFlow();
    await rejected;
  });
  it.each(['routes', 'flow', 'flows'] as const)('rejects a project change during %s', async job => {
    process.env.MAP_DELAY = '0';
    const routes = await session.routes();
    process.env.MAP_DELAY = '250';
    const before = await markers(job + '-started');
    const pending = job === 'routes' ? session.routes() : job === 'flows' ? session.featureFlows(routes.routesId) : session.featureFlow(routes.routesId, 0);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CHANGED' });
    await expect.poll(() => markers(job + '-started')).toBeGreaterThan(before);
    await writeFile(path.join(root, 'a.ts'), 'export const changed = 2;');
    await rejected;
    await expect(session.featureFlow(routes.routesId, 0)).rejects.toMatchObject({ code: 'CHANGED' });
  });
  it.each(['routes', 'flow', 'flows'] as const)('drops %s from a closed project and permits another session', async job => {
    process.env.MAP_DELAY = '0';
    const routes = await session.routes();
    process.env.MAP_DELAY = '-1';
    const pending = job === 'routes' ? session.routes() : job === 'flows' ? session.featureFlows(routes.routesId) : session.featureFlow(routes.routesId, 0);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    await session.close();
    const next = new ProjectSession(randomUUID(), root, workerPath, () => undefined);
    try {
      await next.open();
      await expect(next.read('f1')).resolves.toMatchObject({ fileId: 'f1' });
      await expect(next.featureFlow(routes.routesId, 0)).rejects.toMatchObject({ code: 'CHANGED' });
      await rejected;
    } finally { await next.close(); }
  });
  it('a replacement routes search cannot be overwritten by an older result', async () => {
    process.env.MAP_DELAY = '100';
    const older = session.routes();
    const rejected = expect(older).rejects.toMatchObject({ code: 'CANCELLED' });
    process.env.MAP_DELAY = '0';
    const current = await session.routes();
    await rejected;
    await expect(session.featureFlow(current.routesId, 0)).resolves.toMatchObject({ routesId: current.routesId });
  });
});

it.each(['routes', 'flow', 'flows'] as const)('drops a late successful %s result after cancellation', async job => {
  process.env.MAP_DELAY = '0';
  const routes = await session.routes();
  process.env.SIDE_IGNORE_STOP = '1';
  process.env.MAP_DELAY = '100';
  const pending = job === 'routes' ? session.routes() : job === 'flows' ? session.featureFlows(routes.routesId) : session.featureFlow(routes.routesId, 0);
  const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  if (job === 'routes') session.cancelRoutes(); else if (job === 'flows') session.cancelFeatureFlows(); else session.cancelFeatureFlow();
  await rejected;
});


describe('feature guide session freshness', () => {
  it.each(['different-id', 'changed-file', 'wake', 'cancelled-routes'] as const)('rejects %s before any AI call even with a saved routes result', async reason => {
    process.env.MAP_DELAY = '0';
    const routes = await session.routes(3);
    expect(session.captureFeatureGuide(routes.routesId, 3).material.routes[0]).toMatchObject({ index: 0, path: '/a', file: 'a.ts' });
    if (reason === 'cancelled-routes') session.cancelRoutes();
    if (reason === 'changed-file') {
      await writeFile(path.join(root, 'a.ts'), 'export const changed = 99;');
      await expect.poll(() => { try { session.validateFeatureGuide(routes.routesId, 3); return false; } catch { return true; } }).toBe(true);
    }
    const events: LearningEvent[] = [];
    const run = vi.fn();
    const workflow = new LocalWorkerWorkflow({ assertReady() {}, run, emit: event => events.push(event),
      captureFeatureGuide: async request => session.captureFeatureGuide(request.routesId, reason === 'wake' ? 4 : 3),
      capture: vi.fn(), captureOverview: vi.fn(), captureFile: vi.fn(), expand: vi.fn(), revalidate: vi.fn(), revalidateFeatureGuide: vi.fn() });
    workflow.startFeatureGuide({ projectId: session.id, routesId: reason === 'different-id' ? randomUUID() : routes.routesId, mode: 'codex', consent: true });
    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ kind: 'failed', error: { code: 'CHANGED' } }));
    expect(run).not.toHaveBeenCalled();
    await workflow.close();
  });
  it('cancels a running guide when the session searches again and discards a late success', async () => {
    process.env.MAP_DELAY = '0';
    const routes = await session.routes(3);
    const events: LearningEvent[] = [];
    let release!: () => void;
    const run = vi.fn(async () => {
      await new Promise<void>(resolve => { release = resolve; });
      return { reportedModel: null, value: { summary: '요약', groups: [], unknowns: [] } };
    });
    const workflow = new LocalWorkerWorkflow({ assertReady() {}, run, emit: event => events.push(event),
      captureFeatureGuide: async request => session.captureFeatureGuide(request.routesId, 3),
      capture: vi.fn(), captureOverview: vi.fn(), captureFile: vi.fn(), expand: vi.fn(),
      revalidate: vi.fn(), revalidateFeatureGuide: async snapshot => session.validateFeatureGuide(snapshot.routesId, 3) });
    session.onRoutesInvalidated = () => workflow.cancelFeatureGuide(session.id);
    workflow.startFeatureGuide({ projectId: session.id, routesId: routes.routesId, mode: 'codex', consent: true });
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    const newer = await session.routes(3);
    expect(newer.routesId).not.toBe(routes.routesId);
    release();
    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ kind: 'failed', error: { code: 'CANCELLED' } }));
    expect(events.some(event => event.kind === 'feature-guide-completed')).toBe(false);
    expect(() => session.captureFeatureGuide(routes.routesId, 3)).toThrow('기능 목록이 바뀌었어요');
    await workflow.close();
  });
});


describe('screen grouping freshness and independent cancellation', () => {
  it.each(['replace', 'cancel'] as const)('discards grouping after routes %s, even if its worker reports success', async action => {
    process.env.MAP_DELAY = '0';
    const routes = await session.routes(3);
    process.env.SIDE_IGNORE_STOP = '1';
    process.env.MAP_DELAY = '100';
    const pending = session.featureFlows(routes.routesId, 3);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    if (action === 'replace') await session.routes(3);
    else session.cancelRoutes();
    await rejected;
  });
  it('validates route IDs and revisions and permits a single flow alongside grouping', async () => {
    process.env.MAP_DELAY = '0';
    const routes = await session.routes(3);
    await expect(session.featureFlows(routes.routesId, 4)).rejects.toMatchObject({ code: 'CHANGED' });
    await expect(session.featureFlows(randomUUID(), 3)).rejects.toMatchObject({ code: 'CHANGED' });
    await expect(session.featureFlows(routes.routesId, 3)).resolves.toMatchObject([{ routeIndex: 0 }]);
    process.env.MAP_DELAY = '-1';
    const pending = session.featureFlows(routes.routesId, 3);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    process.env.MAP_DELAY = '0';
    await expect(session.featureFlow(routes.routesId, 0, 3)).resolves.toMatchObject({ routeIndex: 0 });
    session.cancelFeatureFlows();
    await rejected;
    process.env.MAP_DELAY = '-1';
    await expect(session.featureFlows(routes.routesId, 3, 50)).rejects.toMatchObject({ code: 'LIMIT' });
    await expect(session.read('f1')).resolves.toMatchObject({ fileId: 'f1' });
  });
});
