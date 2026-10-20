import { randomUUID } from 'node:crypto';
import type { Evidence, ProjectFiles, SourceView } from '../../shared/contracts';
import { AppError } from '../../shared/errors';
import { readAllowed } from '../project/files';

export const MAX_CONTEXT_FILE_BYTES = 32 * 1024;
export const MAX_CONTEXT_BYTES = 128 * 1024;
export const MAX_RELATED_FILES = 4;
export interface ContextFile { evidence: Evidence; relativePath: string; code: string }
/** What one AI request was given: the files read for it and the list it may still ask from. */
export interface ContextSnapshot {
  projectId: string;
  revision: number;
  files: ContextFile[];
  availableFiles: { id: string; relativePath: string }[];
  limitations: string[];
}
/** A question about selected code: the selection, then the files read for it. An overview has no selection. */
export interface EvidenceSnapshot extends ContextSnapshot, ContextFile {}
const hasSelection = (snapshot: ContextSnapshot): snapshot is EvidenceSnapshot => 'evidence' in snapshot;

function checkCancelled(signal: AbortSignal) {
  if (signal.aborted) throw new AppError('CANCELLED', 'AI 작업을 취소했습니다.');
}

// Only the app reads project files. Models request opaque IDs from this session's
// approved list; they never supply a filesystem path or a command to execute.
export class ProjectAiContext {
  private evidence = new Map<string, Evidence>();
  constructor(private readonly root: string, private readonly project: ProjectFiles) {}

  private remember(evidence: Evidence): Evidence {
    this.evidence.delete(evidence.id);
    this.evidence.set(evidence.id, evidence);
    while (this.evidence.size > 64) this.evidence.delete(this.evidence.keys().next().value!);
    return evidence;
  }
  lookup(id: string): Evidence | undefined { return this.evidence.get(id); }
  /**
   * Evidence the screen checked through main. The analysis worker keeps only the last file it read, so code chosen
   * for a question would no longer resolve once another file is read before sending; every use reads it again.
   */
  keep(evidence: Evidence): void { this.remember(evidence); }
  clear(): void { this.evidence.clear(); }

  async capture(source: SourceView, evidence: Evidence, revision: number, signal: AbortSignal): Promise<EvidenceSnapshot> {
    checkCancelled(signal);
    if (source.projectId !== this.project.id || evidence.projectId !== this.project.id ||
        source.fileId !== evidence.fileId || source.hash !== evidence.fileHash ||
        evidence.startUtf16 < 0 || evidence.endUtf16 > source.text.length || evidence.startUtf16 >= evidence.endUtf16) {
      throw new AppError('CHANGED', '질문할 코드의 근거를 다시 선택해 주세요.');
    }
    const selected = this.project.files.find(file => file.id === source.fileId);
    if (!selected || selected.relativePath !== source.relativePath) throw new AppError('NOT_ALLOWED', '현재 프로젝트의 파일이 아닙니다.');
    const code = source.text.slice(evidence.startUtf16, evidence.endUtf16);
    if (Buffer.byteLength(code) > MAX_CONTEXT_FILE_BYTES) throw new AppError('LIMIT', '선택한 코드가 너무 큽니다. 더 작은 구문을 선택해 주세요.');
    const snapshot: EvidenceSnapshot = { projectId: this.project.id, evidence: this.remember(evidence), relativePath: source.relativePath,
      code, revision, files: [], availableFiles: [], limitations: [] };
    this.listFiles(snapshot);
    await this.addFile(snapshot, source.fileId, signal);
    return snapshot;
  }

  /**
   * Plan G1: the file list and, when the user chose one, a start file from the whole project list (the list sent may
   * be cut by its size limit). A start file the rules refuse fails as any read does; one too big is left out with a reason.
   */
  async captureOverview(startFileId: string | null, revision: number, signal: AbortSignal): Promise<ContextSnapshot> {
    checkCancelled(signal);
    const snapshot: ContextSnapshot = { projectId: this.project.id, revision, files: [], availableFiles: [], limitations: [] };
    this.listFiles(snapshot);
    if (startFileId !== null) await this.addFile(snapshot, startFileId, signal);
    return snapshot;
  }

