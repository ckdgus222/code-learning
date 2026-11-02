import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { lstat, readlink } from 'node:fs/promises';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { ProjectRoutes, FeatureFlow, Evidence, FileDiff, FunctionCalls, GitHistory, ProjectChanges, ProjectEvent, ProjectMap, ProjectView, Result, ShapeQuery, SourceView,
  ValueShapes } from '../shared/contracts';
import { featureGuideMaterial, type FeatureGuideSnapshot } from '../core/ai/feature-guide';
import { AppError } from '../shared/errors';
import type { WorkerRequest, WorkerResponse } from '../workers/analysis';
import type { TypeWatch } from '../core/analysis/shapes';
import { newStopSlots, requestStop } from '../core/analysis/side-stop';

// Ending a worker thread while Tree-sitter parses aborts the whole app (Napi::Error). So a worker is
// only asked to stop, through a shared flag it checks before each parse, and is terminated once it has
// replied. Until then its cleanup is kept here, and quitting waits for all of them.
const cleanups = new Set<Promise<unknown>>();
function keepUntilDone(cleanup: Promise<unknown>): void {
  cleanups.add(cleanup);
  const forget = () => { cleanups.delete(cleanup); };
  cleanup.then(forget, forget);
}
/** Resolves once no session or map worker is left, including ones that started while waiting. */
export async function workersStopped(): Promise<void> {
  while (cleanups.size) await Promise.allSettled([...cleanups]);
}

// Jobs that read the whole project in a worker of their own, so the session's worker keeps answering reads.
type SideJob = 'routes' | 'flow' | 'flows' | 'map' | 'plan-map' | 'calls' | 'shapes' | 'history' | 'changes' | 'diff';
const sideWords: Record<SideJob, { failed: string; ended: string; slow: string; changed: string }> = {
  routes: { failed: '주소를 찾지 못했어요.', ended: '주소 찾기가 끝났어요.', slow: '주소 찾기 시간이 초과됐어요.', changed: '주소를 찾는 동안 파일이 바뀌었어요.' },
  flows: { failed: '화면별로 묶지 못했어요.', ended: '화면별로 묶기가 끝났어요.', slow: '화면별로 묶기 시간이 초과됐어요.', changed: '화면별로 묶는 동안 파일이 바뀌었어요.' },
  flow: { failed: '기능 흐름을 찾지 못했어요.', ended: '기능 흐름 찾기가 끝났어요.', slow: '기능 흐름 찾기 시간이 초과됐어요.', changed: '기능 흐름을 찾는 동안 파일이 바뀌었어요.' },
  map: { failed: '지도를 만들지 못했어요.', ended: '지도 작업이 끝나 버렸어요.', slow: '지도를 만드는 데 너무 오래 걸려 멈췄어요.',
    changed: '지도를 만드는 동안 파일이 바뀌었어요. 다시 만들어 주세요.' },
  'plan-map': { failed: '지도를 만들지 못했어요.', ended: '지도 작업이 끝나 버렸어요.', slow: '지도를 만드는 데 너무 오래 걸려 멈췄어요.',
    changed: '확인하는 동안 파일이 바뀌었어요.' },
  calls: { failed: '호출을 찾지 못했어요.', ended: '호출 찾기 작업이 끝나 버렸어요.', slow: '호출을 찾는 데 너무 오래 걸려 멈췄어요.',
    changed: '호출을 찾는 동안 파일이 바뀌었어요. 다시 찾아 주세요.' },
  shapes: { failed: '값의 모양을 찾지 못했어요.', ended: '값의 모양 찾기 작업이 끝나 버렸어요.', slow: '값의 모양을 찾는 데 너무 오래 걸려 멈췄어요.',
    changed: '값의 모양을 찾는 동안 파일이 바뀌었어요. 다시 찾아 주세요.' },
  history: { failed: 'Git 기록을 읽지 못했어요.', ended: 'Git 기록 읽기 작업이 끝나 버렸어요.', slow: 'Git 기록을 읽는 데 너무 오래 걸려 멈췄어요.',
    changed: 'Git 기록을 읽는 동안 파일이 바뀌었어요. 다시 읽어 주세요.' },
  changes: { failed: '변경을 비교하지 못했어요.', ended: '비교 작업이 끝나 버렸어요.', slow: '비교하는 데 너무 오래 걸려 멈췄어요.',
    changed: '비교하는 동안 파일이 바뀌었어요. 다시 비교해 주세요.' },
  diff: { failed: '코드를 열지 못했어요.', ended: '코드 열기 작업이 끝나 버렸어요.', slow: '코드를 여는 데 너무 오래 걸려 멈췄어요.',
    changed: '코드를 여는 동안 파일이 바뀌었어요. 다시 열어 주세요.' },
};
const changedTypes = '모양을 찾는 동안 외부 패키지 타입 파일이 바뀌었어요. 다시 찾아 주세요.';
// On macOS, chokidar missed 2 of 240 immediate v1 → v2 link replacements; reread targets as an event fallback.
const LINK_RECHECK_MS = 1000;

