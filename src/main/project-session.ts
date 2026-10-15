import { Worker } from 'node:worker_threads';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { Evidence, ProjectEvent, ProjectView, Result, SourceView } from '../shared/contracts';
import { AppError } from '../shared/errors';
import type { WorkerRequest, WorkerResponse } from '../workers/analysis';

export class ProjectSession {
  private worker: Worker;
  private watcher?: FSWatcher;
  private pending = new Map<number, { resolve: (result: WorkerResponse['result']) => void; timer: ReturnType<typeof setTimeout> }>();
  private requestId = 0;
  private closed = false;
  private termination?: Promise<void>;
  private observedChanges = 0;

  constructor(readonly id: string, readonly root: string, workerPath: string, private notify: (event: ProjectEvent) => void) {
    this.worker = new Worker(workerPath, { workerData: { root, projectId: id } });
    this.worker.on('message', (message: WorkerResponse) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      pending.resolve(message.result);
    });
    this.worker.on('error', () => { void this.close('INTERNAL'); });
    this.worker.on('exit', () => { if (!this.closed) void this.close('INTERNAL'); });
  }

  private async request<T>(kind: WorkerRequest['kind'], target?: string): Promise<T> {
    if (this.closed) throw new AppError('PROJECT_CLOSED', '프로젝트가 닫혔습니다. 다시 열어 주세요.');
    if (this.pending.size) throw new AppError('INVALID_REQUEST', '진행 중인 읽기 작업이 있습니다. 잠시 뒤 다시 시도해 주세요.');
    const id = ++this.requestId;
    const result = await new Promise<WorkerResponse['result']>(resolve => {
      const timer = setTimeout(() => { void this.close('LIMIT'); }, 30_000);
      this.pending.set(id, { resolve, timer });
      this.worker.postMessage({ id, kind, target } satisfies WorkerRequest);
    });
    if (!result.ok) throw new AppError(result.code, result.message);
    if (this.closed) throw new AppError('CANCELLED', '취소한 결과는 표시하지 않습니다.');
    return result.value as T;
  }

  async open(): Promise<ProjectView> {
    const project = await this.request<ProjectView>('scan');
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

  close(code: 'CANCELLED' | 'INTERNAL' | 'LIMIT' = 'CANCELLED'): Promise<void> {
    if (this.termination) return this.termination;
    this.closed = true;
    const message = code === 'LIMIT' ? '작업 제한 시간을 넘었습니다. 더 작은 폴더를 선택해 주세요.' :
      code === 'INTERNAL' ? '분석 작업이 종료되었습니다. 폴더를 다시 열어 주세요.' : '작업을 취소했습니다.';
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.resolve({ ok: false, code, message } satisfies Result<never>);
    }
    this.pending.clear();
    this.termination = Promise.all([this.watcher?.close(), this.worker.terminate()]).then(() => undefined);
    return this.termination;
  }
}
