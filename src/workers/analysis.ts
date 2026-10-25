import { parentPort, workerData } from 'node:worker_threads';
import type { ProjectRoutes, FeatureFlow, Evidence, FileDiff, FunctionCalls, GitHistory, ProjectChanges, ProjectFile, ProjectMap, ProjectView, Result, ShapeQuery, SourceView,
  ValueShapes } from '../shared/contracts';
import { AppError, failure } from '../shared/errors';
import { readAllowed, scanProject } from '../core/project/files';
import { analyzeSource } from '../core/analysis/syntax';
import { describeFile } from '../core/analysis/file-guide';
import { buildOverview } from '../core/analysis/overview';
import { buildProjectMap, MAP_LIMITS } from '../core/analysis/project-map';
import { findFunctionCalls } from '../core/analysis/calls';
import { findProjectRoutes } from '../core/analysis/routes';
import { buildFeatureFlow } from '../core/analysis/feature-flow';
import { findValueShapes, type ShapesTarget, type TypeWatch } from '../core/analysis/shapes';
import { gitJob, type GitJob } from '../core/project/git';

export interface WorkerRequest { id: number; kind: 'scan' | 'read' | 'evidence'; target?: string }
export interface WorkerResponse { id: number; result: Result<ProjectRoutes | FeatureFlow | ProjectView | SourceView | ProjectMap | FunctionCalls | { source: SourceView; evidence: Evidence }
  | { shapes: ValueShapes; watch: TypeWatch } | GitHistory | ProjectChanges | FileDiff> }

const { root, projectId, map, calls, shapes, git, routes, flow, stop } = workerData as {
  root: string; projectId: string; map?: { files: ProjectFile[]; starts: string[]; stop: SharedArrayBuffer };
  calls?: { files: ProjectFile[]; target: { fileId: string; fileHash: string; startUtf16: number; endUtf16: number }; stop: SharedArrayBuffer };
  shapes?: { files: ProjectFile[]; target: ShapesTarget; names: ShapeQuery[]; stop: SharedArrayBuffer };
  git?: { job: GitJob; stop: SharedArrayBuffer };
  routes?: { files: ProjectFile[]; stop: SharedArrayBuffer };
  flow?: { files: ProjectFile[]; routes: ProjectRoutes; routeIndex: number; stop: SharedArrayBuffer };
  stop?: SharedArrayBuffer;
};
// The session raises this when it closes; the worker stops before its next parse and replies, and only
// then is it terminated (ending it mid-parse would abort the app).
const stopFlag = stop ? new Int32Array(stop) : null;
const stopped = () => stopFlag !== null && Atomics.load(stopFlag, 0) === 1;
let project: ProjectView | undefined;
// The screen and an AI question can each need a different file (the code shown, the code asked about), so the last few
// files read keep their evidence; whole projects are not cached.
const KEPT_SOURCES = 4;
const sources = new Map<string, SourceView>();

async function readSource(fileId: string): Promise<SourceView> {
  const file = project?.files.find(entry => entry.id === fileId);
  if (!file) throw new AppError('NOT_ALLOWED', '현재 프로젝트에 등록된 파일이 아닙니다.');
  const { text, hash } = await readAllowed(root, file.relativePath);
  const previous = sources.get(fileId);
  sources.delete(fileId);
  if (previous?.hash === hash) { sources.set(fileId, previous); return previous; }
  if (stopped()) throw new AppError('CANCELLED', '작업을 취소했습니다.');
  const analysis = analyzeSource(text, file.relativePath, { projectId, fileId, fileHash: hash });
  let guide: SourceView['guide'] = null;
  if (analysis.language !== 'text') {
    try { guide = describeFile(text, file.relativePath, fileId, hash, analysis, project!.files); }
    catch { /* A guide is optional: a failed description must not prevent reading the source. */ }
  }
  const result: SourceView = { projectId, fileId, relativePath: file.relativePath, text, hash, analysis, guide };
  sources.set(fileId, result);
  while (sources.size > KEPT_SOURCES) sources.delete(sources.keys().next().value!);
  return result;
}