export class ProjectSession {
  private worker: Worker;
  private readonly stop = new Int32Array(new SharedArrayBuffer(4));
  /** Settles when the worker answers the request it is working on, or ends: it is then not parsing. */
  private idle: Promise<void> = Promise.resolve();
  private markIdle = () => {};
  private watcher?: FSWatcher;
  private pending = new Map<number, { resolve: (result: WorkerResponse['result']) => void; timer: ReturnType<typeof setTimeout> }>();
  private requestId = 0;
  private closed = false;
  private observedChanges = 0;
  private project?: ProjectView;
  /** The side jobs running, one per job, and the slots that ask each worker to stop (side-stop.ts). They may run together. */
  private sideRuns: Partial<Record<SideJob, { worker: Worker; stop: Int32Array }>> = {};
  /** The dependency type files the shown shapes were read from (plan v2.3 V-2), and a wait for a new watch to be ready. */
  private typeWatcher?: FSWatcher;
  private stopTypeLinkRecheck?: () => void;
  private abortTypeWatch?: () => void;
  /** Counts shape searches and their cancels: a search adopts its watch only while it is still the latest. */
  private shapesRun = 0;
  private routesRun = 0;
  private flowRun = 0;
  private flowsRun = 0;
  private lastRoutes?: { result: ProjectRoutes; observed: number; revision: number };

  onRoutesInvalidated?: () => void;

  /** Tests only: holds a new type watch back after it is ready and checked, just before it would be adopted. */
  holdTypeWatch?: (watcher: FSWatcher) => Promise<void>;
  /** Tests only: delays a periodic link read to exercise events, replacement and closing during the read. */
  readTypeLink?: (filename: string) => Promise<string>;

  constructor(readonly id: string, readonly root: string, private readonly workerPath: string, private notify: (event: ProjectEvent) => void,
    private readonly requestTimeoutMs = 30_000) {
    this.worker = new Worker(workerPath, { workerData: { root, projectId: id, stop: this.stop.buffer } });
    this.worker.on('message', (message: WorkerResponse) => {
      this.markIdle();
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      pending.resolve(message.result);
    });
    this.worker.on('error', () => { this.markIdle(); void this.close('INTERNAL'); });
    this.worker.on('exit', () => { this.markIdle(); if (!this.closed) void this.close('INTERNAL'); });
  }