  private listFiles(snapshot: ContextSnapshot): void {
    let listBytes = 0;
    for (const file of this.project.files) {
      const entry = { id: file.id, relativePath: file.relativePath };
      listBytes += Buffer.byteLength(JSON.stringify(entry));
      if (listBytes > 96 * 1024) {
        snapshot.limitations.push('파일 목록 크기 제한으로 일부 파일은 이번 질문의 탐색 목록에 없습니다.');
        break;
      }
      snapshot.availableFiles.push(entry);
    }
  }

  async expand(snapshot: ContextSnapshot, ids: string[], signal: AbortSignal): Promise<void> {
    checkCancelled(signal);
    if (ids.length > MAX_RELATED_FILES || new Set(ids).size !== ids.length ||
        ids.some(id => !snapshot.availableFiles.some(file => file.id === id))) {
      throw new AppError('AI_RESPONSE', 'AI가 허용된 파일 목록 밖의 파일을 요청했습니다.');
    }
    for (const id of ids) await this.addFile(snapshot, id, signal);
    snapshot.limitations.push('관련 파일 탐색은 한 번, 최대 4개입니다. 제공되지 않은 파일의 동작은 확인하지 않았습니다.');
  }

  private async addFile(snapshot: ContextSnapshot, fileId: string, signal: AbortSignal): Promise<void> {
    checkCancelled(signal);
    if (snapshot.files.some(file => file.evidence.fileId === fileId)) return;
    const file = this.project.files.find(item => item.id === fileId);
    if (!file) throw new AppError('NOT_ALLOWED', '등록된 프로젝트 파일이 아닙니다.');
    // Recheck ignore rules, symlinks, hard links and file identity on every read.
    const { text, hash } = await readAllowed(this.root, file.relativePath);
    checkCancelled(signal);
    if (hasSelection(snapshot) && fileId === snapshot.evidence.fileId && hash !== snapshot.evidence.fileHash) {
      throw new AppError('CHANGED', '질문한 코드가 바뀌었습니다.');
    }
    const size = Buffer.byteLength(text);
    const selected = hasSelection(snapshot) ? Buffer.byteLength(snapshot.code) : 0;
    if (!text.length || size > MAX_CONTEXT_FILE_BYTES ||
        size + selected + snapshot.files.reduce((sum, item) => sum + Buffer.byteLength(item.code), 0) > MAX_CONTEXT_BYTES) {
      snapshot.limitations.push(`${file.relativePath}: 비어 있거나 자료 크기 제한을 넘어 전체 파일을 포함하지 않았습니다.`);
      return;
    }
    const evidence = this.remember({ id: randomUUID(), projectId: this.project.id, fileId, fileHash: hash,
      startUtf16: 0, endUtf16: text.length, startLine: 1,
      endLine: text.split('\n').length - (text.endsWith('\n') ? 1 : 0) });
    snapshot.files.push({ evidence, relativePath: file.relativePath, code: text });
  }

  async revalidate(snapshot: ContextSnapshot, signal: AbortSignal): Promise<void> {
    const checked = new Set<string>();
    for (const item of hasSelection(snapshot) ? [snapshot, ...snapshot.files] : snapshot.files) {
      checkCancelled(signal);
      const file = this.project.files.find(entry => entry.id === item.evidence.fileId);
      if (!file || file.relativePath !== item.relativePath) throw new AppError('NOT_ALLOWED', '프로젝트 근거를 확인할 수 없습니다.');
      if (checked.has(file.id)) continue;
      const { text, hash } = await readAllowed(this.root, file.relativePath);
      if (hash !== item.evidence.fileHash || text.slice(item.evidence.startUtf16, item.evidence.endUtf16) !== item.code) {
        throw new AppError('CHANGED', '답변에 사용한 파일이 바뀌었습니다. 새 질문으로 다시 확인해 주세요.');
      }
      checked.add(file.id);
    }
    checkCancelled(signal);
  }
}