parentPort!.on('message', async (request: WorkerRequest) => {
  let result: WorkerResponse['result'];
  try {
    if (request.kind === 'scan') {
      // The overview rides on the scan reply: the session handles one request at a time.
      const files = await scanProject(root, projectId);
      project = { ...files, overview: await buildOverview(root, files, stopped) };
      result = { ok: true, value: project };
    } else if (request.kind === 'read') {
      result = { ok: true, value: await readSource(request.target!) };
    } else {
      const all = [...sources.values()].flatMap(source => [...source.analysis.imports.map(item => item.evidence),
        ...source.analysis.symbols.flatMap(symbol => [symbol.evidence, ...symbol.steps.map(step => step.evidence)])]);
      const evidence = all.find(item => item.id === request.target);
      if (!evidence || evidence.projectId !== projectId) throw new AppError('NOT_ALLOWED', '현재 코드에서 수집한 근거가 아닙니다.');
      const source = await readSource(evidence.fileId);
      if (source.hash !== evidence.fileHash) throw new AppError('CHANGED', '코드가 바뀌었습니다. 파일을 다시 읽고 근거를 선택해 주세요.');
      if (evidence.startUtf16 < 0 || evidence.endUtf16 > source.text.length || evidence.startUtf16 >= evidence.endUtf16) {
        throw new AppError('INVALID_REQUEST', '근거 위치를 확인할 수 없습니다.');
      }
      result = { ok: true, value: { source, evidence } };
    }
  } catch (error) { result = failure(error); }
  parentPort!.postMessage({ id: request.id, result } satisfies WorkerResponse);
});

// A map worker is started only to draw the project map and reports one result. The session's own
// worker keeps answering reads meanwhile, so opening files does not wait for the map. It stops itself
// when the session raises the shared flag, because terminating it mid-parse would abort the app.
if (map) {
  const stop = new Int32Array(map.stop);
  buildProjectMap(root, projectId, map.files, map.starts, MAP_LIMITS, () => Atomics.load(stop, 0) === 1).then(
    value => parentPort!.postMessage({ id: 0, result: { ok: true, value } } satisfies WorkerResponse),
    error => parentPort!.postMessage({ id: 0, result: failure(error) } satisfies WorkerResponse));
}
// A calls worker likewise searches the project for one function's calls, with the map's limits.
if (calls) {
  const stop = new Int32Array(calls.stop);
  findFunctionCalls(root, projectId, calls.files, calls.target, MAP_LIMITS, () => Atomics.load(stop, 0) === 1).then(
    value => parentPort!.postMessage({ id: 0, result: { ok: true, value } } satisfies WorkerResponse),
    error => parentPort!.postMessage({ id: 0, result: failure(error) } satisfies WorkerResponse));
}
// A shapes worker runs the TypeScript checker as a process of its own for one function (plan v2.3 V-2). The
// session may end that process to stop it (side-stop.ts); the worker replies only once it has ended.
if (shapes) {
  findValueShapes(root, projectId, shapes.files, shapes.target, shapes.names, new Int32Array(shapes.stop)).then(
    value => parentPort!.postMessage({ id: 0, result: { ok: true, value } } satisfies WorkerResponse),
    error => parentPort!.postMessage({ id: 0, result: failure(error) } satisfies WorkerResponse));
}
// A git worker answers one request of the changes view (plan v2.3 C-2). It waits for git asynchronously and ends its own
// git process when the session raises the flag.
if (git) {
  const stop = new Int32Array(git.stop);
  gitJob(root, projectId, git.job, () => Atomics.load(stop, 0) === 1).then(
    value => parentPort!.postMessage({ id: 0, result: { ok: true, value } } satisfies WorkerResponse),
    error => parentPort!.postMessage({ id: 0, result: failure(error) } satisfies WorkerResponse));
}

if (routes) {
  const stop = new Int32Array(routes.stop);
  findProjectRoutes(root, projectId, routes.files, MAP_LIMITS, () => Atomics.load(stop, 0) === 1).then(
    value => parentPort!.postMessage({ id: 0, result: { ok: true, value } } satisfies WorkerResponse),
    error => parentPort!.postMessage({ id: 0, result: failure(error) } satisfies WorkerResponse));
}
if (flow) {
  const stop = new Int32Array(flow.stop);
  buildFeatureFlow(root, projectId, flow.files, flow.routes, flow.routeIndex, MAP_LIMITS, () => Atomics.load(stop, 0) === 1).then(
    value => parentPort!.postMessage({ id: 0, result: { ok: true, value } } satisfies WorkerResponse),
    error => parentPort!.postMessage({ id: 0, result: failure(error) } satisfies WorkerResponse));
}