  private async request<T>(kind: WorkerRequest['kind'], target?: string): Promise<T> {
    if (this.closed) throw new AppError('PROJECT_CLOSED', '프로젝트가 닫혔습니다. 다시 열어 주세요.');
    if (this.pending.size) throw new AppError('INVALID_REQUEST', '진행 중인 읽기 작업이 있습니다. 잠시 뒤 다시 시도해 주세요.');
    const id = ++this.requestId;
    this.idle = new Promise(resolve => { this.markIdle = resolve; });
    const result = await new Promise<WorkerResponse['result']>(resolve => {
      const timer = setTimeout(() => { void this.close('LIMIT'); }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, timer });
      this.worker.postMessage({ id, kind, target } satisfies WorkerRequest);
    });
    if (!result.ok) throw new AppError(result.code, result.message);
    if (this.closed) throw new AppError('CANCELLED', '취소한 결과는 표시하지 않습니다.');
    return result.value as T;
  }

  async open(): Promise<ProjectView> {
    const project = await this.request<ProjectView>('scan');
    this.project = project;
    const paths = new Set<string>(['.gitignore']);
    for (const file of project.files) {
      paths.add(file.relativePath);
      let dir = path.posix.dirname(file.relativePath);
      while (dir !== '.') { paths.add(`${dir}/.gitignore`); dir = path.posix.dirname(dir); }
    }
    // Watch only approved files and their ignore rules. Newly added files appear on reopening.
    this.watcher = chokidar.watch([...paths].map(relative => path.join(this.root, relative)), {
      persistent: true, ignoreInitial: true, followSymlinks: false, depth: 0,
      ignored: (_filename, stats) => !!stats?.isSymbolicLink(),
    });
    this.watcher.on('all', () => {
      if (!this.closed) { this.observedChanges++; this.notify({ projectId: this.id, kind: 'changed' }); }
    });
    this.watcher.on('error', () => {
      if (!this.closed) { this.observedChanges++; this.notify({ projectId: this.id, kind: 'watch-error' }); }
    });
    return project;
  }

  relativePathOf(fileId: string): string {
    if (this.closed || !this.project) throw new AppError('PROJECT_CLOSED', '프로젝트를 다시 열어 주세요.');
    const file = this.project.files.find(item => item.id === fileId);
    if (!file) throw new AppError('NOT_ALLOWED', '현재 프로젝트에 등록된 파일이 아닙니다.');
    return file.relativePath;
  }

  async read(fileId: string): Promise<SourceView> {
    const revision = this.observedChanges;
    const result = await this.request<SourceView>('read', fileId);
    if (revision !== this.observedChanges) throw new AppError('CHANGED', '읽는 동안 프로젝트가 바뀌었습니다. 다시 읽어 주세요.');
    return result;
  }

  async evidence(evidenceId: string): Promise<{ source: SourceView; evidence: Evidence }> {
    const revision = this.observedChanges;
    const result = await this.request<{ source: SourceView; evidence: Evidence }>('evidence', evidenceId);
    if (revision !== this.observedChanges) throw new AppError('CHANGED', '근거 확인 중 코드가 바뀌었습니다. 다시 읽어 주세요.');
    return result;
  }

  async routes(revision = 0, timeoutMs = 30_000): Promise<ProjectRoutes> {
    if (this.closed || !this.project) throw new AppError('PROJECT_CLOSED', '프로젝트를 다시 열어 주세요.');
    this.cancelRoutes();
    const run = this.routesRun;
    const observed = this.observedChanges;
    const files = this.project.files;
    const result = await this.runSide('routes', stop => ({ routes: { files, stop } }), timeoutMs) as ProjectRoutes;
    if (run !== this.routesRun || this.closed) throw new AppError('CANCELLED', '취소한 주소 결과는 버렸어요.');
    if (observed !== this.observedChanges) throw new AppError('CHANGED', '파일이 바뀌었어요. 주소를 다시 찾아 주세요.');
    this.lastRoutes = { result, observed, revision };
    return result;
  }

  async featureFlow(routesId: string, routeIndex: number, revision = 0, timeoutMs = 30_000): Promise<FeatureFlow> {
    if (this.closed || !this.project) throw new AppError('PROJECT_CLOSED', '프로젝트를 다시 열어 주세요.');
    const saved = this.currentRoutes(routesId, revision);
    if (!Number.isInteger(routeIndex) || routeIndex < 0 || routeIndex >= saved.result.routes.length) {
      throw new AppError('CHANGED', '기능 목록이 바뀌었어요. 주소를 다시 찾아 주세요.');
    }
    this.cancelFeatureFlow();
    const run = this.flowRun;
    const files = this.project.files;
    const result = await this.runSide('flow', stop => ({ flow: { files, routes: saved.result, routeIndex, stop } }), timeoutMs) as FeatureFlow;
    if (run !== this.flowRun || this.closed) throw new AppError('CANCELLED', '취소한 기능 흐름은 버렸어요.');
    if (saved !== this.lastRoutes || saved.observed !== this.observedChanges) throw new AppError('CHANGED', '기능 목록을 다시 찾아 주세요.');
    return result;
  }

  async featureFlows(routesId: string, revision = 0, timeoutMs = 60_000): Promise<FeatureFlow[]> {
    if (this.closed || !this.project) throw new AppError('PROJECT_CLOSED', '프로젝트를 다시 열어 주세요.');
    const saved = this.currentRoutes(routesId, revision);
    this.cancelFeatureFlows();
    const run = this.flowsRun;
    const files = this.project.files;
    const result = await this.runSide('flows', stop => ({ flows: { files, routes: saved.result, stop } }), timeoutMs) as FeatureFlow[];
    if (run !== this.flowsRun || this.closed) throw new AppError('CANCELLED', '취소한 화면 묶음은 버렸어요.');
    if (saved !== this.lastRoutes || saved.observed !== this.observedChanges) throw new AppError('CHANGED', '기능 목록을 다시 찾아 주세요.');
    return result;
  }

  private currentRoutes(routesId: string, revision: number) {
    const saved = this.lastRoutes;
    if (this.closed || !this.project || !saved || saved.result.routesId !== routesId || saved.revision !== revision || saved.observed !== this.observedChanges) {
      throw new AppError('CHANGED', '기능 목록이 바뀌었어요. 주소를 다시 찾아 주세요.');
    }
    return saved;
  }

  captureFeatureGuide(routesId: string, revision: number): FeatureGuideSnapshot & { materialHash: string } {
    const saved = this.currentRoutes(routesId, revision);
    const { material, limitations } = featureGuideMaterial(this.project!, saved.result);
    const materialHash = createHash('sha256').update(JSON.stringify({ material,
      handlerHashes: saved.result.routes.map(route => route.handler.fileHash),
      requestHashes: saved.result.requests.map(request => request.fileHash),
    })).digest('hex');
    return { projectId: this.id, routesId, revision, material, limitations, materialHash };
  }

  validateFeatureGuide(routesId: string, revision: number): void { this.currentRoutes(routesId, revision); }

  cancelRoutes(): void { this.onRoutesInvalidated?.(); this.routesRun++; this.lastRoutes = undefined; this.cancelSide('routes'); this.cancelFeatureFlow(); this.cancelFeatureFlows(); }
  cancelFeatureFlows(): void { this.flowsRun++; this.cancelSide('flows'); }
  cancelFeatureFlow(): void { this.flowRun++; this.cancelSide('flow'); }

  /** Draws the project map from the files listed when the folder was opened. */
  async map(timeoutMs = 30_000, job: 'map' | 'plan-map' = 'map'): Promise<ProjectMap> {
    if (this.closed || !this.project) throw new AppError('PROJECT_CLOSED', '프로젝트가 닫혔습니다. 다시 열어 주세요.');
    if (this.sideRuns[job]) throw new AppError('INVALID_REQUEST', '이미 지도를 만드는 중입니다.');
    const { files, overview } = this.project;
    return await this.runSide(job, stop => ({ map: { files, starts: overview.candidates.map(candidate => candidate.fileId), entries: overview.entryFileIds, stop } }), timeoutMs) as ProjectMap;
  }

  /** Finds what one function calls and where it is called from. Asking for another function replaces the search. */
  async calls(target: { fileId: string; fileHash: string; startUtf16: number; endUtf16: number }, timeoutMs = 30_000): Promise<FunctionCalls> {
    if (this.closed || !this.project) throw new AppError('PROJECT_CLOSED', '프로젝트가 닫혔습니다. 다시 열어 주세요.');
    this.cancelCalls();
    const { files } = this.project;
    return await this.runSide('calls', stop => ({ calls: { files, target, stop } }), timeoutMs) as FunctionCalls;
  }

  /**
   * Finds the shapes the TypeScript checker reads for one function and the names asked (plan v2.3 V-2). Asking
   * for another function replaces the search. The type files it read are then watched like the project's files.
   */
  async shapes(target: { fileId: string; fileHash: string; startUtf16: number; endUtf16: number }, names: ShapeQuery[],
    timeoutMs = 30_000, watchTimeoutMs = 10_000): Promise<ValueShapes> {
    if (this.closed || !this.project) throw new AppError('PROJECT_CLOSED', '프로젝트가 닫혔습니다. 다시 열어 주세요.');
    this.cancelShapes();
    const run = this.shapesRun;
    const { files } = this.project;
    const found = await this.runSide('shapes', stop => ({ shapes: { files, target, names, stop } }), timeoutMs) as { shapes: ValueShapes; watch: TypeWatch };
    return await this.watchTypes(found.shapes, found.watch, watchTimeoutMs, run);
  }

  /** The commits that changed the opened folder (plan v2.3 C-2), or why its Git history cannot be used. */
  async gitHistory(timeoutMs = 30_000): Promise<GitHistory> {
    if (this.closed || !this.project) throw new AppError('PROJECT_CLOSED', '프로젝트가 닫혔습니다. 다시 열어 주세요.');
    this.cancelSide('history');
    return await this.runSide('history', stop => ({ git: { job: { mode: 'history' }, stop } }), timeoutMs) as GitHistory;
  }

  /** The files listed when the folder opened, compared with a commit. Asking again replaces the comparison. */
  async changes(commit: string, timeoutMs = 30_000): Promise<ProjectChanges> {
    if (this.closed || !this.project) throw new AppError('PROJECT_CLOSED', '프로젝트가 닫혔습니다. 다시 열어 주세요.');
    this.cancelChanges();
    const { files } = this.project;
    return await this.runSide('changes', stop => ({ git: { job: { mode: 'changes', files, commit }, stop } }), timeoutMs) as ProjectChanges;
  }

  /**
   * One change's two sides: the old path in a commit and a listed file now, both read in a side worker. The reader's
   * own worker is not used, so the file open there and its evidence stay as they are. Opening another replaces it.
   */
  async fileDiff(commit: string, oldPath: string | null, fileId: string | null, timeoutMs = 30_000): Promise<FileDiff> {
    if (this.closed || !this.project) throw new AppError('PROJECT_CLOSED', '프로젝트가 닫혔습니다. 다시 열어 주세요.');
    const file = fileId === null ? null : this.project.files.find(item => item.id === fileId);
    if (file === undefined) throw new AppError('NOT_ALLOWED', '현재 프로젝트에 등록된 파일이 아닙니다.');
    if (oldPath === null && file === null) throw new AppError('INVALID_REQUEST', '열 코드가 없어요.');
    this.cancelSide('diff');
    return await this.runSide('diff', stop => ({ git: { job: { mode: 'diff', commit, oldPath, nowPath: file?.relativePath ?? null }, stop } }),
      timeoutMs) as FileDiff;
  }

  /**
   * Starts watching the type files a result was read from, and checks them again once the watch is ready: a file
   * changed in between makes the result CHANGED. Until then the request is still running and can be cancelled.
   * Only then does the new watch replace the one for the shapes shown before.
   */
  private async watchTypes(shapes: ValueShapes, watch: TypeWatch, timeoutMs: number, run: number): Promise<ValueShapes> {
    // A search cancelled or replaced while it waited must not touch the watch of the shapes shown now.
    const current = () => run === this.shapesRun && !this.closed;
    const paths = [...watch.files.map(file => file.path), ...watch.links.map(link => link.path)];
    if (!paths.length) {
      if (!current()) throw new AppError('CANCELLED', '취소한 결과는 표시하지 않습니다.');
      // chokidar never reports an empty watch ready.
      await this.replaceTypeWatcher(undefined);
      return shapes;
    }
    const revision = this.observedChanges;
    // A link is watched as itself, so pointing it elsewhere counts as a change.
    const watcher = chokidar.watch(paths, { persistent: true, ignoreInitial: true, followSymlinks: false, depth: 0 });
    let ready = false;
    let adopted = false;
    let changedEarly = false;
    let recheckTimer: ReturnType<typeof setInterval> | undefined;
    let recheckStopped = false;
    let recheckRunning = false;
    const stopRecheck = () => {
      recheckStopped = true;
      clearInterval(recheckTimer);
    };
    // Until the watch is adopted, an error, the time limit or a cancel fails the whole wait, checks included.
    let fail = (_error: AppError) => {};
    const failed = new Promise<never>((_, reject) => { fail = reject; });
    failed.catch(() => {});
    watcher.on('all', () => {
      // Before 'ready' chokidar reports what it first finds (a watched link as 'add', even with ignoreInitial); a change
      // in that time is caught by the check after 'ready'.
      if (!ready) return;
      if (!adopted) changedEarly = true;
      else if (!this.closed && this.typeWatcher === watcher) {
        stopRecheck();
        this.observedChanges++;
        this.notify({ projectId: this.id, kind: 'changed' });
      }
    });
    watcher.on('error', () => {
      if (!adopted) fail(new AppError('IO', '타입 파일을 감시하지 못했어요.'));
      else if (!this.closed && this.typeWatcher === watcher) { this.observedChanges++; this.notify({ projectId: this.id, kind: 'watch-error' }); }
    });
    const abort = () => fail(new AppError('CANCELLED', '취소한 결과는 표시하지 않습니다.'));
    this.abortTypeWatch = abort;
    const timer = setTimeout(() => fail(new AppError('LIMIT', '타입 파일 감시를 준비하는 데 너무 오래 걸려 멈췄어요.')), timeoutMs);
    const readyAndChecked = async () => {
      await new Promise<void>(resolve => watcher.once('ready', () => { ready = true; resolve(); }));
      const same = await Promise.all([
        ...watch.files.map(async file => {
          const now = await lstat(file.path).catch(() => null);
          return !!now && now.isFile() && now.size === file.size && now.mtimeMs === file.mtimeMs && now.ctimeMs === file.ctimeMs &&
            now.dev === file.dev && now.ino === file.ino;
        }),
        ...watch.links.map(async link => await readlink(link.path).catch(() => null) === link.target),
      ]);
      await this.holdTypeWatch?.(watcher);
      return same;
    };
    try {
      const same = await Promise.race([readyAndChecked(), failed]);
      if (!current()) throw new AppError('CANCELLED', '취소한 결과는 표시하지 않습니다.');
      if (changedEarly || same.includes(false)) throw new AppError('CHANGED', changedTypes);
      if (revision !== this.observedChanges) throw new AppError('CHANGED', sideWords.shapes.changed);
    } catch (error) {
      await watcher.close();
      throw error;
    } finally {
      clearTimeout(timer);
      if (this.abortTypeWatch === abort) this.abortTypeWatch = undefined;
    }
    // Adopted in the same turn as the last check, so no event falls between them.
    adopted = true;
    const recheckLinks = async () => {
      if (recheckStopped || recheckRunning || this.closed || this.typeWatcher !== watcher) return;
      recheckRunning = true;
      const same = await Promise.all(watch.links.map(async link =>
        await (this.readTypeLink ?? readlink)(link.path).catch(() => null) === link.target));
      recheckRunning = false;
      // Clearing the timer cannot cancel a read already in flight, including one overtaken by an event.
      if (recheckStopped || this.closed || this.typeWatcher !== watcher || !same.includes(false)) return;
      stopRecheck();
      this.observedChanges++;
      this.notify({ projectId: this.id, kind: 'changed' });
    };
    if (watch.links.length) {
      recheckTimer = setInterval(() => { void recheckLinks(); }, LINK_RECHECK_MS);
      recheckTimer.unref();
    }
    await this.replaceTypeWatcher(watcher, stopRecheck);
    return shapes;
  }

  private async replaceTypeWatcher(next: FSWatcher | undefined, stopRecheck?: () => void): Promise<void> {
    const previous = this.typeWatcher;
    this.stopTypeLinkRecheck?.();
    this.stopTypeLinkRecheck = stopRecheck;
    this.typeWatcher = next;
    await previous?.close();
  }

  /**
   * Runs one side job in a worker of its own. Cancel, time limit and closing raise a shared flag instead of
   * terminating the worker: ending a thread while Tree-sitter parses aborts the whole app. The worker stops
   * after its current file and replies; only then, idle, is it terminated. The time limit stops only the
   * job, never the session.
   */
  private async runSide(job: SideJob, data: (stop: SharedArrayBuffer) => object, timeoutMs: number): Promise<unknown> {
    const words = sideWords[job];
    const revision = this.observedChanges;
    const stop = newStopSlots();
    const worker = new Worker(this.workerPath, { workerData: { root: this.root, projectId: this.id, ...data(stop.buffer) } });
    const run = { worker, stop };
    this.sideRuns[job] = run;
    // Kept until this worker is terminated below, so quitting waits for it even after a cancel.
    let ended = () => {};
    keepUntilDone(new Promise<void>(resolve => { ended = resolve; }));
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; requestStop(stop); }, timeoutMs);
    try {
      const result = await new Promise<WorkerResponse['result']>(resolve => {
        worker.once('message', (message: WorkerResponse) => resolve(message.result));
        worker.once('error', () => resolve({ ok: false, code: 'INTERNAL', message: words.failed }));
        worker.once('exit', () => resolve({ ok: false, code: 'INTERNAL', message: words.ended }));
      });
      if (timedOut) throw new AppError('LIMIT', words.slow);
      if (!result.ok) throw new AppError(result.code, result.message);
      if (this.closed) throw new AppError('CANCELLED', '취소한 결과는 표시하지 않습니다.');
      if (revision !== this.observedChanges) throw new AppError('CHANGED', words.changed);
      return result.value;
    } finally {
      clearTimeout(timer);
      if (this.sideRuns[job] === run) delete this.sideRuns[job];
      // It has replied or ended, so it is not inside Tree-sitter now.
      await worker.terminate();
      ended();
    }
  }

  /**
   * Asks a side job's worker to stop; its request then ends with CANCELLED. A new one may start at once:
   * the stopping worker finishes its current file and is cleaned up by its own request.
   */
  cancelMap(): void { this.cancelSide('map'); }
  cancelCalls(): void { this.cancelSide('calls'); }
  cancelChanges(): void { this.cancelSide('changes'); }
  cancelShapes(): void {
    this.shapesRun++;
    this.cancelSide('shapes');
    this.abortTypeWatch?.();
  }
  private cancelSide(job: SideJob): void {
    const run = this.sideRuns[job];
    if (run) requestStop(run.stop);
    delete this.sideRuns[job];
  }

  /**
   * Answers waiting requests and asks the workers to stop, then returns at once: cancelling and opening
   * the next folder do not wait for a parse to finish. The worker itself is terminated after it has
   * replied (see `cleanups`), and quitting waits for that through `workersStopped()`.
   */
  close(code: 'CANCELLED' | 'INTERNAL' | 'LIMIT' = 'CANCELLED'): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    Atomics.store(this.stop, 0, 1);
    this.cancelMap();
    this.cancelSide('plan-map');
    this.cancelRoutes();
    this.cancelCalls();
    this.cancelShapes();
    this.cancelSide('history');
    this.cancelChanges();
    this.cancelSide('diff');
    const message = code === 'LIMIT' ? '작업 제한 시간을 넘었습니다. 더 작은 폴더를 선택해 주세요.' :
      code === 'INTERNAL' ? '분석 작업이 종료되었습니다. 폴더를 다시 열어 주세요.' : '작업을 취소했습니다.';
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.resolve({ ok: false, code, message } satisfies Result<never>);
    }
    this.pending.clear();
    keepUntilDone(Promise.all([this.watcher?.close(), this.replaceTypeWatcher(undefined), this.idle.then(() => this.worker.terminate())]));
    return Promise.resolve();
  }
}
