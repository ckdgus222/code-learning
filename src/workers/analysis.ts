import { parentPort, workerData } from 'node:worker_threads';
import type { Evidence, ProjectView, Result, SourceView } from '../shared/contracts';
import { AppError, failure } from '../shared/errors';
import { readAllowed, scanProject } from '../core/project/files';
import { analyzeSource } from '../core/analysis/syntax';

export interface WorkerRequest { id: number; kind: 'scan' | 'read' | 'evidence'; target?: string }
export interface WorkerResponse { id: number; result: Result<ProjectView | SourceView | { source: SourceView; evidence: Evidence }> }

const { root, projectId } = workerData as { root: string; projectId: string };
let project: ProjectView | undefined;
const sources = new Map<string, SourceView>();

async function readSource(fileId: string): Promise<SourceView> {
  const file = project?.files.find(entry => entry.id === fileId);
  if (!file) throw new AppError('NOT_ALLOWED', '현재 프로젝트에 등록된 파일이 아닙니다.');
  const { text, hash } = await readAllowed(root, file.relativePath);
  const previous = sources.get(fileId);
  if (previous?.hash === hash) return previous;
  const analysis = analyzeSource(text, file.relativePath, { projectId, fileId, fileHash: hash });
  const result: SourceView = { projectId, fileId, relativePath: file.relativePath, text, hash, analysis };
  // A single active source is enough for the first reading flow; do not cache whole projects.
  sources.clear();
  sources.set(fileId, result);
  return result;
}

parentPort!.on('message', async (request: WorkerRequest) => {
  let result: WorkerResponse['result'];
  try {
    if (request.kind === 'scan') {
      project = await scanProject(root, projectId);
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
