import { createHash } from 'node:crypto';
import path from 'node:path';
import type { ProjectMap } from '../../shared/contracts';
import { CODE_SEND_LIMIT, planSelection, type PlanDocument, type PlanRange, type PlanSelection, type PlanCompareResult } from '../../shared/plan-compare';
import { AppError } from '../../shared/errors';
import { readStable, scanProject } from '../project/files';
import { maskSecrets } from './secrets';
import type { ContextSnapshot, ProjectAiContext } from './context';

export type PickedPlan = PlanDocument & { path: string; hash: string };
export interface PlanCompareSnapshot extends ContextSnapshot {
  document: PickedPlan;
  sent: PlanRange[];
  excluded: PlanRange[];
  plan: { startLine: number; text: string }[];
  edges: PlanCompareResult['edges'];
  basis: PlanCompareResult['basis'];
}
export interface PlanCompareSource {
  projectId: string;
  root: string;
  context: ProjectAiContext;
  map(): Promise<ProjectMap>;
  cancelMap(): void;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Stop waiting immediately; a late filesystem result cannot continue the cancelled operation. */
export async function waitForPlan<T>(signal: AbortSignal, work: () => Promise<T>, cancel?: () => void): Promise<T> {
  if (signal.aborted) throw new AppError('CANCELLED', '대조 작업을 취소했어요.');
  let abort = () => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => { cancel?.(); reject(new AppError('CANCELLED', '대조 작업을 취소했어요.')); };
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([work(), stopped]); }
  finally { signal.removeEventListener('abort', abort); }
}

export async function readPlan(document: PickedPlan, signal: AbortSignal): Promise<string> {
  const source = await waitForPlan(signal, () => readStable(path.dirname(document.path), path.basename(document.path)));
  if (source.hash !== document.hash) throw new AppError('CHANGED', '기획 문서가 바뀌었어요. 다시 골라 주세요.');
  return source.text;
}

