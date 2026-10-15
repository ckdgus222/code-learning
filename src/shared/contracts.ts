import { z } from 'zod';
import type { ConnectionReport, ExplainRequest, LearningEvent } from './ai';

export const idSchema = z.string().uuid();
export const sourceRequestSchema = z.object({ projectId: idSchema, fileId: idSchema }).strict();
export const evidenceRequestSchema = z.object({ projectId: idSchema, evidenceId: idSchema }).strict();

// Offsets refer to the unchanged decoded source: UTF-16, start inclusive/end exclusive.
export interface Evidence {
  id: string;
  projectId: string;
  fileId: string;
  fileHash: string;
  startUtf16: number;
  endUtf16: number;
  startLine: number;
  endLine: number;
}

export interface CodeStep {
  id: string;
  title: string;
  kind: string;
  depth: number;
  evidence: Evidence;
  /** Source text the step decides on or hands back, such as an if condition or a returned value. */
  detail?: string;
  /** If statements only: the step reached when the condition is true or false, inside the same function. */
  branch?: { whenTrue: string | null; whenFalse: string | null };
}

export interface CodeSymbol {
  id: string;
  name: string;
  kind: string;
  /** Parameter list as written, or '' when the function takes none. */
  params: string;
  evidence: Evidence;
  steps: CodeStep[];
}

export interface Analysis {
  language: 'typescript' | 'javascript' | 'text';
  symbols: CodeSymbol[];
  imports: { text: string; evidence: Evidence }[];
  warnings: string[];
}

export interface ProjectFile { id: string; relativePath: string; size: number }
export interface ProjectView {
  id: string;
  name: string;
  files: ProjectFile[];
  excluded: Record<string, number>;
  warnings: string[];
}
export interface SourceView {
  projectId: string;
  fileId: string;
  relativePath: string;
  hash: string;
  text: string;
  analysis: Analysis;
}

export type AppErrorCode = 'CANCELLED' | 'INVALID_REQUEST' | 'PROJECT_CLOSED' | 'NOT_ALLOWED' |
  'CHANGED' | 'UNSUPPORTED' | 'LIMIT' | 'IO' | 'INTERNAL' | 'AI_UNAVAILABLE' | 'AI_AUTH' | 'AI_RESPONSE';
export type Result<T> = { ok: true; value: T } | { ok: false; code: AppErrorCode; message: string };
export type ProjectEvent = { projectId: string; kind: 'changed' | 'watch-error' };

export interface LearningApi {
  openProject(): Promise<Result<ProjectView | null>>;
  readSource(input: z.infer<typeof sourceRequestSchema>): Promise<Result<SourceView>>;
  readEvidence(input: z.infer<typeof evidenceRequestSchema>): Promise<Result<{ source: SourceView; evidence: Evidence }>>;
  cancel(): Promise<Result<null>>;
  checkConnections(): Promise<Result<ConnectionReport>>;
  startExplanation(input: ExplainRequest): Promise<Result<{ jobId: string }>>;
  cancelExplanation(input: { jobId: string }): Promise<Result<null>>;
  onLearningEvent(listener: (event: LearningEvent) => void): () => void;
  onProjectEvent(listener: (event: ProjectEvent) => void): () => void;
}

export const channels = {
  open: 'learning:open', read: 'learning:read', evidence: 'learning:evidence',
  cancel: 'learning:cancel', event: 'learning:project-event',
  connections: 'learning:connections', explain: 'learning:explain',
  cancelExplanation: 'learning:cancel-explanation', learningEvent: 'learning:ai-event',
} as const;