export async function planScope(source: PlanCompareSource, signal: AbortSignal): Promise<string> {
  const scanned = await waitForPlan(signal, () => scanProject(source.root, source.projectId));
  const paths = scanned.files.map(file => file.relativePath).sort();
  if (JSON.stringify(paths) !== JSON.stringify(source.context.paths())) {
    throw new AppError('CHANGED', '폴더에 새 파일이 생겼거나 제외 규칙이 바뀌었어요. 폴더를 다시 열어 주세요.');
  }
  const ignores = new Set(['.gitignore']);
  for (const file of paths) {
    let dir = path.posix.dirname(file);
    while (dir !== '.') { ignores.add(`${dir}/.gitignore`); dir = path.posix.dirname(dir); }
  }
  const rules: { path: string; hash: string | null }[] = [];
  for (const relative of [...ignores].sort()) {
    const value = await waitForPlan(signal, async () => {
      try { return (await readStable(source.root, relative, 64 * 1024)).hash; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    });
    rules.push({ path: relative, hash: value });
  }
  return hash({ paths, rules });
}

/** IDs change on reopening; only paths and observed structure belong in this basis. */
export function planMapHash(map: ProjectMap): string {
  const paths = new Map(map.files.map(file => [file.id, file.relativePath]));
  return hash({
    files: map.files.map(file => ({ path: file.relativePath, checked: file.checked })),
    edges: map.edges.map(edge => ({ from: paths.get(edge.fromFileId), to: paths.get(edge.toFileId), line: edge.startLine, specifier: edge.specifier })),
    unresolved: map.unresolved.map(edge => ({ from: paths.get(edge.fromFileId), specifier: edge.specifier, reason: edge.reason })),
    external: map.external.map(edge => ({ from: paths.get(edge.fromFileId), specifier: edge.specifier })),
  });
}

export async function capturePlanCompare(source: PlanCompareSource, document: PickedPlan, selection: PlanSelection,
  revision: number, signal: AbortSignal): Promise<PlanCompareSnapshot> {
  planSelection(document, selection);
  const text = await readPlan(document, signal);
  const scopeHash = await planScope(source, signal);
  const map = await waitForPlan(signal, () => source.map(), () => source.cancelMap());
  const snapshot = await waitForPlan(signal, () => source.context.captureOverview(null, revision, signal));
  const ranges = 'startLine' in selection ? [selection] : document.sections.filter(section => selection.sectionIds.includes(section.id));
  const sent: PlanRange[] = [];
  for (const range of [...ranges].sort((a, b) => a.startLine - b.startLine)) {
    const previous = sent.at(-1);
    if (previous && previous.endLine + 1 >= range.startLine) { previous.endLine = Math.max(previous.endLine, range.endLine); continue; }
    sent.push({ startLine: range.startLine, endLine: range.endLine });
  }
  const excluded: PlanRange[] = [];
  let startLine = 1;
  for (const range of sent) {
    if (startLine < range.startLine) excluded.push({ startLine, endLine: range.startLine - 1 });
    startLine = range.endLine + 1;
  }
  if (startLine <= document.lines) excluded.push({ startLine, endLine: document.lines });
  // Mask the entire document first: selecting the middle of a PEM must not bypass masking.
  const masked = maskSecrets(text);
  const lines = masked.text.split('\n');
  const plan = sent.map(range => ({ startLine: range.startLine,
    text: lines.slice(range.startLine - 1, range.endLine).join('\n') + (range.endLine < lines.length ? '\n' : '') }));
  if (masked.count) snapshot.limitations.push(`기획 문서: 비밀값처럼 보이는 ${masked.count}곳을 가린 뒤 보냈어요. AI는 가린 내용을 보지 못했어요. 모든 비밀값을 찾아낸다고 보장하지는 않아요.`);
  const paths = new Map(map.files.map(file => [file.id, file.relativePath]));
  const edges: PlanCompareResult['edges'] = [];
  let bytes = 2;
  for (const [index, edge] of map.edges.entries()) {
    const entry = { index, from: paths.get(edge.fromFileId)!, to: paths.get(edge.toFileId)!, line: edge.startLine };
    bytes += Buffer.byteLength(JSON.stringify(entry)) + (edges.length ? 1 : 0);
    if (bytes > 64 * 1024) { snapshot.limitations.push('지도 크기 제한으로 연결 일부를 보내지 않았어요'); break; }
    edges.push(entry);
  }
  if (map.unresolved.length) snapshot.limitations.push(`지도에서 잇지 못한 연결 ${map.unresolved.length}개는 설계 비교에서 판단하지 않았어요`);
  if (map.limited) snapshot.limitations.push('지도 분석 한도로 프로젝트 일부만 확인했어요.');
  snapshot.limitations.push(...map.notes);
  return { ...snapshot, limits: { files: 8, bytes: CODE_SEND_LIMIT },
    document: { documentId: document.documentId, name: document.name, path: document.path, hash: document.hash,
      bytes: document.bytes, lines: document.lines, lineBytes: document.lineBytes, sections: document.sections },
    sent, excluded, plan, edges, basis: { planHash: document.hash, scopeHash, mapHash: planMapHash(map) } };
}

export async function revalidatePlanCompare(source: PlanCompareSource, snapshot: PlanCompareSnapshot, signal: AbortSignal, final: boolean): Promise<void> {
  await readPlan(snapshot.document, signal);
  await waitForPlan(signal, () => source.context.revalidate(snapshot, signal));
  if (await planScope(source, signal) !== snapshot.basis.scopeHash) {
    throw new AppError('CHANGED', '조사 범위나 제외 규칙이 바뀌었어요. 폴더를 다시 열어 주세요.');
  }
  if (!final) return;
  const map = await waitForPlan(signal, () => source.map(), () => source.cancelMap());
  if (planMapHash(map) !== snapshot.basis.mapHash) throw new AppError('CHANGED', '프로젝트 연결이 바뀌었어요. 다시 대조해 주세요.');
  // Changes during the final map read must also discard the result.
  await readPlan(snapshot.document, signal);
  await waitForPlan(signal, () => source.context.revalidate(snapshot, signal));
  if (await planScope(source, signal) !== snapshot.basis.scopeHash) throw new AppError('CHANGED', '조사 범위가 바뀌었어요. 다시 대조해 주세요.');
}
